import { useState } from "react";
import { Form, useLoaderData, useNavigate } from "react-router";
import { requireStore } from "../services/auth.server";
import { loadAnalytics } from "../services/analytics.server";
import { getFx } from "../services/currency.server";
import { RANGE_PRESETS, resolveRange } from "../lib/analytics-ranges";
import BackButton from "../components/BackButton";

export const loader = async ({ request }) => {
  const { store } = await requireStore(request);
  const p = new URL(request.url).searchParams;
  const range = resolveRange({ range: p.get("range"), from: p.get("from"), to: p.get("to") });
  const fx = await getFx(store); // reporting currency (the store's own unless the merchant chose another)
  return { data: await loadAnalytics(store, range, fx) };
};

const nf = new Intl.NumberFormat("en");
const fmt = (n) => nf.format(Math.round(n));
const pct = (n) => `${(n * 100).toFixed(n > 0 && n < 0.1 ? 1 : 0)}%`;
const money = (n, currency) => {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency, maximumFractionDigits: 2 }).format(n);
  } catch {
    return `${n.toFixed(2)} ${currency}`;
  }
};

function Stat({ label, value, hint }) {
  return (
    <s-box padding="base" border="base" borderRadius="base" background="subdued">
      <s-stack gap="small-300">
        <s-text color="subdued">{label}</s-text>
        <s-heading>{value}</s-heading>
        {hint ? <s-text color="subdued">{hint}</s-text> : null}
      </s-stack>
    </s-box>
  );
}

// Dependency-free grouped bar chart: points earned vs redeemed per day.
function PointsChart({ series, bucket }) {
  const W = 760;
  const H = 220;
  const pad = { l: 44, r: 8, t: 10, b: 26 };
  const max = Math.max(1, ...series.flatMap((s) => [s.earned, s.redeemed]));
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const step = iw / series.length;
  const bw = Math.max(1, Math.min(14, step / 2.6));
  const y = (v) => pad.t + ih - (v / max) * ih;
  const ticks = [0, 0.5, 1].map((t) => Math.round(max * t));
  const first = series[0]?.day;
  const last = series[series.length - 1]?.day;
  const empty = series.every((s) => s.earned === 0 && s.redeemed === 0);

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={`Points earned and redeemed per ${bucket}`} style={{ display: "block" }}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} stroke="#e3e3e3" strokeWidth="1" />
            <text x={pad.l - 6} y={y(t) + 4} textAnchor="end" fontSize="11" fill="#6a6a6a">
              {fmt(t)}
            </text>
          </g>
        ))}
        {series.map((s, i) => {
          const x = pad.l + i * step + step / 2;
          return (
            <g key={s.day}>
              <title>{`${s.day}: ${s.earned} earned, ${s.redeemed} redeemed`}</title>
              <rect x={x - bw - 0.5} y={y(s.earned)} width={bw} height={Math.max(0, pad.t + ih - y(s.earned))} fill="#2563eb" rx="1.5" />
              <rect x={x + 0.5} y={y(s.redeemed)} width={bw} height={Math.max(0, pad.t + ih - y(s.redeemed))} fill="#ea580c" rx="1.5" />
            </g>
          );
        })}
        <text x={pad.l} y={H - 6} fontSize="11" fill="#6a6a6a">
          {first}
        </text>
        <text x={W - pad.r} y={H - 6} textAnchor="end" fontSize="11" fill="#6a6a6a">
          {last}
        </text>
      </svg>
      <s-stack direction="inline" gap="base">
        <s-text>
          <span style={{ color: "#2563eb" }}>■</span> Points earned
        </s-text>
        <s-text>
          <span style={{ color: "#ea580c" }}>■</span> Points redeemed
        </s-text>
        <s-text color="subdued">Each bar is one {bucket}</s-text>
        {empty ? <s-text color="subdued">No activity in this period yet.</s-text> : null}
      </s-stack>
    </div>
  );
}

function Table({ head, rows, empty }) {
  if (!rows.length) return <s-paragraph>{empty}</s-paragraph>;
  return (
    <s-table>
      <s-table-header-row>
        {head.map((h, i) => (
          <s-table-header key={h} format={i > 0 ? "numeric" : undefined}>
            {h}
          </s-table-header>
        ))}
      </s-table-header-row>
      <s-table-body>
        {rows.map((r) => (
          <s-table-row key={r.key}>
            {r.cells.map((c, i) => (
              <s-table-cell key={i}>{c}</s-table-cell>
            ))}
          </s-table-row>
        ))}
      </s-table-body>
    </s-table>
  );
}

