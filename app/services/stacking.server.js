import prisma from "../db.server.js";
import { RedeemError } from "./redeem.server.js";

// Which reward codes may be held (and so used in one order) at the same time.
//
// Shopify can only say which *kinds* of discount a code combines with, never "this code with that
// one", so the choice is enforced here: before issuing a code we check the customer's unused codes,
// and refuse one that is blocked against any of them. Clashing codes therefore never exist side by
// side. Only applies when the store allows several codes together (StoreSettings.allowStackedCodes).
//
// Default = everything allowed. A pair is blocked if either reward lists the other in
// `noStackWith`; a reward listing its own id can't be held twice.

const now = () => new Date();

/** Throws if `reward` is blocked against a code the customer already holds and hasn't used. */
export async function assertCanHold({ storeId, customerId, reward }) {
  const held = await prisma.redemption.findMany({
    where: {
      storeId,
      customerId,
      status: "ACTIVE",
      rewardId: { not: null },
      OR: [{ expiresAt: null }, { expiresAt: { gt: now() } }],
    },
    select: { rewardId: true, rewardName: true },
  });
  if (!held.length) return;

  const others = await prisma.reward.findMany({
    where: { storeId, id: { in: [...new Set(held.map((h) => h.rewardId))] } },
    select: { id: true, noStackWith: true },
  });
  const theirBlocks = new Map(others.map((o) => [o.id, o.noStackWith || []]));
  const mine = reward.noStackWith || [];

  const clash = held.find((h) => mine.includes(h.rewardId) || (theirBlocks.get(h.rewardId) || []).includes(reward.id));
  if (clash) {
    const same = clash.rewardId === reward.id;
    throw new RedeemError(
      same
        ? `You already have an unused “${clash.rewardName}” code. Use it (or wait for it to expire) before getting another.`
        : `You already have an unused “${clash.rewardName}” code, and it can't be used together with “${reward.name}”. Use it (or wait for it to expire) first.`,
      409,
    );
  }
}

/**
 * Save the combination grid. `allowed` is a Set of "idA|idB" keys (both orders accepted) for pairs
 * that CAN be held together; every other pair of this store's rewards becomes blocked.
 */
export async function saveStackRules(storeId, allowed) {
  const rewards = await prisma.reward.findMany({ where: { storeId }, select: { id: true } });
  const ok = (a, b) => allowed.has(`${a}|${b}`) || allowed.has(`${b}|${a}`);
  const blocked = new Map(rewards.map((r) => [r.id, new Set()]));
  for (let i = 0; i < rewards.length; i += 1) {
    for (let j = i; j < rewards.length; j += 1) {
      const a = rewards[i].id;
      const b = rewards[j].id;
      if (!ok(a, b)) {
        blocked.get(a).add(b);
        blocked.get(b).add(a); // a pair is one decision: both sides record it
      }
    }
  }
  await prisma.$transaction(
    rewards.map((r) => prisma.reward.updateMany({ where: { id: r.id, storeId }, data: { noStackWith: [...blocked.get(r.id)] } })),
  );
}

/** Everything allowed again. */
export async function clearStackRules(storeId) {
  await prisma.reward.updateMany({ where: { storeId }, data: { noStackWith: [] } });
}
