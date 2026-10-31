// Email templates — shared by the server (sending) and the editor (live preview).
// Plain JS, no imports. A template is either:
//   mode "blocks": { theme, blocks:[{id,type,settings}] }   → rendered to email-safe HTML here
//   mode "html":   a full HTML document you write, with {{variables}}
// Variables use {{name}}; values are HTML-escaped, and unknown names render as empty text.

export const EMAIL_KINDS = {
  points_earned: {
    label: "Points earned",
    when: "Sent when a customer receives points (order, referral, review, bonus, manual credit).",
    vars: [
      ["first_name", "Customer's first name"],
      ["points", "Points just added"],
      ["balance", "Their new balance"],
      ["reason", "Why they got them, e.g. ‘your order #1042 earned points’"],
      ["expires_at", "Expiry date of these points (empty if they never expire)"],
      ["store", "Your store name"],
      ["shop_url", "Link to your store"],
    ],
    sample: {
      first_name: "Alex", points: "120", balance: "1,370", reason: "your order #1042 earned points",
      expires_at: "2027-01-15", store: "Your Store", shop_url: "https://example.myshopify.com",
    },
  },
  redeemed: {
    label: "Reward code issued",
    when: "Sent when a customer redeems points and gets a discount code.",
    vars: [
      ["first_name", "Customer's first name"],
      ["reward_name", "What they redeemed"],
      ["code", "The discount code"],
      ["expires_at", "Code expiry date (empty if none)"],
      ["store", "Your store name"],
      ["shop_url", "Link to your store"],
    ],
    sample: {
      first_name: "Alex", reward_name: "Use points at checkout (500 points)", code: "LOY-8F2A91C0DE",
      expires_at: "2026-12-01", store: "Your Store", shop_url: "https://example.myshopify.com",
    },
  },
  expiring: {
    label: "Points expiring soon",
    when: "Sent ahead of the date a customer's points expire.",
    vars: [
      ["first_name", "Customer's first name"],
      ["points", "Points about to expire"],
      ["expires_at", "The date they expire"],
      ["store", "Your store name"],
      ["shop_url", "Link to your store"],
    ],
    sample: { first_name: "Alex", points: "200", expires_at: "2026-12-15", store: "Your Store", shop_url: "https://example.myshopify.com" },
  },
  otp: {
    label: "Login code",
    when: "Sent when a shopper logs in with their email. Must contain {{code}}.",
    vars: [
      ["code", "The 6-digit login code (required)"],
      ["store", "Your store name"],
      ["shop_url", "Link to your store"],
    ],
    sample: { code: "483920", store: "Your Store", shop_url: "https://example.myshopify.com" },
    required: ["code"],
  },
};

export const FONT_STACKS = {
  system: 'system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif',
  serif: 'Georgia,"Times New Roman",serif',
  mono: 'ui-monospace,Menlo,Consolas,monospace',
};

export const EMAIL_BLOCK_TYPES = {
  brand: { label: "Store name", icon: "◧", defaults: { text: "{{store}}" }, fields: [{ key: "text", label: "Text", type: "text" }] },
  heading: {
    label: "Heading", icon: "H",
    defaults: { text: "Heading", align: "left" },
    fields: [
      { key: "text", label: "Text", type: "text" },
      { key: "align", label: "Alignment", type: "select", options: { left: "Left", center: "Centre" } },
    ],
  },
  text: {
    label: "Text", icon: "T",
    defaults: { text: "Write something here.", muted: false },
    fields: [
      { key: "text", label: "Text", type: "textarea", help: "Use {{variables}}. **bold** works. Line breaks are kept." },
      { key: "muted", label: "Muted (grey, smaller)", type: "toggle" },
    ],
  },
  code: {
    label: "Code box", icon: "▣",
    defaults: { text: "{{code}}", size: 24 },
    fields: [
      { key: "text", label: "Text", type: "text" },
      { key: "size", label: "Size (px)", type: "number", min: 14, max: 48 },
    ],
  },
  button: {
    label: "Button", icon: "▭",
    defaults: { label: "Shop now", url: "{{shop_url}}", style: "solid" },
    fields: [
      { key: "label", label: "Label", type: "text" },
      { key: "url", label: "Link", type: "text", help: "https://… or {{shop_url}}" },
      { key: "style", label: "Style", type: "select", options: { solid: "Solid", outline: "Outline" } },
    ],
  },
  image: {
    label: "Image", icon: "▨",
    defaults: { url: "", alt: "", width: 200 },
    fields: [
      { key: "url", label: "Image URL (https://…)", type: "text" },
      { key: "alt", label: "Alt text", type: "text" },
      { key: "width", label: "Width (px)", type: "number", min: 40, max: 520 },
    ],
  },
  divider: { label: "Divider", icon: "—", defaults: {}, fields: [] },
  spacer: { label: "Spacer", icon: "↕", defaults: { height: 16 }, fields: [{ key: "height", label: "Height (px)", type: "number", min: 0, max: 80 }] },
  footer: { label: "Footer", icon: "…", defaults: { text: "You're receiving this because you're a member of {{store}}'s rewards program." }, fields: [{ key: "text", label: "Text", type: "textarea" }] },
};

