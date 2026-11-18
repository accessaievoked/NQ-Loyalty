import { useEffect, useState } from "react";
import { Link, useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { requireStore } from "../services/auth.server";
import { InsufficientPointsError, postTransaction } from "../services/ledger.server";
import { creditPoints } from "../services/credit.server";
import { convert, getFx } from "../services/currency.server";
import { customerReferralStats } from "../services/referralstats.server";
import db from "../db.server";

const num = (v) => Number(v ?? 0) || 0;

function orderStatus(o) {
  if (o.cancelledAt) return "Cancelled";
  if (o.returnStatus === "CLOSED") return "Returned";
  if (o.paidAt) return "Paid";
  return "Pending";
}

export const loader = async ({ request, params }) => {
  const { store, session } = await requireStore(request);
  // Scoped by store: another shop's customer id simply 404s.
  const customer = await db.customer.findFirst({ where: { id: params.id, storeId: store.id } });
  if (!customer) throw new Response("Not found", { status: 404 });

  const [ledger, codes, refStats, fx, orders, orderAgg] = await Promise.all([
    db.pointsTransaction.findMany({ where: { customerId: customer.id }, orderBy: { createdAt: "desc" }, take: 50 }),
    db.redemption.findMany({ where: { customerId: customer.id }, orderBy: { createdAt: "desc" }, take: 20 }),
    customerReferralStats(store.id, customer.id),
    getFx(store),
    db.order.findMany({
      where: { customerId: customer.id, storeId: store.id },
      orderBy: { createdAt: "desc" },
      take: 25,
      include: { award: { select: { points: true, status: true } } },
    }),
    db.order.aggregate({
      where: { customerId: customer.id, storeId: store.id, cancelledAt: null, returnStatus: { not: "CLOSED" } },
      _count: { _all: true },
      _sum: { eligibleAmount: true },
      _avg: { eligibleAmount: true },
    }),
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
      phone: customer.phone,
      shopifyId: customer.shopifyCustomerId,
      balance: customer.pointsBalance,
      lifetime: customer.lifetimePoints,
      referralCode: customer.referralCode,
      referralLink: customer.referralCode ? `https://${session.shop}/?ref=${customer.referralCode}` : "",
      joinedAt: customer.createdAt.toISOString().slice(0, 10),
    },
    currency: store.currency,
    stats: {
      totalOrders: orderAgg._count._all,
      amountSpent: num(orderAgg._sum.eligibleAmount),
      avgOrderValue: num(orderAgg._avg.eligibleAmount),
    },
    orders: orders.map((o) => ({
      id: o.id,
      name: o.orderName || o.shopifyOrderId,
      total: num(o.eligibleAmount),
      points: o.award?.points ?? 0,
      pending: o.award?.status === "PENDING",
      status: orderStatus(o),
      date: o.createdAt.toISOString().slice(0, 10),
    })),
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

// A single card holding several stat columns side by side, divided by a hairline instead of each
// stat getting its own box — one card, not a wall of boxes.
function StatRow({ items }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", border: "1px solid #e4e6ea", borderRadius: 10, overflow: "hidden" }}>
      {items.map((it, i) => (
        <div
          key={it.label}
          style={{ flex: "1 1 140px", padding: "12px 16px", borderLeft: i ? "1px solid #e4e6ea" : 0, borderTop: "1px solid #e4e6ea", marginTop: i ? 0 : 0 }}
        >
          <div style={{ fontSize: 12, color: "#6b7280" }}>{it.label}</div>
          <div style={{ fontSize: 16, fontWeight: 650, color: "#111827", marginTop: 2 }}>{it.value}</div>
          {it.sub && <div style={{ fontSize: 12, color: "#6b7280", marginTop: 1 }}>{it.sub}</div>}
        </div>
      ))}
    </div>
  );
}

// A card of label/value rows, each with an optional copy button — used for contact-style details.
function InfoCard({ items }) {
  const [copiedKey, setCopiedKey] = useState("");
  const copy = async (key, value) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(""), 1500);
    } catch {
      // Clipboard access denied (e.g. no HTTPS context); nothing to fall back to here.
    }
  };
  return (
    <div style={{ border: "1px solid #e4e6ea", borderRadius: 10, overflow: "hidden" }}>
      {items.map((it, i) => (
        <div
          key={it.label}
          style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, padding: "10px 14px", borderTop: i ? "1px solid #eceef1" : 0 }}
        >
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 12, color: "#6b7280" }}>{it.label}</div>
            <div style={{ fontSize: 14, fontWeight: 600, color: it.value ? "#111827" : "#9ca3af", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {it.value || it.empty || "Not set"}
            </div>
          </div>
          {it.value && !it.noCopy && (
            <button
              type="button"
              onClick={() => copy(it.label, it.value)}
              style={{ flex: "none", border: "1px solid #d1d5db", background: "#fff", borderRadius: 6, padding: "4px 10px", fontSize: 12, fontWeight: 600, color: "#111827", cursor: "pointer" }}
            >
              {copiedKey === it.label ? "Copied" : "Copy"}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

function TabBar({ tabs, active, onChange }) {
  return (
    <div style={{ display: "flex", gap: 20, borderBottom: "1px solid #e4e6ea", marginBottom: 14 }}>
      {tabs.map((t) => (
        <button
          key={t.key}
          type="button"
          onClick={() => onChange(t.key)}
          style={{
            border: 0, background: "none", cursor: "pointer", padding: "0 0 10px", fontSize: 14,
            fontWeight: active === t.key ? 650 : 500, color: active === t.key ? "#111827" : "#6b7280",
            borderBottom: active === t.key ? "2px solid #111827" : "2px solid transparent",
          }}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

const ORDER_STATUS_TONE = { Paid: "success", Pending: "warning", Cancelled: "critical", Returned: "critical" };
const DARK_LINK = { color: "#111827", textDecoration: "none" };

export default function CustomerDetail() {
  const { customer, ledger, codes, referrals, stats, orders, currency } = useLoaderData();
  const money = (n) => {
    try {
      return new Intl.NumberFormat("en", { style: "currency", currency: referrals.currency, maximumFractionDigits: 2 }).format(n);
    } catch {
      return `${n.toFixed(2)} ${referrals.currency}`;
    }
  };
  const storeMoney = (n) => {
    try {
      return new Intl.NumberFormat("en", { style: "currency", currency, maximumFractionDigits: 2 }).format(n);
    } catch {
      return `${n.toFixed(2)} ${currency}`;
    }
  };
  const statusTone = { REWARDED: "success", PENDING: "warning", REVERSED: "critical" };
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  // Generated client-side (not during SSR) and refreshed after each result so a double
  // submit is deduped by the ledger but a deliberate second adjustment is not.
  const [requestId, setRequestId] = useState("");
  useEffect(() => setRequestId(crypto.randomUUID()), [fetcher.data]);
  const [tab, setTab] = useState("orders");

  useEffect(() => {
    if (fetcher.data?.ok) shopify.toast.show(fetcher.data.ok);
    if (fetcher.data?.error) shopify.toast.show(fetcher.data.error, { isError: true });
  }, [fetcher.data, shopify]);

  const TABS = [
    { key: "orders", label: "Recent orders" },
    { key: "referrals", label: "Referrals" },
    { key: "points", label: "Points history" },
    ...(codes.length ? [{ key: "codes", label: "Old discount codes" }] : []),
  ];

  return (
    <s-page heading={customer.name}>
      {/* Plain divs directly under <s-page>, never inside <s-section>: Shopify's web component
          restructures <s-section>'s children on upgrade, which raced React's hydration here and
          crashed the render (React errors #418/#423) down to a near-blank page. <s-page> itself
          doesn't do that — this mirrors the one other page in the app with custom-styled content
          (Home), which has never hit this. */}
      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        <StatRow
          items={[
            { label: "Total orders", value: stats.totalOrders },
            { label: "Average order value", value: storeMoney(stats.avgOrderValue) },
            { label: "Amount spent", value: storeMoney(stats.amountSpent) },
            { label: "Customer since", value: customer.joinedAt },
          ]}
        />

        <style>{"@media (min-width:860px){.cust-detail-grid{grid-template-columns:minmax(0,2fr) minmax(260px,1fr) !important}}"}</style>
        <div className="cust-detail-grid" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 20, alignItems: "start" }}>
          <div style={{ minWidth: 0 }}>
            <TabBar tabs={TABS} active={tab} onChange={setTab} />

            {tab === "orders" && (
              orders.length === 0 ? (
                <s-paragraph>No orders yet.</s-paragraph>
              ) : (
                <s-table>
                  <s-table-header-row>
                    <s-table-header>Order</s-table-header>
                    <s-table-header format="numeric">Order total</s-table-header>
                    <s-table-header format="numeric">Earned points</s-table-header>
                    <s-table-header>Payment</s-table-header>
                    <s-table-header>Date</s-table-header>
                  </s-table-header-row>
                  <s-table-body>
                    {orders.map((o) => (
                      <s-table-row key={o.id}>
                        <s-table-cell>{o.name}</s-table-cell>
                        <s-table-cell>{storeMoney(o.total)}</s-table-cell>
                        <s-table-cell>
                          {o.points}
                          {o.pending ? " (pending)" : ""}
                        </s-table-cell>
                        <s-table-cell>
                          <s-badge tone={ORDER_STATUS_TONE[o.status] ?? "neutral"}>{o.status}</s-badge>
                        </s-table-cell>
                        <s-table-cell>{o.date}</s-table-cell>
                      </s-table-row>
                    ))}
                  </s-table-body>
                </s-table>
              )
            )}

            {tab === "referrals" && (
              <s-stack gap="base">
                {referrals.referredBy && (
                  <s-text>
                    Referred by <Link to={`/app/customers/${referrals.referredBy.id}`} style={DARK_LINK}>{referrals.referredBy.name}</Link>{" "}
                    <s-badge tone={statusTone[referrals.referredBy.status] ?? "neutral"}>{referrals.referredBy.status.toLowerCase()}</s-badge>
                  </s-text>
                )}

                <StatRow
                  items={[
                    { label: "Customers referred", value: referrals.totals.referred, sub: `${referrals.totals.rewarded} rewarded` },
                    { label: "Revenue from them", value: money(referrals.totals.revenue), sub: `${referrals.totals.orders} orders` },
                    { label: "Points earned from referrals", value: referrals.totals.pointsEarned },
                  ]}
                />

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
                            <Link to={`/app/customers/${f.id}`} style={DARK_LINK}>{f.name}</Link>
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
            )}

            {tab === "points" && (
              ledger.length === 0 ? (
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
              )
            )}

            {tab === "codes" && (
              codes.length === 0 ? (
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
              )
            )}
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 650, color: "#111827", marginBottom: 8 }}>Customer info</div>
              <InfoCard
                items={[
                  { label: "Email", value: customer.email },
                  { label: "Phone", value: customer.phone },
                  { label: "Shopify customer ID", value: customer.shopifyId },
                  { label: "Referral link", value: customer.referralLink, empty: "Hasn't generated a referral link yet" },
                  ...(referrals.referredBy
                    ? [{ label: "Referred by", value: referrals.referredBy.name, noCopy: true }]
                    : []),
                ]}
              />
            </div>

            <div>
              <div style={{ fontSize: 13, fontWeight: 650, color: "#111827", marginBottom: 8 }}>Points</div>
              <InfoCard
                items={[
                  { label: "Current balance", value: String(customer.balance) },
                  { label: "Lifetime earned", value: String(customer.lifetime) },
                ]}
              />
              <s-box paddingBlockStart="base">
                <fetcher.Form method="post">
                  <input type="hidden" name="requestId" value={requestId} />
                  <s-stack gap="base">
                    <s-number-field label="Adjust points (use a minus to remove)" name="points" step="1" value="0" />
                    <s-text-field label="Reason" name="note" placeholder="e.g. Goodwill credit" />
                    <s-button type="submit" variant="primary" loading={fetcher.state !== "idle" || undefined}>
                      Apply
                    </s-button>
                  </s-stack>
                </fetcher.Form>
              </s-box>
            </div>
          </div>
        </div>
      </div>
    </s-page>
  );
}
