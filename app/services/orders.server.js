import prisma from "../db.server.js";
import { postTransaction, expiryDate } from "./ledger.server.js";
import { resolveOrderCustomer, claimGuestOrders } from "./customers.server.js";
import { enqueueAwardRelease } from "../queue/queue.server.js";
import { notifyCustomer } from "./notify.server.js";
import { maybeRewardReferral, reverseReferralForOrder } from "./referrals.server.js";

const money = (v) => Number(v ?? 0) || 0;
const DAY = 86400000; // day in ms

// ---------------------------------------------------------------------------------------
// Points maths
// ---------------------------------------------------------------------------------------

export function computePurchasePoints(rules, amount) {
  let total = 0;
  for (const r of rules) {
    if (!r.active || amount < money(r.minOrderAmount)) continue;
    if (r.type === "PURCHASE_PER_CURRENCY") total += Math.floor(amount * r.value);
    else if (r.type === "PURCHASE_FIXED") total += r.value;
  }
  return total;
}

// Merchandise value that earns points: after discounts, before shipping and tax.
function eligibleAmountOf(order) {
  return money(order.current_subtotal_price ?? order.subtotal_price);
}

// ---------------------------------------------------------------------------------------
// Webhook entry points. Each is safe to run many times for the same payload.
// ---------------------------------------------------------------------------------------

/** orders/paid, orders/fulfilled, orders/cancelled */
export async function handleOrderEvent(store, topic, payload) {
  const shopifyOrderId = String(payload.id);
  const customer = await resolveOrderCustomer(store.id, payload);
  const now = new Date();
  const at = (iso) => (iso ? new Date(iso) : now);

  const stamps = {};
  if (topic === "orders/paid") stamps.paidAt = at(payload.processed_at);
  if (topic === "orders/fulfilled") stamps.fulfilledAt = at(payload.updated_at);
  if (topic === "orders/cancelled") stamps.cancelledAt = at(payload.cancelled_at);

  // AWB numbers let a shipping integration (Shiprocket) find this order again.
  const tracking = [
    ...new Set(
      (payload.fulfillments || [])
        .flatMap((f) => [f.tracking_number, ...(f.tracking_numbers || [])])
        .filter(Boolean)
        .map(String),
    ),
  ];

  const base = {
    ...(tracking.length ? { trackingNumbers: tracking } : {}),
    orderName: payload.name ?? null,
    email: (payload.email || payload.contact_email || "").toLowerCase() || null,
    currency: payload.currency ?? null,
    eligibleAmount: eligibleAmountOf(payload),
    discountCodes: (payload.discount_codes || []).map((d) => String(d.code).toUpperCase()),
    loyaltyDiscount: (payload.discount_codes || [])
      .filter((d) => /^LOY-/i.test(String(d.code)))
      .reduce((sum, d) => sum + money(d.amount), 0),
    ...(customer ? { customerId: customer.id } : {}),
  };

  const order = await prisma.order.upsert({
    where: { storeId_shopifyOrderId: { storeId: store.id, shopifyOrderId } },
    create: { storeId: store.id, shopifyOrderId, ...base, ...stamps },
    update: {
      ...base,
      ...stamps,
      // Stubs created by a delivery event carry no amount; never zero out a known amount.
      ...(base.eligibleAmount === 0 ? { eligibleAmount: undefined } : {}),
    },
  });

  if (topic === "orders/paid") await markRedemptionsUsed(store.id, order);
  if (topic === "orders/cancelled") return cancelOrderPoints(store, order);
  return evaluateOrder(store, order);
}

/** fulfillment_events/create — only "delivered" matters. */
export async function handleFulfillmentEvent(store, payload) {
  if (String(payload.status).toLowerCase() !== "delivered") return;
  const shopifyOrderId = String(payload.order_id);
  const order = await prisma.order.upsert({
    where: { storeId_shopifyOrderId: { storeId: store.id, shopifyOrderId } },
    create: { storeId: store.id, shopifyOrderId, deliveredAt: new Date(payload.happened_at || Date.now()) },
    update: { deliveredAt: new Date(payload.happened_at || Date.now()) },
  });
  return evaluateOrder(store, order);
}

