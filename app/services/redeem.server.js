import { randomBytes, randomUUID } from "node:crypto";
import prisma from "../db.server.js";
import { postTransaction, InsufficientPointsError } from "./ledger.server.js";
import { notifyCustomer } from "./notify.server.js";

export class RedeemError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const makeCode = () => `LOY-${randomBytes(5).toString("hex").toUpperCase()}`;

const CREATE_BASIC = `#graphql
  mutation LoyaltyBasicDiscount($input: DiscountCodeBasicInput!) {
    discountCodeBasicCreate(basicCodeDiscount: $input) {
      codeDiscountNode { id }
      userErrors { field message code }
    }
  }`;

const CREATE_SHIPPING = `#graphql
  mutation LoyaltyShippingDiscount($input: DiscountCodeFreeShippingInput!) {
    discountCodeFreeShippingCreate(freeShippingCodeDiscount: $input) {
      codeDiscountNode { id }
      userErrors { field message code }
    }
  }`;

/**
 * Works out what a redemption costs and is worth. Fixed rewards cost `pointsCost`; custom-amount
 * rewards cost whatever the customer picked, which must be a whole number of steps within the
 * merchant's min/max. All validation lives here — the browser's slider is only a convenience.
 */
export function priceRedemption(reward, requestedPoints) {
  if (reward.type !== "CUSTOM_AMOUNT") {
    return { points: reward.pointsCost, amount: reward.type === "FIXED_AMOUNT" ? Number(reward.value) : null, name: reward.name };
  }
  const step = reward.pointsCost;
  const points = Math.floor(Number(requestedPoints));
  if (!Number.isFinite(points) || points <= 0) throw new RedeemError("Choose how many points to use");
  if (points % step !== 0) throw new RedeemError(`Points must be a multiple of ${step}`);
  const min = Math.max(step, reward.minPoints || 0);
  if (points < min) throw new RedeemError(`Minimum is ${min} points`);
  if (reward.maxPoints && points > reward.maxPoints) throw new RedeemError(`Maximum is ${reward.maxPoints} points per redemption`);
  const amount = Math.round((points / step) * Number(reward.value) * 100) / 100;
  if (amount <= 0) throw new RedeemError("That amount is too small");
  return { points, amount, name: `${reward.name} (${points} points)` };
}

async function createShopifyDiscount(admin, { reward, code, customer, endsAt, amount }) {
  const common = {
    title: `Loyalty: ${reward.name} (${code})`,
    code,
    startsAt: new Date().toISOString(),
    endsAt: endsAt ? endsAt.toISOString() : null,
    // Tied to the Shopify customer when we know them. Email-login members who don't have a store
    // account yet get an unrestricted code — still single-use and unguessable.
    customerSelection: customer.shopifyCustomerId
      ? { customers: { add: [`gid://shopify/Customer/${customer.shopifyCustomerId}`] } }
      : { all: true },
    usageLimit: 1,
    appliesOncePerCustomer: true,
    ...(Number(reward.minOrderAmount) > 0
      ? { minimumRequirement: { subtotal: { greaterThanOrEqualToSubtotal: Number(reward.minOrderAmount).toFixed(2) } } }
      : {}),
  };

  let query, input, path;
  if (reward.type === "FREE_SHIPPING") {
    query = CREATE_SHIPPING;
    path = "discountCodeFreeShippingCreate";
    input = { ...common, destination: { all: true }, combinesWith: { productDiscounts: true, orderDiscounts: true } };
  } else {
    query = CREATE_BASIC;
    path = "discountCodeBasicCreate";
    const value =
      reward.type === "PERCENTAGE"
        ? { percentage: Math.min(1, Number(reward.value) / 100) }
        : { discountAmount: { amount: Number(amount).toFixed(2), appliesOnEachItem: false } };
    input = { ...common, customerGets: { value, items: { all: true } }, combinesWith: { shippingDiscounts: true } };
  }

  const res = await admin.graphql(query, { variables: { input } });
  const json = await res.json();
  if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join("; "));
  const out = json.data?.[path];
  if (out?.userErrors?.length) throw new Error(out.userErrors.map((e) => e.message).join("; "));
  const id = out?.codeDiscountNode?.id;
  if (!id) throw new Error("Shopify did not return a discount id");
  return id;
}

/**
 * Redeem a reward. Points are debited in the same DB transaction that records the redemption,
 * *before* anything is created in Shopify; if Shopify fails the points are refunded through
 * the ledger. `requestId` makes the call idempotent (double-clicks, retries).
 */
