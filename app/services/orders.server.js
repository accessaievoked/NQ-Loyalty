import prisma from "../db.server.js";
import { postTransaction, expiryDate } from "./ledger.server.js";
import { resolveOrderCustomer, claimGuestOrders } from "./customers.server.js";
import { enqueueAwardRelease } from "../queue/scheduler.server.js";
import { notifyCustomer } from "./notify.server.js";
import { maybeRewardReferral, reverseReferralForOrder } from "./referrals.server.js";

const money = (v) => Number(v ?? 0) || 0;
const DAY = 86400000; // day in ms

// ---------------------------------------------------------------------------------------
// Points maths
// ---------------------------------------------------------------------------------------

// Points one rule gives for an order of `amount` that is the customer's `orderNumber`th (1-based).
function rulePoints(r, amount, orderNumber) {
  if (r.type === "PURCHASE_PER_CURRENCY") {
    if (amount < money(r.minOrderAmount)) return 0;
    const pts = Math.floor(amount * r.value);
    return r.maxPoints ? Math.min(pts, r.maxPoints) : pts;
  }
  if (r.type === "PURCHASE_FIXED") return amount < money(r.minOrderAmount) ? 0 : r.value;
  if (r.type === "ORDER_MILESTONE") {
    // An exact-order step only pays on that order; a `continuing` step pays on that order AND every later
    // one (the highest one reached wins once no exact step matches). A step's own minimum order gates it.
    const steps = Array.isArray(r.milestones) ? r.milestones : [];
    let step = steps.find((x) => !x?.continuing && Number(x?.order) === orderNumber);
    if (!step) {
      const reached = steps.filter((x) => x?.continuing && Number(x?.order) <= orderNumber);
      step = reached.sort((p, q) => Number(q.order) - Number(p.order))[0];
    }
    if (!step || amount < money(step.minOrderAmount)) return 0;
    return Math.max(0, Math.floor(Number(step.points) || 0));
  }
  return 0;
}

const STAGES = ["PAID", "FULFILLED", "DELIVERED"];

// What an order earns from all the active purchase rules. Rules that "combine" (the default) add up.
// A rule that doesn't combine can't be added to the others: the customer gets that rule's points or
// the combined total of the rest, whichever is more.
//
// Each rule has its own "credit when" status, wait and expiry. One order has one award, so when
// several rules pay on the same order the points arrive together once the LATEST of their statuses is
// reached and the longest wait has passed; each rule's points still expire on that rule's own schedule
// (returned as `parts`, grouped by expiry).
export function computeOrderPoints(rules, amount, orderNumber) {
  const entries = [];
  for (const r of rules) {
    if (!r.active) continue;
    const pts = rulePoints(r, amount, orderNumber);
    if (pts > 0) entries.push({ pts, rule: r });
  }
  const stacked = entries.filter((e) => e.rule.combine !== false);
  const stackedTotal = stacked.reduce((sum, e) => sum + e.pts, 0);
  const alone = entries.filter((e) => e.rule.combine === false).sort((p, q) => q.pts - p.pts)[0];
  const chosen = alone && alone.pts > stackedTotal ? [alone] : stacked;

  const points = chosen.reduce((sum, e) => sum + e.pts, 0);
  let creditWhen = "PAID";
  let holdDays = 0;
  const byExpiry = new Map();
  for (const e of chosen) {
    const stage = e.rule.creditWhen || "PAID";
    if (STAGES.indexOf(stage) > STAGES.indexOf(creditWhen)) creditWhen = stage;
    holdDays = Math.max(holdDays, e.rule.holdDays || 0);
    const days = e.rule.expiryDays || 0;
    byExpiry.set(days, (byExpiry.get(days) || 0) + e.pts);
  }
  const parts = [...byExpiry].map(([expiryDays, p]) => ({ expiryDays, points: p }));
  return { points, parts, creditWhen, holdDays };
}