/** refunds/create */
export async function handleRefund(store, payload) {
  const order = await prisma.order.findUnique({
    where: { storeId_shopifyOrderId: { storeId: store.id, shopifyOrderId: String(payload.order_id) } },
    include: { award: true },
  });
  if (!order) return;

  const amount = (payload.refund_line_items || []).reduce((s, l) => s + money(l.subtotal), 0);
  try {
    await prisma.orderRefund.create({
      data: { orderId: order.id, shopifyRefundId: String(payload.id), amount },
    });
  } catch (e) {
    if (e?.code === "P2002") return; // already processed
    throw e;
  }
  const sum = await prisma.orderRefund.aggregate({ where: { orderId: order.id }, _sum: { amount: true } });
  const refunded = money(sum._sum.amount);
  const updated = await prisma.order.update({
    where: { id: order.id },
    data: { refundedAmount: refunded },
    include: { award: true },
  });

  const award = updated.award;
  if (!award) return;
  const eligible = money(updated.eligibleAmount);
  const keep = eligible > 0 ? Math.max(0, 1 - refunded / eligible) : 0;

  if (award.status === "PENDING") {
    if (keep === 0) {
      await prisma.pointsAward.updateMany({ where: { id: award.id, status: "PENDING" }, data: { status: "CANCELLED" } });
    }
    // Partial refunds on pending awards are applied when the award is released.
    return;
  }
  if (award.status === "RELEASED") {
    const target = award.points - Math.floor(award.points * keep);
    await reverseDelta(store, award, target, `refund:${payload.id}`, `Refund on ${updated.orderName ?? "order"}`);
    if (keep === 0) await reverseReferralForOrder(order.id);
  }
}

/** Order cancelled or returned to the seller: cancel pending points, claw back credited ones. */
export async function cancelOrderPoints(store, order, label = "Cancelled") {
  const award = await prisma.pointsAward.findUnique({ where: { orderId: order.id } });
  if (!award) return;
  if (award.status === "PENDING") {
    await prisma.pointsAward.updateMany({ where: { id: award.id, status: "PENDING" }, data: { status: "CANCELLED" } });
  } else if (award.status === "RELEASED") {
    await reverseDelta(store, award, award.points, `cancel:${order.id}`, `${label} ${order.orderName ?? "order"}`);
    await reverseReferralForOrder(order.id);
  }
}

// Reverse up to `targetTotal` points for this order, minus whatever was reversed already.
async function reverseDelta(store, award, targetTotal, key, note) {
  const done = await prisma.pointsTransaction.aggregate({
    where: { customerId: award.customerId, orderId: award.orderId, type: "REVERSAL", points: { lt: 0 } },
    _sum: { points: true },
  });
  const delta = Math.min(targetTotal, award.points) - Math.abs(done._sum.points ?? 0);
  if (delta <= 0) return;
  await postTransaction({
    storeId: store.id,
    customerId: award.customerId,
    type: "REVERSAL",
    points: -delta,
    idempotencyKey: key,
    orderId: award.orderId,
    allowNegative: true, // points may already have been spent; the balance records the debt
    note,
  });
}

async function markRedemptionsUsed(storeId, order) {
  if (!order.discountCodes.length) return;
  await prisma.redemption.updateMany({
    where: { storeId, code: { in: order.discountCodes }, status: "ACTIVE" },
    data: { status: "USED", usedOrderId: order.shopifyOrderId },
  });
}

// ---------------------------------------------------------------------------------------
// Award lifecycle: PENDING --(holdDays)--> RELEASED | CANCELLED
// ---------------------------------------------------------------------------------------