let seq = 0;
export const newEmailBlockId = () => `e_${Date.now().toString(36)}${(seq += 1)}${Math.random().toString(36).slice(2, 5)}`;

export function makeEmailBlock(type, overrides = {}) {
  const def = EMAIL_BLOCK_TYPES[type];
  return { id: newEmailBlockId(), type, settings: { onlyIf: "", ...def.defaults, ...overrides } };
}

const defaultTheme = () => ({
  brand: "#111827", heading: "#111827", text: "#374151", muted: "#6b7280",
  background: "#f4f5f7", card: "#ffffff", radius: 14, font: "system", width: 520,
});

const B = makeEmailBlock;

const DEFAULTS = {
  points_earned: () => ({
    subject: "You just earned {{points}} points at {{store}}",
    blocks: [
      B("brand"), B("heading", { text: "+{{points}} points" }),
      B("text", { text: "Hi {{first_name}}, {{reason}}: **{{points}}** points added. Your balance is now **{{balance}}**." }),
      B("text", { text: "These points expire on {{expires_at}}.", muted: true, onlyIf: "expires_at" }),
      B("button", { label: "Use your points" }),
    ],
  }),
  redeemed: () => ({
    subject: "Your {{store}} reward code: {{code}}",
    blocks: [
      B("brand"), B("heading", { text: "{{reward_name}}" }),
      B("text", { text: "Hi {{first_name}}, here is your discount code:" }),
      B("code", { text: "{{code}}", size: 24 }),
      B("text", { text: "Valid until {{expires_at}}.", onlyIf: "expires_at" }),
      B("button", { label: "Shop now" }),
    ],
  }),
  expiring: () => ({
    subject: "{{points}} of your points expire soon",
    blocks: [
      B("brand"), B("heading", { text: "Your points are about to expire" }),
      B("text", { text: "Hi {{first_name}}, **{{points}}** points expire on **{{expires_at}}**. Redeem them before they're gone." }),
      B("button", { label: "Redeem now" }),
    ],
  }),
  otp: () => ({
    subject: "{{code}} is your {{store}} login code",
    blocks: [
      B("brand"), B("heading", { text: "Your login code" }),
      B("text", { text: "Enter this code to see your rewards. It expires in 10 minutes." }),
      B("code", { text: "{{code}}", size: 30 }),
      B("text", { text: "If you didn't ask for this, you can ignore this email.", muted: true }),
    ],
  }),
};

export function defaultEmailTemplate(kind) {
  const d = (DEFAULTS[kind] || DEFAULTS.points_earned)();
  return { kind, mode: "blocks", subject: d.subject, theme: defaultTheme(), blocks: d.blocks, html: "" };
}

