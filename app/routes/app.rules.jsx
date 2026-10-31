import { useEffect } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { requireStore } from "../services/auth.server";
import db from "../db.server";

const TRIGGERS = {
  PAID: "Order is paid",
  FULFILLED: "Order is fulfilled",
  DELIVERED: "Order is delivered",
};
const RULE_TYPES = {
  PURCHASE_PER_CURRENCY: "Points per currency unit spent",
  PURCHASE_FIXED: "Fixed points per order",
  SIGNUP: "Welcome bonus (one-time)",
  REFERRAL_FRIEND: "Referral: bonus for the new customer (first order)",
  REFERRAL_REFERRER: "Referral: reward for the referrer (friend's first order)",
  REVIEW: "Product review (Judge.me)",
};

const int = (v, min, max, fallback = 0) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

export const loader = async ({ request }) => {
  const { store } = await requireStore(request);
  const rules = await db.earnRule.findMany({ where: { storeId: store.id }, orderBy: { createdAt: "asc" } });
  const s = store.settings;
  return {
    currency: store.currency,
    settings: {
      earnTrigger: s.earnTrigger,
      holdDays: s.holdDays,
      expiryDays: s.expiryDays,
      minRedeemPoints: s.minRedeemPoints,
    },
    rules: rules.map((r) => ({ ...r, minOrderAmount: Number(r.minOrderAmount) })),
  };
};

export const action = async ({ request }) => {
  const { store } = await requireStore(request);
  const f = await request.formData();
  const intent = String(f.get("intent"));

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
    return { ok: "Settings saved" };
  }

  if (intent === "rule-save") {
    const type = RULE_TYPES[String(f.get("type"))] ? String(f.get("type")) : "PURCHASE_PER_CURRENCY";
    const data = {
      name: String(f.get("name") || RULE_TYPES[type]).slice(0, 80),
      type,
      value: int(f.get("value"), 1, 1000000, 1),
      minOrderAmount: Math.max(0, Number(f.get("minOrderAmount")) || 0),
      active: f.get("active") === "on",
    };
    const id = String(f.get("id") || "");
    if (id) {
      // storeId in the filter keeps one shop from editing another shop's rule by guessing ids
      await db.earnRule.updateMany({ where: { id, storeId: store.id }, data });
    } else {
      await db.earnRule.create({ data: { ...data, storeId: store.id } });
    }
    return { ok: "Rule saved" };
  }

  if (intent === "rule-delete") {
    await db.earnRule.deleteMany({ where: { id: String(f.get("id")), storeId: store.id } });
    return { ok: "Rule deleted" };
  }
  return { error: "Unknown action" };
};

function useToast(fetcher) {
  const shopify = useAppBridge();
  useEffect(() => {
    if (fetcher.data?.ok) shopify.toast.show(fetcher.data.ok);
    if (fetcher.data?.error) shopify.toast.show(fetcher.data.error, { isError: true });
  }, [fetcher.data, shopify]);
}

function RuleForm({ rule, currency }) {
  const fetcher = useFetcher();
  useToast(fetcher);
  const isNew = !rule;
  return (
    <fetcher.Form method="post">
      <input type="hidden" name="intent" value="rule-save" />
      {rule && <input type="hidden" name="id" value={rule.id} />}
      <s-box padding="base" border="base" borderRadius="base">
        <s-stack gap="base">
          <s-grid gridTemplateColumns="repeat(auto-fit, minmax(180px, 1fr))" gap="base">
            <s-text-field label="Name" name="name" value={rule?.name ?? ""} placeholder="e.g. Points per order" />
            <s-select label="Type" name="type" value={rule?.type ?? "PURCHASE_PER_CURRENCY"}>
              {Object.entries(RULE_TYPES).map(([k, v]) => (
                <s-option key={k} value={k}>
                  {v}
                </s-option>
              ))}
            </s-select>
            <s-number-field label="Points" name="value" min="1" step="1" value={String(rule?.value ?? 1)} />
            <s-number-field
              label={`Minimum order (${currency})`}
              name="minOrderAmount"
              min="0"
              value={String(rule?.minOrderAmount ?? 0)}
            />
          </s-grid>
          <s-stack direction="inline" gap="base" justifyContent="space-between" alignItems="center">
            <s-checkbox label="Active" name="active" value="on" checked={rule ? rule.active : true} />
            <s-stack direction="inline" gap="small">
              {!isNew && (
                <s-button
                  tone="critical"
                  variant="tertiary"
                  onClick={() => fetcher.submit({ intent: "rule-delete", id: rule.id }, { method: "post" })}
                >
                  Delete
                </s-button>
              )}
              <s-button type="submit" variant={isNew ? "primary" : "secondary"} loading={fetcher.state !== "idle" || undefined}>
                {isNew ? "Add rule" : "Save"}
              </s-button>
            </s-stack>
          </s-stack>
        </s-stack>
      </s-box>
    </fetcher.Form>
  );
}

export default function Rules() {
  const { settings, rules, currency } = useLoaderData();
  const fetcher = useFetcher();
  useToast(fetcher);

  return (
    <s-page heading="Earning rules">
      <s-section heading="When points are credited">
        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="settings" />
          <s-stack gap="base">
            <s-paragraph>
              Choose the order status that makes an order eligible, and how long to wait afterwards. Use{" "}
              <s-text type="strong">0 days</s-text> to credit points the moment that status is reached. Refunds and
              cancellations before then reduce or cancel the points.
            </s-paragraph>
            <s-grid gridTemplateColumns="repeat(auto-fit, minmax(200px, 1fr))" gap="base">
              <s-select label="Credit points when" name="earnTrigger" value={settings.earnTrigger}>
                {Object.entries(TRIGGERS).map(([k, v]) => (
                  <s-option key={k} value={k}>
                    {v}
                  </s-option>
                ))}
              </s-select>
              <s-number-field
                label="Wait (days)"
                name="holdDays"
                min="0"
                step="1"
                value={String(settings.holdDays)}
                details="0 = credit immediately"
              />
              <s-number-field
                label="Points expire after (days)"
                name="expiryDays"
                min="0"
                step="1"
                value={String(settings.expiryDays)}
                details="0 = never expire"
              />
              <s-number-field
                label="Minimum balance to redeem"
                name="minRedeemPoints"
                min="0"
                step="1"
                value={String(settings.minRedeemPoints)}
              />
            </s-grid>
            <s-stack direction="inline" justifyContent="end">
              <s-button type="submit" variant="primary" loading={fetcher.state !== "idle" || undefined}>
                Save
              </s-button>
            </s-stack>
          </s-stack>
        </fetcher.Form>
        <s-box paddingBlockStart="base">
          <s-banner tone="info">
            "Order is delivered" relies on carrier delivery events reaching Shopify (for example from your shipping
            app). Orders without those events won't be credited under that setting.
          </s-banner>
        </s-box>
      </s-section>

      <s-section heading="Ways to earn">
        <s-stack gap="base">
          {rules.map((r) => (
            <RuleForm key={r.id} rule={r} currency={currency} />
          ))}
          <s-heading>Add a rule</s-heading>
          <RuleForm key={`new-${rules.length}`} currency={currency} />
        </s-stack>
      </s-section>
    </s-page>
  );
}
