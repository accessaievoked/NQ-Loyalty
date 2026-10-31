import prisma from "../db.server.js";
import { getWidgetConfig } from "./store.server.js";
import { shapeCustomer, upsertCustomer } from "./customers.server.js";
import { claimAndEvaluate } from "./orders.server.js";
import { referralInfo } from "./referrals.server.js";

const CUSTOMER_QUERY = `#graphql
  query LoyaltyCustomer($id: ID!) {
    customer(id: $id) {
      id email phone firstName lastName
      verifiedEmail
    }
  }`;

const fmtMoney = (amount, currency) => {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency: currency || "USD", maximumFractionDigits: 2 }).format(amount);
  } catch {
    return `${amount} ${currency}`;
  }
};
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** Extra data the widget needs to draw a points slider for CUSTOM_AMOUNT rewards. */
export function variableOf(r) {
  if (r.type !== "CUSTOM_AMOUNT") return null;
  return {
    step: r.pointsCost,
    unitValue: Number(r.value),
    min: Math.max(r.pointsCost, r.minPoints || 0),
    max: r.maxPoints || null,
  };
}

export function describeReward(r, currency) {
  const v = Number(r.value);
  if (r.type === "CUSTOM_AMOUNT") {
    return `${fmtMoney(v, currency)} for every ${r.pointsCost} points`;
  }
  const base =
    r.type === "FIXED_AMOUNT" ? `${fmtMoney(v, currency)} off` : r.type === "PERCENTAGE" ? `${v}% off` : "Free shipping";
  return Number(r.minOrderAmount) > 0 ? `${base} orders over ${fmtMoney(Number(r.minOrderAmount), currency)}` : base;
}

export function earnLines(rules, settings, currency) {
  const when =
    settings.earnTrigger === "PAID" ? "payment" : settings.earnTrigger === "FULFILLED" ? "fulfilment" : "delivery";
  const timing =
    settings.holdDays > 0
      ? `Credited ${plural(settings.holdDays, "day")} after ${when}`
      : `Credited as soon as the order is ${settings.earnTrigger.toLowerCase()}`;
  return rules
    .filter((r) => r.active)
    .map((r) => {
      if (r.type === "PURCHASE_PER_CURRENCY")
        return { text: "Place an order", detail: `${plural(r.value, "point")} for every ${fmtMoney(1, currency)} spent · ${timing}` };
      if (r.type === "PURCHASE_FIXED")
        return { text: "Place an order", detail: `${plural(r.value, "point")} per order · ${timing}` };
      if (r.type === "REFERRAL_FRIEND")
        return { text: "Use a friend's referral code", detail: `${plural(r.value, "bonus point")} on your first order` };
      if (r.type === "REFERRAL_REFERRER")
        return { text: "Refer a friend", detail: `${plural(r.value, "point")} when their first order is complete` };
      if (r.type === "REVIEW")
        return { text: "Write a product review", detail: `${plural(r.value, "point")} for each product you review` };
      return { text: "Create an account", detail: `${plural(r.value, "point")} welcome bonus` };
    });
}

const LABELS = {
  EARN: "Points earned",
  REDEEM: "Reward redeemed",
  EXPIRE: "Points expired",
  REVERSAL: "Refund adjustment",
  ADJUST: "Adjustment",
};

/** Find (or lazily create) the loyalty account for the signed-in Shopify customer. */
export async function loadShopifyCustomer(store, admin, shopifyCustomerId) {
  let customer = await prisma.customer.findUnique({
    where: { storeId_shopifyCustomerId: { storeId: store.id, shopifyCustomerId } },
  });
  if (customer) return customer;
  try {
    const res = await admin.graphql(CUSTOMER_QUERY, { variables: { id: `gid://shopify/Customer/${shopifyCustomerId}` } });
    const { data } = await res.json();
    if (!data?.customer) return null;
    customer = await upsertCustomer(store.id, shapeCustomer(data.customer));
    if (customer) await claimAndEvaluate(store, customer);
    return customer && (await prisma.customer.findUnique({ where: { id: customer.id } }));
  } catch (e) {
    console.warn("[storefront] customer lookup failed", e.message);
    return null;
  }
}

