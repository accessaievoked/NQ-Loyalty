import { useLoaderData } from "react-router";
import { requireStore } from "../services/auth.server";
import { loadAnalytics } from "../services/analytics.server";
import { getFx } from "../services/currency.server";
import { resolveRange } from "../lib/analytics-ranges";
import db from "../db.server";
import { AreaChart, BarChart, COLORS, Columns, Figure, FiguresStrip, HBars, HiddenScroll, Legend, Panel, compact, moneyFmt, whole } from "../components/charts";

export const loader = async ({ request }) => {
  const { store, session } = await requireStore(request);
  const where = { storeId: store.id };
  const fx = await getFx(store);

  const [analytics, recent, rules, rewards] = await Promise.all([
    loadAnalytics(store, resolveRange({ range: "90d" }), fx), // 90 days feeds both the revenue chart and the 30-day trends
    db.pointsTransaction.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 8,
      include: { customer: { select: { id: true, firstName: true, lastName: true, email: true } } },
    }),
    db.earnRule.count({ where: { ...where, active: true } }),
    db.reward.count({ where: { ...where, active: true } }),
  ]);

  return {
    shop: session.shop,
    apiKey: process.env.SHOPIFY_API_KEY || "",
    mode: store.settings.displayMode,
    currency: analytics.currency,
    members: analytics.members.total,
    outstanding: analytics.points.outstanding,
    activeCodes: await db.redemption.count({ where: { ...where, status: "ACTIVE" } }),
    series: analytics.series,
    top: analytics.topCustomers,
    recent: recent.map((t) => ({
      id: t.id,
      who: nameOf(t.customer),
      customerId: t.customer.id,
      type: t.type,
      points: t.points,
      at: t.createdAt.toISOString(),
    })),
    checklist: { rules: rules > 0, rewards: rewards > 0 },
  };
};

const nameOf = (c) => [c.firstName, c.lastName].filter(Boolean).join(" ") || c.email || "Unknown";
const sum = (rows, key) => rows.reduce((s, r) => s + (r[key] || 0), 0);

const TYPE = {
  EARN: { label: "Earned", color: COLORS.green },
  REDEEM: { label: "Redeemed", color: COLORS.orange },
  EXPIRE: { label: "Expired", color: COLORS.grey },
  REVERSAL: { label: "Reversed", color: COLORS.pink },
  ADJUST: { label: "Adjusted", color: COLORS.blue },
};

