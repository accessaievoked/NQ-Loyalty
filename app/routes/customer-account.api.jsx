import { unauthenticated } from "../shopify.server";
import { CORS, TokenError, json, verifySessionToken } from "../services/customeraccount.server";
import { getStoreByShop } from "../services/store.server";
import { buildStorefrontState, loadShopifyCustomer } from "../services/storefront.server";
import { RedeemError, redeemReward } from "../services/redeem.server";
import { ReferralError, applyReferralCode } from "../services/referrals.server";

// POST /customer-account/api  { action: "state" | "redeem" | "referral", … }
// Called by the customer-account extensions with Shopify's session token (Authorization: Bearer).
export const action = async ({ request }) => {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let identity;
  try {
    identity = verifySessionToken(request.headers.get("authorization"));
  } catch (e) {
    if (e instanceof TokenError) return json({ error: e.message }, 401);
    throw e;
  }
  if (!identity.customerId) return json({ error: "Please sign in to see your rewards" }, 401);

  const store = await getStoreByShop(identity.shop);
  if (!store?.settings) return json({ error: "This store isn't set up for rewards yet" }, 404);

  let body = {};
  try {
    body = (await request.json()) ?? {};
  } catch {
    body = {};
  }

  // The offline session lets us create the loyalty account / discount code on Shopify.
  const { admin } = await unauthenticated.admin(identity.shop);
  const customer = await loadShopifyCustomer(store, admin, identity.customerId);
  if (!customer) return json({ error: "We couldn't find your account" }, 404);

  try {
    if (body.action === "redeem") {
      const r = await redeemReward({
        store,
        admin,
        customerId: customer.id,
        rewardId: String(body.rewardId || ""),
        requestId: String(body.requestId || ""),
        points: body.points,
      });
      return json({ ok: true, code: r.code });
    }
    if (body.action === "referral") {
      await applyReferralCode({ store, customer, code: body.code });
      return json({ ok: true });
    }
    // default: the data for the page
    const s = await buildStorefrontState({ store, customer, via: "shopify" });
    return json({ state: s.state });
  } catch (e) {
    if (e instanceof RedeemError || e instanceof ReferralError) return json({ error: e.message }, e.status ?? 400);
    console.error("[customer-account]", e);
    return json({ error: "Something went wrong" }, 500);
  }
};

// Browsers send a preflight (OPTIONS) before the real call; answer it.
export const loader = ({ request }) =>
  request.method === "OPTIONS" ? new Response(null, { status: 204, headers: CORS }) : json({ error: "Method not allowed" }, 405);
