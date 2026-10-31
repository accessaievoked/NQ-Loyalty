import { randomInt } from "node:crypto";
import prisma from "../db.server.js";
import { hashCode, hashToken, newToken, safeEqual } from "../lib/crypto.server.js";
import { sendNotification, smtpConfigured } from "./mailer.server.js";
import { grantSignupBonus, shapeCustomer, upsertCustomer } from "./customers.server.js";
import { claimAndEvaluate } from "./orders.server.js";

// Email-code (OTP) login for shoppers who aren't signed in to a store account.
//
// - The code is 6 digits, valid 10 minutes, single use, max 5 guesses, and only its HMAC is stored.
// - Asking for a code never reveals whether an account exists.
// - Per-email and per-store send limits stop the endpoint being used to spam inboxes.
// - A successful code proves control of the mailbox, so it counts as a verified email: it may
//   link to an existing account with that email (and later to the Shopify customer).
// - The browser keeps an opaque session token; we store only its hash.

export class IdentityError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const OTP_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const SENDS_PER_EMAIL = 3; // per 15 minutes
const SENDS_PER_STORE_HOUR = 300;
export const SESSION_DAYS = 30;

export function normalizeEmail(raw) {
  const email = String(raw ?? "").trim().toLowerCase();
  if (email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(email)) {
    throw new IdentityError("Enter a valid email address");
  }
  return email;
}

export async function requestOtp({ store, email: rawEmail }) {
  const email = normalizeEmail(rawEmail);
  if (!smtpConfigured()) throw new IdentityError("Email login isn't available right now", 503);

  const now = Date.now();
  const [recent, hourly] = await Promise.all([
    prisma.otpChallenge.count({ where: { storeId: store.id, email, createdAt: { gt: new Date(now - 15 * 60000) } } }),
    prisma.otpChallenge.count({ where: { storeId: store.id, createdAt: { gt: new Date(now - 3600000) } } }),
  ]);
  if (recent >= SENDS_PER_EMAIL) throw new IdentityError("Too many codes requested. Please wait a few minutes.", 429);
  if (hourly >= SENDS_PER_STORE_HOUR) throw new IdentityError("Please try again later", 429);

  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const challenge = await prisma.otpChallenge.create({
    data: { storeId: store.id, email, codeHash: hashCode(store.id, email, code), expiresAt: new Date(now + OTP_TTL_MS) },
  });

  try {
    await sendNotification({ store, kind: "otp", to: email, dedupeKey: `otp:${challenge.id}`, data: { code } });
  } catch (e) {
    await prisma.otpChallenge.delete({ where: { id: challenge.id } }).catch(() => {});
    console.error("[otp] email failed", e.message);
    throw new IdentityError("We couldn't send the email. Please try again.", 502);
  }
  return { sent: true };
}

export async function verifyOtp({ store, admin, email: rawEmail, code: rawCode }) {
  const email = normalizeEmail(rawEmail);
  const code = String(rawCode ?? "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(code)) throw new IdentityError("Enter the 6-digit code");

  const challenge = await prisma.otpChallenge.findFirst({
    where: { storeId: store.id, email, consumedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
  });
  if (!challenge) throw new IdentityError("That code has expired. Request a new one.");

  // Count the attempt first, atomically, so parallel guesses can't exceed the limit.
  const counted = await prisma.otpChallenge.updateMany({
    where: { id: challenge.id, consumedAt: null, attempts: { lt: MAX_ATTEMPTS } },
    data: { attempts: { increment: 1 } },
  });
  if (counted.count === 0) throw new IdentityError("Too many wrong attempts. Request a new code.", 429);

  if (!safeEqual(challenge.codeHash, hashCode(store.id, email, code))) throw new IdentityError("That code isn't right");

  const used = await prisma.otpChallenge.updateMany({
    where: { id: challenge.id, consumedAt: null },
    data: { consumedAt: new Date() },
  });
  if (used.count === 0) throw new IdentityError("That code was already used");

  const customer = await findOrCreateByVerifiedEmail(store, admin, email);
  const token = newToken();
  await prisma.loyaltySession.create({
    data: {
      storeId: store.id,
      customerId: customer.id,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + SESSION_DAYS * 86400000),
    },
  });
  await claimAndEvaluate(store, customer).catch((e) => console.warn("[otp] claim failed", e.message));
  return { token, customer };
}

const LOOKUP = `#graphql
  query LoyaltyCustomerByEmail($q: String!) {
    customers(first: 1, query: $q) { nodes { id email phone firstName lastName verifiedEmail } }
  }`;

/** One account per email per store: reuse, else adopt the Shopify customer, else create. */
export async function findOrCreateByVerifiedEmail(store, admin, email) {
  const existing = await prisma.customer.findUnique({ where: { storeId_email: { storeId: store.id, email } } });
  if (existing) {
    return existing.emailVerified
      ? existing
      : prisma.customer.update({ where: { id: existing.id }, data: { emailVerified: true } });
  }

  if (admin) {
    try {
      const res = await admin.graphql(LOOKUP, { variables: { q: `email:"${email.replace(/"/g, "")}"` } });
      const node = (await res.json()).data?.customers?.nodes?.[0];
      if (node && String(node.email).toLowerCase() === email) {
        const customer = await upsertCustomer(store.id, { ...shapeCustomer(node), emailVerified: true });
        if (customer) return customer.emailVerified ? customer : prisma.customer.update({ where: { id: customer.id }, data: { emailVerified: true } });
      }
    } catch (e) {
      console.warn("[otp] Shopify customer lookup failed", e.message);
    }
  }

  try {
    const created = await prisma.customer.create({ data: { storeId: store.id, email, emailVerified: true } });
    await grantSignupBonus(created);
    return created;
  } catch (e) {
    if (e?.code === "P2002") return prisma.customer.findUnique({ where: { storeId_email: { storeId: store.id, email } } });
    throw e;
  }
}

/** The customer behind a browser token, or null. Sliding expiry, updated at most hourly. */
export async function sessionCustomer(storeId, token) {
  if (!token || typeof token !== "string" || token.length > 200) return null;
  const session = await prisma.loyaltySession.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { customer: true },
  });
  if (!session || session.storeId !== storeId) return null;
  if (session.expiresAt < new Date()) {
    await prisma.loyaltySession.delete({ where: { id: session.id } }).catch(() => {});
    return null;
  }
  if (Date.now() - session.lastUsedAt.getTime() > 3600000) {
    await prisma.loyaltySession.update({
      where: { id: session.id },
      data: { lastUsedAt: new Date(), expiresAt: new Date(Date.now() + SESSION_DAYS * 86400000) },
    });
  }
  return session.customer;
}

export async function revokeSession(storeId, token) {
  if (!token) return;
  await prisma.loyaltySession.deleteMany({ where: { storeId, tokenHash: hashToken(token) } });
}

/** Housekeeping for the worker sweep. */
export async function purgeExpiredAuth() {
  const now = new Date();
  const [otp, sessions] = await Promise.all([
    prisma.otpChallenge.deleteMany({ where: { expiresAt: { lt: new Date(now.getTime() - 86400000) } } }),
    prisma.loyaltySession.deleteMany({ where: { expiresAt: { lt: now } } }),
  ]);
  return otp.count + sessions.count;
}