/**
 * Everything the widget renders for one visitor. `customer` is already resolved and trusted
 * (see proxy.server.js); `via` says how they signed in so the widget can offer the right logout.
 */
export async function buildStorefrontState({ store, customer, via }) {
  const settings = store.settings;
  const currency = store.currency;
  const [rules, rewards] = await Promise.all([
    prisma.earnRule.findMany({ where: { storeId: store.id, active: true }, orderBy: { createdAt: "asc" } }),
    prisma.reward.findMany({ where: { storeId: store.id, active: true }, orderBy: { pointsCost: "asc" } }),
  ]);

  let coupons = [];
  let history = [];
  let referral = null;
  let expiring = null;
  if (customer) {
    referral = await referralInfo(store, customer).catch((e) => {
      console.warn("[storefront] referral info failed", e.message);
      return null;
    });
    const soon = await prisma.pointsTransaction.findMany({
      where: { customerId: customer.id, remaining: { gt: 0 }, expiresAt: { not: null, lte: new Date(Date.now() + 30 * 86400000) } },
      orderBy: { expiresAt: "asc" },
    });
    if (soon.length) {
      expiring = { points: soon.reduce((s, l) => s + l.remaining, 0), date: soon[0].expiresAt.toISOString().slice(0, 10) };
    }
  }
  if (customer) {
    const [reds, txs] = await Promise.all([
      prisma.redemption.findMany({
        // Everything the customer actually received; failed/pending attempts never gave them a code.
        where: { storeId: store.id, customerId: customer.id, status: { in: ["ACTIVE", "USED", "EXPIRED"] } },
        orderBy: { createdAt: "desc" },
        take: 10,
      }),
      prisma.pointsTransaction.findMany({
        where: { customerId: customer.id },
        orderBy: { createdAt: "desc" },
        take: 50,
      }),
    ]);
    // Redeem rows can be opened to see the code they produced. Looked up by id (not just the
    // 10 above) so older redemptions still resolve, and scoped to this customer.
    const redeemIds = txs.map((t) => t.redemptionId).filter(Boolean);
    const byId = new Map(
      (redeemIds.length
        ? await prisma.redemption.findMany({
            where: { id: { in: redeemIds }, storeId: store.id, customerId: customer.id },
            select: { id: true, code: true, status: true, expiresAt: true },
          })
        : []
      ).map((r) => [r.id, r]),
    );
    coupons = reds
      .map((r) => ({
        code: r.code,
        rewardName: r.rewardName,
        status: r.status,
        expiresAt: r.expiresAt ? r.expiresAt.toISOString().slice(0, 10) : null,
      }))
      // usable codes first, then used/expired history
      .sort((a, b) => Number(b.status === "ACTIVE") - Number(a.status === "ACTIVE"));
    history = txs.map((t) => {
      const r = t.type === "REDEEM" ? byId.get(t.redemptionId) : null;
      return {
        label: t.note && t.type !== "EARN" ? `${LABELS[t.type]} · ${t.note}` : t.note || LABELS[t.type],
        points: t.points,
        date: t.createdAt.toISOString().slice(0, 10),
        // Only redemptions that actually produced a code can be opened.
        redeem:
          r && r.code && r.status !== "FAILED" && r.status !== "PENDING"
            ? { code: r.code, status: r.status, expiresAt: r.expiresAt ? r.expiresAt.toISOString().slice(0, 10) : null }
            : null,
      };
    });
  }

  return {
    mode: settings.displayMode,
    config: getWidgetConfig(settings),
    state: {
      shop: { name: store.name || store.shop, currency },
      loggedIn: !!customer,
      via: customer ? via : null,
      customer: customer
        ? {
            firstName: customer.firstName,
            email: customer.email,
            points: customer.pointsBalance,
            lifetime: customer.lifetimePoints,
            expiring,
          }
        : null,
      referral,
      earn: earnLines(rules, settings, currency),
      rewards: rewards.map((r) => ({
        id: r.id,
        name: r.name,
        cost: r.pointsCost,
        description: describeReward(r, currency),
        variable: variableOf(r),
      })),
      coupons,
      history,
    },
  };
}
