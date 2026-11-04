import { useEffect, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { requireStore } from "../services/auth.server";
import { InsufficientPointsError, postTransaction } from "../services/ledger.server";
import { creditPoints } from "../services/credit.server";
import { convert, getFx } from "../services/currency.server";
import { customerReferralStats } from "../services/referralstats.server";
import db from "../db.server";

export const loader = async ({ request, params }) => {
  const { store } = await requireStore(request);
  // Scoped by store: another shop's customer id simply 404s.
  const customer = await db.customer.findFirst({ where: { id: params.id, storeId: store.id } });
  if (!customer) throw new Response("Not found", { status: 404 });

  const [ledger, codes, refStats, fx] = await Promise.all([
    db.pointsTransaction.findMany({ where: { customerId: customer.id }, orderBy: { createdAt: "desc" }, take: 50 }),
    db.redemption.findMany({ where: { customerId: customer.id }, orderBy: { createdAt: "desc" }, take: 20 }),
    customerReferralStats(store.id, customer.id),
    getFx(store),
  ]);

  // Revenue is stored in the store currency; show it in the merchant's reporting currency.
  const referrals = {
    currency: fx.to,
    converted: fx.converted,
    from: fx.from,
    referredBy: refStats.referredBy,
    totals: { ...refStats.totals, revenue: convert(refStats.totals.revenue, fx) },
    friends: refStats.friends.map((f) => ({ ...f, revenue: convert(f.revenue, fx) })),
  };

  return {
    referrals,
    customer: {
      id: customer.id,
      name: [customer.firstName, customer.lastName].filter(Boolean).join(" ") || "Customer",
      email: customer.email,
      shopifyId: customer.shopifyCustomerId,
      balance: customer.pointsBalance,
      lifetime: customer.lifetimePoints,
    },
    ledger: ledger.map((t) => ({
      id: t.id,
      at: t.createdAt.toISOString().slice(0, 16).replace("T", " "),
      type: t.type,
      points: t.points,
      after: t.balanceAfter,
      note: t.note || "",
      expires: t.expiresAt ? t.expiresAt.toISOString().slice(0, 10) : "",
    })),
    codes: codes.map((r) => ({
      id: r.id,
      name: r.rewardName,
      code: r.code,
      status: r.status,
      points: r.points,
      at: r.createdAt.toISOString().slice(0, 10),
    })),
  };
};

export const action = async ({ request, params }) => {
  const { store } = await requireStore(request);
  const customer = await db.customer.findFirst({ where: { id: params.id, storeId: store.id } });
  if (!customer) return { error: "Customer not found" };

  const f = await request.formData();
  const points = Math.trunc(Number(f.get("points")));
  if (!Number.isFinite(points) || points === 0) return { error: "Enter a non-zero number of points" };
  if (Math.abs(points) > 1_000_000) return { error: "That's too many points" };

  const note = String(f.get("note") || "Manual adjustment").slice(0, 120);
  // Same form submission can't be applied twice (double-click / resubmit).
  const key = `adjust:${String(f.get("requestId"))}`;
  try {
    if (points > 0) {
      // Credits respect the store's expiry setting and email the customer.
      await creditPoints({ storeId: store.id, customerId: customer.id, points, type: "ADJUST", source: "manual", key, reason: note });
    } else {
      await postTransaction({ storeId: store.id, customerId: customer.id, type: "ADJUST", points, source: "manual", idempotencyKey: key, note });
    }
  } catch (e) {
    if (e instanceof InsufficientPointsError) return { error: "The customer doesn't have that many points" };
    throw e;
  }
  return { ok: "Balance updated" };
};

export default function CustomerDetail() {
  const { customer, ledger, codes, referrals } = useLoaderData();
  const money = (n) => {
    try {
      return new Intl.NumberFormat("en", { style: "currency", currency: referrals.currency, maximumFractionDigits: 2 }).format(n);
    } catch {
      return `${n.toFixed(2)} ${referrals.currency}`;
    }
  };
  const statusTone = { REWARDED: "success", PENDING: "warning", REVERSED: "critical" };
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  // Generated client-side (not during SSR) and refreshed after each result so a double
  // submit is deduped by the ledger but a deliberate second adjustment is not.
  const [requestId, setRequestId] = useState("");
  useEffect(() => setRequestId(crypto.randomUUID()), [fetcher.data]);

  useEffect(() => {
    if (fetcher.data?.ok) shopify.toast.show(fetcher.data.ok);
    if (fetcher.data?.error) shopify.toast.show(fetcher.data.error, { isError: true });
  }, [fetcher.data, shopify]);

  return (
    <s-page heading={customer.name}>
      <s-section heading="Balance">
        <s-grid gridTemplateColumns="repeat(auto-fit, minmax(160px, 1fr))" gap="base">
          <s-box padding="base" border="base" borderRadius="base" background="subdued">
            <s-text color="subdued">Current balance</s-text>
            <s-heading>{customer.balance}</s-heading>
          </s-box>
          <s-box padding="base" border="base" borderRadius="base" background="subdued">
            <s-text color="subdued">Lifetime earned</s-text>
            <s-heading>{customer.lifetime}</s-heading>
          </s-box>
          <s-box padding="base" border="base" borderRadius="base" background="subdued">
            <s-text color="subdued">Email</s-text>
            <s-heading>{customer.email || "—"}</s-heading>
          </s-box>
        </s-grid>
      </s-section>

      <s-section heading="Adjust points">
        <fetcher.Form method="post">
          <input type="hidden" name="requestId" value={requestId} />
          <s-stack gap="base">
            <s-grid gridTemplateColumns="repeat(auto-fit, minmax(200px, 1fr))" gap="base">
              <s-number-field label="Points (use a minus to remove)" name="points" step="1" value="0" />
              <s-text-field label="Reason" name="note" placeholder="e.g. Goodwill credit" />
            </s-grid>
            <s-stack direction="inline" justifyContent="end">
              <s-button type="submit" variant="primary" loading={fetcher.state !== "idle" || undefined}>
                Apply
              </s-button>
            </s-stack>
          </s-stack>
        </fetcher.Form>
      </s-section>

      <s-section heading="Referrals">
        <s-stack gap="base">
          {referrals.referredBy && (
            <s-text>
              Referred by <s-link href={`/app/customers/${referrals.referredBy.id}`}>{referrals.referredBy.name}</s-link>{" "}
              <s-badge tone={statusTone[referrals.referredBy.status] ?? "neutral"}>{referrals.referredBy.status.toLowerCase()}</s-badge>
            </s-text>
          )}

          <s-grid gridTemplateColumns="repeat(auto-fit, minmax(150px, 1fr))" gap="base">
            <s-box padding="base" border="base" borderRadius="base" background="subdued">
              <s-text color="subdued">Customers referred</s-text>
              <s-heading>{referrals.totals.referred}</s-heading>
              <s-text color="subdued">{referrals.totals.rewarded} rewarded</s-text>
            </s-box>
            <s-box padding="base" border="base" borderRadius="base" background="subdued">
              <s-text color="subdued">Revenue from them</s-text>
              <s-heading>{money(referrals.totals.revenue)}</s-heading>
              <s-text color="subdued">{referrals.totals.orders} orders</s-text>
            </s-box>
            <s-box padding="base" border="base" borderRadius="base" background="subdued">
              <s-text color="subdued">Points earned from referrals</s-text>
              <s-heading>{referrals.totals.pointsEarned}</s-heading>
            </s-box>
          </s-grid>

          {referrals.friends.length === 0 ? (
            <s-paragraph>This customer hasn't referred anyone yet.</s-paragraph>
          ) : (
            <s-table>
              <s-table-header-row>
                <s-table-header>Customer</s-table-header>
                <s-table-header>Status</s-table-header>
                <s-table-header>Joined</s-table-header>
                <s-table-header format="numeric">Orders</s-table-header>
                <s-table-header format="numeric">Revenue</s-table-header>
                <s-table-header format="numeric">Points earned</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {referrals.friends.map((f) => (
                  <s-table-row key={f.id}>
                    <s-table-cell>
                      <s-link href={`/app/customers/${f.id}`}>{f.name}</s-link>
                    </s-table-cell>
                    <s-table-cell>
                      <s-badge tone={statusTone[f.status] ?? "neutral"}>{f.status.toLowerCase()}</s-badge>
                    </s-table-cell>
                    <s-table-cell>{f.joined}</s-table-cell>
                    <s-table-cell>{f.orders}</s-table-cell>
                    <s-table-cell>{money(f.revenue)}</s-table-cell>
                    <s-table-cell>{f.pointsEarned}</s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          )}
          <s-text color="subdued">
            Revenue is the value of their orders after discounts (no shipping or tax), minus refunds, excluding cancelled and returned orders.
            {referrals.converted ? ` Shown in ${referrals.currency}, converted from ${referrals.from}.` : ` Shown in ${referrals.currency}.`}
          </s-text>
        </s-stack>
      </s-section>

      <s-section heading="Points history">
        {ledger.length === 0 ? (
          <s-paragraph>No activity yet.</s-paragraph>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>When</s-table-header>
              <s-table-header>Type</s-table-header>
              <s-table-header>Note</s-table-header>
              <s-table-header format="numeric">Points</s-table-header>
              <s-table-header format="numeric">Balance</s-table-header>
              <s-table-header>Expires</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {ledger.map((t) => (
                <s-table-row key={t.id}>
                  <s-table-cell>{t.at}</s-table-cell>
                  <s-table-cell>{t.type.toLowerCase()}</s-table-cell>
                  <s-table-cell>{t.note}</s-table-cell>
                  <s-table-cell>
                    {t.points > 0 ? "+" : ""}
                    {t.points}
                  </s-table-cell>
                  <s-table-cell>{t.after}</s-table-cell>
                  <s-table-cell>{t.expires}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>

      <s-section heading="Discount codes">
        {codes.length === 0 ? (
          <s-paragraph>No rewards redeemed yet.</s-paragraph>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>Date</s-table-header>
              <s-table-header>Reward</s-table-header>
              <s-table-header>Code</s-table-header>
              <s-table-header>Status</s-table-header>
              <s-table-header format="numeric">Points</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {codes.map((r) => (
                <s-table-row key={r.id}>
                  <s-table-cell>{r.at}</s-table-cell>
                  <s-table-cell>{r.name}</s-table-cell>
                  <s-table-cell>{r.code}</s-table-cell>
                  <s-table-cell>
                    <s-badge tone={r.status === "ACTIVE" ? "success" : r.status === "FAILED" ? "critical" : "neutral"}>
                      {r.status.toLowerCase()}
                    </s-badge>
                  </s-table-cell>
                  <s-table-cell>{r.points}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>
    </s-page>
  );
}
