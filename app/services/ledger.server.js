// Points ledger. Everything that changes a balance goes through `postTransaction`.
//
// Guarantees:
//  - Append-only: each change is a PointsTransaction row with the resulting balance.
//  - Idempotent: (storeId, idempotencyKey) is unique, so retried webhooks/jobs never double-post.
//  - Serialised per customer: the customer row is locked (SELECT … FOR UPDATE) inside the
//    transaction, so concurrent redeem/earn calls can't overspend.
//  - FIFO expiry: credits are "lots" with a `remaining` counter; debits consume the lots that
//    expire first, and the expiry job only expires what is left.
//
// Plain ESM with explicit .js imports so the BullMQ worker can import it directly.
import prisma from "../db.server.js";

export class InsufficientPointsError extends Error {
  constructor() {
    super("Not enough points");
    this.name = "InsufficientPointsError";
  }
}

const isUniqueViolation = (e) => e?.code === "P2002";

/**
 * @param {object} p
 * @param {string} p.storeId
 * @param {string} p.customerId
 * @param {"EARN"|"REDEEM"|"EXPIRE"|"REVERSAL"|"ADJUST"} p.type
 * @param {number} p.points            signed integer (credit > 0, debit < 0)
 * @param {string} p.idempotencyKey
 * @param {Date|null} [p.expiresAt]    only meaningful for credits
 * @param {boolean} [p.allowNegative]  let the balance dip below zero (refund reversals)
 * @returns {{transaction, duplicate: boolean}}
 */
export async function postTransaction(p, db = prisma) {
  if (!Number.isInteger(p.points) || p.points === 0) {
    throw new Error("points must be a non-zero integer");
  }

  const run = async (tx) => {
    const locked = await tx.$queryRaw`
      SELECT "id", "pointsBalance" FROM "Customer"
      WHERE "id" = ${p.customerId} AND "storeId" = ${p.storeId} FOR UPDATE`;
    if (locked.length === 0) throw new Error("Customer not found in this store");

    const existing = await tx.pointsTransaction.findUnique({
      where: { storeId_idempotencyKey: { storeId: p.storeId, idempotencyKey: p.idempotencyKey } },
    });
    if (existing) return { transaction: existing, duplicate: true };

    const balance = locked[0].pointsBalance;
    if (p.points < 0) {
      const want = -p.points;
      if (!p.allowNegative && balance < want) throw new InsufficientPointsError();

      // Consume lots, earliest expiry first (no-expiry lots last).
      const lots = await tx.pointsTransaction.findMany({
        where: { customerId: p.customerId, remaining: { gt: 0 } },
        orderBy: [{ expiresAt: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }],
      });
      let left = want;
      for (const lot of lots) {
        if (left === 0) break;
        const take = Math.min(lot.remaining, left);
        await tx.pointsTransaction.update({
          where: { id: lot.id },
          data: { remaining: { decrement: take } },
        });
        left -= take;
      }
    }

    const balanceAfter = balance + p.points;
    const created = await tx.pointsTransaction.create({
      data: {
        storeId: p.storeId,
        customerId: p.customerId,
        type: p.type,
        points: p.points,
        balanceAfter,
        remaining: p.points > 0 ? p.points : 0,
        expiresAt: p.points > 0 ? (p.expiresAt ?? null) : null,
        source: p.source ?? null,
        idempotencyKey: p.idempotencyKey,
        orderId: p.orderId ?? null,
        redemptionId: p.redemptionId ?? null,
        note: p.note ?? null,
      },
    });
    await tx.customer.update({
      where: { id: p.customerId },
      data: {
        pointsBalance: balanceAfter,
        ...(p.type === "EARN" && p.points > 0 ? { lifetimePoints: { increment: p.points } } : {}),
      },
    });
    return { transaction: created, duplicate: false };
  };

  try {
    // Joining an outer interactive transaction if one was passed in.
    return typeof db.$transaction === "function"
      ? await db.$transaction(run, { timeout: 15000, maxWait: 10000 })
      : await run(db);
  } catch (e) {
    if (isUniqueViolation(e)) {
      const existing = await prisma.pointsTransaction.findUnique({
        where: { storeId_idempotencyKey: { storeId: p.storeId, idempotencyKey: p.idempotencyKey } },
      });
      if (existing) return { transaction: existing, duplicate: true };
    }
    throw e;
  }
}

export const expiryDate = (days, from = new Date()) =>
  days > 0 ? new Date(from.getTime() + days * 86400000) : null;

/** Expire every lot whose expiry date has passed. Safe to run repeatedly. */
export async function expireDuePoints(now = new Date()) {
  const lots = await prisma.pointsTransaction.findMany({
    where: { remaining: { gt: 0 }, expiresAt: { lte: now } },
    select: { id: true, storeId: true, customerId: true },
    take: 500,
  });
  let expired = 0;
  for (const lot of lots) {
    await prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Customer" WHERE "id" = ${lot.customerId} FOR UPDATE`;
        const fresh = await tx.pointsTransaction.findUnique({ where: { id: lot.id } });
        if (!fresh || fresh.remaining <= 0) return;
        const customer = await tx.customer.findUnique({ where: { id: lot.customerId } });
        const balanceAfter = customer.pointsBalance - fresh.remaining;
        await tx.pointsTransaction.create({
          data: {
            storeId: lot.storeId,
            customerId: lot.customerId,
            type: "EXPIRE",
            points: -fresh.remaining,
            balanceAfter,
            idempotencyKey: `expire:${lot.id}`,
            note: "Points expired",
          },
        });
        await tx.pointsTransaction.update({ where: { id: lot.id }, data: { remaining: 0 } });
        await tx.customer.update({ where: { id: lot.customerId }, data: { pointsBalance: balanceAfter } });
        expired += 1;
      },
      { timeout: 15000 },
    ).catch((e) => {
      if (!isUniqueViolation(e)) throw e;
    });
  }
  return expired;
}
