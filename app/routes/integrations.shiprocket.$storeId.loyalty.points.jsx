import { authenticateFastCheckout, fastCheckoutJson as json } from "../services/fastcheckout.server";
import { fetchLoyaltyPoints } from "../services/fastrrLoyalty.server";

// POST /integrations/shiprocket/:storeId/loyalty/points   { mobile_number, cart_value }
// Shiprocket/fastrr's "Fetch Loyalty Points" call.
// → { data: { mobile_number, available_points, applicable_points } }
export const action = async ({ request, params }) => {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const auth = await authenticateFastCheckout(request, params.storeId, "loyalty-points");
  if (auth instanceof Response) return auth;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  if (!body?.mobile_number) return json({ error: "mobile_number is required" }, 400);

  try {
    const data = await fetchLoyaltyPoints(auth.store, { mobile_number: String(body.mobile_number), cart_value: body.cart_value });
    return json({ data });
  } catch (e) {
    console.error("[fastrr loyalty points]", e);
    return json({ error: "Something went wrong" }, 500);
  }
};

export const loader = () => json({ error: "Method not allowed" }, 405);
