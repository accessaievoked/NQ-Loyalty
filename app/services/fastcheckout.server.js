import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import prisma from "../db.server.js";
import { normalizeEmail } from "./identity.server.js";
import { redeemReward, RedeemError } from "./redeem.server.js";
import { describeReward, variableOf } from "./storefront.server.js";
import { authenticateIntegrationWebhook, ensureIntegration, getIntegration } from "./integrations.server.js";
import { phoneKey } from "../lib/phone.js";

// Fast-checkout apps (Shiprocket Checkout / fastrr) replace the Shopify checkout page, so the
// storefront widget and a pasted discount code never get a chance to run. Instead their server
// calls us, once it has already verified the shopper's phone number:
//
//   POST …/lookup   { phone?, email? }                          → points + what they can redeem
//   POST …/redeem   { phone?, email?, rewardId, points?, requestId } → a real Shopify discount code
//
// The checkout applies the returned code to the order itself. Both calls carry the store's secret
// key; without it nobody can ask about a customer or spend their points. Stored as a Shopify
// "SHIPROCKET" integration so it shares the secret/enable plumbing with the other integrations.

const KIND = "SHIPROCKET";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

export async function getFastCheckout(storeId) {
  return getIntegration(storeId, KIND);
}

const cleanIps = (raw) =>
  String(raw ?? "")
    .split(/[\s,]+/)
    .map((x) => x.trim())
    .filter((x) => isIP(x) !== 0)
    .slice(0, 20);

const cleanText = (v, max) => String(v ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, max);

