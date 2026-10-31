import { useEffect, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { requireStore } from "../services/auth.server";
import db from "../db.server";

const TYPES = {
  CUSTOM_AMOUNT: "Customer picks points (e.g. 100 points = 1 unit of your currency)",
  FIXED_AMOUNT: "Fixed amount off",
  PERCENTAGE: "Percentage off",
  FREE_SHIPPING: "Free shipping",
};

export const loader = async ({ request }) => {
  const { store } = await requireStore(request);
  const rewards = await db.reward.findMany({
    where: { storeId: store.id },
    orderBy: { pointsCost: "asc" },
    include: { _count: { select: { redemptions: true } } },
  });
  return {
    currency: store.currency,
    rewards: rewards.map((r) => ({
      id: r.id,
      name: r.name,
      type: r.type,
      value: Number(r.value),
      pointsCost: r.pointsCost,
      minPoints: r.minPoints,
      maxPoints: r.maxPoints ?? 0,
      minOrderAmount: Number(r.minOrderAmount),
      codeValidDays: r.codeValidDays,
      active: r.active,
      redemptions: r._count.redemptions,
    })),
  };
};

export const action = async ({ request }) => {
  const { store } = await requireStore(request);
  const f = await request.formData();
  const intent = String(f.get("intent"));

  if (intent === "reward-save") {
    const type = TYPES[String(f.get("type"))] ? String(f.get("type")) : "FIXED_AMOUNT";
    let value = Math.max(0, Number(f.get("value")) || 0);
    if (type === "PERCENTAGE") value = Math.min(100, value);
    if (type === "FREE_SHIPPING") value = 0;
    if (type !== "FREE_SHIPPING" && value <= 0) return { error: "Enter a discount value above 0" };

    const custom = type === "CUSTOM_AMOUNT";
    const minPoints = custom ? Math.max(0, Math.floor(Number(f.get("minPoints")) || 0)) : 0;
    const maxPoints = custom ? Math.max(0, Math.floor(Number(f.get("maxPoints")) || 0)) || null : null;
    if (maxPoints && maxPoints < Math.max(minPoints, Math.floor(Number(f.get("pointsCost")) || 1))) {
      return { error: "Maximum points must be at least the minimum (and one step)" };
    }

    const data = {
      name: String(f.get("name") || "").trim().slice(0, 80),
      type,
      value,
      minPoints,
      maxPoints,
      pointsCost: Math.max(1, Math.floor(Number(f.get("pointsCost")) || 0)),
      minOrderAmount: Math.max(0, Number(f.get("minOrderAmount")) || 0),
      codeValidDays: Math.max(0, Math.min(3650, Math.floor(Number(f.get("codeValidDays")) || 0))),
      active: f.get("active") === "on",
    };
    if (!data.name) return { error: "Give the reward a name" };

    const id = String(f.get("id") || "");
    if (id) await db.reward.updateMany({ where: { id, storeId: store.id }, data });
    else await db.reward.create({ data: { ...data, storeId: store.id } });
    return { ok: "Reward saved" };
  }

  if (intent === "reward-delete") {
    // Redemptions keep a snapshot of the reward name, so history survives deletion.
    await db.reward.deleteMany({ where: { id: String(f.get("id")), storeId: store.id } });
    return { ok: "Reward deleted" };
  }
  return { error: "Unknown action" };
};

function RewardForm({ reward, currency }) {
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  useEffect(() => {
    if (fetcher.data?.ok) shopify.toast.show(fetcher.data.ok);
    if (fetcher.data?.error) shopify.toast.show(fetcher.data.error, { isError: true });
  }, [fetcher.data, shopify]);
  const isNew = !reward;
  const [type, setType] = useState(reward?.type ?? "CUSTOM_AMOUNT");
  const custom = type === "CUSTOM_AMOUNT";

  return (
    <fetcher.Form method="post">
      <input type="hidden" name="intent" value="reward-save" />
      {reward && <input type="hidden" name="id" value={reward.id} />}
      <s-box padding="base" border="base" borderRadius="base">
        <s-stack gap="base">
          <s-grid gridTemplateColumns="repeat(auto-fit, minmax(180px, 1fr))" gap="base">
            <s-text-field label="Name" name="name" value={reward?.name ?? ""} placeholder={`e.g. ${currency} 5 off your order`} />
            <s-select label="Discount type" name="type" value={type} onChange={(e) => setType(e.currentTarget.value)}>
              {Object.entries(TYPES).map(([k, v]) => (
                <s-option key={k} value={k}>
                  {v}
                </s-option>
              ))}
            </s-select>
            <s-number-field
              label={custom ? `Worth (${currency}) per step` : `Value (${currency} or %)`}
              name="value"
              min="0"
              value={String(reward?.value ?? (custom ? 1 : 5))}
              details={custom ? "Discount for each block of points below" : "Ignored for free shipping"}
            />
            <s-number-field
              label={custom ? "Points per step" : "Points cost"}
              name="pointsCost"
              min="1"
              step="1"
              value={String(reward?.pointsCost ?? (custom ? 100 : 500))}
              details={custom ? "e.g. 100 points = the value on the left" : undefined}
            />
            {custom && (
              <>
                <s-number-field
                  label="Minimum points to use"
                  name="minPoints"
                  min="0"
                  step="1"
                  value={String(reward?.minPoints ?? 100)}
                />
                <s-number-field
                  label="Maximum points per redemption"
                  name="maxPoints"
                  min="0"
                  step="1"
                  value={String(reward?.maxPoints ?? 2000)}
                  details="0 = no cap (balance is the only limit)"
                />
              </>
            )}
            <s-number-field
              label={`Minimum order (${currency})`}
              name="minOrderAmount"
              min="0"
              value={String(reward?.minOrderAmount ?? 0)}
            />
            <s-number-field
              label="Code valid for (days)"
              name="codeValidDays"
              min="0"
              step="1"
              value={String(reward?.codeValidDays ?? 30)}
              details="0 = never expires"
            />
          </s-grid>
          <s-stack direction="inline" gap="base" justifyContent="space-between" alignItems="center">
            <s-stack direction="inline" gap="base" alignItems="center">
              <s-checkbox label="Active" name="active" value="on" checked={reward ? reward.active : true} />
              {reward && <s-text color="subdued">{reward.redemptions} redeemed</s-text>}
            </s-stack>
            <s-stack direction="inline" gap="small">
              {!isNew && (
                <s-button
                  tone="critical"
                  variant="tertiary"
                  onClick={() => fetcher.submit({ intent: "reward-delete", id: reward.id }, { method: "post" })}
                >
                  Delete
                </s-button>
              )}
              <s-button type="submit" variant={isNew ? "primary" : "secondary"} loading={fetcher.state !== "idle" || undefined}>
                {isNew ? "Add reward" : "Save"}
              </s-button>
            </s-stack>
          </s-stack>
        </s-stack>
      </s-box>
    </fetcher.Form>
  );
}

export default function Rewards() {
  const { rewards, currency } = useLoaderData();
  return (
    <s-page heading="Rewards">
      <s-section heading="What customers can redeem">
        <s-stack gap="base">
          <s-paragraph>
            When a customer redeems, we deduct the points and create a single-use Shopify discount code tied to their
            account. Shopify applies it at checkout, so the customer pays the reduced total with any payment method.
            With <s-text type="strong">Customer picks points</s-text> they choose how many points to spend, up to the
            maximum you set.
          </s-paragraph>
          {rewards.map((r) => (
            <RewardForm key={r.id} reward={r} currency={currency} />
          ))}
          <s-heading>Add a reward</s-heading>
          <RewardForm key={`new-${rewards.length}`} currency={currency} />
        </s-stack>
      </s-section>
    </s-page>
  );
}
