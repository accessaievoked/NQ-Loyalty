import { authenticateFastCheckout, fastCheckoutJson as json, lookupForCheckout } from "../services/fastcheckout.server";

// POST /integrations/shiprocket/:storeId/lookup   { phone?, email? }
// Called by the fast-checkout server (key in `x-api-key` or `Authorization: Bearer`).
// → { found, customer: { firstName, points }, canRedeem, offers: [...], currency, display: { heading, logoUrl } }
export const action = async ({ request, params }) => {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const auth = await authenticateFastCheckout(request, params.storeId, "lookup");
  if (auth instanceof Response) return auth;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  if (!body?.phone && !body?.email) return json({ error: "Send a phone or an email" }, 400);
  try {
    return json(await lookupForCheckout(auth.store, auth.integration, { phone: body.phone, email: body.email }));
  } catch (e) {
    console.error("[fast-checkout lookup]", e);
    return json({ error: "Something went wrong" }, 500);
  }
};

export const loader = () => json({ error: "Method not allowed" }, 405);
