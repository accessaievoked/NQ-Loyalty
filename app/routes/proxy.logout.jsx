import { revokeSession } from "../services/identity.server";
import { proxyContext, reply } from "../services/proxy.server";

// POST /apps/loyalty/logout  { token }  — ends an email-code session. (Store-account logins are
// ended by the shopper's own Shopify logout, which the widget links to.)
export const action = async ({ request }) => {
  if (request.method !== "POST") return reply({ error: "Method not allowed" }, 405);
  const ctx = await proxyContext(request);
  await revokeSession(ctx.store.id, ctx.body.token);
  return reply({ ok: true });
};
