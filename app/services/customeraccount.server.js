import { createHmac } from "node:crypto";
import { safeEqual } from "../lib/crypto.server.js";

// Requests from the customer-account extensions (the "My Rewards" page and the profile widget)
// arrive with Shopify's session token: a short-lived JWT, signed with this app's secret, that says
// which shop and which customer. We verify it ourselves (HS256) — nothing else identifies the
// customer, so a request without a valid token gets nothing.

export class TokenError extends Error {
  constructor(message) {
    super(message);
    this.name = "TokenError";
  }
}

const b64 = (s) => Buffer.from(s, "base64url");

/**
 * @returns {{ shop: string, customerId: string|null }} customerId is the numeric Shopify id.
 * @throws TokenError
 */
export function verifySessionToken(header, { secret = process.env.SHOPIFY_API_SECRET, apiKey = process.env.SHOPIFY_API_KEY, now = Date.now() } = {}) {
  if (!secret || !apiKey) throw new TokenError("App credentials are not configured");
  const token = String(header ?? "").replace(/^Bearer\s+/i, "").trim();
  const parts = token.split(".");
  if (parts.length !== 3) throw new TokenError("Missing session token");

  let head;
  let payload;
  try {
    head = JSON.parse(b64(parts[0]).toString("utf8"));
    payload = JSON.parse(b64(parts[1]).toString("utf8"));
  } catch {
    throw new TokenError("Malformed session token");
  }
  if (head.alg !== "HS256") throw new TokenError("Unsupported token type");

  const expected = createHmac("sha256", secret).update(`${parts[0]}.${parts[1]}`).digest("base64url");
  if (!safeEqual(expected, parts[2])) throw new TokenError("Invalid session token");

  const sec = now / 1000;
  if (!(payload.exp > sec - 5)) throw new TokenError("Session token expired");
  if (payload.nbf && payload.nbf > sec + 10) throw new TokenError("Session token not valid yet");
  if (payload.aud !== apiKey) throw new TokenError("Session token is for a different app");

  const dest = String(payload.dest ?? "").replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(dest)) throw new TokenError("Session token has no shop");

  const sub = String(payload.sub ?? "");
  const customerId = /^gid:\/\/shopify\/Customer\/(\d+)$/.test(sub) ? sub.split("/").pop() : /^\d+$/.test(sub) ? sub : null;
  return { shop: dest, customerId };
}

export const CORS = {
  // Extensions run on Shopify's CDN origin. The bearer token (not cookies) is the credential,
  // so any origin is fine as long as it presents a valid token.
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

export const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS } });
