import { RedeemError, redeemReward } from "../services/redeem.server";
import { proxyContext, reply, resolveCustomer } from "../services/proxy.server";

// POST /apps/loyalty/redeem  { rewardId, requestId, points?, token? }
// The balance check, point debit and Shopify discount creation all happen on the server; the
// browser only says which reward (and how many points) it wants.
export const action = async ({ request }) => {
  if (request.method !== "POST") return reply({ error: "Method not allowed" }, 405);
  const ctx = await proxyContext(request);
  const { customer } = await resolveCustomer(ctx);
  if (!customer) return reply({ error: "Please log in to redeem" }, 401);

  try {
    const redemption = await redeemReward({
      store: ctx.store,
      admin: ctx.admin,
      customerId: customer.id,
      rewardId: String(ctx.body.rewardId || ""),
      requestId: String(ctx.body.requestId || ""),
      points: ctx.body.points,
    });
    return reply({ ok: true, code: redemption.code, rewardName: redemption.rewardName });
  } catch (e) {
    if (e instanceof RedeemError) return reply({ error: e.message }, e.status);
    console.error("[proxy.redeem]", e);
    return reply({ error: "Something went wrong" }, 500);
  }
};
