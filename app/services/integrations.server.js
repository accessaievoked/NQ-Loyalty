import { randomBytes } from "node:crypto";
import prisma from "../db.server.js";
import { decrypt, encrypt, safeEqual } from "../lib/crypto.server.js";
import { creditPoints } from "./credit.server.js";
import { cancelOrderPoints, evaluateOrder } from "./orders.server.js";
import { ensureJudgeMeSchedule, removeJudgeMeSchedule } from "../queue/queue.server.js";

// Third-party integrations. Each one is optional, per store, and its credentials are encrypted.
//
//  Judge.me  — customers earn points for good product reviews.
//              Reviews arrive by webhook (when Judge.me can reach us) and by polling every
//              30 minutes (so nothing is missed). Either path is idempotent.
//  Shiprocket — delivery/return status drives when order points are credited or taken back.
//              Shiprocket calls our webhook; we match the shipment to the order by AWB number
//              (copied from the Shopify fulfillment) or by order id.
//
// The exact field names these services send are not fully documented publicly, so parsing is
// deliberately tolerant, and the last event / error is saved for the merchant to see.

const APP_URL = () => (process.env.SHOPIFY_APP_URL || "").replace(/\/$/, "");

export async function getIntegration(storeId, kind) {
  return prisma.integration.findUnique({ where: { storeId_kind: { storeId, kind } } });
}

export async function ensureIntegration(storeId, kind) {
  const found = await getIntegration(storeId, kind);
  if (found) return found;
  try {
    return await prisma.integration.create({
      data: { storeId, kind, webhookToken: randomBytes(24).toString("base64url") },
    });
  } catch (e) {
    if (e?.code === "P2002") return getIntegration(storeId, kind);
    throw e;
  }
}

export const webhookUrl = (kind, integration) =>
  `${APP_URL()}/integrations/${kind.toLowerCase()}/${integration.storeId}?token=${integration.webhookToken}`;

function tokenOk(request, integration) {
  const url = new URL(request.url);
  const header = request.headers.get("x-api-key") || (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  return [url.searchParams.get("token"), header].some((t) => t && safeEqual(t, integration.webhookToken));
}

/** Resolve + authenticate an inbound integration webhook. Returns { integration } or a Response. */
export async function authenticateIntegrationWebhook(request, kind, storeId) {
  const integration = storeId ? await getIntegration(storeId, kind) : null;
  // Same response for "no such store" and "bad token" so ids can't be probed.
  if (!integration || !integration.enabled || !tokenOk(request, integration)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
  }
  return { integration };
}

const record = (id, data) => prisma.integration.update({ where: { id }, data }).catch(() => {});

// ---------------------------------------------------------------------------------------
// Judge.me
// ---------------------------------------------------------------------------------------

const JM = "https://judge.me/api/v1";

export async function connectJudgeMe({ store, apiToken, minRating = 4 }) {
  const token = String(apiToken || "").trim();
  if (token.length < 8) throw new Error("Paste your Judge.me private API token");

  // Prove the token works before saving it.
  const res = await fetch(`${JM}/reviews?${new URLSearchParams({ api_token: token, shop_domain: store.shop, per_page: "1" })}`);
  if (res.status === 401 || res.status === 403) throw new Error("Judge.me rejected that token");
  if (!res.ok) throw new Error(`Judge.me returned ${res.status}. Check the token and try again.`);

  const integration = await ensureIntegration(store.id, "JUDGEME");
  await prisma.integration.update({
    where: { id: integration.id },
    data: {
      enabled: true,
      secretEnc: encrypt(token),
      config: { minRating: Math.min(5, Math.max(1, Number(minRating) || 4)) },
      lastError: null,
    },
  });

  // Best effort: ask Judge.me to push new reviews to us. Polling covers us if this fails.
  if (APP_URL().startsWith("https://")) {
    try {
      await fetch(`${JM}/webhooks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_token: token,
          shop_domain: store.shop,
          key: "review/created",
          url: webhookUrl("JUDGEME", integration),
        }),
      });
    } catch (e) {
      console.warn("[judgeme] webhook registration failed (polling will be used)", e.message);
    }
  }
  await ensureJudgeMeSchedule(); // start polling now that at least one store uses it
  return getIntegration(store.id, "JUDGEME");
}

export async function disconnect(storeId, kind) {
  await prisma.integration.updateMany({ where: { storeId, kind }, data: { enabled: false, secretEnc: null } });
  if (kind === "JUDGEME" && (await countJudgeMeConnected()) === 0) await removeJudgeMeSchedule();
}

export const countJudgeMeConnected = () =>
  prisma.integration.count({ where: { kind: "JUDGEME", enabled: true, secretEnc: { not: null } } });

/** Turn one Judge.me review into points (once). Returns a short outcome string. */
export async function processReview(store, review) {
  const reviewId = review?.id ?? review?.review_id;
  if (!reviewId) return "ignored: no id";

  const rule = await prisma.earnRule.findFirst({ where: { storeId: store.id, type: "REVIEW", active: true } });
  if (!rule) return "ignored: no active review rule";

  const integration = await getIntegration(store.id, "JUDGEME");
  const minRating = Number(integration?.config?.minRating ?? 4);
  const rating = Number(review.rating);
  if (!(rating >= minRating)) return `ignored: rating ${rating} below ${minRating}`;
  if (review.hidden === true || String(review.curated || "").toLowerCase() === "spam") return "ignored: hidden or spam";

  const reviewer = review.reviewer || {};
  const email = String(reviewer.email ?? review.email ?? review.reviewer_email ?? "").trim().toLowerCase();
  const shopifyId = String(reviewer.external_id ?? review.reviewer_external_id ?? "").split("/").pop();

  // Only existing members are paid, and only when we're sure who they are: the Shopify customer id,
  // or an email that was verified (Shopify-verified or confirmed by email code).
  let customer = null;
  if (shopifyId && /^\d+$/.test(shopifyId)) {
    customer = await prisma.customer.findUnique({ where: { storeId_shopifyCustomerId: { storeId: store.id, shopifyCustomerId: shopifyId } } });
  }
  if (!customer && email) {
    customer = await prisma.customer.findFirst({ where: { storeId: store.id, email, emailVerified: true } });
  }
  if (!customer) return "ignored: reviewer is not a verified member";

  const productKey = String(review.product_external_id ?? review.product_id ?? reviewId);
  const result = await creditPoints({
    storeId: store.id,
    customerId: customer.id,
    points: rule.value,
    source: "review",
    // One reward per customer per product, however many times they review it.
    key: `review:${customer.id}:${productKey}`,
    reason: "thank you for your review",
  });
  return result?.duplicate ? "ignored: already rewarded for this product" : `rewarded ${rule.value} points`;
}

/** Pull recent reviews. Used by the 30-minute job and the "Sync now" button. */
export async function syncJudgeMe(integration) {
  const store = await prisma.store.findUnique({ where: { id: integration.storeId } });
  const token = decrypt(integration.secretEnc);
  if (!store || !token) return { processed: 0 };

  let processed = 0;
  let rewarded = 0;
  try {
    // Newest first; stop at the first page that is entirely older than the last sync.
    for (let page = 1; page <= 5; page++) {
      const res = await fetch(`${JM}/reviews?${new URLSearchParams({ api_token: token, shop_domain: store.shop, per_page: "50", page: String(page) })}`);
      if (!res.ok) throw new Error(`Judge.me returned ${res.status}`);
      const reviews = (await res.json()).reviews ?? [];
      if (reviews.length === 0) break;
      let anyNew = false;
      for (const r of reviews) {
        const created = r.created_at ? new Date(r.created_at) : null;
        if (integration.lastSyncAt && created && created < integration.lastSyncAt) continue;
        anyNew = true;
        processed++;
        const outcome = await processReview(store, r);
        if (outcome.startsWith("rewarded")) rewarded++;
      }
      if (!anyNew) break;
    }
    await record(integration.id, { lastSyncAt: new Date(), lastError: null });
  } catch (e) {
    await record(integration.id, { lastError: String(e.message).slice(0, 300) });
    throw e;
  }
  return { processed, rewarded };
}

export async function syncAllJudgeMe() {
  const all = await prisma.integration.findMany({ where: { kind: "JUDGEME", enabled: true, secretEnc: { not: null } } });
  let total = 0;
  for (const i of all) {
    try {
      total += (await syncJudgeMe(i)).rewarded;
    } catch (e) {
      console.warn("[judgeme] sync failed for", i.storeId, e.message);
    }
  }
  return total;
}

export async function handleJudgeMeWebhook(integration, body) {
  const store = await prisma.store.findUnique({ where: { id: integration.storeId } });
  const review = body?.review ?? body;
  const outcome = await processReview(store, review);
  await record(integration.id, { lastEventAt: new Date(), lastError: null });
  return outcome;
}

// ---------------------------------------------------------------------------------------
// Shiprocket
// ---------------------------------------------------------------------------------------

export async function connectShiprocket({ store }) {
  const integration = await ensureIntegration(store.id, "SHIPROCKET");
  await prisma.integration.update({ where: { id: integration.id }, data: { enabled: true, lastError: null } });
  return getIntegration(store.id, "SHIPROCKET");
}

/** Map a Shiprocket status label to what it means for points. */
export function classifyShipment(statusRaw) {
  const s = String(statusRaw ?? "").trim().toLowerCase();
  if (!s) return "unknown";
  // "RTO Delivered" means the parcel went BACK to the seller, so check returns first.
  if (/\brto\b|return(ed)? to (origin|seller)|undelivered|lost|destroyed|cancel(l)?ed|rejected by customer/.test(s)) return "returned";
  if (/^delivered$|\bdelivered\b/.test(s)) return "delivered";
  if (/picked up|shipped|in transit|out for delivery|reached|dispatched|pickup/.test(s)) return "shipped";
  return "other";
}

const stripHash = (v) => String(v ?? "").replace(/^#/, "").trim();

async function findOrderForShipment(storeId, { awb, orderRef }) {
  if (awb) {
    const byAwb = await prisma.order.findFirst({ where: { storeId, trackingNumbers: { has: String(awb) } } });
    if (byAwb) return byAwb;
  }
  const ref = stripHash(orderRef);
  if (ref) {
    return prisma.order.findFirst({
      where: { storeId, OR: [{ shopifyOrderId: ref }, { orderName: `#${ref}` }, { orderName: ref }] },
    });
  }
  return null;
}

export async function handleShiprocketWebhook(integration, body) {
  const store = await prisma.store.findUnique({ where: { id: integration.storeId }, include: { settings: true } });
  const awb = body?.awb ?? body?.awb_code ?? body?.tracking_number;
  const status = body?.current_status ?? body?.shipment_status ?? body?.status;
  const orderRef = body?.order_id ?? body?.channel_order_id ?? body?.sr_order_id;
  const when = body?.current_timestamp ? new Date(String(body.current_timestamp).replace(" ", "T")) : new Date();
  const at = Number.isNaN(when.getTime()) ? new Date() : when;

  await record(integration.id, { lastEventAt: new Date(), lastError: null });
  const kind = classifyShipment(status);
  const order = await findOrderForShipment(store.id, { awb, orderRef });
  if (!order) return `no matching order (awb=${awb ?? "-"}, ref=${orderRef ?? "-"})`;

  const patch = { shipmentStatus: String(status ?? "").slice(0, 80) };
  if (awb && !order.trackingNumbers.includes(String(awb))) patch.trackingNumbers = [...order.trackingNumbers, String(awb)];

  if (kind === "delivered" && !order.returnedAt) {
    // Keep the first delivery time: later "delivered" pings must not push the return window out.
    if (!order.deliveredAt) patch.deliveredAt = at;
  } else if (kind === "returned" && !order.returnedAt) {
    patch.returnedAt = at;
  }

  const updated = await prisma.order.update({ where: { id: order.id }, data: patch });
  if (kind === "returned" && patch.returnedAt) {
    await cancelOrderPoints(store, updated, "Returned");
    return "returned: points cancelled or reversed";
  }
  if (kind === "delivered") {
    const award = await evaluateOrder(store, updated);
    return award ? `delivered: award ${award.status.toLowerCase()}` : "delivered";
  }
  return `status saved: ${status}`;
}
