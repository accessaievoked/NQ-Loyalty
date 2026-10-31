// Date ranges for the analytics page. Plain JS (no imports), shared by the page and the queries.
// All dates are UTC days, so "today" means the current UTC day.

export const RANGE_PRESETS = [
  ["today", "Today"],
  ["yesterday", "Yesterday"],
  ["7d", "Last 7 days"],
  ["14d", "Last 14 days"],
  ["30d", "Last 30 days"],
  ["60d", "Last 60 days"],
  ["90d", "Last 90 days"],
  ["180d", "Last 6 months"],
  ["365d", "Last 12 months"],
  ["this_month", "This month"],
  ["last_month", "Last month"],
  ["this_year", "This year"],
  ["all", "All time"],
  ["custom", "Custom range…"],
];

// Older links used these short keys.
const LEGACY = { 7: "7d", 30: "30d", 90: "90d" };
const DAY = 86400000;
export const DEFAULT_RANGE = "30d";

const startOfDay = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const ymd = (d) => d.toISOString().slice(0, 10);
const parseDay = (s) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ""))) return null;
  const d = new Date(`${s}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
};
const fmt = (d) =>
  d.toLocaleDateString("en", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });

/**
 * { range, from, to } (from URL params) → { key, label, since, until, from, to, text }
 * `since`/`until` are Dates (or null = open ended). `until` null means "up to now".
 */
export function resolveRange({ range, from, to } = {}, now = new Date()) {
  let key = LEGACY[range] ?? range ?? DEFAULT_RANGE;
  if (!RANGE_PRESETS.some(([k]) => k === key)) key = DEFAULT_RANGE;

  const today = startOfDay(now);
  let since = null;
  let until = null;

  const nd = /^(\d+)d$/.exec(key);
  if (nd) {
    since = new Date(today.getTime() - (Number(nd[1]) - 1) * DAY);
  } else if (key === "today") {
    since = today;
  } else if (key === "yesterday") {
    since = new Date(today.getTime() - DAY);
    until = new Date(today.getTime() - 1);
  } else if (key === "this_month") {
    since = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  } else if (key === "last_month") {
    since = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
    until = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1) - 1);
  } else if (key === "this_year") {
    since = new Date(Date.UTC(today.getUTCFullYear(), 0, 1));
  } else if (key === "custom") {
    let a = parseDay(from);
    let b = parseDay(to);
    if (!a || !b) {
      // Missing or invalid dates: fall back to the last 30 days rather than showing nothing.
      key = DEFAULT_RANGE;
      since = new Date(today.getTime() - 29 * DAY);
    } else {
      if (a > b) [a, b] = [b, a];
      since = a;
      until = new Date(b.getTime() + DAY - 1); // end of the chosen day
    }
  }
  // "all" keeps since = null

  const label = RANGE_PRESETS.find(([k]) => k === key)?.[1] ?? "Last 30 days";
  const shownTo = until ?? now;
  const text =
    key === "all"
      ? "All time"
      : key === "custom"
        ? `${fmt(since)} – ${fmt(until)}`
        : since && ymd(since) === ymd(shownTo)
          ? fmt(since)
          : `${fmt(since)} – ${fmt(shownTo)}`;

  return {
    key,
    label: key === "custom" ? text : label,
    since,
    until,
    from: since ? ymd(since) : "",
    to: ymd(until ?? today),
    text,
  };
}