const clamp = (n, lo, hi, fb) => {
  const v = Number(n);
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fb;
};
const hex = (v, fb) => (typeof v === "string" && /^#[0-9a-fA-F]{3,8}$/.test(v.trim()) ? v.trim() : fb);

/** Make any stored/incoming template safe to render. */
export function normalizeEmailTemplate(kind, input) {
  const base = defaultEmailTemplate(kind);
  const src = input && typeof input === "object" ? input : {};
  const t = { ...base.theme, ...(src.theme || {}) };
  const theme = {
    brand: hex(t.brand, base.theme.brand), heading: hex(t.heading, base.theme.heading), text: hex(t.text, base.theme.text),
    muted: hex(t.muted, base.theme.muted), background: hex(t.background, base.theme.background), card: hex(t.card, base.theme.card),
    radius: clamp(t.radius, 0, 32, 14), font: FONT_STACKS[t.font] ? t.font : "system", width: clamp(t.width, 360, 700, 520),
  };
  const raw = Array.isArray(src.blocks) ? src.blocks : base.blocks;
  const seen = new Set();
  const blocks = [];
  for (const b of raw.slice(0, 40)) {
    const def = EMAIL_BLOCK_TYPES[b?.type];
    if (!def) continue;
    let id = typeof b.id === "string" && b.id ? b.id.slice(0, 40) : newEmailBlockId();
    if (seen.has(id)) id = newEmailBlockId();
    seen.add(id);
    const settings = { onlyIf: "", ...def.defaults, ...(b.settings || {}) };
    const allowed = (EMAIL_KINDS[kind]?.vars || []).map((v) => v[0]);
    if (settings.onlyIf && !allowed.includes(settings.onlyIf)) settings.onlyIf = "";
    blocks.push({ id, type: b.type, settings });
  }
  return {
    kind,
    mode: src.mode === "html" ? "html" : "blocks",
    subject: String(src.subject ?? base.subject).replace(/[\r\n]+/g, " ").slice(0, 200) || base.subject,
    theme,
    blocks,
    html: String(src.html ?? "").slice(0, 100000),
  };
}

// --- rendering -------------------------------------------------------------------------

const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** Replace {{name}} with the (escaped) value; unknown or missing → empty. */
function fill(text, vars) {
  return String(text ?? "").replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (k in vars && vars[k] != null ? esc(vars[k]) : ""));
}

// Escape the author's text, fill variables, then apply **bold** and keep line breaks.
function rich(text, vars) {
  return fill(esc(text), vars)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\r?\n/g, "<br>");
}

const safeUrl = (u) => (/^(https?:\/\/|mailto:)/i.test(u) ? u : "#");

