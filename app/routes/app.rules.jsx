import { useEffect, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { requireStore } from "../services/auth.server";
import { connectJudgeMe, disconnect, getIntegration, syncJudgeMe } from "../services/integrations.server";
import { disableFastCheckout, getFastCheckout, saveFastCheckout } from "../services/fastcheckout.server";
import { Prisma } from "@prisma/client";
import db from "../db.server";

// Earning and spending rules, and review points, on one page.

const TRIGGERS = {
  PAID: "Order is paid",
  FULFILLED: "Order is fulfilled",
  DELIVERED: "Order is delivered",
};
const RULE_TYPES = {
  PURCHASE_PER_CURRENCY: "Points per amount spent",
  PURCHASE_FIXED: "Fixed points per order",
  ORDER_MILESTONE: "Bonus by order number (1st, 2nd, …)",
  SIGNUP: "Welcome bonus",
  REVIEW: "Product review",
  REFERRAL_FRIEND: "Referral: new customer bonus",
  REFERRAL_REFERRER: "Referral: referrer reward",
};
// Order number steps for ORDER_MILESTONE rules are capped so one rule can't hold an unbounded list.
const MAX_MILESTONE_STEPS = 50;
// Only the first rule of these types is used, so offer them once.
const SINGLETON = ["SIGNUP", "REVIEW", "REFERRAL_FRIEND", "REFERRAL_REFERRER"];
const stamp = (d) => (d ? new Date(d).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "");

const int = (v, min, max, fallback = 0) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

export const loader = async ({ request }) => {
  const { store } = await requireStore(request);
  const [rules, rewards, jm, fast] = await Promise.all([
    db.earnRule.findMany({ where: { storeId: store.id }, orderBy: { createdAt: "asc" } }),
    db.reward.findMany({ where: { storeId: store.id, type: "CUSTOM_AMOUNT" }, orderBy: { createdAt: "asc" }, include: { _count: { select: { redemptions: true } } } }),
    getIntegration(store.id, "JUDGEME"),
    getFastCheckout(store.id),
  ]);
  const s = store.settings;
  return {
    currency: store.currency,
    settings: { earnTrigger: s.earnTrigger, holdDays: s.holdDays, expiryDays: s.expiryDays, minRedeemPoints: s.minRedeemPoints, allowStackedCodes: s.allowStackedCodes },
    rules: rules.map((r) => ({
      id: r.id, name: r.name, type: r.type, value: r.value, minOrderAmount: Number(r.minOrderAmount), active: r.active,
      maxPoints: r.maxPoints ?? 0,
      milestones: Array.isArray(r.milestones) ? r.milestones : [],
      notify: r.notify,
      combine: r.combine,
      creditWhen: r.creditWhen,
      holdDays: r.holdDays,
      expiryDays: r.expiryDays,
      updatedAt: stamp(r.updatedAt),
    })),
    rewards: rewards.map((r) => ({
      id: r.id, name: r.name, type: r.type, value: Number(r.value), pointsCost: r.pointsCost, minPoints: r.minPoints,
      maxPoints: r.maxPoints ?? 0, minOrderAmount: Number(r.minOrderAmount), codeValidDays: r.codeValidDays, active: r.active,
      redemptions: r._count.redemptions, noStackWith: r.noStackWith ?? [],
      cartRanges: Array.isArray(r.cartRanges) ? r.cartRanges : [],
      updatedAt: stamp(r.updatedAt),
    })),
    // The key and URLs are never sent to the page; they only leave via the downloaded setup file.
    fastCheckout: {
      enabled: !!fast?.enabled,
      hasLoyaltyReward: fast?.enabled ? !!(await db.reward.findFirst({ where: { storeId: store.id, type: "CUSTOM_AMOUNT", active: true } })) : true,
      lastEvent: fast?.lastEventAt ? new Date(fast.lastEventAt).toISOString().slice(0, 16).replace("T", " ") + " UTC" : null,
    },
    judgeme: {
      connected: !!(jm?.enabled && jm?.secretEnc),
      minRating: jm?.config?.minRating ?? 4,
      lastSync: jm?.lastSyncAt ? new Date(jm.lastSyncAt).toISOString().slice(0, 16).replace("T", " ") + " UTC" : null,
      lastError: jm?.lastError ?? null,
    },
  };
};

export const action = async ({ request }) => {
  const { store } = await requireStore(request);
  const f = await request.formData();
  const intent = String(f.get("intent"));
  const id = String(f.get("id") || "");

  try {
    if (intent === "settings") {
      const earnTrigger = String(f.get("earnTrigger"));
      await db.storeSettings.update({
        where: { storeId: store.id },
        data: {
          earnTrigger: TRIGGERS[earnTrigger] ? earnTrigger : "PAID",
          holdDays: int(f.get("holdDays"), 0, 365),
          expiryDays: int(f.get("expiryDays"), 0, 3650),
          minRedeemPoints: int(f.get("minRedeemPoints"), 0, 1000000),
        },
      });
      return { ok: "Saved" };
    }

    // ---- earning rules
    if (intent === "rule-save") {
      const type = RULE_TYPES[String(f.get("type"))] ? String(f.get("type")) : "PURCHASE_PER_CURRENCY";
      const milestone = type === "ORDER_MILESTONE";
      const data = {
        name: String(f.get("name") || RULE_TYPES[type]).slice(0, 80),
        type,
        // Milestone rules don't use `value` — the per-step amounts live in `milestones`.
        value: milestone ? 0 : int(f.get("value"), 1, 1000000, 1),
        minOrderAmount: Math.max(0, Number(f.get("minOrderAmount")) || 0),
        notify: f.get("notify") !== "off",
        combine: f.get("combine") !== "off",
        creditWhen: TRIGGERS[String(f.get("creditWhen"))] ? String(f.get("creditWhen")) : "PAID",
        holdDays: int(f.get("holdDays"), 0, 365),
        expiryDays: int(f.get("expiryDays"), 0, 3650),
        maxPoints: type === "PURCHASE_PER_CURRENCY" ? Math.max(0, Math.floor(Number(f.get("maxPoints")) || 0)) || null : null,
        active: f.get("active") !== "off",
      };
      if (milestone) {
        const steps = [];
        const seen = new Set();
        for (const [k, v] of f.entries()) {
          const m = /^milestoneOrder:(\d+)$/.exec(String(k));
          if (!m) continue;
          const row = m[1];
          const order = int(v, 1, 100000, 0);
          const stepPoints = int(f.get(`milestonePoints:${row}`), 0, 1000000, 0);
          const stepMin = Math.max(0, Number(f.get(`milestoneMin:${row}`)) || 0);
          const continuing = f.get(`milestoneContinuing:${row}`) === "on";
          const dedupeKey = `${order}|${continuing ? 1 : 0}`;
          if (order > 0 && stepPoints > 0 && !seen.has(dedupeKey)) {
            seen.add(dedupeKey);
            steps.push({ order, points: stepPoints, minOrderAmount: stepMin, continuing });
          }
        }
        steps.sort((a, b) => a.order - b.order);
        if (!steps.length) return { error: "Add at least one order-number step with a bonus above 0" };
        data.milestones = steps.slice(0, MAX_MILESTONE_STEPS);
      } else {
        data.milestones = Prisma.DbNull;
      }
      // storeId in the filter keeps one shop from editing another shop's rule by guessing ids
      if (id) await db.earnRule.updateMany({ where: { id, storeId: store.id }, data });
      else await db.earnRule.create({ data: { ...data, storeId: store.id } });
      return { ok: "Saved" };
    }
    if (intent === "rule-toggle") {
      await db.earnRule.updateMany({ where: { id, storeId: store.id }, data: { active: f.get("active") === "true" } });
      return { ok: "Updated" };
    }
    if (intent === "rule-delete") {
      await db.earnRule.deleteMany({ where: { id, storeId: store.id } });
      return { ok: "Removed" };
    }

    // ---- rewards
    if (intent === "reward-save") {
      const type = "CUSTOM_AMOUNT"; // the only spend rule now (others: unused-code/admin)
      let value = Math.max(0, Number(f.get("value")) || 0);
      if (type === "PERCENTAGE") value = Math.min(100, value);
      if (type === "FREE_SHIPPING") value = 0;
      if (type !== "FREE_SHIPPING" && value <= 0) return { error: "Enter a discount value above 0" };
      const custom = type === "CUSTOM_AMOUNT";
      const pointsCost = Math.max(1, Math.floor(Number(f.get("pointsCost")) || 0));
      const minPoints = custom ? Math.max(0, Math.floor(Number(f.get("minPoints")) || 0)) : 0;
      const maxPoints = custom ? Math.max(0, Math.floor(Number(f.get("maxPoints")) || 0)) || null : null;
      if (maxPoints && maxPoints < Math.max(minPoints, pointsCost)) return { error: "Maximum points must be at least the minimum (and one step)" };
      const data = {
        name: String(f.get("name") || "").trim().slice(0, 80),
        type, value, pointsCost, minPoints, maxPoints,
        minOrderAmount: Math.max(0, Number(f.get("minOrderAmount")) || 0),
        codeValidDays: Math.max(0, Math.min(3650, Math.floor(Number(f.get("codeValidDays")) || 0))),
        active: f.get("active") !== "off",
      };
      // Cart-value limits (Customer picks points only): rows arrive as rangeMin:i / rangeMax:i / rangeMode:i / rangeLimit:i.
      const ranges = [];
      if (custom) {
        for (const [k, v] of f.entries()) {
          const m = /^rangeMin:(\d+)$/.exec(String(k));
          if (!m) continue;
          const row = m[1];
          const min = Math.max(0, Number(v) || 0);
          const maxRaw = String(f.get(`rangeMax:${row}`) ?? "").trim();
          const max = maxRaw === "" ? null : Math.max(min, Number(maxRaw) || 0);
          const modeRaw = f.get(`rangeMode:${row}`);
          const mode = modeRaw === "POINTS" ? "POINTS" : modeRaw === "PERCENT" ? "PERCENT" : modeRaw === "AMOUNT" ? "AMOUNT" : "ALL";
          let limit = Math.max(0, Number(f.get(`rangeLimit:${row}`)) || 0);
          if (mode === "PERCENT") limit = Math.min(100, limit);
          else if (mode === "POINTS") limit = Math.floor(limit);
          else if (mode === "AMOUNT") limit = Math.round(limit * 100) / 100;
          else limit = 0;
          if (limit > 0 || mode === "ALL") ranges.push({ min, max, mode: limit > 0 || mode !== "ALL" ? mode : "ALL", limit });
        }
        ranges.sort((a, b) => a.min - b.min);
      }
      data.cartRanges = ranges.length ? ranges.slice(0, 20) : Prisma.DbNull;
      if (!data.name) return { error: "Give it a name" };
      if (id) await db.reward.updateMany({ where: { id, storeId: store.id }, data });
      else await db.reward.create({ data: { ...data, storeId: store.id } });
      // One point value for every spending rule (see fastrrLoyalty.server.js).
      await db.reward.updateMany({ where: { storeId: store.id, type: "CUSTOM_AMOUNT" }, data: { value: data.value, pointsCost: data.pointsCost } });
      return { ok: "Saved" };
    }
    if (intent === "reward-toggle") {
      await db.reward.updateMany({ where: { id, storeId: store.id }, data: { active: f.get("active") === "true" } });
      return { ok: "Updated" };
    }
    if (intent === "reward-delete") {
      // Redemptions keep a snapshot of the reward name, so history survives deletion.
      await db.reward.deleteMany({ where: { id, storeId: store.id } });
      return { ok: "Removed" };
    }

    // ---- fast checkout (Shiprocket)
    if (intent === "fast-save" || intent === "fast-rotate") {
      await saveFastCheckout(store, {
        heading: f.get("heading"),
        logoUrl: f.get("logoUrl"),
        allowedIps: f.get("allowedIps"),
        regenerateKey: intent === "fast-rotate",
      });
      return { ok: intent === "fast-rotate" ? "New key created. The old one no longer works" : "Saved" };
    }
    if (intent === "fast-off") {
      await disableFastCheckout(store.id);
      return { ok: "Fast checkout redemption turned off" };
    }

    // ---- Judge.me (review points)
    if (intent === "judgeme-connect") {
      await connectJudgeMe({ store, apiToken: f.get("apiToken"), minRating: f.get("minRating") });
      return { ok: "Judge.me connected" };
    }
    if (intent === "judgeme-sync") {
      const jm = await getIntegration(store.id, "JUDGEME");
      if (!jm?.enabled) return { error: "Connect Judge.me first" };
      const r = await syncJudgeMe(jm);
      return { ok: `Checked ${r.processed} reviews, rewarded ${r.rewarded}` };
    }
    if (intent === "judgeme-disconnect") {
      await disconnect(store.id, "JUDGEME");
      return { ok: "Judge.me disconnected" };
    }
  } catch (e) {
    return { error: e.message || "Something went wrong" };
  }
  return { error: "Unknown action" };
};

// ---- helpers -----------------------------------------------------------------------------------

function useMoney(currency) {
  const locale = currency === "INR" ? "en-IN" : "en";
  return (n) => {
    try {
      return new Intl.NumberFormat(locale, { style: "currency", currency, maximumFractionDigits: n % 1 ? 2 : 0 }).format(n);
    } catch {
      return `${n} ${currency}`;
    }
  };
}
const pts = (n) => `${new Intl.NumberFormat("en-IN").format(n)} point${n === 1 ? "" : "s"}`;

const ordinal = (n) => {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
};

function ruleSummary(r, money) {
  const min = r.minOrderAmount > 0 ? ` on orders over ${money(r.minOrderAmount)}` : "";
  switch (r.type) {
    case "PURCHASE_PER_CURRENCY": {
      const cap = r.maxPoints > 0 ? `, capped at ${pts(r.maxPoints)} per order` : "";
      return `${pts(r.value)} for every ${money(1)} spent${cap}${min}`;
    }
    case "PURCHASE_FIXED": return `${pts(r.value)} per order${min}`;
    case "ORDER_MILESTONE": {
      if (!r.milestones?.length) return "Bonus points by order number";
      const stepNote = (s) => (s.minOrderAmount > 0 ? ` (orders over ${money(s.minOrderAmount)})` : "");
      const parts = r.milestones.map((s) =>
        s.continuing
          ? `+${s.points} on order ${ordinal(s.order)} and every order after${stepNote(s)}`
          : `+${s.points} on order ${ordinal(s.order)}${stepNote(s)}`
      );
      return parts.join(" · ");
    }
    case "SIGNUP": return `${pts(r.value)} when someone joins`;
    case "REVIEW": return `${pts(r.value)} for each product review (needs Judge.me)`;
    case "REFERRAL_FRIEND": return `A new customer gets ${pts(r.value)} bonus on their first order${min}`;
    case "REFERRAL_REFERRER": return `The referrer gets ${pts(r.value)} when their friend's first order is complete${min}`;
    default: return "";
  }
}

function rewardSummary(r, money) {
  const rate = r.pointsCost > 0 ? r.value / r.pointsCost : r.value;
  const where = r.cartRanges?.length ? `${r.cartRanges.length} cart value rule${r.cartRanges.length === 1 ? "" : "s"}` : "any cart";
  const cap = r.maxPoints ? ` · up to ${pts(r.maxPoints)} per order` : "";
  return `1 point = ${money(rate)} off · ${where}${cap}`;
}

// Ready-made starting points. Amounts are in the store's currency, scaled to something sensible.
function presets(currency) {
  const amountOff = currency === "INR" ? 100 : currency === "JPY" ? 500 : 5;
  const big = currency === "INR" ? 1000 : currency === "JPY" ? 5000 : 50;
  return {
    earn: [
      { key: "spend", title: "Points for amount spent", text: "Customers earn points for every rupee or dollar they spend. You can cap the points per order.", rule: { name: "Points for amount spent", type: "PURCHASE_PER_CURRENCY", value: 1, minOrderAmount: 0 } },
      { key: "fixed", title: "Flat points every order", text: "The same fixed points on every order, regardless of its value.", rule: { name: "Flat points per order", type: "PURCHASE_FIXED", value: 50, minOrderAmount: 0 } },
      { key: "big", title: "Bonus on big orders", text: "Extra fixed points, only when an order is above an amount you choose.", rule: { name: "Big order bonus", type: "PURCHASE_FIXED", value: 100, minOrderAmount: big } },
      {
        key: "milestone",
        title: "Rewards by order number",
        text: "Fixed points that depend on which order this is for the customer (1st, 2nd, 3rd...), plus an optional bonus that keeps going from a chosen order onward.",
        rule: {
          name: "Order rewards",
          type: "ORDER_MILESTONE",
          value: 0,
          minOrderAmount: 0,
          "milestoneOrder:0": 2, "milestonePoints:0": 200,
          "milestoneOrder:1": 3, "milestonePoints:1": 300,
          "milestoneOrder:2": 4, "milestonePoints:2": 400,
          "milestoneOrder:3": 5, "milestonePoints:3": 500,
          "milestoneOrder:4": 6, "milestonePoints:4": 100, "milestoneContinuing:4": "on",
        },
      },
      { key: "welcome", title: "Welcome bonus", text: "Points when someone joins your rewards.", rule: { name: "Welcome bonus", type: "SIGNUP", value: 50, minOrderAmount: 0 } },
      { key: "review", title: "Reward product reviews", text: "Points for good reviews (uses Judge.me).", rule: { name: "Product review", type: "REVIEW", value: 50, minOrderAmount: 0 } },
      { key: "ref-friend", title: "Referral: new customer bonus", text: "Bonus for a customer who uses a friend's code.", rule: { name: "Referral bonus for new customer", type: "REFERRAL_FRIEND", value: 100, minOrderAmount: 0 } },
      { key: "ref-owner", title: "Referral: reward for the referrer", text: "Points when their friend completes a first order.", rule: { name: "Referral reward", type: "REFERRAL_REFERRER", value: 200, minOrderAmount: 0 } },
    ],
    redeem: [
      {
        key: "cart",
        title: "Based on cart value",
        text: "Choose how much of a cart points can pay for, by cart value (for example carts from ₹500 to ₹1,000 can use up to 50%). Starts with any cart able to use all of a customer's points.",
        reward: { name: "Redeem on cart value", type: "CUSTOM_AMOUNT", value: 1, pointsCost: 1, minPoints: 0, maxPoints: 0, minOrderAmount: 0, codeValidDays: 0 },
      },
      {
        key: "amount",
        title: "Amount discount",
        text: "Points can take a set amount off a cart, at most. Example: up to ₹100 off any cart.",
        reward: {
          name: "Amount off the cart", type: "CUSTOM_AMOUNT", value: 1, pointsCost: 1, minPoints: 0, maxPoints: 0, minOrderAmount: 0, codeValidDays: 0,
          "rangeMin:0": 0, "rangeMax:0": "", "rangeMode:0": "AMOUNT", "rangeLimit:0": amountOff,
        },
      },
      {
        key: "percent",
        title: "Percentage off",
        text: "Points can take a percentage off a cart, at most. Example: up to 10% of any cart.",
        reward: {
          name: "Percent off the cart", type: "CUSTOM_AMOUNT", value: 1, pointsCost: 1, minPoints: 0, maxPoints: 0, minOrderAmount: 0, codeValidDays: 0,
          "rangeMin:0": 0, "rangeMax:0": "", "rangeMode:0": "PERCENT", "rangeLimit:0": 10,
        },
      },
    ],
  };
}

function useToast(fetcher) {
  const shopify = useAppBridge();
  useEffect(() => {
    if (fetcher.data?.ok) shopify.toast.show(fetcher.data.ok);
    if (fetcher.data?.error) shopify.toast.show(fetcher.data.error, { isError: true });
  }, [fetcher.data, shopify]);
}

const toForm = (obj) => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, typeof v === "boolean" ? (v ? "on" : "off") : String(v)]));

