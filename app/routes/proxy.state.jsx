import { buildStorefrontState } from "../services/storefront.server";
import { maybeSweep } from "../services/sweep.server";
import { proxyContext, reply, resolveCustomer } from "../services/proxy.server";

// /apps/loyalty/state — everything the storefront widget needs for this visitor.
// GET works for store-account shoppers (Shopify signs the customer id). Visitors using the
// email-code login POST their session token in the body so it never appears in a URL.
async function handle(request) {
  maybeSweep();
  const ctx = await proxyContext(request);
  const { customer, via } = await resolveCustomer(ctx);
  const state = await buildStorefrontState({ store: ctx.store, customer, via });
  return reply({ mode: state.mode, config: state.config, state: state.state });
}

export const loader = ({ request }) => handle(request);
export const action = ({ request }) => handle(request);
