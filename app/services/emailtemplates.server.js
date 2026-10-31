import prisma from "../db.server.js";
import {
  EMAIL_KINDS,
  defaultEmailTemplate,
  missingRequired,
  normalizeEmailTemplate,
  renderEmail,
} from "../lib/email/templates.js";

// Per-store email templates. No row means "use the built-in default", so a store only has rows
// for emails it customised, and deleting the row restores the default.

export const isKind = (k) => Object.prototype.hasOwnProperty.call(EMAIL_KINDS, k);

function fromRow(kind, row) {
  if (!row) return defaultEmailTemplate(kind);
  return normalizeEmailTemplate(kind, { mode: row.mode, subject: row.subject, html: row.html, ...(row.config || {}) });
}

export async function getEmailTemplate(storeId, kind) {
  const row = await prisma.emailTemplate.findUnique({ where: { storeId_kind: { storeId, kind } } });
  return { template: fromRow(kind, row), customised: !!row };
}

export async function listEmailTemplates(storeId) {
  const rows = await prisma.emailTemplate.findMany({ where: { storeId } });
  const byKind = new Map(rows.map((r) => [r.kind, r]));
  return Object.keys(EMAIL_KINDS).map((kind) => ({ kind, customised: byKind.has(kind), template: fromRow(kind, byKind.get(kind)) }));
}

/** Validate and save. Returns { ok } or { ok:false, errors }. */
export async function saveEmailTemplate(storeId, kind, input) {
  if (!isKind(kind)) return { ok: false, errors: ["Unknown email"] };
  const t = normalizeEmailTemplate(kind, input);
  const errors = [];
  if (t.mode === "html" && !t.html.trim()) errors.push("The HTML is empty. Write your HTML, or switch back to blocks.");
  if (!t.subject.trim()) errors.push("Add a subject line.");
  // Some emails are useless without a variable (a login email with no code locks people out).
  const missing = missingRequired(kind, t, EMAIL_KINDS[kind].sample);
  for (const k of missing) errors.push(`This email must include {{${k}}}, otherwise the customer can't use it.`);
  if (errors.length) return { ok: false, errors };

  const data = { mode: t.mode, subject: t.subject, html: t.mode === "html" ? t.html : t.html || null, config: { theme: t.theme, blocks: t.blocks } };
  await prisma.emailTemplate.upsert({
    where: { storeId_kind: { storeId, kind } },
    create: { storeId, kind, ...data },
    update: data,
  });
  return { ok: true };
}

export async function resetEmailTemplate(storeId, kind) {
  await prisma.emailTemplate.deleteMany({ where: { storeId, kind } });
  return { ok: true };
}

/** Variables available to every email, plus the per-email data (camelCase → snake_case). */
export function buildEmailVars(store, data = {}) {
  const fmt = (n) => (typeof n === "number" ? n.toLocaleString("en") : n);
  return {
    store: store.name || store.shop,
    shop_url: `https://${store.shop}`,
    first_name: data.firstName || "there",
    points: fmt(data.points),
    balance: fmt(data.balance),
    reason: data.reason || "you earned points",
    expires_at: data.expiresAt || "",
    reward_name: data.rewardName,
    code: data.code,
  };
}

/**
 * Render the email for sending. If anything about the store's template is wrong, fall back to
 * the default so a customer-facing email is never lost because of an editing mistake.
 */
export async function renderStoreEmail(store, kind, data) {
  const vars = buildEmailVars(store, data);
  try {
    const { template } = await getEmailTemplate(store.id, kind);
    const out = renderEmail(kind, template, vars);
    const broken = missingRequired(kind, template, vars).length > 0;
    if (!broken && out.html.trim()) return out;
  } catch (e) {
    console.warn("[email] template failed, using default:", e.message);
  }
  return renderEmail(kind, defaultEmailTemplate(kind), vars);
}
