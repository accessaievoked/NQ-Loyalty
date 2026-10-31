import { authenticateIntegrationWebhook, handleJudgeMeWebhook } from "../services/integrations.server";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// POST /integrations/judgeme/:storeId?token=…  — Judge.me "review/created" webhook.
export const action = async ({ request, params }) => {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const auth = await authenticateIntegrationWebhook(request, "JUDGEME", params.storeId);
  if (auth instanceof Response) return auth;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  try {
    return json({ ok: true, result: await handleJudgeMeWebhook(auth.integration, body) });
  } catch (e) {
    console.error("[judgeme webhook]", e);
    return json({ error: "Failed" }, 500); // non-2xx so Judge.me retries
  }
};

export const loader = () => json({ error: "Method not allowed" }, 405);
