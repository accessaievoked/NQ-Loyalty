import { randomBytes } from "node:crypto";
import prisma from "../db.server.js";
import { postTransaction } from "./ledger.server.js";
import { creditPoints } from "./credit.server.js";

// Referral rules
//  - Every member has one shareable code.
//  - A new customer can apply ONE code, once, and only before their first order.
//  - Nothing is paid when the code is applied. When the friend's first order is credited and
//    is large enough, the friend and the referrer are each paid ONCE (Referral is unique per
//    friend, and the payout is claimed atomically).
//  - If that order is later cancelled or fully refunded, both rewards are reversed.

export class ReferralError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I

function makeCode(customer) {
  const name = (customer.firstName || "").replace(/[^a-z]/gi, "").toUpperCase().slice(0, 5);
  let tail = "";
  const bytes = randomBytes(5);
  for (const b of bytes) tail += ALPHABET[b % ALPHABET.length];
  return `${name}${tail}`.slice(0, 10);
}

export async function ensureReferralCode(customer) {
  if (customer.referralCode) return customer.referralCode;
  for (let i = 0; i < 5; i++) {
    const code = makeCode(customer);
    try {
      // Only fill an empty slot: a code already handed out must never change, even if this
      // call was made with a stale copy of the customer or two requests race.
      await prisma.customer.updateMany({ where: { id: customer.id, referralCode: null }, data: { referralCode: code } });
    } catch (e) {
      if (e?.code !== "P2002") throw e;
      continue; // that code is taken by someone else: try another
    }
    const fresh = await prisma.customer.findUnique({ where: { id: customer.id } });
    if (fresh?.referralCode) return fresh.referralCode;
  }
  throw new Error("Could not generate a referral code");
}

async function activeRules(storeId) {
  const rules = await prisma.earnRule.findMany({
    where: { storeId, active: true, type: { in: ["REFERRAL_FRIEND", "REFERRAL_REFERRER"] } },
  });
  return {
    friend: rules.find((r) => r.type === "REFERRAL_FRIEND") ?? null,
    referrer: rules.find((r) => r.type === "REFERRAL_REFERRER") ?? null,
  };
}

/** Everything the widget's referral block shows. */
export async function referralInfo(store, customer) {
  const rules = await activeRules(store.id);
  if (!rules.friend && !rules.referrer) return null;

  const [code, mine, received, orders] = await Promise.all([
    ensureReferralCode(customer),
    prisma.referral.findMany({ where: { storeId: store.id, referrerId: customer.id } }),
    prisma.referral.findUnique({ where: { refereeId: customer.id } }),
    prisma.order.count({ where: { storeId: store.id, customerId: customer.id, cancelledAt: null } }),
  ]);
  return {
    code,
    link: `https://${store.shop}/?ref=${code}`,
    friendPoints: rules.friend?.value ?? 0,
    referrerPoints: rules.referrer?.value ?? 0,
    minOrder: Number(rules.referrer?.minOrderAmount ?? rules.friend?.minOrderAmount ?? 0),
    invited: mine.length,
    rewarded: mine.filter((r) => r.status === "REWARDED").length,
    earned: (rules.referrer?.value ?? 0) * mine.filter((r) => r.status === "REWARDED").length,
    canApply: !received && orders === 0,
    applied: !!received,
  };
}

export async function applyReferralCode({ store, customer, code: rawCode }) {
  const rules = await activeRules(store.id);
  if (!rules.friend && !rules.referrer) throw new ReferralError("Referrals aren't turned on for this store");

  const code = String(rawCode ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9]{4,12}$/.test(code)) throw new ReferralError("That code doesn't look right");

  const referrer = await prisma.customer.findUnique({
    where: { storeId_referralCode: { storeId: store.id, referralCode: code } },
  });
  if (!referrer) throw new ReferralError("We couldn't find that code");
  if (referrer.id === customer.id || (referrer.email && referrer.email === customer.email)) {
    throw new ReferralError("You can't use your own code");
  }
  if (await prisma.referral.findUnique({ where: { refereeId: customer.id } })) {
    throw new ReferralError("You've already used a referral code");
  }
  const orders = await prisma.order.count({ where: { storeId: store.id, customerId: customer.id, cancelledAt: null } });
  if (orders > 0) throw new ReferralError("Referral codes are for new customers, before their first order");

  try {
    await prisma.referral.create({ data: { storeId: store.id, referrerId: referrer.id, refereeId: customer.id } });
  } catch (e) {
    if (e?.code === "P2002") throw new ReferralError("You've already used a referral code");
    throw e;
  }
  return { friendPoints: rules.friend?.value ?? 0 };
}

/** Called after a customer's order award is credited. Pays both sides once, if it qualifies. */
export async function maybeRewardReferral(award, order) {
  const referral = await prisma.referral.findFirst({
    where: { refereeId: award.customerId, status: "PENDING" },
  });
  if (!referral) return null;

  const rules = await activeRules(referral.storeId);
  if (!rules.friend && !rules.referrer) return null;
  const min = Number(rules.referrer?.minOrderAmount ?? rules.friend?.minOrderAmount ?? 0);
  const net = Number(order.eligibleAmount) - Number(order.refundedAmount);
  if (net < min || order.cancelledAt) return null;

  const claimed = await prisma.referral.updateMany({
    where: { id: referral.id, status: "PENDING" },
    data: { status: "REWARDED", qualifyingOrderId: order.id, rewardedAt: new Date() },
  });
  if (claimed.count === 0) return null;

  try {
    if (rules.friend) {
      await creditPoints({
        storeId: referral.storeId,
        customerId: referral.refereeId,
        points: rules.friend.value,
        source: "referral",
        key: `referral-friend:${referral.id}`,
        reason: "Referral bonus on your first order",
        orderId: order.id,
      });
    }
    if (rules.referrer) {
      await creditPoints({
        storeId: referral.storeId,
        customerId: referral.referrerId,
        points: rules.referrer.value,
        source: "referral",
        key: `referral-referrer:${referral.id}`,
        reason: "A friend you referred placed their first order",
        orderId: order.id,
      });
    }
  } catch (e) {
    // Credits are idempotent, so releasing the claim lets a later attempt finish the job.
    await prisma.referral.updateMany({
      where: { id: referral.id, status: "REWARDED" },
      data: { status: "PENDING", qualifyingOrderId: null, rewardedAt: null },
    });
    throw e;
  }
  return referral;
}

/** The qualifying order was cancelled or fully refunded: take both rewards back. */
export async function reverseReferralForOrder(orderId) {
  const referral = await prisma.referral.findFirst({ where: { qualifyingOrderId: orderId, status: "REWARDED" } });
  if (!referral) return;
  const claimed = await prisma.referral.updateMany({ where: { id: referral.id, status: "REWARDED" }, data: { status: "REVERSED" } });
  if (claimed.count === 0) return;

  for (const [prefix, customerId] of [
    ["referral-friend", referral.refereeId],
    ["referral-referrer", referral.referrerId],
  ]) {
    const original = await prisma.pointsTransaction.findUnique({
      where: { storeId_idempotencyKey: { storeId: referral.storeId, idempotencyKey: `${prefix}:${referral.id}` } },
    });
    if (!original || original.points <= 0) continue;
    await postTransaction({
      storeId: referral.storeId,
      customerId,
      type: "REVERSAL",
      points: -original.points,
      source: "referral",
      idempotencyKey: `${prefix}-reversal:${referral.id}`,
      allowNegative: true,
      note: "Referral reversed: the order was cancelled or refunded",
    });
  }
}
