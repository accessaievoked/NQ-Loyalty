import prisma from "../db.server.js";

/**
 * customers/redact: erase one shopper from one store.
 *
 * Found by Shopify customer id AND by email, because someone who only ever signed in with an email
 * code has no Shopify id. Their ledger, redemptions, referrals and login sessions go with the
 * account (cascade). Email addresses that live elsewhere are erased too: on orders (the order row
 * itself stays for the merchant's accounting), in the sent-email log, and in pending login codes.
 */
export async function redactCustomer(storeId, { id, email } = {}) {
  const mail = String(email || "").trim().toLowerCase();
  const match = [...(id ? [{ shopifyCustomerId: String(id) }] : []), ...(mail ? [{ email: mail }] : [])];
  if (!match.length) return { customers: 0 };

  const found = await prisma.customer.findMany({ where: { storeId, OR: match }, select: { id: true, email: true } });
  const ids = found.map((c) => c.id);
  const emails = [...new Set([mail, ...found.map((c) => c.email)].filter(Boolean))];
  const byEmail = (field) => (emails.length ? [{ [field]: { in: emails } }] : []);

  await prisma.$transaction([
    prisma.order.updateMany({ where: { storeId, OR: [{ customerId: { in: ids } }, ...byEmail("email")] }, data: { email: null } }),
    prisma.notification.deleteMany({ where: { storeId, OR: [{ customerId: { in: ids } }, ...byEmail("toEmail")] } }),
    ...(emails.length ? [prisma.otpChallenge.deleteMany({ where: { storeId, email: { in: emails } } })] : []),
    prisma.customer.deleteMany({ where: { id: { in: ids } } }),
  ]);
  return { customers: ids.length };
}
