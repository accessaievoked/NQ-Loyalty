// Used by both customer-account extensions. Talks to THIS app's server.
//
// The server never trusts the browser: every call carries Shopify's signed session token, which
// proves which customer is signed in. APP_URL is filled in by the Shopify CLI when it bundles the
// extension (the tunnel address in `shopify app dev`, your app URL on deploy).

const APP_URL = (process.env.APP_URL || "").replace(/\/$/, "");

export async function call(action, body = {}) {
  if (!APP_URL) throw new Error("This extension doesn't know the app's address yet. Restart `shopify app dev`.");
  const token = await shopify.sessionToken.get(); // short-lived, so ask for a fresh one every time
  const res = await fetch(`${APP_URL}/customer-account/api`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ action, ...body }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Something went wrong. Please try again.");
  return data;
}

export function money(amount, currency) {
  try {
    return shopify.i18n.formatCurrency(amount, { currency });
  } catch {
    return `${Number(amount).toFixed(2)} ${currency}`;
  }
}

export const newRequestId = () => (globalThis.crypto?.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
