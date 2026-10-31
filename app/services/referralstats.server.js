import prisma from "../db.server.js";

const num = (v) => Number(v ?? 0) || 0;
const nameOf = (c) => [c.firstName, c.lastName].filter(Boolean).join(" ") || c.email || "Member";

/**
 * Referral picture for one customer, in the STORE's currency (callers convert for display):
 *  - who they referred, each friend's status and what that friend has spent;
 *  - who referred them;
 *  - totals, including the revenue those friends brought in.
 * Revenue = merchandise value after discounts (no shipping/tax) of the friends' orders, minus
 * refunds, ignoring cancelled and returned orders.
 */
export async function customerReferralStats(storeId, customerId) {
  const [made, received] = await Promise.all([
    prisma.referral.findMany({
      where: { storeId, referrerId: customerId },
      orderBy: { createdAt: "desc" },
      include: { referee: { select: { id: true, firstName: true, lastName: true, email: true, createdAt: true } } },
    }),
    prisma.referral.findUnique({
      where: { refereeId: customerId },
      include: { referrer: { select: { id: true, firstName: true, lastName: true, email: true } } },
    }),
  ]);

  const ids = made.map((r) => r.refereeId);
  const [spend, payouts] = await Promise.all([
    ids.length
      ? prisma.order.groupBy({
          by: ["customerId"],
          where: { storeId, customerId: { in: ids }, cancelledAt: null, returnedAt: null },
          _sum: { eligibleAmount: true, refundedAmount: true },
          _count: true,
        })
      : [],
    made.length
      ? prisma.pointsTransaction.findMany({
          where: { storeId, customerId, idempotencyKey: { in: made.map((r) => `referral-referrer:${r.id}`) } },
          select: { idempotencyKey: true, points: true },
        })
      : [],
  ]);
  const spendBy = new Map(spend.map((s) => [s.customerId, s]));
  const paid = new Map(payouts.map((p) => [p.idempotencyKey, p.points]));

  const friends = made.map((r) => {
    const s = spendBy.get(r.refereeId);
    return {
      id: r.referee.id,
      name: nameOf(r.referee),
      email: r.referee.email,
      status: r.status,
      joined: r.createdAt.toISOString().slice(0, 10),
      orders: s?._count ?? 0,
      revenue: Math.max(0, num(s?._sum.eligibleAmount) - num(s?._sum.refundedAmount)),
      pointsEarned: paid.get(`referral-referrer:${r.id}`) ?? 0,
    };
  });

  return {
    referredBy: received ? { id: received.referrer.id, name: nameOf(received.referrer), status: received.status } : null,
    friends,
    totals: {
      referred: friends.length,
      rewarded: friends.filter((f) => f.status === "REWARDED").length,
      orders: friends.reduce((s, f) => s + f.orders, 0),
      revenue: friends.reduce((s, f) => s + f.revenue, 0),
      pointsEarned: friends.reduce((s, f) => s + f.pointsEarned, 0),
    },
  };
}

/** Referral counts per customer, for the customers list. */
export async function referralCounts(storeId, customerIds) {
  if (!customerIds.length) return new Map();
  const rows = await prisma.referral.groupBy({
    by: ["referrerId"],
    where: { storeId, referrerId: { in: customerIds } },
    _count: true,
  });
  return new Map(rows.map((r) => [r.referrerId, r._count]));
}

/**
 * Revenue from everyone who joined through a referral, in the store currency (all referrers).
 * `range` is optional: { since, until } limits it to orders placed in that window.
 */
export async function totalReferralRevenue(storeId, range = {}) {
  const { since = null, until = null } = range instanceof Date ? { since: range } : range;
  const refs = await prisma.referral.findMany({ where: { storeId }, select: { refereeId: true } });
  if (!refs.length) return { revenue: 0, orders: 0, customers: 0 };
  const agg = await prisma.order.aggregate({
    where: {
      storeId,
      customerId: { in: refs.map((r) => r.refereeId) },
      cancelledAt: null,
      returnedAt: null,
      ...(since || until ? { createdAt: { ...(since ? { gte: since } : {}), ...(until ? { lte: until } : {}) } } : {}),
    },
    _sum: { eligibleAmount: true, refundedAmount: true },
    _count: true,
  });
  return {
    revenue: Math.max(0, num(agg._sum.eligibleAmount) - num(agg._sum.refundedAmount)),
    orders: agg._count,
    customers: refs.length,
  };
}