const when = (iso) => {
  const d = new Date(iso);
  return `${d.getUTCDate()} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()]}, ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
};

function Step({ done, children }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 0", borderTop: "1px solid #eceef1" }}>
      <span
        aria-label={done ? "Done" : "To do"}
        style={{ width: 22, height: 22, borderRadius: 99, flex: "none", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 13, color: "#fff", background: done ? COLORS.green : "#fff", border: done ? 0 : "2px solid #cbd5e1" }}
      >
        {done ? "✓" : ""}
      </span>
      <span style={{ fontSize: 14, color: "#1f2937" }}>{children}</span>
    </div>
  );
}

export default function Home() {
  const { series, top, recent, checklist, shop, apiKey, mode, currency, members, outstanding, activeCodes } = useLoaderData();
  const money = moneyFmt(currency);
  const embedUrl = `https://${shop}/admin/themes/current/editor?context=apps&activateAppId=${apiKey}/loyalty-embed`;

  const last30 = series.slice(-30);
  const labels30 = last30.map((s) => s.day);
  const col = (rows, key) => rows.map((r) => r[key]);
  const setupDone = checklist.rules && checklist.rewards;

  return (
    <s-page heading="Loyalty & rewards">
      <s-button slot="primary-action" href="/app/appearance">
        Customise storefront
      </s-button>
      <s-button slot="secondary-actions" href="/app/analytics">
        Full analytics
      </s-button>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 16 }}>
        <details open={!setupDone} style={{ background: "#fff", border: "1px solid #e4e6ea", borderRadius: 14, padding: "14px 18px" }}>
          <summary style={{ cursor: "pointer", fontWeight: 650, fontSize: 15, listStyle: "none", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>{setupDone ? "Setup" : "Finish setting up"}</span>
            <span style={{ fontSize: 13, color: "#6b7280", fontWeight: 400 }}>{setupDone ? "Rules and rewards are ready" : `${Number(checklist.rules) + Number(checklist.rewards)} of 2 steps done`}</span>
          </summary>
          <div style={{ marginTop: 10 }}>
            <Step done={checklist.rules}>
              Choose how customers earn points and when they&apos;re credited. <s-link href="/app/rules">Open rules</s-link>
            </Step>
            <Step done={checklist.rewards}>
              Add rewards customers can spend points on. <s-link href="/app/rules">Open rewards</s-link>
            </Step>
            <Step done={false}>
              {mode === "WIDGET" ? (
                <>
                  Turn on the app embed so the widget appears in your theme.{" "}
                  <s-link href={embedUrl} target="_blank">
                    Open theme editor
                  </s-link>
                </>
              ) : (
                <>
                  Your rewards page is at{" "}
                  <s-link href={`https://${shop}/apps/loyalty/rewards`} target="_blank">
                    /apps/loyalty/rewards
                  </s-link>
                  . Add it to your navigation.
                </>
              )}
            </Step>
          </div>
        </details>

        <FiguresStrip>
          {[
            <Figure key="m" label="Members" value={whole(members)} hint={`+${whole(sum(last30, "members"))} in 30 days`} values={col(last30, "members")} color={COLORS.purple} />,
            <Figure key="e" label="Points earned" value={compact(sum(last30, "earned"))} hint="last 30 days" values={col(last30, "earned")} color={COLORS.blue} />,
            <Figure key="r" label="Points redeemed" value={compact(sum(last30, "redeemed"))} hint={`${whole(activeCodes)} codes live`} values={col(last30, "redeemed")} color={COLORS.orange} />,
            <Figure key="v" label="Member revenue" value={money(sum(last30, "revenue"))} hint={`${whole(sum(last30, "orders"))} orders · 30 days`} values={col(last30, "revenue")} color={COLORS.green} />,
          ]}
        </FiguresStrip>

        <Panel
          title="Revenue from members"
          subtitle="Last 90 days · swipe or drag sideways for earlier days"
          right={<Legend items={[{ label: "All member orders", color: "#9db8f5" }, { label: "Orders that used points", color: COLORS.green }]} />}
        >
          <BarChart
            scrollable
            labels={series.map((s) => s.day)}
            format={money}
            ariaLabel="Member revenue per day, last 90 days"
            series={[
              { label: "All member orders", color: COLORS.blue, values: col(series, "revenue") },
              { label: "Orders that used points", color: COLORS.green, values: col(series, "loyaltyRevenue") },
            ]}
          />
        </Panel>

        <Panel
          title="Points usage"
          subtitle={`Earned and redeemed each day · ${whole(outstanding)} points are held by members right now`}
          right={<Legend items={[{ label: "Earned", color: COLORS.blue }, { label: "Redeemed", color: COLORS.orange }]} />}
        >
          <AreaChart
            labels={labels30}
            ariaLabel="Points earned and redeemed each day, last 30 days"
            series={[
              { label: "Earned", color: COLORS.blue, values: col(last30, "earned") },
              { label: "Redeemed", color: COLORS.orange, values: col(last30, "redeemed") },
            ]}
          />
        </Panel>

        <Columns>
          <Panel title="Top members" subtitle="By points earned in total" right={<s-link href="/app/customers">All customers</s-link>}>
            <HBars
              empty="No members yet. They appear when a customer logs in or places an order."
              items={top.map((c) => ({ label: c.name, href: `/app/customers/${c.id}`, value: c.lifetime, sub: `${whole(c.balance)} held` }))}
            />
          </Panel>

          <Panel title="Recent activity" subtitle="Latest points movements">
            {recent.length === 0 ? (
              <div style={{ color: "#6b7280", fontSize: 13 }}>Nothing yet.</div>
            ) : (
              <HiddenScroll style={{ display: "flex", flexDirection: "column", maxHeight: 340, overflowY: "auto" }}>
                {recent.map((t, i) => {
                  const kind = TYPE[t.type] || TYPE.ADJUST;
                  return (
                    <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 0", borderTop: i ? "1px solid #eceef1" : 0 }}>
                      <span style={{ width: 8, height: 8, borderRadius: 99, background: kind.color, flex: "none" }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 14, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                          <s-link href={`/app/customers/${t.customerId}`}>{t.who}</s-link>
                        </div>
                        <div style={{ fontSize: 12, color: "#6b7280" }}>
                          {kind.label} · {when(t.at)}
                        </div>
                      </div>
                      <b style={{ fontSize: 14, color: t.points > 0 ? "#15803d" : "#c2410c" }}>
                        {t.points > 0 ? "+" : ""}
                        {whole(t.points)}
                      </b>
                    </div>
                  );
                })}
              </HiddenScroll>
            )}
          </Panel>
        </Columns>
      </div>
    </s-page>
  );
}
