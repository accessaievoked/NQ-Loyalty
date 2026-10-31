import { authenticate } from "../shopify.server";
import { getStoreByShop } from "./store.server";
import { sessionCustomer } from "./identity.server";
import { loadShopifyCustomer } from "./storefront.server";

export const reply = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

/**
 * Common setup for every /apps/loyalty/* request.
 * `authenticate.public.appProxy` verifies Shopify's signature, so `shop` and
 * `logged_in_customer_id` can be trusted. Nothing about *who* the visitor is comes from the body
 * except the email-login token, which is checked against our own session table.
 * Throws a Response (returned as-is by React Router) when the request can't be served.
 */
export async function proxyContext(request) {
  const { session, admin } = await authenticate.public.appProxy(request);
  if (!session) throw reply({ error: "App not installed" }, 403);

  const store = await getStoreByShop(session.shop);
  if (!store?.settings) throw reply({ error: "Store not set up" }, 404);

  let body = {};
  if (request.method === "POST") {
    try {
      body = (await request.json()) ?? {};
    } catch {
      body = {};
    }
  }
  const shopifyCustomerId = new URL(request.url).searchParams.get("logged_in_customer_id") || null;
  return { store, admin, shopifyCustomerId, body };
}

/** Who is this visitor? A store-account login wins; otherwise the email-login token. */
export async function resolveCustomer(ctx) {
  if (ctx.shopifyCustomerId) {
    const customer = await loadShopifyCustomer(ctx.store, ctx.admin, ctx.shopifyCustomerId);
    if (customer) return { customer, via: "shopify" };
  }
  const customer = await sessionCustomer(ctx.store.id, ctx.body?.token);
  return customer ? { customer, via: "otp" } : { customer: null, via: null };
}