// ---- row editors ---------------------------------------------------------------------------------

// Order-number -> bonus-points ladder editor for ORDER_MILESTONE rules. Each step submits a group
// of hidden/number inputs named `milestone<Field>:<row>`; the row index is just a React key, not
// meaningful to the server, which reads and sorts whatever rows arrive. A step can be a one-time
// bonus on exactly that order number, or "keep going" (continuing), which also covers every later
// order — the highest continuing step reached wins once no exact step matches, so a short ladder
// (order 2, 3, 4…) can end in an open-ended tail like "+100 from order 6 on".
function MilestoneEditor({ steps, onChange, currency }) {
  const addStep = () => {
    const nextOrder = (steps.reduce((m, s) => Math.max(m, s.order), 0) || 0) + 1;
    onChange([...steps, { order: nextOrder, points: 0, minOrderAmount: 0, continuing: false }]);
  };
  const update = (i, patch) => onChange(steps.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  const remove = (i) => onChange(steps.filter((_, idx) => idx !== i));

  return (
    <s-stack gap="small">
      <s-text type="strong">Points by order number</s-text>
      <s-text color="subdued">
        A fixed amount, whatever the order is worth (unless you set a smallest order below). Stacks on top of any other active earning
        rules. An order number with no step and no "keep going" step before it gets no bonus.
      </s-text>
      {steps.map((s, i) => (
        <s-box key={i} padding="small-400" border="base" borderRadius="base" background="subdued">
          <s-stack gap="small">
            <s-grid gridTemplateColumns="repeat(auto-fit, minmax(150px, 1fr))" gap="small">
              <s-number-field
                label="Order number"
                min="1"
                step="1"
                value={String(s.order)}
                onChange={(e) => update(i, { order: int(e.currentTarget.value, 1, 100000, 1) })}
              />
              <input type="hidden" name={`milestoneOrder:${i}`} value={s.order} />
              <s-number-field
                label="Points"
                min="0"
                step="1"
                value={String(s.points)}
                onChange={(e) => update(i, { points: int(e.currentTarget.value, 0, 1000000, 0) })}
              />
              <input type="hidden" name={`milestonePoints:${i}`} value={s.points} />
              <s-number-field
                label={`Minimum order (${currency})`}
                min="0"
                value={String(s.minOrderAmount || 0)}
                details="0 = any order"
                onChange={(e) => update(i, { minOrderAmount: Math.max(0, Number(e.currentTarget.value) || 0) })}
              />
              <input type="hidden" name={`milestoneMin:${i}`} value={s.minOrderAmount || 0} />
            </s-grid>
            <s-stack direction="inline" justifyContent="space-between" alignItems="center">
              <s-checkbox
                label="Also keep giving this on every later order"
                checked={!!s.continuing}
                onChange={(e) => update(i, { continuing: e.currentTarget.checked })}
              />
              {s.continuing && <input type="hidden" name={`milestoneContinuing:${i}`} value="on" />}
              <s-button variant="tertiary" tone="critical" onClick={() => remove(i)}>
                Remove step
              </s-button>
            </s-stack>
          </s-stack>
        </s-box>
      ))}
      <s-stack direction="inline">
        <s-button variant="tertiary" onClick={addStep} disabled={steps.length >= MAX_MILESTONE_STEPS || undefined}>
          Add a step
        </s-button>
      </s-stack>
    </s-stack>
  );
}

// ---- layout pieces (Flits-style: description + action on the left, a card of rows on the right) ----

const ICON_PATHS = {
  cart: <><path d="M3 4h2.2l1.6 8.2a1 1 0 0 0 1 .8h7.3a1 1 0 0 0 1-.7L17 7H6" /><circle cx="8.5" cy="16.5" r="1.2" /><circle cx="14.5" cy="16.5" r="1.2" /></>,
  tag: <><path d="M3 10.5V4a1 1 0 0 1 1-1h6.5l7 7-7.5 7.5-7-7z" /><circle cx="7" cy="7" r="1.2" /></>,
  steps: <path d="M3 16h4v-4h4V8h4V4h2" />,
  user: <><circle cx="10" cy="7" r="3" /><path d="M4 17c0-3.2 2.7-5 6-5s6 1.8 6 5" /></>,
  star: <path d="M10 2.8l2.2 4.6 5 .7-3.6 3.5.9 5-4.5-2.4-4.5 2.4.9-5L2.8 8.1l5-.7z" />,
  gift: <><rect x="3" y="8" width="14" height="9" rx="1" /><path d="M2.5 5.5h15V8h-15zM10 5.5V17" /><path d="M10 5.5C8 5.5 6.5 4 7.5 3S10 4 10 5.5zM10 5.5c2 0 3.5-1.5 2.5-2.5S10 4 10 5.5z" /></>,
  percent: <><path d="M15.5 4.5l-11 11" /><circle cx="6" cy="6" r="1.8" /><circle cx="14" cy="14" r="1.8" /></>,
  truck: <><path d="M2 5h9v8H2zM11 8h4l3 3v2h-7z" /><circle cx="6" cy="15" r="1.4" /><circle cx="14.5" cy="15" r="1.4" /></>,
  coin: <><circle cx="10" cy="10" r="7" /><path d="M10 6v8M7.5 8.5H11a1.5 1.5 0 0 1 0 3H7.5" /></>,
};
const RULE_ICON = { PURCHASE_PER_CURRENCY: "cart", PURCHASE_FIXED: "tag", ORDER_MILESTONE: "steps", SIGNUP: "user", REVIEW: "star", REFERRAL_FRIEND: "gift", REFERRAL_REFERRER: "gift" };
const REWARD_ICON = { CUSTOM_AMOUNT: "cart" };
const PURCHASE_TYPES = ["PURCHASE_PER_CURRENCY", "PURCHASE_FIXED", "ORDER_MILESTONE"];

// What each earning rule does, in plain words, and when its points arrive.
const RULE_HELP = {
  PURCHASE_PER_CURRENCY: "Gives points based on how much the customer spends on an order. Example: 1 point for every ₹10 spent. You can cap the points one order can earn.",
  PURCHASE_FIXED: "Gives the same number of points on every order, whatever it is worth. Set a smallest order if you only want bigger orders to earn it.",
  ORDER_MILESTONE: "Gives fixed points that depend on which order this is for the customer: 1st, 2nd, 3rd and so on. You can keep a bonus going from a chosen order onward.",
  SIGNUP: "Gives points once, when someone joins your rewards program.",
  REVIEW: "Gives points when a customer leaves a good review on Judge.me. Each customer is rewarded once per product.",
  REFERRAL_FRIEND: "Gives a new customer bonus points on their first order, after they use a friend's referral code.",
  REFERRAL_REFERRER: "Gives the referrer points when the friend they referred completes a first order.",
};
const RULE_WHEN = {
  PURCHASE_PER_CURRENCY: "Points are added after the order reaches the status you chose under “When points are credited”, plus any wait period.",
  PURCHASE_FIXED: "Points are added after the order reaches the status you chose under “When points are credited”, plus any wait period.",
  ORDER_MILESTONE: "Points are added after the order reaches the status you chose under “When points are credited”, plus any wait period.",
  SIGNUP: "Points are added straight away.",
  REVIEW: "Points are added when the review is picked up from Judge.me (every few hours).",
  REFERRAL_FRIEND: "Points are added when the friend's first order is credited.",
  REFERRAL_REFERRER: "Points are added when the friend's first order is credited.",
};

function Glyph({ kind }) {
  return (
    <span style={{ flex: "none", width: 36, height: 36, borderRadius: 8, border: "1px solid #e4e6ea", background: "#fff", display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="#374151" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {ICON_PATHS[kind] || ICON_PATHS.tag}
      </svg>
    </span>
  );
}

const TEXT_BUTTON = { border: 0, background: "none", cursor: "pointer", padding: "4px 2px", fontSize: 13, fontWeight: 600, color: "#111827", textDecoration: "underline", textUnderlineOffset: 3 };

// Left: what this is and the main action. Right: the card. Stacks on narrow screens.
function SectionRow({ title, text, action, children }) {
  return (
    <div className="rules-row" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 16, padding: "24px 0", borderTop: "1px solid #e4e6ea" }}>
      <div>
        <div style={{ fontSize: 15, fontWeight: 650, color: "#111827" }}>{title}</div>
        <p style={{ margin: "6px 0 14px", fontSize: 13, color: "#6b7280", lineHeight: 1.55 }}>{text}</p>
        {action}
      </div>
      <div style={{ minWidth: 0 }}>{children}</div>
    </div>
  );
}

function Card({ title, note, children }) {
  return (
    <div style={{ border: "1px solid #e4e6ea", borderRadius: 12, background: "#fff", overflow: "hidden" }}>
      {title && <div style={{ padding: "12px 16px", fontSize: 14, fontWeight: 650, color: "#111827" }}>{title}</div>}
      {children}
      {note && <div style={{ padding: "10px 16px", borderTop: "1px solid #eceef1", background: "#fafafa", fontSize: 12.5, color: "#6b7280", lineHeight: 1.5 }}>{note}</div>}
    </div>
  );
}

function EmptyRow({ children }) {
  return <div style={{ padding: "18px 16px", borderTop: "1px solid #eceef1", fontSize: 13, color: "#6b7280" }}>{children}</div>;
}

// One line in a card: icon, name + plain-language summary, status, Edit (opens a modal).
function ListRow({ icon, title, summary, active, onEdit }) {
  return (
    <div style={{ borderTop: "1px solid #eceef1", display: "flex", alignItems: "center", gap: 12, padding: "12px 16px" }}>
      <Glyph kind={icon} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: "#111827" }}>{title}</div>
        <div style={{ fontSize: 13, color: "#6b7280", marginTop: 2, lineHeight: 1.45 }}>{summary}</div>
      </div>
      <s-badge tone={active ? "success" : "neutral"}>{active ? "Active" : "Inactive"}</s-badge>
      <button type="button" onClick={onEdit} style={TEXT_BUTTON}>Edit</button>
    </div>
  );
}

