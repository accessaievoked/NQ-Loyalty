import { useLoaderData } from "react-router";
import { requireStore } from "../services/auth.server";
import db from "../db.server";

export const loader = async ({ request }) => {
  const { store, session } = await requireStore(request);
  const where = { storeId: store.id };

  const [members, balance, issued, redeemed, activeCodes, top, recent, rules, rewards] = await Promise.all([
    db.customer.count({ where }),
    db.customer.aggregate({ where, _sum: { pointsBalance: true } }),
    db.pointsTransaction.aggregate({ where: { ...where, type: "EARN" }, _sum: { points: true } }),
    db.pointsTransaction.aggregate({ where: { ...where, type: "REDEEM" }, _sum: { points: true } }),
    db.redemption.count({ where: { ...where, status: "ACTIVE" } }),
    db.customer.findMany({ where, orderBy: { lifetimePoints: "desc" }, take: 5 }),
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
    stats: {
      members,
      outstanding: balance._sum.pointsBalance ?? 0,
      issued: issued._sum.points ?? 0,
      redeemed: Math.abs(redeemed._sum.points ?? 0),
      activeCodes,
    },
    top: top.map((c) => ({ id: c.id, name: nameOf(c), points: c.pointsBalance, lifetime: c.lifetimePoints })),
    recent: recent.map((t) => ({
      id: t.id,
      who: nameOf(t.customer),
      customerId: t.customer.id,
      type: t.type,
      points: t.points,
      at: t.createdAt.toISOString().slice(0, 16).replace("T", " "),
    })),
    checklist: { rules: rules > 0, rewards: rewards > 0 },
  };
};

const nameOf = (c) => [c.firstName, c.lastName].filter(Boolean).join(" ") || c.email || "Unknown";
const fmt = (n) => new Intl.NumberFormat("en-IN").format(n);

function Stat({ label, value }) {
  return (
    <s-box padding="base" border="base" borderRadius="large" background="base">
      <s-stack gap="small-300">
        <s-text color="subdued">{label}</s-text>
        <s-heading size="large">{fmt(value)}</s-heading>
      </s-stack>
    </s-box>
  );
}

// const SHORTCUTS = [
//   { href: "/app/rules", icon: "target", title: "Rules & rewards", text: "How customers earn and what they can spend points on" },
//   { href: "/app/customers", icon: "person", title: "Customers", text: "Balances, referrals, and importing existing members" },
//   { href: "/app/appearance", icon: "color", title: "Storefront widget", text: "Design what shoppers see, with a live editor" },
//   { href: "/app/emails", icon: "email", title: "Emails", text: "15 designs, every block and spacing editable" },
//   { href: "/app/analytics", icon: "chart-vertical", title: "Analytics", text: "Points, redemptions and referral revenue over time" },
// ];

// function Shortcut({ href, icon, title, text }) {
//   return (
//     <s-clickable href={href} border="base" borderRadius="large" padding="base" background="base">
//       <s-stack direction="inline" gap="base" alignItems="start">
//         <s-icon type={icon} />
//         <s-stack gap="small-500">
//           <s-text type="strong">{title}</s-text>
//           <s-text color="subdued">{text}</s-text>
//         </s-stack>
//       </s-stack>
//     </s-clickable>
//   );
// }

export default function Home() {
  const { stats, top, recent, checklist, shop, apiKey, mode } = useLoaderData();
  const embedUrl = `https://${shop}/admin/themes/current/editor?context=apps&activateAppId=${apiKey}/loyalty-embed`;

  return (
    <s-page heading="Loyalty & rewards">
      <s-button slot="primary-action" href="/app/appearance">
        Customise storefront
      </s-button>

      {/* <s-section heading="Jump to">
        <s-grid gridTemplateColumns="repeat(auto-fit, minmax(240px, 1fr))" gap="base">
          {SHORTCUTS.map((x) => (
            <Shortcut key={x.href} {...x} />
          ))}
        </s-grid>
      </s-section> */}

      <s-section heading="Get started">
        <s-stack gap="base">
          <s-stack direction="inline" gap="small" alignItems="center">
            <s-badge tone={checklist.rules ? "success" : "warning"}>{checklist.rules ? "Done" : "To do"}</s-badge>
            <s-text>
              Set how customers earn points and when they're credited.{" "}
              <s-link href="/app/rules">Rules</s-link>
            </s-text>
          </s-stack>
          <s-stack direction="inline" gap="small" alignItems="center">
            <s-badge tone={checklist.rewards ? "success" : "warning"}>{checklist.rewards ? "Done" : "To do"}</s-badge>
            <s-text>
              Create rewards customers can redeem, in the same place. <s-link href="/app/rules">Rules</s-link>
            </s-text>
          </s-stack>
          <s-stack direction="inline" gap="small" alignItems="center">
            <s-badge tone="info">{mode === "WIDGET" ? "Widget" : "Page"}</s-badge>
            <s-text>
              {mode === "WIDGET" ? (
                <>
                  Turn on the app embed in your theme so the widget appears.{" "}
                  <s-link href={embedUrl} target="_blank">
                    Open theme editor
                  </s-link>
                </>
              ) : (
                <>
                  Rewards page lives at <s-link href={`https://${shop}/apps/loyalty/rewards`} target="_blank">/apps/loyalty/rewards</s-link>
                  . Add it to your navigation.
                </>
              )}
            </s-text>
          </s-stack>
        </s-stack>
      </s-section>

      <s-section heading="Overview">
        <s-grid gridTemplateColumns="repeat(auto-fit, minmax(160px, 1fr))" gap="base">
          <Stat label="Members" value={stats.members} />
          <Stat label="Points issued" value={stats.issued} />
          <Stat label="Points redeemed" value={stats.redeemed} />
          <Stat label="Outstanding points" value={stats.outstanding} />
          <Stat label="Live discount codes" value={stats.activeCodes} />
        </s-grid>
      </s-section>

      <s-section heading="Top customers">
        {top.length === 0 ? (
          <s-paragraph>No members yet. Customers appear here after they log in or place an order.</s-paragraph>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>Customer</s-table-header>
              <s-table-header format="numeric">Balance</s-table-header>
              <s-table-header format="numeric">Lifetime</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {top.map((c) => (
                <s-table-row key={c.id}>
                  <s-table-cell>
                    <s-link href={`/app/customers/${c.id}`}>{c.name}</s-link>
                  </s-table-cell>
                  <s-table-cell>{fmt(c.points)}</s-table-cell>
                  <s-table-cell>{fmt(c.lifetime)}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>

      <s-section heading="Recent activity">
        {recent.length === 0 ? (
          <s-paragraph>Nothing yet.</s-paragraph>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>When</s-table-header>
              <s-table-header>Customer</s-table-header>
              <s-table-header>Type</s-table-header>
              <s-table-header format="numeric">Points</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {recent.map((t) => (
                <s-table-row key={t.id}>
                  <s-table-cell>{t.at}</s-table-cell>
                  <s-table-cell>
                    <s-link href={`/app/customers/${t.customerId}`}>{t.who}</s-link>
                  </s-table-cell>
                  <s-table-cell>{t.type.toLowerCase()}</s-table-cell>
                  <s-table-cell>
                    {t.points > 0 ? "+" : ""}
                    {fmt(t.points)}
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>
    </s-page>
  );
}
