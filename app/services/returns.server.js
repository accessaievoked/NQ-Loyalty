import { handleReturnStatus } from "./orders.server.js";

// Shopify's return webhooks. Each topic IS a state change, so the topic decides the status;
// the payload only has to tell us which order it's about (and if it doesn't, we ask Shopify).

const TOPIC_STATUS = {
  RETURNS_REQUEST: "REQUESTED", // customer asked for a return
  RETURNS_APPROVE: "OPEN", //      merchant approved it: the item is on its way back
  RETURNS_REOPEN: "OPEN",
  RETURNS_DECLINE: "DECLINED", //  merchant refused it
  RETURNS_CANCEL: "CANCELED", //   withdrawn before completion
  RETURNS_CLOSE: "CLOSED", //      finished: the item came back
};

const numeric = (id) => String(id).split("/").pop();

const RETURN_QUERY = `#graphql
  query LoyaltyReturnOrder($id: ID!) { return(id: $id) { id status order { id } } }`;

/** Returns a short description of what happened (for logs and tests). */
export async function handleReturnWebhook(store, topic, payload, admin) {
  const status = TOPIC_STATUS[topic];
  if (!status) return "ignored topic";

  let orderId = payload?.order_id ?? payload?.order?.id ?? payload?.order?.admin_graphql_api_id ?? null;
  const returnGid = payload?.admin_graphql_api_id ?? (String(payload?.id ?? "").startsWith("gid:") ? payload.id : null);

  // The payload shape isn't fully documented, so if the order isn't in it, look the return up.
  if (!orderId && returnGid && admin) {
    try {
      const res = await admin.graphql(RETURN_QUERY, { variables: { id: returnGid } });
      orderId = (await res.json()).data?.return?.order?.id ?? null;
    } catch (e) {
      console.warn("[returns] could not look up the return's order:", e.message);
    }
  }
  if (!orderId) return "ignored: order unknown";
  return handleReturnStatus(store, numeric(orderId), status);
}
