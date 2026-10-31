import { IdentityError, requestOtp } from "../services/identity.server";
import { proxyContext, reply } from "../services/proxy.server";

// POST /apps/loyalty/otp/request  { email }  → emails a 6-digit code
export const action = async ({ request }) => {
  if (request.method !== "POST") return reply({ error: "Method not allowed" }, 405);
  const ctx = await proxyContext(request);
  try {
    await requestOtp({ store: ctx.store, email: ctx.body.email });
    return reply({ ok: true }); // same answer whether or not an account exists
  } catch (e) {
    if (e instanceof IdentityError) return reply({ error: e.message }, e.status);
    console.error("[otp.request]", e);
    return reply({ error: "Something went wrong" }, 500);
  }
};
