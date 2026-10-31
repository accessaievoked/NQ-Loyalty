import { authenticate } from "../shopify.server";
import { markUninstalled } from "../services/store.server";

export const action = async ({ request }) => {
  const { shop, topic } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  // Credentials go immediately; loyalty data is kept until Shopify sends shop/redact (~48h
  // later), which hard-deletes the store and everything under it. Reinstalling in between
  // restores the merchant's program.
  await markUninstalled(shop);

  return new Response();
};
