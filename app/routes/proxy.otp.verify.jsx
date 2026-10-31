import { IdentityError, verifyOtp } from "../services/identity.server";
import { proxyContext, reply } from "../services/proxy.server";

// POST /apps/loyalty/otp/verify  { email, code }  → { token }
export const action = async ({ request }) => {
  if (request.method !== "POST") return reply({ error: "Method not allowed" }, 405);
  const ctx = await proxyContext(request);
  try {
    const { token } = await verifyOtp({ store: ctx.store, admin: ctx.admin, email: ctx.body.email, code: ctx.body.code });
    return reply({ ok: true, token });
  } catch (e) {
    if (e instanceof IdentityError) return reply({ error: e.message }, e.status);
    console.error("[otp.verify]", e);
    return reply({ error: "Something went wrong" }, 500);
  }
};
