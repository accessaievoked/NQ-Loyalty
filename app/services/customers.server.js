import prisma from "../db.server.js";
import { creditPoints } from "./credit.server.js";
import { verifyRef } from "../lib/crypto.server.js";

// Identity rules
//  1. A loyalty account is keyed by (store, Shopify customer id). One per customer per store.
//  2. Email is only a supporting signal. It links anything to a Shopify customer ONLY when
//     Shopify itself reports that customer's email as verified: guest orders are attached by a
//     verified email, and an email-code account (or an imported one) is merged into a Shopify
//     customer only when Shopify verified that customer's email. A verified inbox on our side
//     is never enough, because it says nothing about who registered the store account.
//  3. A different Shopify id never merges into an existing account, even if the email matches.
//  4. An unverified Shopify customer whose email is already taken gets its own account without
//     that email; their points start from zero and nothing of the other account is visible.

const toStr = (v) => (v === null || v === undefined ? null : String(v));
const num = (gid) => String(gid).split("/").pop();

/** Normalise REST webhook customers and GraphQL customers into one shape. */
export function shapeCustomer(c) {
  if (!c) return null;
  return {
    shopifyCustomerId: num(c.id),
    email: c.email ? String(c.email).toLowerCase() : null,
    emailVerified: !!(c.verified_email ?? c.verifiedEmail ?? false),
    phone: c.phone ?? null,
    firstName: c.first_name ?? c.firstName ?? null,
    lastName: c.last_name ?? c.lastName ?? null,
  };
}

export async function upsertCustomer(storeId, input, { bonus = true } = {}) {
  const c = input.shopifyCustomerId ? input : shapeCustomer(input);
  if (!c?.shopifyCustomerId) return null;

  const where = { storeId_shopifyCustomerId: { storeId, shopifyCustomerId: toStr(c.shopifyCustomerId) } };
  const existing = await prisma.customer.findUnique({ where });
  const data = {
    email: c.email,
    emailVerified: c.emailVerified,
    phone: c.phone,
    firstName: c.firstName,
    lastName: c.lastName,
  };

  if (existing) {
    // Don't wipe good data with a sparse payload (e.g. order webhooks omit fields).
    const patch = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== null && v !== undefined));
    if (Object.keys(patch).length === 0) return existing;
    try {
      return await prisma.customer.update({ where: { id: existing.id }, data: patch });
    } catch (e) {
      // The new email already belongs to another account in this store: keep the old one.
      if (e?.code !== "P2002") throw e;
      delete patch.email;
      delete patch.emailVerified;
      return prisma.customer.update({ where: { id: existing.id }, data: patch });
    }
  }

  // An account created by email login (no Shopify id yet) is the same person once Shopify
  // reports the same email — adopt it instead of creating a second account.
  let email = data.email;
  if (email) {
    const byEmail = await prisma.customer.findUnique({ where: { storeId_email: { storeId, email } } });
    // Merge ONLY when Shopify says this customer owns the address. The old account's email code
    // proves its owner controls the inbox, but proves nothing about whoever just registered a store
    // account with that email: merging on that alone would hand them the old account's points.
    // An unverified Shopify customer falls through to a separate account without the email.
    if (byEmail && !byEmail.shopifyCustomerId && data.emailVerified) {
      return prisma.customer.update({
        where: { id: byEmail.id },
        data: {
          shopifyCustomerId: toStr(c.shopifyCustomerId),
          emailVerified: true,
          phone: data.phone ?? byEmail.phone,
          firstName: data.firstName ?? byEmail.firstName,
          lastName: data.lastName ?? byEmail.lastName,
        },
      });
    }
    if (byEmail) email = null; // email belongs to a different Shopify customer: don't merge them
  }

  let customer;
  try {
    customer = await prisma.customer.create({
      data: { storeId, shopifyCustomerId: toStr(c.shopifyCustomerId), ...data, email },
    });
  } catch (e) {
    if (e?.code === "P2002") return prisma.customer.findUnique({ where });
    throw e;
  }
  if (bonus) await grantSignupBonus(customer);
  return customer;
}

export async function grantSignupBonus(customer) {
  const rule = await prisma.earnRule.findFirst({
    where: { storeId: customer.storeId, type: "SIGNUP", active: true },
  });
  if (!rule || rule.value <= 0) return;
  await creditPoints({
    storeId: customer.storeId,
    customerId: customer.id,
    points: rule.value,
    source: "signup",
    key: `signup:${customer.id}`,
    reason: rule.name || "Welcome bonus",
    notify: rule.notify,
    expiryDays: rule.expiryDays,
  });
}

/**
 * Which loyalty account does an order's points go to?
 *  1. A shopper with a store account (customer.state "enabled", i.e. signed in / registered)
 *     → the account for THEIR email, whatever happened to be open in the widget.
 *  2. A guest checkout where a loyalty account was open in the widget (the storefront put a
 *     signed `loyalty_ref` on the cart) → that open account.
 *  3. Otherwise Shopify's own customer record for the order, then a verified-email match.
 */
export async function resolveOrderCustomer(storeId, order) {
  if (order.customer?.id && order.customer.state === "enabled") {
    return upsertCustomer(storeId, shapeCustomer(order.customer));
  }

  const ref = (order.note_attributes || []).find((a) => a?.name === "loyalty_ref")?.value;
  const refId = ref ? verifyRef(storeId, ref) : null;
  if (refId) {
    const open = await prisma.customer.findFirst({ where: { id: refId, storeId } });
    if (open) return open;
  }

  if (order.customer?.id) {
    return upsertCustomer(storeId, shapeCustomer(order.customer));
  }
  const email = (order.email || order.contact_email || "").toLowerCase();
  if (!email) return null;
  return prisma.customer.findFirst({ where: { storeId, email, emailVerified: true } });
}

/** After an account is created/logs in, attach earlier guest orders placed with its verified email. */
export async function claimGuestOrders(customer) {
  if (!customer.emailVerified || !customer.email) return [];
  const orders = await prisma.order.findMany({
    where: { storeId: customer.storeId, customerId: null, email: customer.email },
  });
  for (const o of orders) {
    await prisma.order.update({ where: { id: o.id }, data: { customerId: customer.id } });
  }
  return orders;
}
