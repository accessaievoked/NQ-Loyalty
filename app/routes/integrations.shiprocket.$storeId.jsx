import { authenticateIntegrationWebhook, handleShiprocketWebhook } from "../services/integrations.server";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// POST /integrations/shiprocket/:storeId?token=…  — Shiprocket tracking webhook.
// The token can also be sent as an `x-api-key` header (Shiprocket's "security token" field).
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
    return json({ ok: true, result: await handleShiprocketWebhook(auth.integration, body) });
  } catch (e) {
    console.error("[shiprocket webhook]", e);
    return json({ error: "Failed" }, 500);
  }
};

// Shiprocket's "test" button may issue a GET; answer it so the URL is accepted.
export const loader = () => json({ ok: true });