// How many of the customer's other orders already reached the earn trigger before this one —
// used as the 1-based "order number" for ORDER_MILESTONE rules. Counted from Order rows (not
// PointsAward rows) so a first order worth 0 points still counts as order #1 for the next one.
async function priorEligibleOrderCount(storeId, customerId, order) {
  return prisma.order.count({
    where: {
      storeId,
      customerId,
      id: { not: order.id },
      cancelledAt: null,
      returnStatus: { not: "CLOSED" },
      OR: [{ paidAt: { not: null } }, { fulfilledAt: { not: null } }, { deliveredAt: { not: null } }],
      createdAt: { lt: order.createdAt },
    },
  });
}

// Merchandise value that earns points: after discounts, before shipping and tax, as it was when
// the order was placed. Deliberately `subtotal_price`, never `current_subtotal_price`: the current
// one already has refunds (and edits) taken off, and refunds are subtracted separately in
// `keep` below, so using it would count every refund twice. Order edits after checkout therefore
// don't change the points (a decision: points follow what the customer originally bought).
function eligibleAmountOf(order) {
  return money(order.subtotal_price);
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

  const base = {
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

// Delivery comes from Shopify itself, in two forms (either may fire, depending on the carrier):
//   fulfillment_events/create  { order_id, status: "delivered", happened_at }
//   fulfillments/create|update { order_id, shipment_status: "delivered", updated_at }
// The FIRST delivery time is kept, so repeated pings never push the return window out.
async function markDelivered(store, shopifyOrderId, when, shipmentStatus) {
  const where = { storeId_shopifyOrderId: { storeId: store.id, shopifyOrderId } };
  const existing = await prisma.order.findUnique({ where });
  const deliveredAt = existing?.deliveredAt ?? when;
  const order = await prisma.order.upsert({
    where,
    create: { storeId: store.id, shopifyOrderId, deliveredAt, shipmentStatus },
    update: { deliveredAt, shipmentStatus },
  });
  return evaluateOrder(store, order);
}

/** fulfillment_events/create — only "delivered" matters. */
export async function handleFulfillmentEvent(store, payload) {
  if (String(payload.status).toLowerCase() !== "delivered") return;
  return markDelivered(store, String(payload.order_id), new Date(payload.happened_at || Date.now()), "delivered");
}

/** fulfillments/create and fulfillments/update — shipment_status reports the carrier's progress. */
export async function handleFulfillmentUpdate(store, payload) {
  const status = String(payload.shipment_status ?? "").toLowerCase();
  if (!payload.order_id) return;
  if (status !== "delivered") {
    if (status) {
      await prisma.order.updateMany({
        where: { storeId: store.id, shopifyOrderId: String(payload.order_id) },
        data: { shipmentStatus: status.slice(0, 40) },
      });
    }
    return;
  }
  return markDelivered(store, String(payload.order_id), new Date(payload.updated_at || Date.now()), "delivered");
}

// Returns, straight from Shopify:
//   REQUESTED / OPEN  → a return is in progress: points still waiting are HELD (not credited);
//   CLOSED            → the item came back: the order's points are cancelled, or taken back
//                       if they were already credited, and never credited again;
//   DECLINED/CANCELED → the return didn't happen: normal crediting resumes.
export const RETURN_ON_HOLD = ["REQUESTED", "OPEN"];

/** `status` is Shopify's ReturnStatus; `shopifyOrderId` is the numeric order id. */
export async function handleReturnStatus(store, shopifyOrderId, status) {
  const normalised = String(status).toUpperCase();
  const where = { storeId_shopifyOrderId: { storeId: store.id, shopifyOrderId: String(shopifyOrderId) } };
  const order = await prisma.order.upsert({
    where,
    create: { storeId: store.id, shopifyOrderId: String(shopifyOrderId), returnStatus: normalised },
    update: { returnStatus: normalised, ...(normalised === "CLOSED" ? { returnedAt: new Date() } : {}) },
  });

  if (normalised === "CLOSED") {
    await cancelOrderPoints(store, order, "Returned");
    return "returned: points cancelled";
  }
  if (normalised === "DECLINED" || normalised === "CANCELED") {
    // The hold is over: credit now if the waiting period has already passed.
    const award = await prisma.pointsAward.findUnique({ where: { orderId: order.id } });
    if (award?.status === "PENDING") await releaseAward(award.id);
    return "return ended: points resume";
  }
  return "return in progress: points held";
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
    await reverseOrderPoints(store, award, keep, `refund:${payload.id}`, `Refund on ${updated.orderName ?? "order"}`);
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
    await reverseOrderPoints(store, award, 0, `cancel:${order.id}`, `${label} ${order.orderName ?? "order"}`);
    await reverseReferralForOrder(order.id);
  }
}

// What was actually credited for this award. It can be less than `award.points`: a refund that
// happened while the points were on hold lowered the credit at release time.
async function creditedFor(store, award) {
  if (Array.isArray(award.parts) && award.parts.length) {
    const sum = await prisma.pointsTransaction.aggregate({
      where: { storeId: store.id, idempotencyKey: { startsWith: `award:${award.id}:` } },
      _sum: { points: true },
    });
    return Math.max(0, sum._sum.points ?? 0);
  }
  const earn = await prisma.pointsTransaction.findUnique({
    where: { storeId_idempotencyKey: { storeId: store.id, idempotencyKey: `award:${award.id}` } },
    select: { points: true },
  });
  return Math.max(0, earn?.points ?? 0);
}

// Bring the points kept for this order down to `keepFraction` (0..1) of the full award, never taking
// back more than was credited. Whatever was reversed before counts, so every call is a top-up.
//   refund → keepFraction = what is left of the order after refunds
//   cancel / returned → keepFraction = 0 (everything credited is taken back, exactly once)
async function reverseOrderPoints(store, award, keepFraction, key, note) {
  const credited = await creditedFor(store, award);
  const shouldRemain = Math.floor(award.points * keepFraction);
  const totalToReverse = Math.max(0, credited - shouldRemain);
  const done = await prisma.pointsTransaction.aggregate({
    where: { customerId: award.customerId, orderId: award.orderId, type: "REVERSAL", points: { lt: 0 } },
    _sum: { points: true },
  });
  const delta = totalToReverse - Math.abs(done._sum.points ?? 0);
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
  if (order.cancelledAt || order.returnedAt || order.returnStatus === "CLOSED" || !order.customerId) return null;
  const existing = await prisma.pointsAward.findUnique({ where: { orderId: order.id } });
  if (existing) return existing;

  const rules = await prisma.earnRule.findMany({
    where: { storeId: store.id, active: true, type: { in: ["PURCHASE_PER_CURRENCY", "PURCHASE_FIXED", "ORDER_MILESTONE"] } },
  });
  const eligibleAmount = money(order.eligibleAmount);
  const needsOrderNumber = rules.some((r) => r.type === "ORDER_MILESTONE");
  const orderNumber = needsOrderNumber ? 1 + (await priorEligibleOrderCount(store.id, order.customerId, order)) : 0;
  const calc = computeOrderPoints(rules, eligibleAmount, orderNumber);
  if (calc.points <= 0) return null;

  // Wait for the latest status any of the paying rules asks for; a later event re-checks.
  const reachedAt = { PAID: order.paidAt, FULFILLED: order.fulfilledAt, DELIVERED: order.deliveredAt }[calc.creditWhen];
  if (!reachedAt) return null;
  const points = calc.points;
  const releaseAt = new Date(reachedAt.getTime() + calc.holdDays * DAY);
  let award;
  try {
    award = await prisma.pointsAward.create({
      data: { storeId: store.id, customerId: order.customerId, orderId: order.id, points, parts: calc.parts, releaseAt },
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
  // Shopify's return status decides first: a return in progress HOLDS the points (they stay
  // pending and are looked at again later); a completed return cancels them for good.
  const pre = await prisma.pointsAward.findUnique({ where: { id: awardId }, include: { order: true } });
  if (!pre || pre.status !== "PENDING") return null;
  if (pre.order.returnedAt || pre.order.returnStatus === "CLOSED") {
    await prisma.pointsAward.updateMany({ where: { id: awardId, status: "PENDING" }, data: { status: "CANCELLED" } });
    return null;
  }
  if (RETURN_ON_HOLD.includes(pre.order.returnStatus)) return null;

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

  // One ledger entry per expiry schedule (older awards have no `parts`: one entry, store-wide expiry).
  const parts = Array.isArray(award.parts) && award.parts.length ? award.parts : null;
  const split = parts
    ? parts.map((p, i) => ({ key: `award:${award.id}:${i}`, points: Math.floor(p.points * keep), days: p.expiryDays || 0 })).filter((p) => p.points > 0)
    : [{ key: `award:${award.id}`, points, days: settings?.expiryDays ?? 0 }];
  if (!split.length) {
    await prisma.pointsAward.update({ where: { id: awardId }, data: { status: "CANCELLED", releasedAt: null } });
    return null;
  }
  const results = [];
  try {
    for (const p of split) {
      results.push(
        await postTransaction({
          storeId: award.storeId,
          customerId: award.customerId,
          type: "EARN",
          points: p.points,
          source: "order",
          idempotencyKey: p.key,
          orderId: award.orderId,
          expiresAt: expiryDate(p.days),
          note: `Order ${award.order.orderName ?? award.order.shopifyOrderId}`,
        })
      );
    }
  } catch (e) {
    // Posting failed: put the award back so the job retry / sweeper can try again (keys make it safe).
    await prisma.pointsAward.updateMany({ where: { id: awardId, status: "RELEASED" }, data: { status: "PENDING", releasedAt: null } });
    throw e;
  }
  const result = results[results.length - 1];
  const earliestExpiry = results.map((r) => r.transaction.expiresAt).filter(Boolean).sort((p, q) => p - q)[0];
  const creditedTotal = split.reduce((sum, p) => sum + p.points, 0);

  // Email only if at least one of the purchase rules has its "email the customer" switch on.
  const purchaseRules = await prisma.earnRule.findMany({
    where: { storeId: award.storeId, active: true, type: { in: ["PURCHASE_PER_CURRENCY", "PURCHASE_FIXED", "ORDER_MILESTONE"] } },
    select: { notify: true },
  });
  const notifyOn = purchaseRules.length === 0 || purchaseRules.some((r) => r.notify);
  if (results.some((r) => !r.duplicate) && notifyOn) {
    await notifyCustomer({
      storeId: award.storeId,
      customerId: award.customerId,
      kind: "points_earned",
      dedupeKey: `earned:${award.id}`,
      data: {
        points: creditedTotal,
        balance: result.transaction.balanceAfter,
        reason: `your order ${award.order.orderName ?? ""} earned points`.replace("  ", " "),
        expiresAt: earliestExpiry ? earliestExpiry.toISOString().slice(0, 10) : null,
      },
    });
  }
  // A friend's first qualifying order pays out the referral. Idempotent, so it also runs on a
  // retried release; never fail the award over it.
  await maybeRewardReferral(award, award.order).catch((e) => console.error("[referral] payout failed", e.message));
  return result.transaction;
}

/**
 * Release every award whose hold has ended. Run by the scheduler when one is due, at start (anything
 * that came due while the app was away) and in the 6-hourly maintenance pass.
 * Awards held by an open return are left out of the query (they resume when the return ends), and
 * one that errors is tried once per run, so this always finishes.
 */
export async function releaseDueAwards({ storeId = null } = {}) {
  let released = 0;
  const tried = new Set();
  for (let pass = 0; pass < 25; pass += 1) {
    const due = await prisma.pointsAward.findMany({
      where: {
        status: "PENDING",
        releaseAt: { lte: new Date() },
        OR: [{ order: { returnStatus: null } }, { order: { returnStatus: { notIn: RETURN_ON_HOLD } } }],
        ...(storeId ? { storeId } : {}),
      },
      orderBy: { releaseAt: "asc" },
      select: { id: true },
      take: 200,
    });
    const fresh = due.filter((a) => !tried.has(a.id));
    if (!fresh.length) break;
    for (const a of fresh) {
      tried.add(a.id);
      try {
        if (await releaseAward(a.id)) released += 1;
      } catch (e) {
        console.error("[scheduler] release failed", a.id, e.message);
      }
    }
  }
  return released;
}

/** Account just created/linked: attach guest orders and award points they now qualify for. */
export async function claimAndEvaluate(store, customer) {
  const claimed = await claimGuestOrders(customer);
  for (const o of claimed) {
    const fresh = await prisma.order.findUnique({ where: { id: o.id } });
    await evaluateOrder(store, { ...fresh, customerId: customer.id });
  }
}