/** Create the award once the configured status has been reached. Idempotent per order. */
export async function evaluateOrder(store, order) {
  if (order.cancelledAt || order.returnedAt || !order.customerId) return null;
  const settings = store.settings ?? (await prisma.storeSettings.findUnique({ where: { storeId: store.id } }));
  if (!settings) return null;

  const reachedAt = { PAID: order.paidAt, FULFILLED: order.fulfilledAt, DELIVERED: order.deliveredAt }[settings.earnTrigger];
  if (!reachedAt) return null;

  const existing = await prisma.pointsAward.findUnique({ where: { orderId: order.id } });
  if (existing) return existing;

  const rules = await prisma.earnRule.findMany({
    where: { storeId: store.id, active: true, type: { in: ["PURCHASE_PER_CURRENCY", "PURCHASE_FIXED"] } },
  });
  const points = computePurchasePoints(rules, money(order.eligibleAmount));
  if (points <= 0) return null;

  const releaseAt = new Date(reachedAt.getTime() + settings.holdDays * DAY);
  let award;
  try {
    award = await prisma.pointsAward.create({
      data: { storeId: store.id, customerId: order.customerId, orderId: order.id, points, releaseAt },
    });
  } catch (e) {
    if (e?.code === "P2002") return prisma.pointsAward.findUnique({ where: { orderId: order.id } });
    throw e;
  }

  if (releaseAt.getTime() <= Date.now()) {
    await releaseAward(award.id); // holdDays = 0 → credit right now
  } else {
    await enqueueAwardRelease(award.id, releaseAt);
  }
  return award;
}

/** Credit a pending award to the ledger. Safe to call repeatedly and concurrently. */
export async function releaseAward(awardId) {
  const claimed = await prisma.pointsAward.updateMany({
    where: { id: awardId, status: "PENDING", releaseAt: { lte: new Date(Date.now() + 1000) } },
    data: { status: "RELEASED", releasedAt: new Date() },
  });
  if (claimed.count === 0) return null;

  const award = await prisma.pointsAward.findUnique({ where: { id: awardId }, include: { order: true } });
  const settings = await prisma.storeSettings.findUnique({ where: { storeId: award.storeId } });

  // Apply refunds that happened while the points were on hold.
  const eligible = money(award.order.eligibleAmount);
  const keep = eligible > 0 ? Math.max(0, 1 - money(award.order.refundedAmount) / eligible) : 0;
  const points = award.order.cancelledAt || award.order.returnedAt ? 0 : Math.floor(award.points * keep);
  if (points <= 0) {
    await prisma.pointsAward.update({ where: { id: awardId }, data: { status: "CANCELLED", releasedAt: null } });
    return null;
  }

  let result;
  try {
    result = await postTransaction({
      storeId: award.storeId,
      customerId: award.customerId,
      type: "EARN",
      points,
      source: "order",
      idempotencyKey: `award:${award.id}`,
      orderId: award.orderId,
      expiresAt: expiryDate(settings?.expiryDays ?? 0),
      note: `Order ${award.order.orderName ?? award.order.shopifyOrderId}`,
    });
  } catch (e) {
    // Posting failed: put the award back so the job retry / sweeper can try again.
    await prisma.pointsAward.updateMany({ where: { id: awardId, status: "RELEASED" }, data: { status: "PENDING", releasedAt: null } });
    throw e;
  }

  if (!result.duplicate) {
    await notifyCustomer({
      storeId: award.storeId,
      customerId: award.customerId,
      kind: "points_earned",
      dedupeKey: `earned:${award.id}`,
      data: {
        points,
        balance: result.transaction.balanceAfter,
        reason: `your order ${award.order.orderName ?? ""} earned points`.replace("  ", " "),
        expiresAt: result.transaction.expiresAt ? result.transaction.expiresAt.toISOString().slice(0, 10) : null,
      },
    });
  }
  // A friend's first qualifying order pays out the referral. Idempotent, so it also runs on a
  // retried release; never fail the award over it.
  await maybeRewardReferral(award, award.order).catch((e) => console.error("[referral] payout failed", e.message));
  return result.transaction;
}

/** Safety net run by the worker: release anything due that the delayed job missed. */
export async function releaseDueAwards() {
  const due = await prisma.pointsAward.findMany({
    where: { status: "PENDING", releaseAt: { lte: new Date() } },
    select: { id: true },
    take: 200,
  });
  let n = 0;
  for (const a of due) {
    try {
      if (await releaseAward(a.id)) n += 1;
    } catch (e) {
      console.error("[sweep] release failed", a.id, e.message);
    }
  }
  return n;
}

/** Account just created/linked: attach guest orders and award points they now qualify for. */
export async function claimAndEvaluate(store, customer) {
  const claimed = await claimGuestOrders(customer);
  for (const o of claimed) {
    const fresh = await prisma.order.findUnique({ where: { id: o.id } });
    await evaluateOrder(store, { ...fresh, customerId: customer.id });
  }
}