export default function Analytics() {
  const { data: d } = useLoaderData();
  const cur = d.currency;
  const ref = d.referrals;
  const navigate = useNavigate();

  // Presets apply immediately; "Custom range…" reveals two dates and waits for Apply.
  const [choice, setChoice] = useState(d.range.key);
  const pick = (value) => {
    setChoice(value);
    if (value !== "custom") navigate(`/app/analytics?range=${encodeURIComponent(value)}`);
  };
  const dateStyle = { font: "inherit", padding: "7px 9px", border: "1px solid #b5b5b5", borderRadius: 8, background: "#fff", color: "inherit" };

  return (
    <s-page heading="Loyalty analytics">
      <BackButton href="/app" label="Back to home" />
      <s-section>
        <s-stack direction="inline" gap="base" alignItems="end">
          <s-select label="Period" name="range" value={choice} onChange={(e) => pick(e.currentTarget.value)}>
            {RANGE_PRESETS.map(([key, label]) => (
              <s-option key={key} value={key}>
                {label}
              </s-option>
            ))}
          </s-select>

          {choice === "custom" && (
            <Form method="get">
              <input type="hidden" name="range" value="custom" />
              <s-stack direction="inline" gap="small" alignItems="end">
                <label>
                  <s-text color="subdued">From</s-text>
                  <br />
                  <input type="date" name="from" defaultValue={d.range.from} max={d.range.to} required style={dateStyle} />
                </label>
                <label>
                  <s-text color="subdued">To</s-text>
                  <br />
                  <input type="date" name="to" defaultValue={d.range.to} required style={dateStyle} />
                </label>
                <s-button type="submit" variant="primary">
                  Apply
                </s-button>
              </s-stack>
            </Form>
          )}

          <s-text color="subdued">Showing {d.range.text} (UTC dates)</s-text>
        </s-stack>
      </s-section>

      <s-banner tone={d.fx.error ? "warning" : "info"}>
        {d.fx.converted ? (
          <>
            Amounts are shown in <s-text type="strong">{d.currency}</s-text>, converted from your store currency ({d.fx.from}) at 1 {d.fx.from} ={" "}
            {d.fx.rate.toFixed(4)} {d.fx.to}
            {d.fx.updatedAt ? ` (live rate, updated ${d.fx.updatedAt.slice(0, 10)})` : ""}
            {d.fx.stale ? " — the rate service is unreachable, so the last saved rate is used" : ""}. Rewards and discount codes stay in {d.fx.from}.
          </>
        ) : (
          <>
            Amounts are shown in <s-text type="strong">{d.currency}</s-text>. {d.fx.error ? d.fx.error : ""}
          </>
        )}
      </s-banner>

      <s-section heading="Members">
        <s-grid gridTemplateColumns="repeat(auto-fit, minmax(170px, 1fr))" gap="base">
          <Stat label="Total members" value={fmt(d.members.total)} />
          <Stat label="New members" value={fmt(d.members.new)} hint={d.range.label} />
          <Stat label="Outstanding points" value={fmt(d.points.outstanding)} hint="held by members now" />
        </s-grid>
      </s-section>

      <s-section heading="Points">
        <s-stack gap="base">
          <s-grid gridTemplateColumns="repeat(auto-fit, minmax(170px, 1fr))" gap="base">
            <Stat label="Points issued" value={fmt(d.points.issued)} />
            <Stat label="Points spent" value={fmt(d.points.spent)} hint={`${pct(d.points.redeemRate)} of issued`} />
            <Stat label="Points expired" value={fmt(d.points.expired)} />
            <Stat label="Points reversed" value={fmt(d.points.reversed)} hint="refunds & returns" />
          </s-grid>
          <PointsChart series={d.series} bucket={d.bucket} />
        </s-stack>
      </s-section>

      <s-section heading="Discounts & redemptions">
        <s-grid gridTemplateColumns="repeat(auto-fit, minmax(170px, 1fr))" gap="base">
          <Stat label="Redemptions" value={fmt(d.redemptions.count)} hint={`${fmt(d.redemptions.used)} codes used so far`} />
          <Stat label="Discount value given" value={money(d.redemptions.valueGiven, cur)} hint="amount-based rewards" />
          <Stat label="Avg points per redemption" value={fmt(d.redemptions.avgPoints)} />
          <Stat label="Avg value of 1 point" value={money(d.redemptions.avgCoinValue, cur)} hint="discount ÷ points spent" />
        </s-grid>
      </s-section>

      <s-section heading="Orders">
        <s-grid gridTemplateColumns="repeat(auto-fit, minmax(170px, 1fr))" gap="base">
          <Stat label="Member orders" value={fmt(d.orders.count)} hint={money(d.orders.revenue, cur)} />
          <Stat label="Avg member order" value={money(d.orders.avgValue, cur)} />
          <Stat label="Orders using points" value={fmt(d.orders.withLoyaltyCode)} hint={`${money(d.orders.loyaltyDiscount, cur)} discounted`} />
          <Stat label="Avg order using points" value={money(d.orders.loyaltyAvgValue, cur)} />
        </s-grid>
      </s-section>

      <s-section heading="Where points come from">
        <Table
          head={["Source", "Points", "Credits"]}
          empty="No points issued in this period."
          rows={d.sources.map((s) => ({ key: s.label, cells: [s.label, fmt(s.points), fmt(s.count)] }))}
        />
      </s-section>

      <s-section heading="Most redeemed rewards">
        <Table
          head={["Reward", "Times redeemed", "Points spent"]}
          empty="No redemptions in this period."
          rows={d.topRewards.map((r) => ({ key: r.name, cells: [r.name, fmt(r.count), fmt(r.points)] }))}
        />
      </s-section>

      <s-section heading="Referrals & reviews">
        <s-grid gridTemplateColumns="repeat(auto-fit, minmax(170px, 1fr))" gap="base">
          <Stat label="Referrals started" value={fmt((ref.PENDING ?? 0) + (ref.REWARDED ?? 0) + (ref.REVERSED ?? 0))} />
          <Stat label="Referrals rewarded" value={fmt(ref.REWARDED ?? 0)} />
          <Stat
            label="Revenue from referred customers"
            value={money(d.referralRevenue.revenue, cur)}
            hint={`${fmt(d.referralRevenue.orders)} orders from ${fmt(d.referralRevenue.customers)} referred customers`}
          />
          <Stat label="Reviews rewarded" value={fmt(d.reviewsRewarded)} />
        </s-grid>
      </s-section>

      <s-section heading="Top members">
        <Table
          head={["Member", "Balance", "Lifetime earned"]}
          empty="No members yet."
          rows={d.topCustomers.map((c) => ({
            key: c.id,
            cells: [<s-link key="l" href={`/app/customers/${c.id}`}>{c.name}</s-link>, fmt(c.balance), fmt(c.lifetime)],
          }))}
        />
      </s-section>
    </s-page>
  );
}
