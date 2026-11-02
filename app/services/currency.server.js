import prisma from "../db.server.js";

// Reporting currency.
//
// Orders, rewards and discount codes always use the STORE's currency (that's what Shopify uses).
// Admin reports (analytics, referral revenue) are shown in INR: if the store already sells in
// rupees nothing is converted; otherwise figures are multiplied by a live exchange rate that is
// refreshed once a day. Set REPORT_CURRENCY in the environment to report in something else.
// Customers always see the store's own currency, never a converted one.

export const REPORT_CURRENCY = () => (process.env.REPORT_CURRENCY || "INR").toUpperCase();

const MAX_AGE_MS = 24 * 3600 * 1000;
const RATE_URL = (from) => `https://open.er-api.com/v6/latest/${encodeURIComponent(from)}`;

/** Live rate from a free, key-less public API. Returns a number or throws. */
export async function fetchRate(from, to) {
  const res = await fetch(RATE_URL(from), { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`rate service returned ${res.status}`);
  const json = await res.json();
  const rate = Number(json?.rates?.[to]);
  if (json?.result !== "success" || !Number.isFinite(rate) || rate <= 0) throw new Error(`no ${from}→${to} rate available`);
  return rate;
}

const same = (store, error = null) => ({ from: store.currency, to: store.currency, rate: 1, converted: false, manual: false, updatedAt: null, stale: false, error });

/**
 * How to show money in reports. Refreshes the stored rate if it is older than a day; if the rate
 * service is down the last stored rate is used (flagged `stale`), and with no rate at all the
 * report simply stays in the store's own currency.
 */
export async function getFx(store) {
  const from = store.currency;
  const to = REPORT_CURRENCY();
  if (to === from) return same(store);

  const s = store.settings ?? (await prisma.storeSettings.findUnique({ where: { storeId: store.id } }));
  const pair = `${from}>${to}`;
  const stored = s?.fxPair === pair && s.fxRate != null ? Number(s.fxRate) : null;
  const base = { from, to, converted: true, manual: false, updatedAt: s?.fxRateAt ?? null, stale: false, error: null };

  const fresh = stored != null && s.fxRateAt && Date.now() - s.fxRateAt.getTime() < MAX_AGE_MS;
  if (fresh) return { ...base, rate: stored };

  try {
    const rate = await fetchRate(from, to);
    const now = new Date();
    await prisma.storeSettings.update({ where: { storeId: store.id }, data: { fxRate: rate, fxRateAt: now, fxPair: pair, fxManual: false } });
    return { ...base, rate, updatedAt: now };
  } catch (e) {
    if (stored != null) return { ...base, rate: stored, stale: true, error: e.message };
    return same(store, `Couldn't get an exchange rate (${e.message}). Showing ${from}.`);
  }
}

export const convert = (amount, fx) => Number(amount || 0) * fx.rate;

export function formatMoney(amount, code) {
  try {
    return new Intl.NumberFormat(code === "INR" ? "en-IN" : "en", { style: "currency", currency: code, maximumFractionDigits: 2 }).format(amount);
  } catch {
    return `${Number(amount).toFixed(2)} ${code}`;
  }
}
