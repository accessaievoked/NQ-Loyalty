import { authenticateFastCheckout, fastCheckoutJson as json } from "../services/fastcheckout.server";
import { blockPoints } from "../services/fastrrLoyalty.server";

// POST /integrations/shiprocket/:storeId/loyalty/block   { mobile_number, transactional_points, order_id }
// Shiprocket/fastrr's "Block Points" call — debits the points for their own order id. Retried calls
// for the same order_id, while it's still blocked, return the original result rather than debiting twice.
// → { data: { status, available_points, message, debited_points, transaction_id, discount_value, additional_properties } }
export const action = async ({ request, params }) => {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const auth = await authenticateFastCheckout(request, params.storeId, "loyalty-block");
  if (auth instanceof Response) return auth;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  if (!body?.mobile_number || !body?.order_id || body?.transactional_points == null) {
    return json({ error: "mobile_number, transactional_points and order_id are required" }, 400);
  }

  try {
    const data = await blockPoints(auth.store, {
      mobile_number: String(body.mobile_number),
      transactional_points: body.transactional_points,
      order_id: body.order_id,
    });
    return json({ data });
  } catch (e) {
    console.error("[fastrr loyalty block]", e);
    return json({ error: "Something went wrong" }, 500);
  }
};

export const loader = () => json({ error: "Method not allowed" }, 405);
