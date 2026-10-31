import prisma from "../db.server.js";
import { defaultWidgetConfig, normalizeConfig } from "../lib/widget/defaults.js";

const SHOP_QUERY = `#graphql
  query LoyaltyShop { shop { name email currencyCode } }`;

/**
 * Returns the Store row for this shop, creating it (with settings and a starter rule/reward)
 * on first load. `admin` is only used to fill name/email/currency once.
 */
// Starter rewards are expressed in the store's own currency, with the same ratio everywhere
// (100 points = 1 unit of currency). Currencies with very small units get a larger step.
const STEP_VALUE = { JPY: 100, KRW: 100, IDR: 1000, VND: 1000 }; // currency worth of 100 points
const FIXED_REWARD = { INR: 100, AED: 20, JPY: 500, KRW: 5000, IDR: 50000, VND: 100000 };

function starterRewards(currency) {
  const step = STEP_VALUE[currency] ?? 1;
  const fixed = FIXED_REWARD[currency] ?? 5;
  let label;
  try {
    label = new Intl.NumberFormat("en", { style: "currency", currency, maximumFractionDigits: 0 }).format(fixed);
  } catch {
    label = `${fixed} ${currency}`;
  }
  return [
    { name: "Use points at checkout", type: "CUSTOM_AMOUNT", value: step, pointsCost: 100, minPoints: 100, maxPoints: 2000 },
    { name: `${label} off your order`, type: "FIXED_AMOUNT", value: fixed, pointsCost: Math.round((fixed / step) * 100) },
  ];
}

async function loadShopInfo(admin) {
  const res = await admin.graphql(SHOP_QUERY);
  const { data } = await res.json();
  return data.shop;
}

// Re-read name/email/currency now and then, so a currency change in Shopify is picked up.
const shopInfoCheckedAt = new Map();
const SHOP_INFO_TTL = 6 * 3600 * 1000;

export async function ensureStore({ shop, scope }, admin) {
  let store = await prisma.store.findUnique({ where: { shop }, include: { settings: true } });

  if (!store) {
    // Fetch the shop's currency first so the starter rewards are named and sized for it.
    let info = null;
    if (admin) {
      try {
        info = await loadShopInfo(admin);
      } catch (e) {
        console.warn("[store] could not load shop details", e?.message);
      }
    }
    const currency = info?.currencyCode || "USD";
    try {
      store = await prisma.store.create({
        data: {
          shop,
          scopes: scope ?? null,
          ...(info ? { name: info.name, email: info.email, currency } : {}),
          settings: { create: { widgetConfig: defaultWidgetConfig("classic") } },
          earnRules: {
            create: [
              { name: "Points per order", type: "PURCHASE_PER_CURRENCY", value: 1 },
              { name: "Welcome bonus", type: "SIGNUP", value: 50, active: false },
              { name: "Friend's first-order bonus", type: "REFERRAL_FRIEND", value: 100, active: false },
              { name: "Referrer reward", type: "REFERRAL_REFERRER", value: 200, active: false },
              { name: "Product review", type: "REVIEW", value: 50, active: false },
            ],
          },
          rewards: { create: starterRewards(currency) },
        },
        include: { settings: true },
      });
    } catch (e) {
      // The /app layout and the page route load in parallel on first open, so two requests
      // can race to create the same store. The loser just reads the winner's row.
      if (e?.code !== "P2002") throw e;
      store = await prisma.store.findUnique({ where: { shop }, include: { settings: true } });
    }
  } else if (store.uninstalledAt || (scope && store.scopes !== scope)) {
    store = await prisma.store.update({
      where: { id: store.id },
      data: { uninstalledAt: null, scopes: scope ?? store.scopes },
      include: { settings: true },
    });
  }

  // Stores created before referral/review rules existed get them too (inactive, ready to switch on).
  await backfillRules(store.id);

  if (!store.settings) {
    await prisma.storeSettings.create({
      data: { storeId: store.id, widgetConfig: defaultWidgetConfig("classic") },
    });
    store = await prisma.store.findUnique({ where: { id: store.id }, include: { settings: true } });
  }

  const lastChecked = shopInfoCheckedAt.get(shop) ?? 0;
  if (admin && (!store.name || Date.now() - lastChecked > SHOP_INFO_TTL)) {
    shopInfoCheckedAt.set(shop, Date.now());
    try {
      const info = await loadShopInfo(admin);
      if (info.name !== store.name || info.email !== store.email || info.currencyCode !== store.currency) {
        store = await prisma.store.update({
          where: { id: store.id },
          data: { name: info.name, email: info.email, currency: info.currencyCode },
          include: { settings: true },
        });
      }
    } catch (e) {
      shopInfoCheckedAt.delete(shop); // try again next time
      console.warn("[store] could not load shop details", e?.message);
    }
  }
  return store;
}

const OPTIONAL_RULES = [
  { name: "Friend's first-order bonus", type: "REFERRAL_FRIEND", value: 100 },
  { name: "Referrer reward", type: "REFERRAL_REFERRER", value: 200 },
  { name: "Product review", type: "REVIEW", value: 50 },
];

async function backfillRules(storeId) {
  const have = await prisma.earnRule.findMany({
    where: { storeId, type: { in: OPTIONAL_RULES.map((r) => r.type) } },
    select: { type: true },
  });
  const missing = OPTIONAL_RULES.filter((r) => !have.some((h) => h.type === r.type));
  if (missing.length) {
    await prisma.earnRule.createMany({ data: missing.map((r) => ({ ...r, storeId, active: false })) });
  }
}

export async function getStoreByShop(shop) {
  return prisma.store.findUnique({ where: { shop }, include: { settings: true } });
}

/**
 * The widget config the storefront renders. If the store has developer source enabled, its
 * CSS/HTML shells are merged in (they live in their own columns, never in the visual config).
 */
export function getWidgetConfig(settings) {
  const dev = settings?.devEnabled
    ? { css: settings.devCss ?? "", shell: settings.devShell ?? "", pageShell: settings.devPageShell ?? "" }
    : null;
  return normalizeConfig({ ...(settings?.widgetConfig || {}), dev });
}

/** App uninstalled: keep the data for a while (merchant may reinstall), drop credentials. */
export async function markUninstalled(shop) {
  await prisma.$transaction([
    prisma.session.deleteMany({ where: { shop } }),
    prisma.store.updateMany({ where: { shop }, data: { uninstalledAt: new Date() } }),
  ]);
}

/**
 * Hard delete. Every business table cascades from Store, so this removes customers, orders,
 * ledger, rewards, settings and email logs. Sessions have no FK, so they go in the same
 * transaction. Called from the shop/redact compliance webhook (48h after uninstall).
 */
export async function deleteStore(shop) {
  await prisma.$transaction([
    prisma.session.deleteMany({ where: { shop } }),
    prisma.store.deleteMany({ where: { shop } }),
  ]);
}
