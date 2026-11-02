import { useEffect, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { requireStore } from "../services/auth.server";
import { connectJudgeMe, disconnect, getIntegration, syncJudgeMe } from "../services/integrations.server";
import db from "../db.server";
import BackButton from "../components/BackButton";

// Earning and spending rules, and review points, on one page.

const TRIGGERS = {
  PAID: "Order is paid",
  FULFILLED: "Order is fulfilled",
  DELIVERED: "Order is delivered",
};
const RULE_TYPES = {
  PURCHASE_PER_CURRENCY: "Points per amount spent",
  PURCHASE_FIXED: "Fixed points per order",
  SIGNUP: "Welcome bonus",
  REVIEW: "Product review",
  REFERRAL_FRIEND: "Referral: new customer bonus",
  REFERRAL_REFERRER: "Referral: referrer reward",
};
// Only the first rule of these types is used, so offer them once.
const SINGLETON = ["SIGNUP", "REVIEW", "REFERRAL_FRIEND", "REFERRAL_REFERRER"];
const REWARD_TYPES = {
  CUSTOM_AMOUNT: "Customer picks points",
  FIXED_AMOUNT: "Fixed amount off",
  PERCENTAGE: "Percentage off",
  FREE_SHIPPING: "Free shipping",
};

const int = (v, min, max, fallback = 0) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

export const loader = async ({ request }) => {
  const { store } = await requireStore(request);
  const [rules, rewards, jm] = await Promise.all([
    db.earnRule.findMany({ where: { storeId: store.id }, orderBy: { createdAt: "asc" } }),
    db.reward.findMany({ where: { storeId: store.id }, orderBy: { pointsCost: "asc" }, include: { _count: { select: { redemptions: true } } } }),
    getIntegration(store.id, "JUDGEME"),
  ]);
  const s = store.settings;
  return {
    currency: store.currency,
    settings: { earnTrigger: s.earnTrigger, holdDays: s.holdDays, expiryDays: s.expiryDays, minRedeemPoints: s.minRedeemPoints },
    rules: rules.map((r) => ({ id: r.id, name: r.name, type: r.type, value: r.value, minOrderAmount: Number(r.minOrderAmount), active: r.active })),
    rewards: rewards.map((r) => ({
      id: r.id, name: r.name, type: r.type, value: Number(r.value), pointsCost: r.pointsCost, minPoints: r.minPoints,
      maxPoints: r.maxPoints ?? 0, minOrderAmount: Number(r.minOrderAmount), codeValidDays: r.codeValidDays, active: r.active,
      redemptions: r._count.redemptions,
    })),
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
      const data = {
        name: String(f.get("name") || RULE_TYPES[type]).slice(0, 80),
        type,
        value: int(f.get("value"), 1, 1000000, 1),
        minOrderAmount: Math.max(0, Number(f.get("minOrderAmount")) || 0),
        active: f.get("active") !== "off",
      };
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
      const type = REWARD_TYPES[String(f.get("type"))] ? String(f.get("type")) : "FIXED_AMOUNT";
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
      if (!data.name) return { error: "Give it a name" };
      if (id) await db.reward.updateMany({ where: { id, storeId: store.id }, data });
      else await db.reward.create({ data: { ...data, storeId: store.id } });
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

function ruleSummary(r, money) {
  const min = r.minOrderAmount > 0 ? ` on orders over ${money(r.minOrderAmount)}` : "";
  switch (r.type) {
    case "PURCHASE_PER_CURRENCY": return `${pts(r.value)} for every ${money(1)} spent${min}`;
    case "PURCHASE_FIXED": return `${pts(r.value)} per order${min}`;
    case "SIGNUP": return `${pts(r.value)} when someone joins`;
    case "REVIEW": return `${pts(r.value)} for each product review (needs Judge.me)`;
    case "REFERRAL_FRIEND": return `A new customer gets ${pts(r.value)} bonus on their first order${min}`;
    case "REFERRAL_REFERRER": return `The referrer gets ${pts(r.value)} when their friend's first order is complete${min}`;
    default: return "";
  }
}

function rewardSummary(r, money) {
  const min = r.minOrderAmount > 0 ? ` · orders over ${money(r.minOrderAmount)}` : "";
  if (r.type === "CUSTOM_AMOUNT") return `Customer picks ${pts(r.minPoints || r.pointsCost)} to ${r.maxPoints ? pts(r.maxPoints) : "their whole balance"} · ${money(r.value)} per ${pts(r.pointsCost)}${min}`;
  if (r.type === "FIXED_AMOUNT") return `${money(r.value)} off for ${pts(r.pointsCost)}${min}`;
  if (r.type === "PERCENTAGE") return `${r.value}% off for ${pts(r.pointsCost)}${min}`;
  return `Free shipping for ${pts(r.pointsCost)}${min}`;
}

// Ready-made starting points. Amounts are in the store's currency, scaled to something sensible.
function presets(currency) {
  const big = currency === "INR" ? 1000 : currency === "JPY" ? 5000 : 50;
  const off = currency === "INR" ? 100 : currency === "JPY" ? 500 : 5;
  const step = currency === "JPY" ? 100 : 1; // value of 100 points
  return {
    earn: [
      { key: "spend", title: "Points for every purchase", text: "Customers earn points on what they spend.", rule: { name: "Points per order", type: "PURCHASE_PER_CURRENCY", value: 1, minOrderAmount: 0 } },
      { key: "big", title: "Bonus on big orders", text: "Extra points when an order is over a set amount.", rule: { name: "Big order bonus", type: "PURCHASE_FIXED", value: 100, minOrderAmount: big } },
      { key: "welcome", title: "Welcome bonus", text: "Points when someone joins your rewards.", rule: { name: "Welcome bonus", type: "SIGNUP", value: 50, minOrderAmount: 0 } },
      { key: "review", title: "Reward product reviews", text: "Points for good reviews (uses Judge.me).", rule: { name: "Product review", type: "REVIEW", value: 50, minOrderAmount: 0 } },
      { key: "ref-friend", title: "Referral: new customer bonus", text: "Bonus for a customer who uses a friend's code.", rule: { name: "Referral bonus for new customer", type: "REFERRAL_FRIEND", value: 100, minOrderAmount: 0 } },
      { key: "ref-owner", title: "Referral: reward for the referrer", text: "Points when their friend completes a first order.", rule: { name: "Referral reward", type: "REFERRAL_REFERRER", value: 200, minOrderAmount: 0 } },
    ],
    redeem: [
      { key: "any", title: "Spend any amount of points", text: "Customer chooses how many points to use, up to a maximum.", reward: { name: "Use points at checkout", type: "CUSTOM_AMOUNT", value: step, pointsCost: 100, minPoints: 100, maxPoints: 2000, minOrderAmount: 0, codeValidDays: 30 } },
      { key: "fixed", title: "Fixed amount off", text: "A set discount for a set number of points.", reward: { name: `${off} off your order`, type: "FIXED_AMOUNT", value: off, pointsCost: Math.round((off / step) * 100), minPoints: 0, maxPoints: 0, minOrderAmount: 0, codeValidDays: 30 } },
      { key: "percent", title: "Percentage off", text: "A percentage discount for a set number of points.", reward: { name: "10% off your order", type: "PERCENTAGE", value: 10, pointsCost: 1500, minPoints: 0, maxPoints: 0, minOrderAmount: 0, codeValidDays: 30 } },
      { key: "ship", title: "Free shipping", text: "Waive shipping for a set number of points.", reward: { name: "Free shipping", type: "FREE_SHIPPING", value: 0, pointsCost: 800, minPoints: 0, maxPoints: 0, minOrderAmount: 0, codeValidDays: 30 } },
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

function RuleRow({ rule, currency, money }) {
  const fetcher = useFetcher();
  const [open, setOpen] = useState(false);
  useToast(fetcher);
  useEffect(() => {
    if (fetcher.state === "idle" && (fetcher.data?.ok === "Saved" || fetcher.data?.ok === "Removed")) setOpen(false);
  }, [fetcher.state, fetcher.data]);

  const valueLabel =
    rule.type === "PURCHASE_PER_CURRENCY" ? `Points per ${money(1)} spent`
    : rule.type === "PURCHASE_FIXED" ? "Points per order"
    : rule.type === "SIGNUP" ? "Welcome points"
    : rule.type === "REVIEW" ? "Points per review"
    : rule.type === "REFERRAL_FRIEND" ? "Bonus points"
    : "Reward points";
  const hasMin = !["SIGNUP", "REVIEW"].includes(rule.type);

  return (
    <s-box padding="base" border="base" borderRadius="base">
      <s-stack gap="base">
        <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base">
          <s-stack gap="small-300">
            <s-stack direction="inline" gap="small" alignItems="center">
              <s-text type="strong">{rule.name}</s-text>
              <s-badge tone={rule.active ? "success" : "neutral"}>{rule.active ? "Active" : "Off"}</s-badge>
            </s-stack>
            <s-text color="subdued">{ruleSummary(rule, money)}</s-text>
          </s-stack>
          <s-stack direction="inline" gap="small" alignItems="center">
            <s-checkbox
              label="Active"
              checked={rule.active}
              onChange={(e) => fetcher.submit({ intent: "rule-toggle", id: rule.id, active: String(e.currentTarget.checked) }, { method: "post" })}
            />
            <s-button variant="tertiary" onClick={() => setOpen((v) => !v)}>
              {open ? "Close" : "Edit"}
            </s-button>
          </s-stack>
        </s-stack>

        {open && (
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="rule-save" />
            <input type="hidden" name="id" value={rule.id} />
            <input type="hidden" name="type" value={rule.type} />
            <input type="hidden" name="active" value={rule.active ? "on" : "off"} />
            <s-stack gap="base">
              <s-grid gridTemplateColumns="repeat(auto-fit, minmax(190px, 1fr))" gap="base">
                <s-text-field label="Name (shown to customers)" name="name" value={rule.name} />
                <s-number-field label={valueLabel} name="value" min="1" step="1" value={String(rule.value)} />
                {hasMin && (
                  <s-number-field
                    label={`Minimum order (${currency})`}
                    name="minOrderAmount"
                    min="0"
                    value={String(rule.minOrderAmount)}
                    details="0 = any order"
                  />
                )}
              </s-grid>
              <s-stack direction="inline" justifyContent="space-between">
                <s-button tone="critical" variant="tertiary" onClick={() => window.confirm("Remove this rule?") && fetcher.submit({ intent: "rule-delete", id: rule.id }, { method: "post" })}>
                  Remove
                </s-button>
                <s-button type="submit" variant="primary" loading={fetcher.state !== "idle" || undefined}>
                  Save
                </s-button>
              </s-stack>
            </s-stack>
          </fetcher.Form>
        )}
      </s-stack>
    </s-box>
  );
}

function RewardRow({ reward, currency, money }) {
  const fetcher = useFetcher();
  const [open, setOpen] = useState(false);
  const [type, setType] = useState(reward.type);
  useToast(fetcher);
  useEffect(() => {
    if (fetcher.state === "idle" && (fetcher.data?.ok === "Saved" || fetcher.data?.ok === "Removed")) setOpen(false);
  }, [fetcher.state, fetcher.data]);
  const custom = type === "CUSTOM_AMOUNT";

  return (
    <s-box padding="base" border="base" borderRadius="base">
      <s-stack gap="base">
        <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base">
          <s-stack gap="small-300">
            <s-stack direction="inline" gap="small" alignItems="center">
              <s-text type="strong">{reward.name}</s-text>
              <s-badge tone={reward.active ? "success" : "neutral"}>{reward.active ? "Active" : "Off"}</s-badge>
            </s-stack>
            <s-text color="subdued">
              {rewardSummary(reward, money)} · {reward.redemptions} redeemed
            </s-text>
          </s-stack>
          <s-stack direction="inline" gap="small" alignItems="center">
            <s-checkbox
              label="Active"
              checked={reward.active}
              onChange={(e) => fetcher.submit({ intent: "reward-toggle", id: reward.id, active: String(e.currentTarget.checked) }, { method: "post" })}
            />
            <s-button variant="tertiary" onClick={() => setOpen((v) => !v)}>
              {open ? "Close" : "Edit"}
            </s-button>
          </s-stack>
        </s-stack>

        {open && (
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="reward-save" />
            <input type="hidden" name="id" value={reward.id} />
            <input type="hidden" name="active" value={reward.active ? "on" : "off"} />
            <s-stack gap="base">
              <s-grid gridTemplateColumns="repeat(auto-fit, minmax(190px, 1fr))" gap="base">
                <s-text-field label="Name (shown to customers)" name="name" value={reward.name} />
                <s-select label="Type" name="type" value={type} onChange={(e) => setType(e.currentTarget.value)}>
                  {Object.entries(REWARD_TYPES).map(([k, v]) => (
                    <s-option key={k} value={k}>{v}</s-option>
                  ))}
                </s-select>
                {type !== "FREE_SHIPPING" && (
                  <s-number-field
                    label={custom ? `Worth (${currency}) per step` : type === "PERCENTAGE" ? "Percent off" : `Amount off (${currency})`}
                    name="value"
                    min="0"
                    step="any"
                    value={String(reward.value)}
                  />
                )}
                <s-number-field
                  label={custom ? "Points per step" : "Points cost"}
                  name="pointsCost"
                  min="1"
                  step="1"
                  value={String(reward.pointsCost)}
                  details={custom ? "e.g. 100 points = the amount on the left" : undefined}
                />
                {custom && (
                  <>
                    <s-number-field label="Minimum points to use" name="minPoints" min="0" step="1" value={String(reward.minPoints)} />
                    <s-number-field label="Maximum points per redemption" name="maxPoints" min="0" step="1" value={String(reward.maxPoints)} details="0 = no cap" />
                  </>
                )}
                <s-number-field label={`Minimum order (${currency})`} name="minOrderAmount" min="0" value={String(reward.minOrderAmount)} details="0 = any order" />
                <s-number-field label="Code valid for (days)" name="codeValidDays" min="0" step="1" value={String(reward.codeValidDays)} details="0 = never expires" />
              </s-grid>
              <s-stack direction="inline" justifyContent="space-between">
                <s-button tone="critical" variant="tertiary" onClick={() => window.confirm("Remove this reward? Past redemptions stay in the history.") && fetcher.submit({ intent: "reward-delete", id: reward.id }, { method: "post" })}>
                  Remove
                </s-button>
                <s-button type="submit" variant="primary" loading={fetcher.state !== "idle" || undefined}>
                  Save
                </s-button>
              </s-stack>
            </s-stack>
          </fetcher.Form>
        )}
      </s-stack>
    </s-box>
  );
}

function PresetGallery({ items, existing, singleton, onAdd, busy }) {
  return (
    <s-grid gridTemplateColumns="repeat(auto-fit, minmax(230px, 1fr))" gap="base">
      {items.map((p) => {
        const has = singleton && singleton(p, existing);
        return (
          <s-box key={p.key} padding="base" border="base" borderRadius="base" background="subdued">
            <s-stack gap="small">
              <s-text type="strong">{p.title}</s-text>
              <s-text color="subdued">{p.text}</s-text>
              <s-stack direction="inline">
                <s-button disabled={has || busy || undefined} onClick={() => onAdd(p)}>
                  {has ? "Already added" : "Add"}
                </s-button>
              </s-stack>
            </s-stack>
          </s-box>
        );
      })}
    </s-grid>
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

export default function Rules() {
  const { settings, rules, rewards, currency, judgeme } = useLoaderData();
  const money = useMoney(currency);
  const settingsFetcher = useFetcher();
  const adder = useFetcher();
  useToast(settingsFetcher);
  useToast(adder);
  const p = presets(currency);

  const addRule = (preset) => adder.submit({ intent: "rule-save", ...toForm({ ...preset.rule, active: true }) }, { method: "post" });
  const addReward = (preset) => adder.submit({ intent: "reward-save", ...toForm({ ...preset.reward, active: true }) }, { method: "post" });
  const reviewRule = rules.find((r) => r.type === "REVIEW");

  return (
    <s-page heading="Rules">
      <BackButton href="/app" label="Back to home" />
      <s-section heading="When points are credited">
        <settingsFetcher.Form method="post">
          <input type="hidden" name="intent" value="settings" />
          <s-stack gap="base">
            <s-grid gridTemplateColumns="repeat(auto-fit, minmax(200px, 1fr))" gap="base">
              <s-select label="Credit points when" name="earnTrigger" value={settings.earnTrigger}>
                {Object.entries(TRIGGERS).map(([k, v]) => (
                  <s-option key={k} value={k}>{v}</s-option>
                ))}
              </s-select>
              <s-number-field label="Wait after that (days)" name="holdDays" min="0" step="1" value={String(settings.holdDays)} details="Your return window. 0 = credit straight away" />
              <s-number-field label="Points expire after (days)" name="expiryDays" min="0" step="1" value={String(settings.expiryDays)} details="0 = never expire. Customers get a reminder email first" />
              <s-number-field label="Minimum balance to redeem" name="minRedeemPoints" min="0" step="1" value={String(settings.minRedeemPoints)} />
            </s-grid>
            <s-stack direction="inline" justifyContent="end">
              <s-button type="submit" variant="primary" loading={settingsFetcher.state !== "idle" || undefined}>Save</s-button>
            </s-stack>
          </s-stack>
        </settingsFetcher.Form>
        <s-box paddingBlockStart="base">
          <s-banner tone="info">
            Delivery and returns come straight from Shopify. While a return is open, waiting points are held. If the return
            completes, the order's points are cancelled (or taken back if already credited) and never credited. If it's declined or
            cancelled, crediting carries on. Refunds reduce points in proportion.
          </s-banner>
        </s-box>
      </s-section>

      <s-section heading="Ways to earn">
        <s-stack gap="base">
          {rules.length === 0 && <s-paragraph>No earning rules yet. Add one from the ready-made options below.</s-paragraph>}
          {rules.map((r) => (
            <RuleRow key={r.id} rule={r} currency={currency} money={money} />
          ))}
          <s-heading>Add a way to earn</s-heading>
          <PresetGallery
            items={p.earn}
            existing={rules}
            singleton={(preset, existing) => SINGLETON.includes(preset.rule.type) && existing.some((r) => r.type === preset.rule.type)}
            onAdd={addRule}
            busy={adder.state !== "idle"}
          />
        </s-stack>
      </s-section>

      <s-section heading="Ways to spend points">
        <s-stack gap="base">
          {rewards.length === 0 && <s-paragraph>No rewards yet. Add one below so customers have something to redeem.</s-paragraph>}
          {rewards.map((r) => (
            <RewardRow key={r.id} reward={r} currency={currency} money={money} />
          ))}
          <s-paragraph>
            Redeeming creates a single-use Shopify discount code for that customer. They copy it and paste it at checkout, and Shopify takes
            the amount off before payment, whatever payment method they use.
          </s-paragraph>
          <s-heading>Add a way to spend</s-heading>
          <PresetGallery items={p.redeem} existing={rewards} onAdd={addReward} busy={adder.state !== "idle"} />
        </s-stack>
      </s-section>

      <s-section heading="Review points (Judge.me)">
        <JudgeMe jm={judgeme} reviewRuleActive={!!reviewRule?.active} />
      </s-section>
    </s-page>
  );
}