function renderBlock(b, theme, vars) {
  const s = b.settings;
  if (s.onlyIf && !String(vars[s.onlyIf] ?? "").trim()) return "";
  const pad = "padding:0 32px";
  switch (b.type) {
    case "brand":
      return `<tr><td style="${pad};padding-top:28px;padding-bottom:8px;font-size:13px;color:${theme.muted}">${rich(s.text, vars)}</td></tr>`;
    case "heading":
      return `<tr><td style="${pad};padding-bottom:8px;font-size:22px;font-weight:700;line-height:1.3;color:${theme.heading};text-align:${s.align === "center" ? "center" : "left"}">${rich(s.text, vars)}</td></tr>`;
    case "text":
      return `<tr><td style="${pad};padding-top:6px;padding-bottom:6px;font-size:${s.muted ? 13 : 15}px;line-height:1.55;color:${s.muted ? theme.muted : theme.text}">${rich(s.text, vars)}</td></tr>`;
    case "code":
      return `<tr><td style="${pad};padding-top:8px;padding-bottom:8px"><div style="display:inline-block;background:${theme.background};padding:14px 18px;border-radius:10px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:${clamp(s.size, 14, 48, 24)}px;font-weight:800;letter-spacing:.08em;color:${theme.heading}">${rich(s.text, vars)}</div></td></tr>`;
    case "button": {
      const href = esc(safeUrl(fill(s.url, vars).replace(/&amp;/g, "&")));
      const outline = s.style === "outline";
      return `<tr><td style="${pad};padding-top:18px;padding-bottom:6px"><a href="${href}" style="display:inline-block;${outline ? `border:2px solid ${theme.brand};color:${theme.brand};background:transparent;` : `background:${theme.brand};color:#ffffff;`}text-decoration:none;padding:12px 20px;border-radius:10px;font-weight:600;font-size:15px">${rich(s.label, vars)}</a></td></tr>`;
    }
    case "image": {
      const url = fill(s.url, vars).replace(/&amp;/g, "&");
      if (!/^https:\/\//i.test(url)) return "";
      return `<tr><td style="${pad};padding-top:8px;padding-bottom:8px"><img src="${esc(url)}" alt="${esc(s.alt)}" width="${clamp(s.width, 40, 520, 200)}" style="display:block;max-width:100%;height:auto;border:0"></td></tr>`;
    }
    case "divider":
      return `<tr><td style="${pad};padding-top:12px;padding-bottom:12px"><div style="height:1px;background:${theme.background}"></div></td></tr>`;
    case "spacer":
      return `<tr><td style="height:${clamp(s.height, 0, 80, 16)}px;line-height:${clamp(s.height, 0, 80, 16)}px;font-size:0">&nbsp;</td></tr>`;
    case "footer":
      return `<tr><td style="${pad};padding-top:14px;padding-bottom:26px;font-size:12px;line-height:1.5;color:${theme.muted}">${rich(s.text, vars)}</td></tr>`;
    default:
      return "";
  }
}

/** Conservative clean-up for merchant-written email HTML. */
export function cleanEmailHtml(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<(iframe|object|embed|form)[\s\S]*?(<\/\1>|\/>|>)/gi, "")
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(href|src)\s*=\s*("|')\s*javascript:[^"']*\2/gi, '$1="#"');
}

/** Render a template with variables → { subject, html }. Never throws. */
export function renderEmail(kind, template, vars) {
  const t = normalizeEmailTemplate(kind, template);
  const subject = String(t.subject).replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => String(vars[k] ?? "")).replace(/[\r\n]+/g, " ").trim().slice(0, 200);

  if (t.mode === "html" && t.html.trim()) {
    return { subject, html: cleanEmailHtml(fill(t.html, vars)) };
  }
  const th = t.theme;
  const rows = t.blocks.map((b) => renderBlock(b, th, vars)).join("\n");
  const html = `<!doctype html><html><body style="margin:0;background:${th.background};font-family:${FONT_STACKS[th.font]};color:${th.text}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="${th.width}" cellpadding="0" cellspacing="0" style="max-width:${th.width}px;width:100%;background:${th.card};border-radius:${th.radius}px;overflow:hidden">
${rows}
</table></td></tr></table></body></html>`;
  return { subject, html };
}

/** The editor's "start from blocks" button: the rendered HTML with variables left in place. */
export function blocksToHtml(kind, template) {
  const t = normalizeEmailTemplate(kind, { ...template, mode: "blocks" });
  const vars = Object.fromEntries((EMAIL_KINDS[kind]?.vars || []).map(([k]) => [k, `{{${k}}}`]));
  const th = t.theme;
  const rows = t.blocks.map((b) => renderBlock({ ...b, settings: { ...b.settings, onlyIf: "" } }, th, vars)).join("\n");
  return `<!doctype html><html><body style="margin:0;background:${th.background};font-family:${FONT_STACKS[th.font]};color:${th.text}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="${th.width}" cellpadding="0" cellspacing="0" style="max-width:${th.width}px;width:100%;background:${th.card};border-radius:${th.radius}px;overflow:hidden">
${rows}
</table></td></tr></table></body></html>`;
}

/** Variables a template must use for the email to make sense (e.g. the login code). */
export function missingRequired(kind, template, sampleVars) {
  const req = EMAIL_KINDS[kind]?.required || [];
  if (!req.length) return [];
  const probe = Object.fromEntries(req.map((k) => [k, `__${k.toUpperCase()}__`]));
  const out = renderEmail(kind, template, { ...sampleVars, ...probe });
  return req.filter((k) => !out.html.includes(`__${k.toUpperCase()}__`));
}
