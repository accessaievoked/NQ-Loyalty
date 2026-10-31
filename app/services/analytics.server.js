import prisma from "../db.server.js";
import { totalReferralRevenue } from "./referralstats.server.js";
import { resolveRange } from "../lib/analytics-ranges.js";

const num = (v) => Number(v ?? 0) || 0;

const SOURCE_LABELS = {
  order: "Orders",
  signup: "Sign-up bonus",
  referral: "Referrals",
  review: "Reviews",
  manual: "Manual adjustments",
  redeem: "Redemptions",
};

const DAY = 86400000;
const startOfDay = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

// Accepts a resolved range ({ since, until, … }) or, for older callers, a number of days / null.
function toRange(arg) {
  if (arg && typeof arg === "object" && "since" in arg) return arg;
  return resolveRange({ range: arg ? `${arg}d` : "all" });
}

/**
 * Everything on the Analytics page, for one store and date range.
 * All queries are scoped by storeId; nothing here reads another store's rows.
 */
export async function loadAnalytics(store, rangeArg, fx = { from: store.currency, to: store.currency, rate: 1, converted: false }) {
  const sid = store.id;
  const m = (v) => num(v) * fx.rate; // money: store currency → reporting currency
  const range = toRange(rangeArg);
  const { since, until } = range;
  const now = new Date();
  const inRange = since || until ? { ...(since ? { gte: since } : {}), ...(until ? { lte: until } : {}) } : undefined;
  const txWhere = { storeId: sid, ...(inRange ? { createdAt: inRange } : {}) };

  // Chart window: the range itself, or the last 90 days for "all time". Long ranges use weekly bars.
  const seriesFrom = since ?? new Date(startOfDay(now).getTime() - 89 * DAY);
  const seriesTo = until ?? now;
  const bucket = seriesTo.getTime() - seriesFrom.getTime() > 120 * DAY ? "week" : "day";

  const [
    totalMembers,
    newMembers,
    outstanding,
    byType,
    bySource,
    redemptions,
    amountRedemptions,
    usedCodes,
    topRewards,
    ordersAll,
    ordersLoyalty,
    referrals,
    topCustomers,
    earnedSeries,
    memberSeries,
  ] = await Promise.all([
    prisma.customer.count({ where: { storeId: sid } }),
    prisma.customer.count({ where: { storeId: sid, ...(inRange ? { createdAt: inRange } : {}) } }),
    prisma.customer.aggregate({ where: { storeId: sid }, _sum: { pointsBalance: true } }),
    prisma.pointsTransaction.groupBy({ by: ["type"], where: txWhere, _sum: { points: true }, _count: true }),
    prisma.pointsTransaction.groupBy({ by: ["source"], where: { ...txWhere, points: { gt: 0 } }, _sum: { points: true }, _count: true }),
    prisma.redemption.aggregate({
      where: { storeId: sid, status: { not: "FAILED" }, ...(inRange ? { createdAt: inRange } : {}) },
      _count: true,
      _sum: { points: true },
    }),
    // Amount-based codes only: percentage and free-shipping have no fixed currency value.
    prisma.redemption.aggregate({
      where: { storeId: sid, status: { not: "FAILED" }, discountAmount: { not: null }, ...(inRange ? { createdAt: inRange } : {}) },
      _sum: { points: true, discountAmount: true },
    }),
    prisma.redemption.count({ where: { storeId: sid, status: "USED", ...(inRange ? { createdAt: inRange } : {}) } }),
    prisma.redemption.groupBy({
      by: ["rewardId"],
      where: { storeId: sid, status: { not: "FAILED" }, ...(inRange ? { createdAt: inRange } : {}) },
      _count: true,
      _sum: { points: true },
      orderBy: { _count: { rewardId: "desc" } },
      take: 5,
    }),
    prisma.order.aggregate({
      where: { storeId: sid, customerId: { not: null }, cancelledAt: null, ...(inRange ? { createdAt: inRange } : {}) },
      _count: true,
      _sum: { eligibleAmount: true },
    }),
    prisma.order.aggregate({
      where: { storeId: sid, cancelledAt: null, loyaltyDiscount: { gt: 0 }, ...(inRange ? { createdAt: inRange } : {}) },
      _count: true,
      _sum: { loyaltyDiscount: true, eligibleAmount: true },
    }),
    prisma.referral.groupBy({ by: ["status"], where: { storeId: sid, ...(inRange ? { createdAt: inRange } : {}) }, _count: true }),
    prisma.customer.findMany({
      where: { storeId: sid },
      orderBy: { lifetimePoints: "desc" },
      take: 5,
      select: { id: true, firstName: true, lastName: true, email: true, pointsBalance: true, lifetimePoints: true },
    }),
    prisma.$queryRaw`
      SELECT to_char(date_trunc(${bucket}, "createdAt"), 'YYYY-MM-DD') AS day,
             COALESCE(SUM(CASE WHEN "points" > 0 THEN "points" ELSE 0 END), 0)::int AS earned,
             COALESCE(SUM(CASE WHEN "type" = 'REDEEM' THEN -"points" ELSE 0 END), 0)::int AS redeemed
      FROM "PointsTransaction"
      WHERE "storeId" = ${sid} AND "createdAt" >= ${seriesFrom} AND "createdAt" <= ${seriesTo}
      GROUP BY 1 ORDER BY 1`,
    prisma.$queryRaw`
      SELECT to_char(date_trunc(${bucket}, "createdAt"), 'YYYY-MM-DD') AS day, COUNT(*)::int AS members
      FROM "Customer"
      WHERE "storeId" = ${sid} AND "createdAt" >= ${seriesFrom} AND "createdAt" <= ${seriesTo}
      GROUP BY 1 ORDER BY 1`,
  ]);

  const rewardNames = new Map(
    (await prisma.reward.findMany({ where: { storeId: sid, id: { in: topRewards.map((r) => r.rewardId).filter(Boolean) } }, select: { id: true, name: true } })).map((r) => [r.id, r.name]),
  );

  const typeSum = (t) => num(byType.find((x) => x.type === t)?._sum.points);
  const issued = bySource.reduce((s, x) => s + num(x._sum.points), 0);
  const expired = Math.abs(typeSum("EXPIRE"));
  const reversed = Math.abs(typeSum("REVERSAL"));
  const spent = Math.abs(typeSum("REDEEM"));

  const referralRevenue = await totalReferralRevenue(sid, { since, until });
  const valuePoints = num(amountRedemptions._sum.points);
  const valueGiven = num(amountRedemptions._sum.discountAmount);
  const redemptionCount = redemptions._count;

  const loyaltyOrders = ordersLoyalty._count;
  const loyaltyRevenue = num(ordersLoyalty._sum.eligibleAmount);

  // Fill empty days/weeks with zeros so the chart has a continuous axis (weeks start on Monday,
  // matching Postgres date_trunc('week')).
  const days_ = [];
  let cursor = startOfDay(seriesFrom);
  if (bucket === "week") cursor = new Date(cursor.getTime() - ((cursor.getUTCDay() + 6) % 7) * DAY);
  const step = bucket === "week" ? 7 * DAY : DAY;
  for (let t = cursor.getTime(); t <= seriesTo.getTime() && days_.length < 400; t += step) days_.push(new Date(t).toISOString().slice(0, 10));
  const earnedBy = new Map(earnedSeries.map((r) => [r.day, r]));
  const membersBy = new Map(memberSeries.map((r) => [r.day, r.members]));

  return {
    currency: fx.to,
    fx: { from: fx.from, to: fx.to, rate: fx.rate, converted: fx.converted, manual: !!fx.manual, stale: !!fx.stale, updatedAt: fx.updatedAt ? new Date(fx.updatedAt).toISOString() : null, error: fx.error ?? null },
    range: { key: range.key, label: range.label, text: range.text, from: range.from, to: range.to },
    bucket,
    members: { total: totalMembers, new: newMembers },
    points: {
      issued,
      spent,
      expired,
      reversed,
      outstanding: num(outstanding._sum.pointsBalance),
      redeemRate: issued > 0 ? spent / issued : 0,
    },
    redemptions: {
      count: redemptionCount,
      used: usedCodes,
      valueGiven: m(valueGiven),
      avgPoints: redemptionCount ? num(redemptions._sum.points) / redemptionCount : 0,
      // What one point is worth in practice, across amount-based redemptions.
      avgCoinValue: valuePoints > 0 ? m(valueGiven / valuePoints) : 0,
    },
    orders: {
      count: ordersAll._count,
      revenue: m(ordersAll._sum.eligibleAmount),
      avgValue: ordersAll._count ? m(num(ordersAll._sum.eligibleAmount) / ordersAll._count) : 0,
      withLoyaltyCode: loyaltyOrders,
      loyaltyDiscount: m(ordersLoyalty._sum.loyaltyDiscount),
      loyaltyAvgValue: loyaltyOrders ? m(loyaltyRevenue / loyaltyOrders) : 0,
    },
    referrals: Object.fromEntries(referrals.map((r) => [r.status, r._count])),
    referralRevenue: { revenue: m(referralRevenue.revenue), orders: referralRevenue.orders, customers: referralRevenue.customers },
    reviewsRewarded: bySource.find((x) => x.source === "review")?._count ?? 0,
    sources: bySource
      .filter((x) => x.source)
      .map((x) => ({ label: SOURCE_LABELS[x.source] ?? x.source, points: num(x._sum.points), count: x._count }))
      .sort((a, b) => b.points - a.points),
    topRewards: topRewards.map((r) => ({
      name: rewardNames.get(r.rewardId) ?? "Deleted reward",
      count: r._count,
      points: num(r._sum.points),
    })),
    topCustomers: topCustomers.map((c) => ({
      id: c.id,
      name: [c.firstName, c.lastName].filter(Boolean).join(" ") || c.email || "Member",
      balance: c.pointsBalance,
      lifetime: c.lifetimePoints,
    })),
    series: days_.map((day) => ({
      day,
      earned: earnedBy.get(day)?.earned ?? 0,
      redeemed: earnedBy.get(day)?.redeemed ?? 0,
      members: membersBy.get(day) ?? 0,
    })),
  };
}
