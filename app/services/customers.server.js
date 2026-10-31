import prisma from "../db.server.js";
import { creditPoints } from "./credit.server.js";

// Identity rules
//  1. A loyalty account is keyed by (store, Shopify customer id). One per customer per store.
//  2. Email is only a supporting signal: guest orders are attached to an account by email
//     ONLY when Shopify reports that email as verified for the customer.
//  3. A different Shopify id never merges into an existing account, even if the email matches.

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

export async function upsertCustomer(storeId, input) {
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
    if (byEmail && !byEmail.shopifyCustomerId && byEmail.emailVerified) {
      return prisma.customer.update({
        where: { id: byEmail.id },
        data: {
          shopifyCustomerId: toStr(c.shopifyCustomerId),
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
  await grantSignupBonus(customer);
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
  });
}

/** Find an account for an order: by Shopify id first, then verified email for guests. */
export async function resolveOrderCustomer(storeId, order) {
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
