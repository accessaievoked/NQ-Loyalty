import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// Key for encrypting third-party credentials at rest. Prefer a dedicated APP_ENCRYPTION_KEY;
// fall back to the Shopify API secret so a fresh install works without extra setup.
function key() {
  const material = process.env.APP_ENCRYPTION_KEY || process.env.SHOPIFY_API_SECRET;
  if (!material) throw new Error("Set APP_ENCRYPTION_KEY (or SHOPIFY_API_SECRET) to store integration credentials");
  return createHash("sha256").update(`loyalty:enc:${material}`).digest();
}

/** AES-256-GCM → "iv.tag.ciphertext" (base64url). */
export function encrypt(plain) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([c.update(String(plain), "utf8"), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString("base64url")).join(".");
}

export function decrypt(payload) {
  if (!payload) return null;
  const [iv, tag, enc] = payload.split(".").map((p) => Buffer.from(p, "base64url"));
  const d = createDecipheriv("aes-256-gcm", key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString("utf8");
}

const pepper = () => {
  const p = process.env.APP_ENCRYPTION_KEY || process.env.SHOPIFY_API_SECRET;
  // Fail closed in production: a known pepper would make leaked OTP hashes brute-forceable.
  if (!p && process.env.NODE_ENV === "production") throw new Error("Set APP_ENCRYPTION_KEY");
  return p || "dev-only-pepper";
};

/** One-way hash for OTP codes (HMAC so a leaked table can't be brute-forced offline cheaply). */
export const hashCode = (storeId, email, code) =>
  createHmac("sha256", pepper()).update(`${storeId}:${email}:${code}`).digest("hex");

/** Session tokens are 256-bit random values; a plain SHA-256 of them is enough. */
export const hashToken = (token) => createHash("sha256").update(token).digest("hex");

export const newToken = (bytes = 32) => randomBytes(bytes).toString("base64url");

export function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ""));
  const y = Buffer.from(String(b ?? ""));
  return x.length === y.length && timingSafeEqual(x, y);
}
