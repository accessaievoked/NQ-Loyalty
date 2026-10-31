import prisma from "../db.server.js";

// Reporting currency.
//
// Everything is STORED and TRANSACTED in the store's own currency (that's what Shopify uses for
// orders and discounts). Merchants may choose to VIEW admin reports (analytics, referral revenue)
// in another currency; those figures are simply multiplied by an exchange rate. Rewards, discount
// codes and everything customers see always stay in the store currency.

export const REPORT_CURRENCIES = {
  INR: "Indian rupee (₹)",
  USD: "US dollar ($)",
  EUR: "Euro (€)",
  GBP: "British pound (£)",
  AED: "UAE dirham (AED)",
  AUD: "Australian dollar (A$)",
  CAD: "Canadian dollar (C$)",
};

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

const same = (store) => ({ from: store.currency, to: store.currency, rate: 1, converted: false, manual: false, updatedAt: null, stale: false, error: null });

/**
 * How to show money in reports for this store. Refreshes the stored rate if it is older than a
 * day; if the rate service is down, the last stored rate is used (flagged `stale`), and with no
 * rate at all the report simply stays in the store currency.
 */
export async function getFx(store) {
  const s = store.settings ?? (await prisma.storeSettings.findUnique({ where: { storeId: store.id } }));
  const from = store.currency;
  const to = s?.displayCurrency && REPORT_CURRENCIES[s.displayCurrency] ? s.displayCurrency : from;
  if (to === from) return same(store);

  const pair = `${from}>${to}`;
  const stored = s.fxPair === pair && s.fxRate != null ? Number(s.fxRate) : null;
  const base = { from, to, converted: true, manual: !!s.fxManual && stored != null, updatedAt: s.fxRateAt ?? null, stale: false, error: null };

  if (base.manual) return { ...base, rate: stored };
  const fresh = stored != null && s.fxRateAt && Date.now() - s.fxRateAt.getTime() < MAX_AGE_MS;
  if (fresh) return { ...base, rate: stored };

  try {
    const rate = await fetchRate(from, to);
    const now = new Date();
    await prisma.storeSettings.update({ where: { storeId: store.id }, data: { fxRate: rate, fxRateAt: now, fxPair: pair, fxManual: false } });
    return { ...base, rate, updatedAt: now };
  } catch (e) {
    if (stored != null) return { ...base, rate: stored, stale: true, error: e.message };
    return { ...same(store), error: `Couldn't get an exchange rate (${e.message}). Showing ${from}.` };
  }
}

/** Save the chosen reporting currency (null / the store's own = no conversion). */
export async function setDisplayCurrency(store, code) {
  const to = code && REPORT_CURRENCIES[code] && code !== store.currency ? code : null;
  await prisma.storeSettings.update({
    where: { storeId: store.id },
    data: { displayCurrency: to, fxRate: null, fxRateAt: null, fxPair: null, fxManual: false },
  });
  return to;
}

/** Force a fresh live rate. */
export async function refreshRate(store) {
  const s = store.settings ?? (await prisma.storeSettings.findUnique({ where: { storeId: store.id } }));
  const to = s?.displayCurrency;
  if (!to || to === store.currency) throw new Error("Pick a different reporting currency first");
  const rate = await fetchRate(store.currency, to);
  await prisma.storeSettings.update({
    where: { storeId: store.id },
    data: { fxRate: rate, fxRateAt: new Date(), fxPair: `${store.currency}>${to}`, fxManual: false },
  });
  return rate;
}

/** Use the merchant's own rate (1 store-currency unit = `rate` reporting-currency units). */
export async function setManualRate(store, rate) {
  const s = store.settings ?? (await prisma.storeSettings.findUnique({ where: { storeId: store.id } }));
  const to = s?.displayCurrency;
  const r = Number(rate);
  if (!to || to === store.currency) throw new Error("Pick a different reporting currency first");
  if (!Number.isFinite(r) || r <= 0 || r > 1e7) throw new Error("Enter a rate above 0");
  await prisma.storeSettings.update({
    where: { storeId: store.id },
    data: { fxRate: r, fxRateAt: new Date(), fxPair: `${store.currency}>${to}`, fxManual: true },
  });
}

export async function switchToLiveRate(store) {
  await prisma.storeSettings.update({ where: { storeId: store.id }, data: { fxManual: false, fxRate: null, fxRateAt: null, fxPair: null } });
}

export const convert = (amount, fx) => Number(amount || 0) * fx.rate;

export function formatMoney(amount, code) {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency: code, maximumFractionDigits: 2 }).format(amount);
  } catch {
    return `${Number(amount).toFixed(2)} ${code}`;
  }
}