export async function redeemReward({ store, admin, customerId, rewardId, requestId, points: requestedPoints }) {
  if (!requestId) throw new RedeemError("Missing request id");

  // A repeated request (double click, network retry) gets the original result back, even though
  // the balance has since dropped. Checked first so the balance checks below can't reject it.
  const replay = await prisma.pointsTransaction.findUnique({
    where: { storeId_idempotencyKey: { storeId: store.id, idempotencyKey: `redeem:${requestId}` } },
  });
  if (replay?.redemptionId) {
    const original = await prisma.redemption.findFirst({ where: { id: replay.redemptionId, storeId: store.id, customerId } });
    if (original) return original;
  }

  const [reward, settings, customer] = await Promise.all([
    prisma.reward.findFirst({ where: { id: rewardId, storeId: store.id, active: true } }),
    prisma.storeSettings.findUnique({ where: { storeId: store.id } }),
    prisma.customer.findFirst({ where: { id: customerId, storeId: store.id } }),
  ]);
  if (!customer) throw new RedeemError("Customer not found", 404);
  if (!reward) throw new RedeemError("Reward is not available", 404);
  const priced = priceRedemption(reward, requestedPoints);
  const minimum = Math.max(priced.points, settings?.minRedeemPoints ?? 0);
  if (customer.pointsBalance < minimum) throw new RedeemError("Not enough points");

  const idemKey = `redeem:${requestId}`;
  const redemptionId = randomUUID();
  const code = makeCode();
  const endsAt = reward.codeValidDays > 0 ? new Date(Date.now() + reward.codeValidDays * 86400000) : null;

  let redemption;
  try {
    redemption = await prisma.$transaction(
      async (tx) => {
        const dup = await tx.pointsTransaction.findUnique({
          where: { storeId_idempotencyKey: { storeId: store.id, idempotencyKey: idemKey } },
        });
        if (dup?.redemptionId) return { existing: await tx.redemption.findUnique({ where: { id: dup.redemptionId } }) };

        await tx.redemption.create({
          data: {
            id: redemptionId,
            storeId: store.id,
            customerId: customer.id,
            rewardId: reward.id,
            rewardName: priced.name,
            rewardType: reward.type,
            discountAmount: priced.amount,
            points: priced.points,
            code,
            expiresAt: endsAt,
          },
        });
        await postTransaction(
          {
            storeId: store.id,
            customerId: customer.id,
            type: "REDEEM",
            source: "redeem",
            points: -priced.points,
            idempotencyKey: idemKey,
            redemptionId,
            note: priced.name,
          },
          tx,
        );
        return { created: true };
      },
      { timeout: 15000 },
    );
  } catch (e) {
    if (e instanceof InsufficientPointsError) throw new RedeemError("Not enough points");
    throw e;
  }

  if (redemption.existing) return redemption.existing; // replayed request
  return finishRedemption({ store, admin, redemptionId, reward, customer, code, endsAt, priced });
}

async function finishRedemption({ store, admin, redemptionId, reward, customer, code, endsAt, priced }) {
  try {
    const shopifyDiscountId = await createShopifyDiscount(admin, { reward, code, customer, endsAt, amount: priced.amount });
    const done = await prisma.redemption.update({
      where: { id: redemptionId },
      data: { status: "ACTIVE", shopifyDiscountId },
    });
    await notifyCustomer({
      storeId: store.id,
      customerId: customer.id,
      kind: "redeemed",
      dedupeKey: `redeemed:${redemptionId}`,
      data: { rewardName: priced.name, code, expiresAt: endsAt?.toISOString().slice(0, 10) },
    });
    return done;
  } catch (e) {
    console.error("[redeem] Shopify discount failed, refunding", redemptionId, e.message);
    await failRedemption(redemptionId, e.message);
    throw new RedeemError("We couldn't create your code. Your points were returned.", 502);
  }
}

/** Mark a redemption failed and give the points back (once). */
export async function failRedemption(redemptionId, reason = "failed") {
  const r = await prisma.redemption.findUnique({ where: { id: redemptionId } });
  if (!r || r.status === "FAILED") return;
  await prisma.redemption.update({ where: { id: redemptionId }, data: { status: "FAILED" } });
  await postTransaction({
    storeId: r.storeId,
    customerId: r.customerId,
    type: "REVERSAL",
    points: r.points,
    idempotencyKey: `redeem-refund:${redemptionId}`,
    redemptionId,
    note: `Redemption failed: ${r.rewardName}`,
  });
  return reason;
}

/** Worker safety net: PENDING redemptions that never reached Shopify get refunded. */
export async function recoverStaleRedemptions() {
  const stale = await prisma.redemption.findMany({
    where: { status: "PENDING", createdAt: { lt: new Date(Date.now() - 5 * 60000) } },
    select: { id: true },
    take: 100,
  });
  for (const r of stale) await failRedemption(r.id, "stale");
  return stale.length;
}

/** Mark ACTIVE codes past their end date as EXPIRED (cosmetic status for the UI). */
export async function expireOldRedemptions() {
  const res = await prisma.redemption.updateMany({
    where: { status: "ACTIVE", expiresAt: { lt: new Date() } },
    data: { status: "EXPIRED" },
  });
  return res.count;
}