export async function saveFastCheckout(store, { heading, logoUrl, allowedIps, regenerateKey }) {
  let integration = await ensureIntegration(store.id, KIND);
  const logo = cleanText(logoUrl, 500);
  if (logo && !/^https:\/\//i.test(logo)) throw new Error("The logo must be a full https:// image link");
  const ips = cleanIps(allowedIps);
  // An IP list is only as good as the header it reads. Without a header our own proxy sets, the
  // caller could send any address, so refuse to turn the list on rather than pretend it protects.
  if (ips.length && !trustedIpHeader()) {
    throw new Error(
      "To use an IP list, tell the server which header carries the real caller address: set TRUSTED_IP_HEADER (for example fly-client-ip on Fly, cf-connecting-ip behind Cloudflare, or x-forwarded-for behind one load balancer), then save again.",
    );
  }
  const data = {
    enabled: true,
    config: { heading: cleanText(heading, 60) || "Use your points", logoUrl: logo, allowedIps: ips },
  };
  if (regenerateKey) data.webhookToken = randomBytes(24).toString("base64url");
  integration = await prisma.integration.update({ where: { id: integration.id }, data });
  return integration;
}

export async function disableFastCheckout(storeId) {
  await prisma.integration.updateMany({ where: { storeId, kind: KIND }, data: { enabled: false } });
}

// ---- who is asking ------------------------------------------------------------------------------

// The header our own proxy sets (name in TRUSTED_IP_HEADER). Never read a header the caller can set
// freely: they could send any address and pass the list.
const trustedIpHeader = () => String(process.env.TRUSTED_IP_HEADER || "").trim().toLowerCase();

/** The caller's address as our own proxy saw it, or null when no trusted header is configured. */
export function callerIp(request) {
  const name = trustedIpHeader();
  if (!name) return null;
  const parts = String(request.headers.get(name) || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  // x-forwarded-for grows to the right as it passes proxies, so the LAST entry is the one our proxy
  // added; everything before it was supplied by the caller. Other headers hold a single address.
  return (name === "x-forwarded-for" ? parts[parts.length - 1] : parts[0]) || null;
}

// A leaked key must not be able to hammer the lookup (it answers "does this phone have points").
// Counted in this process: right for one server, and a restart resets it (the secret key is the real
// protection; this only slows a leaked one down).
const hits = new Map();
function limited(storeId, bucket, max) {
  const now = Date.now();
  const key = `${storeId}:${bucket}`;
  const recent = (hits.get(key) || []).filter((t) => now - t < 60_000);
  if (recent.length >= max) {
    hits.set(key, recent);
    return true;
  }
  recent.push(now);
  hits.set(key, recent);
  return false;
}

/** Checks the key (and the allowed IPs, if set) → { integration, store } or a Response to send back. */
export async function authenticateFastCheckout(request, storeId, bucket) {
  const auth = await authenticateIntegrationWebhook(request, KIND, storeId);
  if (auth instanceof Response) return auth;
  const { integration } = auth;

  const allowed = integration.config?.allowedIps || [];
  if (allowed.length) {
    const ip = callerIp(request);
    if (!ip) console.warn("[fast-checkout] IP list is set but TRUSTED_IP_HEADER is not configured: refusing the request");
    if (!ip || !allowed.includes(ip)) return json({ error: "Unauthorized" }, 401);
  }
  if (limited(storeId, bucket, bucket === "redeem" ? 30 : 120)) return json({ error: "Too many requests" }, 429);

  const store = await prisma.store.findUnique({ where: { id: storeId }, include: { settings: true } });
  if (!store?.settings) return json({ error: "Unauthorized" }, 401);
  return { integration, store };
}

// ---- finding the customer -----------------------------------------------------------------------

export { phoneKey };

/** Email wins when both are given; two different people for one request is treated as "not found". */
export async function findCustomerByContact(storeId, { phone, email } = {}) {
  let byEmail = null;
  if (email) {
    try {
      byEmail = await prisma.customer.findUnique({ where: { storeId_email: { storeId, email: normalizeEmail(email) } } });
    } catch {
      byEmail = null;
    }
  }
  let byPhone = null;
  const key = phoneKey(phone);
  if (key) {
    const rows = await prisma.$queryRaw`
      SELECT "id" FROM "Customer"
      WHERE "storeId" = ${storeId} AND "phone" IS NOT NULL
        AND right(regexp_replace("phone", '[^0-9]', '', 'g'), 10) = ${key}
      LIMIT 2`;
    if (rows.length === 1) byPhone = await prisma.customer.findUnique({ where: { id: rows[0].id } });
  }
  if (byEmail && byPhone && byEmail.id !== byPhone.id) return null;
  return byEmail || byPhone;
}

// ---- the two calls ------------------------------------------------------------------------------

function offerOf(r, balance, currency) {
  const variable = variableOf(r);
  const base = {
    id: r.id,
    name: r.name,
    description: describeReward(r, currency),
    type: r.type,
    minOrderAmount: Number(r.minOrderAmount) || 0,
  };
  if (variable) {
    const top = Math.floor(Math.min(balance, variable.max || Infinity) / variable.step) * variable.step;
    return { ...base, variable: { minPoints: variable.min, maxPoints: top, step: variable.step, valuePerStep: variable.unitValue }, affordable: top >= variable.min };
  }
  return { ...base, pointsCost: r.pointsCost, value: Number(r.value), affordable: balance >= r.pointsCost };
}

export async function lookupForCheckout(store, integration, contact) {
  const customer = await findCustomerByContact(store.id, contact);
  const display = { heading: integration.config?.heading || "Use your points", logoUrl: integration.config?.logoUrl || "" };
  if (!customer) return { found: false, display };

  const rewards = await prisma.reward.findMany({ where: { storeId: store.id, active: true }, orderBy: { pointsCost: "asc" } });
  const minPoints = store.settings.minRedeemPoints || 0;
  return {
    found: true,
    display,
    currency: store.currency,
    customer: { firstName: customer.firstName || null, points: customer.pointsBalance },
    canRedeem: customer.pointsBalance > 0 && customer.pointsBalance >= minPoints,
    offers: rewards.map((r) => offerOf(r, customer.pointsBalance, store.currency)),
  };
}

export async function redeemForCheckout({ store, admin, contact, rewardId, points, requestId }) {
  const rid = String(requestId || "").trim();
  if (!/^[\w.:-]{8,100}$/.test(rid)) throw new RedeemError("requestId is required (8–100 letters, digits, - _ . :) so a retry can't spend points twice", 400);
  const customer = await findCustomerByContact(store.id, contact);
  if (!customer) throw new RedeemError("No rewards account found for that phone or email", 404);
  const redemption = await redeemReward({
    store,
    admin,
    customerId: customer.id,
    rewardId: String(rewardId || ""),
    requestId: `checkout:${rid}`,
    points,
    anyCustomer: true,
  });
  return {
    ok: true,
    code: redemption.code,
    rewardName: redemption.rewardName,
    pointsSpent: redemption.points,
    discountAmount: redemption.discountAmount == null ? null : Number(redemption.discountAmount),
    currency: store.currency,
    expiresAt: redemption.expiresAt ? redemption.expiresAt.toISOString() : null,
    balance: (await prisma.customer.findUnique({ where: { id: customer.id }, select: { pointsBalance: true } })).pointsBalance,
  };
}

export { json as fastCheckoutJson };
