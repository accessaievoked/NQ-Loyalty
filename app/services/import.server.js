import prisma from "../db.server.js";
import { normalizeEmail } from "./identity.server.js";
import { upsertCustomer, shapeCustomer } from "./customers.server.js";
import { postTransaction } from "./ledger.server.js";
import { MAX_ROWS } from "../lib/import-limits.js";

// Bringing people in from somewhere else: a CSV (an export from another loyalty app, or your own
// spreadsheet) and the customers Shopify already has. Neither gives out welcome bonuses, and
// imported accounts start unverified — someone claiming an imported account by email login still
// has to prove they own the address.

export const MAX_CSV_BYTES = 1_500_000;
const MAX_POINTS = 10_000_000;

/** Small RFC-4180-ish parser: quoted fields, doubled quotes, CRLF, a UTF-8 BOM. */
export function parseCsv(text) {
  const src = String(text ?? "").replace(/^\uFEFF/, "");
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === "," || ch === ";" || ch === "\t") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i += 1;
      row.push(cell);
      cell = "";
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== "")) rows.push(row);
  return rows;
}

const ALIASES = {
  email: ["email", "e-mail", "email address", "customer email"],
  first: ["first name", "first_name", "firstname", "first"],
  last: ["last name", "last_name", "lastname", "last", "surname"],
  name: ["name", "full name", "customer", "customer name"],
  points: ["points", "point balance", "points balance", "balance", "coins", "credits", "current points", "available points"],
};

const norm = (h) => String(h ?? "").trim().toLowerCase().replace(/\s+/g, " ");

/** → { rows: [{ line, email, firstName, lastName, points }], problems: [{ line, reason }] } */
export function readImportRows(text) {
  const table = parseCsv(text);
  if (table.length < 2) return { rows: [], problems: [], error: "The file needs a header row and at least one customer." };
  const head = table[0].map(norm);
  const col = Object.fromEntries(Object.entries(ALIASES).map(([k, names]) => [k, head.findIndex((h) => names.includes(h))]));
  if (col.email < 0) return { rows: [], problems: [], error: 'No "email" column found. The first row must name the columns, for example: email, first_name, last_name, points.' };

  const rows = [];
  const problems = [];
  const seen = new Set();
  for (let i = 1; i < table.length; i += 1) {
    const r = table[i];
    const line = i + 1;
    let email;
    try {
      email = normalizeEmail(r[col.email]);
    } catch {
      problems.push({ line, reason: `"${String(r[col.email] ?? "").slice(0, 40)}" isn't a valid email` });
      continue;
    }
    if (seen.has(email)) {
      problems.push({ line, reason: `${email} appears more than once (first one used)` });
      continue;
    }
    seen.add(email);
    let firstName = col.first >= 0 ? (r[col.first] || "").trim() : "";
    let lastName = col.last >= 0 ? (r[col.last] || "").trim() : "";
    if (!firstName && !lastName && col.name >= 0) {
      const [f, ...rest] = String(r[col.name] || "").trim().split(/\s+/);
      firstName = f || "";
      lastName = rest.join(" ");
    }
    let points = 0;
    if (col.points >= 0 && String(r[col.points] ?? "").trim() !== "") {
      const n = Number(String(r[col.points]).replace(/[, ]/g, ""));
      if (!Number.isFinite(n) || n < 0) {
        problems.push({ line, reason: `${email}: "${r[col.points]}" isn't a valid points number (account added without points)` });
      } else points = Math.min(MAX_POINTS, Math.floor(n));
    }
    rows.push({ line, email, firstName: firstName.slice(0, 80), lastName: lastName.slice(0, 80), points });
  }
  return { rows, problems };
}

async function pool(items, size, fn) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (i < items.length) {
        const item = items[i];
        i += 1;
        await fn(item);
      }
    }),
  );
}

/** Add the rows as loyalty accounts, with their starting points. Safe to run twice. */
export async function importCustomers(store, text) {
  if (String(text ?? "").length > MAX_CSV_BYTES) return { error: "That file is too big. Split it into smaller files (up to 2,000 customers each)." };
  const { rows, problems, error } = readImportRows(text);
  if (error) return { error };
  if (rows.length > MAX_ROWS) return { error: `Up to ${MAX_ROWS.toLocaleString()} customers per file — this one has ${rows.length.toLocaleString()}. Split it and import the parts one by one.` };

  const out = { total: rows.length, created: 0, matched: 0, pointsAdded: 0, withPoints: 0, alreadyImported: 0, problems };
  await pool(rows, 6, async (r) => {
    try {
      let c = await prisma.customer.findUnique({ where: { storeId_email: { storeId: store.id, email: r.email } } });
      if (c) {
        out.matched += 1;
        const fill = {};
        if (!c.firstName && r.firstName) fill.firstName = r.firstName;
        if (!c.lastName && r.lastName) fill.lastName = r.lastName;
        if (Object.keys(fill).length) c = await prisma.customer.update({ where: { id: c.id }, data: fill });
      } else {
        c = await prisma.customer.create({ data: { storeId: store.id, email: r.email, firstName: r.firstName || null, lastName: r.lastName || null } });
        out.created += 1;
      }
      if (r.points > 0) {
        const { duplicate } = await postTransaction({
          storeId: store.id,
          customerId: c.id,
          type: "ADJUST",
          points: r.points,
          source: "import",
          note: "Imported balance",
          idempotencyKey: `import:${r.email}`,
        });
        if (duplicate) out.alreadyImported += 1;
        else {
          await prisma.customer.update({ where: { id: c.id }, data: { lifetimePoints: { increment: r.points } } });
          out.pointsAdded += r.points;
          out.withPoints += 1;
        }
      }
    } catch (e) {
      console.warn("[import]", r.email, e.message);
      out.problems.push({ line: r.line, reason: `${r.email}: couldn't be imported (${e.code || e.message})` });
    }
  });
  out.problems.sort((a, b) => a.line - b.line);
  return out;
}

const SHOPIFY_CUSTOMERS = `#graphql
  query LoyaltyImportCustomers($after: String) {
    customers(first: 100, after: $after) {
      nodes { id email phone firstName lastName verifiedEmail }
      pageInfo { hasNextPage endCursor }
    }
  }`;

/** Create a loyalty account for every customer Shopify already has (no points, no welcome bonus). */
export async function importShopifyCustomers(store, admin, { after = null, pages = 10 } = {}) {
  const out = { seen: 0, created: 0, existing: 0, next: null };
  let cursor = after || null;
  for (let p = 0; p < pages; p += 1) {
    const res = await admin.graphql(SHOPIFY_CUSTOMERS, { variables: { after: cursor } });
    const body = await res.json();
    if (body.errors?.length) return { error: body.errors[0].message || "Shopify wouldn't return the customer list" };
    const page = body.data?.customers;
    if (!page) return { error: "Shopify wouldn't return the customer list. Check that the app has the customers permission." };
    await pool(page.nodes, 6, async (node) => {
      const shaped = shapeCustomer(node);
      const known = await prisma.customer.findUnique({
        where: { storeId_shopifyCustomerId: { storeId: store.id, shopifyCustomerId: shaped.shopifyCustomerId } },
        select: { id: true },
      });
      out.seen += 1;
      if (known) {
        out.existing += 1;
        return;
      }
      await upsertCustomer(store.id, shaped, { bonus: false });
      out.created += 1;
    });
    if (!page.pageInfo.hasNextPage) return out;
    cursor = page.pageInfo.endCursor;
  }
  out.next = cursor;
  return out;
}
