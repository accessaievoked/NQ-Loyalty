import { authenticateFastCheckout, fastCheckoutJson as json } from "../services/fastcheckout.server";
import { unblockPoints } from "../services/fastrrLoyalty.server";

// POST /integrations/shiprocket/:storeId/loyalty/unblock   { order_id }
// Shiprocket/fastrr's "[OPTIONAL] Unblock points" call — releases a block that never turned into an
// order (customer removed points, exited checkout, or changed their number). Safe to call more than
// once, and safe to call for an order_id we never blocked points for.
// → { data: { status: "Success" } }
export const action = async ({ request, params }) => {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const auth = await authenticateFastCheckout(request, params.storeId, "loyalty-unblock");
  if (auth instanceof Response) return auth;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  if (!body?.order_id) return json({ error: "order_id is required" }, 400);

  try {
    const data = await unblockPoints(auth.store, { order_id: body.order_id });
    return json({ data });
  } catch (e) {
    console.error("[fastrr loyalty unblock]", e);
    return json({ error: "Something went wrong" }, 500);
  }
};

export const loader = () => json({ error: "Method not allowed" }, 405);
