import { authenticate } from "../shopify.server";
import { ensureStore } from "./store.server";

/**
 * Every merchant route starts here. The store is derived from the verified Shopify session,
 * never from a URL/body parameter, so one shop can't read or write another shop's data.
 */
export async function requireStore(request) {
  const { admin, session } = await authenticate.admin(request);
  const store = await ensureStore(session, admin);
  return { admin, session, store };
}
