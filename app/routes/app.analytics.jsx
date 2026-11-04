import { useState } from "react";
import { Form, useLoaderData, useNavigate } from "react-router";
import { requireStore } from "../services/auth.server";
import { loadAnalytics } from "../services/analytics.server";
import { getFx } from "../services/currency.server";
import { RANGE_PRESETS, resolveRange } from "../lib/analytics-ranges";
import { AreaChart, BarChart, COLORS, Columns, Donut, Figure, FiguresStrip, HBars, Legend, Panel, compact, moneyFmt, whole } from "../components/charts";

export const loader = async ({ request }) => {
  const { store } = await requireStore(request);
  const p = new URL(request.url).searchParams;
  const range = resolveRange({ range: p.get("range"), from: p.get("from"), to: p.get("to") });
  const fx = await getFx(store); // reporting currency (the store's own unless the merchant chose another)
  return { data: await loadAnalytics(store, range, fx) };
};

const pct = (n) => `${(n * 100).toFixed(n > 0 && n < 0.1 ? 1 : 0)}%`;

function Facts({ rows }) {
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      {rows.map(([label, value, hint], i) => (
        <div key={label} style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 16, padding: "11px 0", borderTop: i ? "1px solid #eceef1" : 0 }}>
          <span style={{ fontSize: 13.5, color: "#4b5563" }}>
            {label}
            {hint ? <span style={{ color: "#9ca3af" }}> · {hint}</span> : null}
          </span>
          <b style={{ fontSize: 15, color: "#111827", whiteSpace: "nowrap" }}>{value}</b>
        </div>
      ))}
    </div>
  );
}

