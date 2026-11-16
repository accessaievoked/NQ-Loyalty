import prisma from "../db.server";
import { authenticateIntegrationWebhook } from "../services/integrations.server";
import { handleOrderWebhook } from "../services/fastrrLoyalty.server";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

// POST /integrations/shiprocket/:storeId/order-webhook?token=…
// Shiprocket/fastrr's "Order" webhook: how a checkout we blocked points for ended up. `status:
// "SUCCESS"` confirms the debit; anything else (failed, cancelled, …) releases the points. The doc
// sends no auth header for this one, so the secret travels in the URL's ?token= — register this
// exact URL (with the token) as the webhook, not a bare one.
export const action = async ({ request, params }) => {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const auth = await authenticateIntegrationWebhook(request, "SHIPROCKET", params.storeId);
  if (auth instanceof Response) return auth;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  try {
    const store = await prisma.store.findUnique({ where: { id: params.storeId } });
    if (!store) return json({ error: "Unauthorized" }, 401);
    await handleOrderWebhook(store, body);
    await prisma.integration.update({ where: { id: auth.integration.id }, data: { lastEventAt: new Date() } }).catch(() => {});
    return json({ ok: true });
  } catch (e) {
    console.error("[fastrr order webhook]", e);
    return json({ error: "Something went wrong" }, 500);
  }
};

export const loader = () => json({ error: "Method not allowed" }, 405);
