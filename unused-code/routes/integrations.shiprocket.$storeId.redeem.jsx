import { unauthenticated } from "../shopify.server";
import { authenticateFastCheckout, fastCheckoutJson as json, redeemForCheckout } from "../services/fastcheckout.server";
import { RedeemError } from "../services/redeem.server";

// POST /integrations/shiprocket/:storeId/redeem   { phone?, email?, rewardId, points?, requestId }
// Spends the points and returns a single-use Shopify discount code for the checkout to apply.
// `requestId` makes a retry safe: the same id always returns the same code and never spends twice.
// → { ok, code, rewardName, pointsSpent, discountAmount, currency, expiresAt, balance }
export const action = async ({ request, params }) => {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const auth = await authenticateFastCheckout(request, params.storeId, "redeem");
  if (auth instanceof Response) return auth;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  if (!body?.phone && !body?.email) return json({ error: "Send a phone or an email" }, 400);

  try {
    const { admin } = await unauthenticated.admin(auth.store.shop);
    const out = await redeemForCheckout({
      store: auth.store,
      admin,
      contact: { phone: body.phone, email: body.email },
      rewardId: body.rewardId,
      points: body.points,
      requestId: body.requestId,
    });
    return json(out);
  } catch (e) {
    if (e instanceof RedeemError) return json({ error: e.message }, e.status);
    console.error("[fast-checkout redeem]", e);
    return json({ error: "Something went wrong" }, 500);
  }
};

export const loader = () => json({ error: "Method not allowed" }, 405);