export default function Analytics() {
  const { data: d } = useLoaderData();
  const money = moneyFmt(d.currency);
  const ref = d.referrals;
  const navigate = useNavigate();
  const labels = d.series.map((s) => s.day);
  const per = d.bucket === "week" ? "week" : "day";
  const spark = (key) => d.series.map((s) => s[key]);
  const referralsStarted = (ref.PENDING ?? 0) + (ref.REWARDED ?? 0) + (ref.REVERSED ?? 0);

  // Presets apply immediately; "Custom range…" reveals two dates and waits for Apply.
  const [choice, setChoice] = useState(d.range.key);
  const pick = (value) => {
    setChoice(value);
    if (value !== "custom") navigate(`/app/analytics?range=${encodeURIComponent(value)}`);
  };
  const dateStyle = { font: "inherit", padding: "7px 9px", border: "1px solid #b5b5b5", borderRadius: 8, background: "#fff", color: "inherit" };

  return (
    <s-page heading="Loyalty analytics">
      <s-section>
        <s-stack direction="inline" gap="base" alignItems="end" justifyContent="space-between">
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
          </s-stack>
          <s-text color="subdued">Showing {d.range.text} (UTC dates)</s-text>
        </s-stack>
      </s-section>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 16, marginTop: 4 }}>
        <FiguresStrip>
          {[
            <Figure key="m" label="Members" value={whole(d.members.total)} hint={`+${whole(d.members.new)} in this period`} values={spark("members")} color={COLORS.purple} />,
            <Figure key="i" label="Points issued" value={compact(d.points.issued)} hint={`${pct(d.points.redeemRate)} spent`} values={spark("earned")} color={COLORS.blue} />,
            <Figure key="r" label="Points redeemed" value={compact(d.points.spent)} hint={`${whole(d.redemptions.count)} redemptions`} values={spark("redeemed")} color={COLORS.orange} />,
            <Figure key="v" label="Member revenue" value={money(d.orders.revenue)} hint={`${whole(d.orders.count)} orders`} values={spark("revenue")} color={COLORS.green} />,
          ]}
        </FiguresStrip>

        <Panel
          title="Points activity"
          subtitle={`Points earned and redeemed per ${per}`}
          right={<Legend items={[{ label: "Earned", color: COLORS.blue }, { label: "Redeemed", color: COLORS.orange }]} />}
        >
          <AreaChart
            labels={labels}
            ariaLabel={`Points earned and redeemed per ${per}`}
            series={[
              { label: "Earned", color: COLORS.blue, values: spark("earned") },
              { label: "Redeemed", color: COLORS.orange, values: spark("redeemed") },
            ]}
          />
        </Panel>

        <Panel
          title="Revenue from members"
          subtitle={`Per ${per} · swipe or drag sideways for earlier ${per}s`}
          right={<Legend items={[{ label: "All member orders", color: "#9db8f5" }, { label: "Orders that used points", color: COLORS.green }]} />}
        >
          <BarChart
            scrollable
            labels={labels}
            format={money}
            ariaLabel={`Member revenue per ${per}`}
            series={[
              { label: "All member orders", color: COLORS.blue, values: spark("revenue") },
              { label: "Orders that used points", color: COLORS.green, values: spark("loyaltyRevenue") },
            ]}
          />
          <div style={{ marginTop: 14 }}>
            <Columns min={240}>
              <Facts
                rows={[
                  ["Member orders", whole(d.orders.count)],
                  ["Average member order", money(d.orders.avgValue)],
                ]}
              />
              <Facts
                rows={[
                  ["Orders using points", whole(d.orders.withLoyaltyCode)],
                  ["Discount given", money(d.orders.loyaltyDiscount)],
                ]}
              />
            </Columns>
          </div>
        </Panel>

        <Columns>
          <Panel title="Where points come from" subtitle="Points issued in this period">
            {d.sources.length ? (
              <Donut
                center={compact(d.points.issued)}
                centerLabel="issued"
                items={d.sources.map((s, i) => ({
                  label: s.label,
                  value: s.points,
                  color: [COLORS.blue, COLORS.purple, COLORS.teal, COLORS.pink, COLORS.amber, COLORS.grey][i % 6],
                }))}
              />
            ) : (
              <HBars items={[]} empty="No points issued in this period." />
            )}
          </Panel>
          <Panel title="What happens to points" subtitle="Spent, expired, reversed, still held">
            <Donut
              center={compact(d.points.outstanding)}
              centerLabel="held now"
              items={[
                { label: "Spent on rewards", value: d.points.spent, color: COLORS.orange },
                { label: "Expired", value: d.points.expired, color: COLORS.grey },
                { label: "Reversed (refunds, returns)", value: d.points.reversed, color: COLORS.pink },
                { label: "Still held by members", value: d.points.outstanding, color: COLORS.green },
              ]}
            />
          </Panel>
        </Columns>

        <Columns>
          <Panel title="New members" subtitle={`Joined per ${per}`}>
            <BarChart labels={labels} height={200} ariaLabel={`New members per ${per}`} series={[{ label: "New members", color: COLORS.purple, values: spark("members") }]} />
          </Panel>
          <Panel title="Most redeemed rewards" subtitle="Times redeemed">
            <HBars color={COLORS.orange} empty="No redemptions in this period." items={d.topRewards.map((r) => ({ label: r.name, value: r.count, sub: `${compact(r.points)} pts` }))} />
          </Panel>
        </Columns>

        <Columns>
          <Panel title="Redemptions" subtitle="How rewards are being used">
            <Facts
              rows={[
                ["Redemptions", whole(d.redemptions.count), `${whole(d.redemptions.used)} codes used`],
                ["Discount value given", money(d.redemptions.valueGiven), "amount-based rewards"],
                ["Average points per redemption", whole(d.redemptions.avgPoints)],
                ["Value of 1 point", money(d.redemptions.avgCoinValue), "discount ÷ points"],
              ]}
            />
          </Panel>
          <Panel title="Referrals & reviews" subtitle="Growth from your members">
            <HBars
              color={COLORS.teal}
              empty="No referrals or reviews in this period."
              items={[
                { label: "Referrals started", value: referralsStarted },
                { label: "Referrals rewarded", value: ref.REWARDED ?? 0, color: COLORS.green },
                { label: "Reviews rewarded", value: d.reviewsRewarded, color: COLORS.amber },
              ].filter((i) => i.value > 0)}
            />
            <div style={{ marginTop: 12 }}>
              <Facts rows={[["Revenue from referred customers", money(d.referralRevenue.revenue), `${whole(d.referralRevenue.orders)} orders`]]} />
            </div>
          </Panel>
        </Columns>

        <Panel title="Top members" subtitle="By points earned over their lifetime">
          <HBars
            color={COLORS.blue}
            empty="No members yet."
            items={d.topCustomers.map((c) => ({ label: c.name, href: `/app/customers/${c.id}`, value: c.lifetime, sub: `${whole(c.balance)} held` }))}
          />
        </Panel>
      </div>
    </s-page>
  );
}