// Centred dialog. While it is open the page behind it can't scroll (the app lives in an iframe whose
// own document scrolls, so both the root and the body are frozen) and Escape / clicking outside close it.
function Modal({ open, title, intro, onClose, children, footer, wide }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    const html = document.documentElement;
    const body = document.body;
    const before = { html: html.style.overflow, body: body.style.overflow };
    html.style.overflow = "hidden";
    body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      html.style.overflow = before.html;
      body.style.overflow = before.body;
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={onClose}
      style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(17,24,39,.45)", display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "4vh 16px 16px", overflowY: "auto", overscrollBehavior: "contain" }}
    >
      <div onClick={(e) => e.stopPropagation()} style={{ width: wide ? "min(960px, 100%)" : "min(620px, 100%)", background: wide ? "#f6f6f7" : "#fff", borderRadius: 14, boxShadow: "0 20px 50px rgba(0,0,0,.25)", overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 20px", borderBottom: "1px solid #e4e6ea", background: "#fff" }}>
          <div style={{ fontSize: 16, fontWeight: 650, color: "#111827" }}>{title}</div>
          <button type="button" onClick={onClose} aria-label="Close" style={{ border: 0, background: "none", cursor: "pointer", fontSize: 22, lineHeight: 1, color: "#6b7280", padding: 4 }}>×</button>
        </div>
        {intro && <div style={{ padding: "12px 20px 0", fontSize: 13, color: "#6b7280", lineHeight: 1.5 }}>{intro}</div>}
        <div style={{ maxHeight: "78vh", overflowY: "auto", overscrollBehavior: "contain" }}>{children}</div>
        {footer && <div style={{ padding: "12px 20px", borderTop: "1px solid #e4e6ea", background: "#fff" }}>{footer}</div>}
      </div>
    </div>
  );
}

// "Add ..." picker. Lists only what this app can actually do, grouped, with a one-line explanation each.
function PickerModal({ open, title, intro, groups, taken, busy, onPick, onClose }) {
  return (
    <Modal open={open} title={title} intro={intro} onClose={onClose} footer={<div style={{ display: "flex", justifyContent: "flex-end" }}><s-button onClick={onClose}>Cancel</s-button></div>}>
      <div style={{ padding: "4px 0 8px", background: "#fff" }}>
        {groups.map((g) => (
          <div key={g.title}>
            <div style={{ padding: "14px 20px 6px", fontSize: 12, fontWeight: 650, color: "#6b7280", textTransform: "uppercase", letterSpacing: ".04em" }}>{g.title}</div>
            {g.items.map((it) => {
              const done = taken(it);
              return (
                <div key={it.key} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 20px", borderTop: "1px solid #f1f2f4" }}>
                  <Glyph kind={it.icon} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: "#111827" }}>{it.title}</div>
                    <div style={{ fontSize: 13, color: "#6b7280", marginTop: 2, lineHeight: 1.45 }}>{it.text}</div>
                  </div>
                  <s-button disabled={done || busy || undefined} onClick={() => onPick(it)}>
                    {done ? "Added" : "Add"}
                  </s-button>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </Modal>
  );
}

// ---- the detailed edit screen: settings on the left, summary / status / notifications on the right ----

function EditLayout({ main, side }) {
  return (
    <div className="edit-grid" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 16, padding: 20 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>{main}</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>{side}</div>
    </div>
  );
}

function Panel({ title, children }) {
  return (
    <div style={{ background: "#fff", border: "1px solid #e4e6ea", borderRadius: 12, padding: 16 }}>
      {title && <div style={{ fontSize: 14, fontWeight: 650, color: "#111827", marginBottom: 10 }}>{title}</div>}
      {children}
    </div>
  );
}

const MUTED = { margin: "0 0 8px", fontSize: 13, color: "#6b7280", lineHeight: 1.55 };

function SummaryPanel({ lines, savedAt }) {
  return (
    <>
      <Panel title="Summary">
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: "#374151", lineHeight: 1.6 }}>
          {lines.map((l, i) => <li key={i}>{l}</li>)}
        </ul>
      </Panel>
      <Panel title="Last saved">
        <div style={{ fontSize: 13, color: "#374151" }}>{savedAt || "Not saved yet"}</div>
      </Panel>
    </>
  );
}

// Native radios: they post nothing themselves; the form reads the `active` state kept in a hidden input.
function StatusPanel({ active, onChange }) {
  const row = { display: "flex", alignItems: "center", gap: 8, fontSize: 14, color: "#111827", padding: "3px 0", cursor: "pointer" };
  return (
    <Panel title="Status">
      <label style={row}><input type="radio" name="status-radio" checked={active} onChange={() => onChange(true)} style={{ accentColor: "#111827" }} /> Active</label>
      <label style={row}><input type="radio" name="status-radio" checked={!active} onChange={() => onChange(false)} style={{ accentColor: "#111827" }} /> Inactive</label>
      <p style={{ ...MUTED, margin: "8px 0 0" }}>Inactive keeps the settings but stops it applying to new orders.</p>
    </Panel>
  );
}

const rangeText = (rg, money) => {
  const to = rg.max == null || rg.max === "" ? "no upper limit" : money(Number(rg.max));
  const what = rg.mode === "ALL" ? "all their points" : rg.mode === "POINTS" ? `up to ${pts(Number(rg.limit))}` : rg.mode === "AMOUNT" ? `up to ${money(Number(rg.limit))} off` : `up to ${rg.limit}% of the cart`;
  return `Cart ${money(Number(rg.min) || 0)} to ${to}: ${what}`;
};

// Cart-value rules for the spend rule (used by Shiprocket checkout, which tells us the cart value).
function RangesEditor({ ranges, onChange, currency }) {
  const update = (i, patch) => onChange(ranges.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const remove = (i) => onChange(ranges.filter((_, idx) => idx !== i));
  const add = () => {
    const lastMax = ranges.length ? Number(ranges[ranges.length - 1].max) : 0;
    onChange([...ranges, { min: Number.isFinite(lastMax) && lastMax > 0 ? lastMax + 1 : 1, max: "", mode: "ALL", limit: 0 }]);
  };
  return (
    <s-stack gap="small">
      <p style={MUTED}>
        Choose how much of a cart points can pay for, by cart value. With no rules here, any cart can use points. Once you add a rule, a cart outside every
        range can&apos;t use points. If a customer has fewer points than the limit, all of their points are used.
      </p>
      {ranges.map((r, i) => (
        <div key={i} style={{ border: "1px solid #e4e6ea", borderRadius: 10, padding: 12, background: "#fafafa" }}>
          <s-grid gridTemplateColumns="repeat(auto-fit, minmax(150px, 1fr))" gap="small">
            <s-number-field label={`Cart from (${currency})`} min="0" value={String(r.min)} onChange={(e) => update(i, { min: e.currentTarget.value })} />
            <s-number-field label={`Cart up to (${currency})`} min="0" value={String(r.max ?? "")} details="Empty = no upper limit (Max)" onChange={(e) => update(i, { max: e.currentTarget.value })} />
            <s-select label="Most they can take off" value={r.mode} onChange={(e) => update(i, { mode: e.currentTarget.value })}>
              <s-option value="ALL">All their points</s-option>
              <s-option value="POINTS">A set number of points</s-option>
              <s-option value="PERCENT">A percent of the cart</s-option>
              <s-option value="AMOUNT">A set amount off</s-option>
            </s-select>
            {r.mode !== "ALL" && (
              <s-number-field label={r.mode === "POINTS" ? "Most points" : r.mode === "AMOUNT" ? `Most off (${currency})` : "Most percent of cart"} min="0" step="any" value={String(r.limit)} onChange={(e) => update(i, { limit: e.currentTarget.value })} />
            )}
          </s-grid>
          <input type="hidden" name={`rangeMin:${i}`} value={r.min} />
          <input type="hidden" name={`rangeMax:${i}`} value={r.max ?? ""} />
          <input type="hidden" name={`rangeMode:${i}`} value={r.mode} />
          <input type="hidden" name={`rangeLimit:${i}`} value={r.mode === "ALL" ? 0 : r.limit} />
          <div style={{ marginTop: 8 }}>
            <s-button variant="tertiary" tone="critical" onClick={() => remove(i)}>Remove this rule</s-button>
          </div>
        </div>
      ))}
      <div>
        <s-button onClick={add}>Add rule</s-button>
      </div>
    </s-stack>
  );
}

// ---- row editors ---------------------------------------------------------------------------------

function ruleSummaryLines(rule, money) {
  const lines = [ruleSummary(rule, money)];
  if (PURCHASE_TYPES.includes(rule.type)) {
    lines.push(rule.combine ? "Adds to points from other earning rules" : "Doesn't add to other rules: the customer gets the larger of this and the others");
  }
  if (PURCHASE_TYPES.includes(rule.type)) {
    const when = TRIGGERS[rule.creditWhen] || TRIGGERS.PAID;
    lines.push(`Credited when: ${when.toLowerCase()}${rule.holdDays > 0 ? `, then ${rule.holdDays} day${rule.holdDays === 1 ? "" : "s"} later` : ""}`);
  }
  lines.push(rule.expiryDays > 0 ? `Points expire after ${rule.expiryDays} day${rule.expiryDays === 1 ? "" : "s"}` : "Points never expire");
  lines.push(rule.notify ? "The customer is emailed when this gives them points" : "No email is sent for this rule");
  lines.push(rule.active ? "Active" : "Inactive: not applied to new orders");
  return lines;
}

function RuleRow({ rule, currency, money }) {
  const fetcher = useFetcher();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(rule.active);
  const [notify, setNotify] = useState(rule.notify);
  const [combine, setCombine] = useState(rule.combine);
  const [milestones, setMilestones] = useState(() =>
    rule.milestones?.length ? rule.milestones : [{ order: 1, points: 0, minOrderAmount: 0, continuing: false }]
  );
  useToast(fetcher);
  useEffect(() => {
    if (fetcher.state === "idle" && (fetcher.data?.ok === "Saved" || fetcher.data?.ok === "Removed")) setOpen(false);
  }, [fetcher.state, fetcher.data]);
  useEffect(() => { setActive(rule.active); setNotify(rule.notify); setCombine(rule.combine); }, [rule.active, rule.notify, rule.combine]);

  const isMilestone = rule.type === "ORDER_MILESTONE";
  const isPerCurrency = rule.type === "PURCHASE_PER_CURRENCY";
  const isPurchase = PURCHASE_TYPES.includes(rule.type);
  const valueLabel =
    rule.type === "PURCHASE_PER_CURRENCY" ? `Points per ${money(1)} spent`
    : rule.type === "PURCHASE_FIXED" ? "Points per order"
    : rule.type === "SIGNUP" ? "Welcome points"
    : rule.type === "REVIEW" ? "Points per review"
    : rule.type === "REFERRAL_FRIEND" ? "Bonus points"
    : "Reward points";
  const hasMin = !["SIGNUP", "REVIEW", "ORDER_MILESTONE"].includes(rule.type);

  return (
    <>
      <ListRow icon={RULE_ICON[rule.type]} title={rule.name} summary={ruleSummary(rule, money)} active={rule.active} onEdit={() => setOpen(true)} />
      <Modal open={open} wide title={`Edit: ${rule.name}`} onClose={() => setOpen(false)}>
        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="rule-save" />
          <input type="hidden" name="id" value={rule.id} />
          <input type="hidden" name="type" value={rule.type} />
          <input type="hidden" name="active" value={active ? "on" : "off"} />
          <input type="hidden" name="notify" value={notify ? "on" : "off"} />
          <input type="hidden" name="combine" value={combine ? "on" : "off"} />
          <EditLayout
            main={
              <>
                <Panel title="What this rule does">
                  <p style={{ ...MUTED, color: "#374151" }}>{RULE_HELP[rule.type]}</p>
                  <p style={{ ...MUTED, margin: 0 }}>{RULE_WHEN[rule.type]}</p>
                </Panel>
                <Panel title="Settings">
                  <s-grid gridTemplateColumns="repeat(auto-fit, minmax(200px, 1fr))" gap="base">
                    <s-text-field label="Name (shown to customers)" name="name" value={rule.name} />
                    {!isMilestone && <s-number-field label={valueLabel} name="value" min="1" step="1" value={String(rule.value)} />}
                    {isPerCurrency && (
                      <s-number-field
                        label="Most points per order"
                        name="maxPoints"
                        min="0"
                        step="1"
                        value={String(rule.maxPoints || 0)}
                        details="0 = no limit. Example: 1 point per ₹10, up to 100 points."
                      />
                    )}
                    {hasMin && (
                      <s-number-field
                        label={`Smallest order that counts (${currency})`}
                        name="minOrderAmount"
                        min="0"
                        value={String(rule.minOrderAmount)}
                        details="0 = every order counts."
                      />
                    )}
                  </s-grid>
                </Panel>
                <Panel title="When points arrive and how long they last">
                  <s-grid gridTemplateColumns="repeat(auto-fit, minmax(200px, 1fr))" gap="base">
                    {isPurchase ? (
                      <>
                        <s-select label="Credit points when" name="creditWhen" value={rule.creditWhen} details="Which order status releases the points.">
                          {Object.entries(TRIGGERS).map(([k, v]) => (
                            <s-option key={k} value={k}>{v}</s-option>
                          ))}
                        </s-select>
                        <s-number-field label="Wait after that (days)" name="holdDays" min="0" step="1" value={String(rule.holdDays)} details="Your return window. 0 = straight away." />
                      </>
                    ) : (
                      <s-text color="subdued">{RULE_WHEN[rule.type]}</s-text>
                    )}
                    <s-number-field label="Points expire after (days)" name="expiryDays" min="0" step="1" value={String(rule.expiryDays)} details="0 = never expire. Customers get a reminder email first." />
                  </s-grid>
                  {isPurchase && (
                    <p style={{ ...MUTED, margin: "10px 0 0" }}>
                      If several rules pay on the same order, its points arrive together once the latest of their statuses is reached (and the longest wait has
                      passed). Each rule&apos;s points still expire on that rule&apos;s own schedule.
                    </p>
                  )}
                </Panel>
                {isMilestone && (
                  <Panel title="Points by order number">
                    <MilestoneEditor steps={milestones} onChange={setMilestones} currency={currency} />
                  </Panel>
                )}
                {isPurchase && (
                  <Panel title="Combination">
                    <s-checkbox label="Add this rule's points to the other earning rules" checked={combine} onChange={(e) => setCombine(e.currentTarget.checked)} />
                    <p style={{ ...MUTED, margin: "8px 0 0" }}>
                      On: points from every rule that applies are added up. Off: the customer gets either this rule&apos;s points or the total of the other
                      rules, whichever is more.
                    </p>
                  </Panel>
                )}
              </>
            }
            side={
              <>
                <SummaryPanel lines={ruleSummaryLines({ ...rule, active, notify, combine }, money)} savedAt={rule.updatedAt} />
                <StatusPanel active={active} onChange={setActive} />
                <Panel title="Notifications">
                  <s-checkbox label="Email the customer" checked={notify} onChange={(e) => setNotify(e.currentTarget.checked)} />
                  <p style={{ ...MUTED, margin: "8px 0 0" }}>Sends the “Points earned” email when this rule gives them points. Edit that email under Emails.</p>
                </Panel>
              </>
            }
          />
          <div style={{ display: "flex", justifyContent: "space-between", padding: "0 20px 20px" }}>
            <s-button tone="critical" variant="tertiary" onClick={() => window.confirm("Remove this rule? Points already earned are not affected.") && fetcher.submit({ intent: "rule-delete", id: rule.id }, { method: "post" })}>
              Remove
            </s-button>
            <s-button type="submit" variant="primary" loading={fetcher.state !== "idle" || undefined}>
              Save
            </s-button>
          </div>
        </fetcher.Form>
      </Modal>
    </>
  );
}

function rewardSummaryLines(reward, rate, money) {
  const lines = [`1 point = ${money(rate)} off the cart`];
  if (reward.cartRanges?.length) {
    reward.cartRanges.forEach((rg) => lines.push(rangeText(rg, money)));
    lines.push("Carts outside these ranges can't use points");
  } else {
    lines.push("Any cart can use points");
  }
  if (reward.minPoints) lines.push(`At least ${pts(reward.minPoints)} per order`);
  if (reward.maxPoints) lines.push(`At most ${pts(reward.maxPoints)} per order`);
  lines.push("A customer with fewer points than the limit uses all of them");
  lines.push(reward.active ? "Active" : "Inactive: customers can't spend points");
  return lines;
}

// The spend rule: points are taken off the cart in Shiprocket checkout. No codes.
function RewardRow({ reward, currency, money }) {
  const fetcher = useFetcher();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(reward.active);
  const [ranges, setRanges] = useState(() => reward.cartRanges || []);
  useToast(fetcher);
  useEffect(() => {
    if (fetcher.state === "idle" && (fetcher.data?.ok === "Saved" || fetcher.data?.ok === "Removed")) setOpen(false);
  }, [fetcher.state, fetcher.data]);
  useEffect(() => setActive(reward.active), [reward.active]);
  const rate = reward.pointsCost > 0 ? Math.round((reward.value / reward.pointsCost) * 10000) / 10000 : reward.value;

  return (
    <>
      <ListRow icon={REWARD_ICON[reward.type]} title={reward.name} summary={rewardSummary(reward, money)} active={reward.active} onEdit={() => setOpen(true)} />
      <Modal open={open} wide title={`Edit: ${reward.name}`} onClose={() => setOpen(false)}>
        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="reward-save" />
          <input type="hidden" name="id" value={reward.id} />
          <input type="hidden" name="type" value="CUSTOM_AMOUNT" />
          <input type="hidden" name="pointsCost" value="1" />
          <input type="hidden" name="minOrderAmount" value="0" />
          <input type="hidden" name="codeValidDays" value="0" />
          <input type="hidden" name="active" value={active ? "on" : "off"} />
          <EditLayout
            main={
              <>
                <Panel title="What this rule does">
                  <p style={{ ...MUTED, color: "#374151" }}>
                    When a customer pays with Shiprocket checkout, their points are taken off the cart automatically. There are no discount codes to copy. They
                    use as many points as the rules below allow; if they have fewer, all of their points are used.
                  </p>
                  <p style={{ ...MUTED, margin: 0 }}>Works on the cart in Shiprocket checkout only, so Shiprocket checkout must be on.</p>
                </Panel>
                <Panel title="Points value">
                  <s-grid gridTemplateColumns="repeat(auto-fit, minmax(200px, 1fr))" gap="base">
                    <s-text-field label="Name" name="name" value={reward.name} />
                    <s-number-field label={`Value of 1 point (${currency})`} name="value" min="0.01" step="any" value={String(rate)} details="1 point = ₹1 is the simplest." />
                    <s-number-field label="Fewest points to use" name="minPoints" min="0" step="1" value={String(reward.minPoints)} details="0 = no minimum." />
                    <s-number-field label="Most points per order" name="maxPoints" min="0" step="1" value={String(reward.maxPoints)} details="0 = no overall limit." />
                  </s-grid>
                </Panel>
                <Panel title="Cart value rules">
                  <RangesEditor ranges={ranges} onChange={setRanges} currency={currency} />
                </Panel>
              </>
            }
            side={
              <>
                <SummaryPanel lines={rewardSummaryLines({ ...reward, active, cartRanges: ranges }, rate, money)} savedAt={reward.updatedAt} />
                <StatusPanel active={active} onChange={setActive} />
                <Panel title="Where it works">
                  <p style={{ ...MUTED, margin: 0 }}>On the cart, in Shiprocket checkout. Not on Shopify&apos;s own checkout.</p>
                </Panel>
              </>
            }
          />
          <div style={{ display: "flex", justifyContent: "space-between", padding: "0 20px 20px" }}>
            <s-button tone="critical" variant="tertiary" onClick={() => window.confirm("Remove this rule? Customers won't be able to spend points until you add one again.") && fetcher.submit({ intent: "reward-delete", id: reward.id }, { method: "post" })}>
              Remove
            </s-button>
            <s-button type="submit" variant="primary" loading={fetcher.state !== "idle" || undefined}>
              Save
            </s-button>
          </div>
        </fetcher.Form>
      </Modal>
    </>
  );
}

// Shiprocket Checkout (fastrr): just on/off here. The secret key is never shown on screen; the merchant
// downloads a setup file to send to Shiprocket, or makes a new key (which invalidates the old file).
function FastCheckout({ fc }) {
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const [downloading, setDownloading] = useState(false);
  useToast(fetcher);
  const busy = fetcher.state !== "idle" || undefined;
  const send = (intent) => fetcher.submit({ intent }, { method: "post" });

  const download = async () => {
    setDownloading(true);
    try {
      const res = await fetch("/app/shiprocket-file");
      if (!res.ok) throw new Error("download failed");
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = "shiprocket-checkout-setup.txt";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      shopify.toast.show("Setup file downloaded. Send it to Shiprocket.");
    } catch {
      shopify.toast.show("Couldn't download the file. Please try again.", { isError: true });
    } finally {
      setDownloading(false);
    }
  };

  return (
    <s-stack gap="base">
      <s-stack direction="inline" gap="small" alignItems="center">
        <s-badge tone={fc.enabled ? "success" : "neutral"}>{fc.enabled ? "On" : "Off"}</s-badge>
        {fc.enabled && fc.lastEvent && <s-text color="subdued">Last request from Shiprocket {fc.lastEvent}</s-text>}
      </s-stack>
      {!fc.enabled ? (
        <>
          <s-paragraph>
            Turn this on if you use Shiprocket Checkout. Customers can then spend points on that page with no code to copy. Nothing changes for stores
            that use Shopify&apos;s own checkout.
          </s-paragraph>
          <s-stack direction="inline">
            <s-button variant="primary" onClick={() => send("fast-save")} loading={busy}>Turn on</s-button>
          </s-stack>
        </>
      ) : (
        <>
          <s-paragraph>
            Download the setup file and send it to Shiprocket&apos;s checkout support. They switch it on at their end. Keep the file private: it holds the
            secret key.
          </s-paragraph>
          {!fc.hasLoyaltyReward && (
            <s-banner tone="warning">
              Add a &quot;Customer picks points&quot; reward under Ways to spend points, so Shiprocket knows how many points equal how much money. Until you do,
              customers can&apos;t spend points there.
            </s-banner>
          )}
          <s-stack direction="inline" gap="small">
            <s-button variant="primary" onClick={download} loading={downloading || undefined}>Download setup file</s-button>
            <s-button
              onClick={() => window.confirm("Make a new key? The old key and file stop working, so send Shiprocket the new file.") && send("fast-rotate")}
              loading={busy}
            >
              Make a new key
            </s-button>
            <s-button tone="critical" variant="tertiary" onClick={() => send("fast-off")}>Turn off</s-button>
          </s-stack>
        </>
      )}
    </s-stack>
  );
}

function JudgeMe({ jm, reviewRuleActive }) {
  const fetcher = useFetcher();
  useToast(fetcher);
  const busy = fetcher.state !== "idle" || undefined;
  const send = (intent) => fetcher.submit({ intent }, { method: "post" });
  return (
    <s-stack gap="base">
      <s-stack direction="inline" gap="small" alignItems="center">
        <s-badge tone={jm.connected ? "success" : "neutral"}>{jm.connected ? "Connected" : "Not connected"}</s-badge>
        {jm.connected && jm.lastSync && <s-text color="subdued">Last checked {jm.lastSync}</s-text>}
      </s-stack>
      <s-paragraph>
        Members earn points when they leave a good product review on Judge.me. Each member is rewarded once per product, and only when we're sure who they are.
      </s-paragraph>
      {!reviewRuleActive && <s-banner tone="warning">Turn on a “Product review” earning rule above, or no review points will be given.</s-banner>}
      {jm.lastError && <s-banner tone="critical">Last error: {jm.lastError}</s-banner>}
      <fetcher.Form method="post">
        <input type="hidden" name="intent" value="judgeme-connect" />
        <s-stack gap="base">
          <s-grid gridTemplateColumns="repeat(auto-fit, minmax(220px, 1fr))" gap="base">
            <s-password-field
              label="Judge.me private API token"
              name="apiToken"
              placeholder={jm.connected ? "•••••••• (saved)" : "Paste your token"}
              details="Judge.me admin → Settings → General → Integrations"
            />
            <s-number-field label="Minimum star rating" name="minRating" min="1" max="5" step="1" value={String(jm.minRating)} />
          </s-grid>
          <s-stack direction="inline" gap="small">
            <s-button type="submit" variant="primary" loading={busy}>{jm.connected ? "Update" : "Connect Judge.me"}</s-button>
            {jm.connected && (
              <>
                <s-button onClick={() => send("judgeme-sync")} loading={busy}>Check for new reviews</s-button>
                <s-button tone="critical" variant="tertiary" onClick={() => send("judgeme-disconnect")}>Disconnect</s-button>
              </>
            )}
          </s-stack>
        </s-stack>
      </fetcher.Form>
      <s-text color="subdued">New reviews are picked up every few hours (and straight away when Judge.me can reach us). Your token is stored encrypted.</s-text>
    </s-stack>
  );
}

// ---- the page --------------------------------------------------------------------------------------

const EARN_GROUPS = [
  { title: "Purchases", keys: ["spend", "fixed", "big", "milestone"] },
  { title: "Customer actions", keys: ["welcome", "review"] },
  { title: "Referrals", keys: ["ref-friend", "ref-owner"] },
];
const EARN_ICON = { spend: "cart", fixed: "tag", big: "tag", milestone: "steps", welcome: "user", review: "star", "ref-friend": "gift", "ref-owner": "gift" };
const REDEEM_ICON = { cart: "cart", amount: "tag", percent: "percent" };

export default function Rules() {
  const { rules, rewards, currency, judgeme, fastCheckout } = useLoaderData();
  const money = useMoney(currency);
  const adder = useFetcher();
  const [picker, setPicker] = useState(null); // "earn" | "spend" | null
  useToast(adder);
  const p = presets(currency);
  const busy = adder.state !== "idle";

  const addRule = (preset) => {
    adder.submit({ intent: "rule-save", ...toForm({ ...preset.rule, active: true }) }, { method: "post" });
    setPicker(null);
  };
  const addReward = (preset) => {
    // Every spending rule shares one point value, so a new rule starts with the existing one.
    const first = rewards[0];
    const rate = first && first.pointsCost > 0 ? first.value / first.pointsCost : preset.reward.value;
    adder.submit({ intent: "reward-save", ...toForm({ ...preset.reward, value: rate, pointsCost: 1, active: true }) }, { method: "post" });
    setPicker(null);
  };
  const reviewRule = rules.find((r) => r.type === "REVIEW");

  const earnGroups = EARN_GROUPS.map((g) => ({
    title: g.title,
    items: g.keys.map((k) => ({ ...p.earn.find((e) => e.key === k), icon: EARN_ICON[k] })),
  }));
  const spendGroups = [{ title: "Ways to spend", items: p.redeem.map((x) => ({ ...x, icon: REDEEM_ICON[x.key] })) }];
  const spendTaken = () => false;
  const earnTaken = (it) => SINGLETON.includes(it.rule.type) && rules.some((r) => r.type === it.rule.type);

  return (
    <s-page heading="Rules">
      <style>{"@media (min-width:900px){.rules-row{grid-template-columns:minmax(220px,1fr) minmax(0,2fr) !important}} @media (min-width:760px){.edit-grid{grid-template-columns:minmax(0,2fr) minmax(240px,1fr) !important}}"}</style>

      <div style={{ paddingBottom: 24 }}>
        <p style={{ margin: "0 0 16px", fontSize: 14, color: "#374151", lineHeight: 1.55, maxWidth: 720 }}>
          Rules decide how customers <b>earn</b> points and how they <b>spend</b> them. Points are spent in the Shiprocket checkout, where the amount
          comes off the cart automatically, so there are no discount codes. Changes only affect future orders, never points a customer already has.
        </p>

        <SectionRow
          title="Ways to earn points"
          text="Pick what earns points: spending, order count, joining, reviews or referrals. Customers see these in your rewards widget."
          action={<s-button variant="primary" onClick={() => setPicker("earn")}>Add a way to earn</s-button>}
        >
          <Card title="Earning rules" note="Every rule that is on applies together. One order can earn from several rules at once, for example points per amount spent plus a bonus for the customer's first order.">
            {rules.length === 0 ? (
              <EmptyRow>No earning rules yet. Click “Add a way to earn” to create your first one.</EmptyRow>
            ) : (
              rules.map((r) => <RuleRow key={r.id} rule={r} currency={currency} money={money} />)
            )}
          </Card>
        </SectionRow>

        <SectionRow
          title="Ways to spend points"
          text="Choose what a point is worth and how much of a cart points can pay for: by cart value, a set amount, or a percentage. In Shiprocket checkout the customer's points come off the cart on their own: no codes."
          action={<s-button variant="primary" onClick={() => setPicker("spend")}>Add a way to spend</s-button>}
        >
          <Card title="Spending rules" note={fastCheckout.enabled ? "Points are used in Shiprocket checkout, on the cart. All spending rules share one point value; if more than one fits a cart, the one that lets the customer use the most points applies." : "Shiprocket checkout is off, so customers can't spend points yet. Turn it on in the Shiprocket section below."}>
            {rewards.length === 0 ? (
              <EmptyRow>No spending rule yet. Customers can't use points until you add one.</EmptyRow>
            ) : (
              rewards.map((r) => <RewardRow key={r.id} reward={r} currency={currency} money={money} />)
            )}
          </Card>
        </SectionRow>

        <SectionRow
          title="Product review points"
          text="Optional. Give points when customers leave a good review on Judge.me. Skip this if you don't use Judge.me."
        >
          <Card>
            <div style={{ padding: 16 }}>
              <JudgeMe jm={judgeme} reviewRuleActive={!!reviewRule?.active} />
            </div>
          </Card>
        </SectionRow>

        <SectionRow
          title="Shiprocket checkout"
          text="Optional. Only for stores that use Shiprocket Checkout instead of Shopify's own checkout, so customers can still spend points there."
        >
          <Card>
            <div style={{ padding: 16 }}>
              <FastCheckout fc={fastCheckout} />
            </div>
          </Card>
        </SectionRow>
      </div>

      <PickerModal
        open={picker === "earn"}
        title="Add a way to earn"
        intro="Customers earn from every rule that is on. You can change the numbers after adding."
        groups={earnGroups}
        taken={earnTaken}
        busy={busy}
        onPick={addRule}
        onClose={() => setPicker(null)}
      />
      <PickerModal
        open={picker === "spend"}
        title="Add a way to spend"
        intro="You can change the numbers after adding."
        groups={spendGroups}
        taken={spendTaken}
        busy={busy}
        onPick={addReward}
        onClose={() => setPicker(null)}
      />
    </s-page>
  );
}
