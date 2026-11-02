import { authenticate } from "../shopify.server";
import db from "../db.server";
import { deleteStore, getStoreByShop } from "../services/store.server";
import { upsertCustomer, shapeCustomer } from "../services/customers.server";
import { handleReturnWebhook } from "../services/returns.server";
import {
  claimAndEvaluate,
  handleFulfillmentEvent,
  handleFulfillmentUpdate,
  handleOrderEvent,
  handleRefund,
} from "../services/orders.server";

// One endpoint for every non-app webhook topic. Shopify retries on non-2xx, and every handler
// below is idempotent, so a failure here is safe to bubble up as a 500 and be retried.
export const action = async ({ request }) => {
  const { shop, topic, payload, admin } = await authenticate.webhook(request);

  if (topic === "SHOP_REDACT") {
    await deleteStore(shop); // cascades through every table
    return new Response();
  }

  const store = await getStoreByShop(shop);
  if (!store) return new Response(); // not installed / already erased

  switch (topic) {
    case "ORDERS_PAID":
      await handleOrderEvent(store, "orders/paid", payload);
      break;
    case "ORDERS_FULFILLED":
      await handleOrderEvent(store, "orders/fulfilled", payload);
      break;
    case "ORDERS_CANCELLED":
      await handleOrderEvent(store, "orders/cancelled", payload);
      break;
    case "REFUNDS_CREATE":
      await handleRefund(store, payload);
      break;
    case "FULFILLMENT_EVENTS_CREATE":
      await handleFulfillmentEvent(store, payload);
      break;
    case "FULFILLMENTS_CREATE":
    case "FULFILLMENTS_UPDATE":
      await handleFulfillmentUpdate(store, payload);
      break;
    case "RETURNS_REQUEST":
    case "RETURNS_APPROVE":
    case "RETURNS_DECLINE":
    case "RETURNS_CANCEL":
    case "RETURNS_CLOSE":
    case "RETURNS_REOPEN":
      console.log(`[returns] ${topic}:`, await handleReturnWebhook(store, topic, payload, admin));
      break;

    case "CUSTOMERS_CREATE":
    case "CUSTOMERS_UPDATE": {
      const customer = await upsertCustomer(store.id, shapeCustomer(payload));
      if (customer) await claimAndEvaluate(store, customer);
      break;
    }

    case "PRODUCTS_UPDATE": {
      const shopifyProductId = String(payload.id);
      const data = {
        title: payload.title ?? "Untitled",
        handle: payload.handle ?? null,
        status: payload.status ?? null,
        imageUrl: payload.image?.src ?? payload.images?.[0]?.src ?? null,
      };
      await db.product.upsert({
        where: { storeId_shopifyProductId: { storeId: store.id, shopifyProductId } },
        create: { storeId: store.id, shopifyProductId, ...data },
        update: data,
      });
      break;
    }
    case "PRODUCTS_DELETE":
      await db.product.deleteMany({
        where: { storeId: store.id, shopifyProductId: String(payload.id) },
      });
      break;

    case "CUSTOMERS_REDACT": {
      // Erase the shopper's account in this store; ledger/redemptions cascade.
      const id = payload.customer?.id;
      if (id) {
        await db.customer.deleteMany({
          where: { storeId: store.id, shopifyCustomerId: String(id) },
        });
      }
      break;
    }
    case "CUSTOMERS_DATA_REQUEST":
      // Data is exportable by the merchant from the Customers page; nothing to push.
      console.log(`[compliance] data request for ${shop}`);
      break;

    default:
      console.log(`[webhooks] unhandled topic ${topic} for ${shop}`);
  }

  return new Response();
};
