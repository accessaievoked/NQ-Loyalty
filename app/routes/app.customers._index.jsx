import { Form, useLoaderData } from "react-router";
import { requireStore } from "../services/auth.server";
import db from "../db.server";
import { referralCounts } from "../services/referralstats.server";

const PAGE = 25;
const fmt = (n) => new Intl.NumberFormat("en-IN").format(n);

export const loader = async ({ request }) => {
  const { store } = await requireStore(request);
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").trim();
  const page = Math.max(1, Number(url.searchParams.get("page")) || 1);

  const where = {
    storeId: store.id,
    ...(q
      ? {
          OR: [
            { email: { contains: q, mode: "insensitive" } },
            { firstName: { contains: q, mode: "insensitive" } },
            { lastName: { contains: q, mode: "insensitive" } },
          ],
        }
      : {}),
  };
  const [total, rows] = await Promise.all([
    db.customer.count({ where }),
    db.customer.findMany({
      where,
      orderBy: [{ lifetimePoints: "desc" }, { createdAt: "desc" }],
      skip: (page - 1) * PAGE,
      take: PAGE,
    }),
  ]);
  const referred = await referralCounts(store.id, rows.map((c) => c.id));
  return {
    q,
    page,
    pages: Math.max(1, Math.ceil(total / PAGE)),
    total,
    rows: rows.map((c) => ({
      id: c.id,
      referred: referred.get(c.id) ?? 0,
      name: [c.firstName, c.lastName].filter(Boolean).join(" ") || "—",
      email: c.email || "—",
      balance: c.pointsBalance,
      lifetime: c.lifetimePoints,
      joined: c.createdAt.toISOString().slice(0, 10),
    })),
  };
};

export default function Customers() {
  const { rows, q, page, pages, total } = useLoaderData();
  const link = (p) => `/app/customers?${new URLSearchParams({ ...(q ? { q } : {}), page: String(p) })}`;

  return (
    <s-page heading="Customers">
      <s-button slot="primary-action" variant="primary" icon="import" href="/app/customers/import">
        Import customers
      </s-button>
      <s-section>
        <s-stack gap="base">
          <Form method="get">
            <s-stack direction="inline" gap="small" alignItems="end">
              <s-search-field label="Search" labelAccessibilityVisibility="exclusive" name="q" value={q} placeholder="Search name or email" />
              <s-button type="submit">Search</s-button>
            </s-stack>
          </Form>

          {rows.length === 0 ? (
            <s-paragraph>
              {q ? "No customers match that search." : "No members yet. They're added when a logged-in customer opens the widget or places an order, or you can import them."}
            </s-paragraph>
          ) : (
            <s-table>
              <s-table-header-row>
                <s-table-header listSlot="primary">Customer</s-table-header>
                <s-table-header format="numeric">Points</s-table-header>
                <s-table-header format="numeric">Earned in total</s-table-header>
                <s-table-header format="numeric">Referred</s-table-header>
                <s-table-header>Joined</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {rows.map((c) => (
                  <s-table-row key={c.id}>
                    <s-table-cell>
                      <s-stack gap="small-500">
                        <s-link href={`/app/customers/${c.id}`}>{c.name === "—" ? c.email : c.name}</s-link>
                        {c.name !== "—" && <s-text color="subdued">{c.email}</s-text>}
                      </s-stack>
                    </s-table-cell>
                    <s-table-cell>{fmt(c.balance)}</s-table-cell>
                    <s-table-cell>{fmt(c.lifetime)}</s-table-cell>
                    <s-table-cell>{c.referred}</s-table-cell>
                    <s-table-cell>{c.joined}</s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          )}

          <s-stack direction="inline" gap="small" justifyContent="space-between" alignItems="center">
            <s-text color="subdued">
              {total} member{total === 1 ? "" : "s"} · page {page} of {pages}
            </s-text>
            <s-stack direction="inline" gap="small">
              <s-button icon="chevron-left" accessibilityLabel="Previous page" disabled={page <= 1 || undefined} href={link(page - 1)} />
              <s-button icon="chevron-right" accessibilityLabel="Next page" disabled={page >= pages || undefined} href={link(page + 1)} />
            </s-stack>
          </s-stack>
        </s-stack>
      </s-section>
    </s-page>
  );
}
