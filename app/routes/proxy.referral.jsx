import { ReferralError, applyReferralCode } from "../services/referrals.server";
import { proxyContext, reply, resolveCustomer } from "../services/proxy.server";

// POST /apps/loyalty/referral  { code, token? }  — a new customer applies a friend's code.
export const action = async ({ request }) => {
  if (request.method !== "POST") return reply({ error: "Method not allowed" }, 405);
  const ctx = await proxyContext(request);
  const { customer } = await resolveCustomer(ctx);
  if (!customer) return reply({ error: "Please log in first" }, 401);
  try {
    const result = await applyReferralCode({ store: ctx.store, customer, code: ctx.body.code });
    return reply({ ok: true, ...result });
  } catch (e) {
    if (e instanceof ReferralError) return reply({ error: e.message }, e.status);
    console.error("[referral]", e);
    return reply({ error: "Something went wrong" }, 500);
  }
};
