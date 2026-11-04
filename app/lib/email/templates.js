// Email templates — shared by the server (sending) and the editor (live preview).
// Plain JS, no imports. A template is either:
//   mode "blocks": { theme, blocks:[{id,type,settings,style}] }  → rendered to email-safe HTML here
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
      ["support_email", "Where customers can reach you (your reply-to address)"],
    ],
    sample: {
      first_name: "Alex", points: "120", balance: "1,370", reason: "your order #1042 earned points",
      expires_at: "2027-01-15", store: "Claura", shop_url: "https://example.myshopify.com", support_email: "care@claura.in",
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
      ["support_email", "Where customers can reach you (your reply-to address)"],
    ],
    sample: {
      first_name: "Alex", reward_name: "Use points at checkout (500 points)", code: "LOY-8F2A91C0DE",
      expires_at: "2026-12-01", store: "Claura", shop_url: "https://example.myshopify.com", support_email: "care@claura.in",
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
      ["support_email", "Where customers can reach you (your reply-to address)"],
    ],
    sample: { first_name: "Alex", points: "200", expires_at: "2026-12-15", store: "Claura", shop_url: "https://example.myshopify.com", support_email: "care@claura.in" },
  },
  otp: {
    label: "Login code",
    when: "Sent when a shopper logs in with their email. Must contain {{code}}.",
    vars: [
      ["code", "The 6-digit login code (required)"],
      ["store", "Your store name"],
      ["shop_url", "Link to your store"],
      ["support_email", "Where customers can reach you (your reply-to address)"],
    ],
    sample: { code: "483920", store: "Claura", shop_url: "https://example.myshopify.com", support_email: "care@claura.in" },
    required: ["code"],
  },
};

export const FONT_STACKS = {
  // Single quotes inside: these go in a double-quoted style="…" attribute.
  system: "system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif",
  trebuchet: "'Trebuchet MS','Lucida Grande',Verdana,sans-serif",
  verdana: "Verdana,Geneva,sans-serif",
  serif: "Georgia,'Times New Roman',serif",
  palatino: "'Palatino Linotype',Palatino,'Book Antiqua',serif",
  mono: "ui-monospace,Menlo,Consolas,'Courier New',monospace",
};
export const FONT_LABELS = {
  system: "Sans-serif (system)", trebuchet: "Trebuchet", verdana: "Verdana",
  serif: "Georgia (serif)", palatino: "Palatino (serif)", mono: "Monospace",
};

export const EMAIL_BLOCK_TYPES = {
  brand: {
    label: "Store name / logo", icon: "◧",
    defaults: { text: "{{store}}", logo: "", logoWidth: 120, logoFull: false },
    fields: [
      { key: "text", label: "Text", type: "text" },
      { key: "logo", label: "Logo image URL (https://…)", type: "text", help: "Shown above the text. Leave empty for text only." },
      { key: "logoWidth", label: "Logo width (px)", type: "number", min: 40, max: 400 },
      { key: "logoFull", label: "Logo fills the whole header", type: "toggle", help: "Edge to edge, like a banner image. Spacing and background are ignored." },
    ],
  },
  badge: {
    label: "Label pill", icon: "◖",
    defaults: { text: "NEW" },
    fields: [{ key: "text", label: "Text", type: "text", help: "A small coloured pill above the heading, e.g. POINTS EARNED." }],
  },
  heading: {
    label: "Heading", icon: "H",
    defaults: { text: "Heading", align: "left" },
    fields: [
      { key: "text", label: "Text", type: "text" },
      { key: "align", label: "Alignment", type: "select", options: { left: "Left", center: "Centre", right: "Right" } },
    ],
  },
  text: {
    label: "Text", icon: "T",
    defaults: { text: "Write something here.", muted: false },
    fields: [
      { key: "text", label: "Text", type: "textarea", help: "Variables work. **bold**, line breaks, and links like [Shop now](https://…) or [Shop]({{shop_url}})." },
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
    defaults: { label: "Shop now", url: "{{shop_url}}", style: "solid", fullWidth: false },
    fields: [
      { key: "label", label: "Label", type: "text" },
      { key: "url", label: "Link", type: "text", help: "https://… or {{shop_url}}" },
      { key: "style", label: "Style", type: "select", options: { solid: "Solid", outline: "Outline" } },
      { key: "fullWidth", label: "Full width", type: "toggle" },
    ],
  },
  image: {
    label: "Image", icon: "▨",
    defaults: { url: "", alt: "", width: 200, link: "", fullWidth: false },
    fields: [
      { key: "url", label: "Image URL (https://…)", type: "text" },
      { key: "alt", label: "Alt text", type: "text" },
      { key: "width", label: "Width (px)", type: "number", min: 40, max: 700 },
      { key: "fullWidth", label: "Stretch edge to edge", type: "toggle" },
      { key: "link", label: "Link when clicked (optional)", type: "text", help: "https://… or {{shop_url}}" },
    ],
  },
  links: {
    label: "Links row", icon: "⌁",
    defaults: { items: "Visit {{store}} | {{shop_url}}", separator: "·" },
    fields: [
      { key: "items", label: "Links (one per line: Label | URL)", type: "textarea", help: "e.g. Shop | {{shop_url}}" },
      { key: "separator", label: "Separator", type: "text" },
    ],
  },
  divider: { label: "Divider", icon: "—", defaults: {}, fields: [] },
  spacer: { label: "Spacer", icon: "↕", defaults: { height: 16 }, fields: [{ key: "height", label: "Height (px)", type: "number", min: 0, max: 120 }] },
  footer: { label: "Footer", icon: "…", defaults: { text: "You're receiving this because you're a member of {{store}}'s rewards program." }, fields: [{ key: "text", label: "Text", type: "textarea" }] },
};

// Per-block look. All optional: empty = the design's default for that block.
export const EMAIL_STYLE_FIELDS = [
  { key: "bg", label: "Row background (full width)", type: "color" },
  { key: "box", label: "Box background", type: "color", help: "A coloured box around the content, or the button's colour." },
  { key: "color", label: "Text colour", type: "color" },
  { key: "size", label: "Text size", type: "range", min: 10, max: 48 },
  { key: "weight", label: "Text weight", type: "select", options: { "": "Default", "400": "Regular", "500": "Medium", "600": "Semi-bold", "700": "Bold", "800": "Extra bold" } },
  { key: "lineHeight", label: "Line height", type: "select", options: { "": "Default", "1.2": "Tight", "1.4": "Snug", "1.55": "Normal", "1.75": "Relaxed", "2": "Airy" } },
  { key: "align", label: "Alignment", type: "select", options: { "": "Default", left: "Left", center: "Centre", right: "Right" } },
  { key: "italic", label: "Italic", type: "toggle" },
  { key: "upper", label: "Uppercase", type: "toggle" },
  { key: "padTop", label: "Space above", type: "range", min: 0, max: 100 },
  { key: "padBottom", label: "Space below", type: "range", min: 0, max: 100 },
  { key: "padX", label: "Side spacing", type: "range", min: 0, max: 100 },
  { key: "boxPad", label: "Padding inside the box", type: "range", min: 0, max: 60 },
  { key: "radius", label: "Corner radius", type: "range", min: 0, max: 60 },
  { key: "borderW", label: "Border width", type: "range", min: 0, max: 8 },
  { key: "borderColor", label: "Border colour", type: "color" },
];

const STYLE_COLORS = ["bg", "box", "color", "borderColor"];
const STYLE_RANGES = { size: [10, 48], padTop: [0, 100], padBottom: [0, 100], padX: [0, 100], boxPad: [0, 60], radius: [0, 60], borderW: [0, 8] };

const isHex = (v) => typeof v === "string" && /^#[0-9a-fA-F]{3,8}$/.test(v.trim());

export function normalizeEmailStyle(s) {
  const out = {};
  if (!s || typeof s !== "object") return out;
  for (const k of STYLE_COLORS) if (isHex(s[k])) out[k] = s[k].trim();
  for (const [k, [lo, hi]] of Object.entries(STYLE_RANGES)) {
    if (s[k] === "" || s[k] == null) continue;
    const n = Number(s[k]);
    if (Number.isFinite(n)) out[k] = Math.min(hi, Math.max(lo, n));
  }
  if (["400", "500", "600", "700", "800"].includes(String(s.weight))) out.weight = String(s.weight);
  if (["1.2", "1.4", "1.55", "1.75", "2"].includes(String(s.lineHeight))) out.lineHeight = String(s.lineHeight);
  if (["left", "center", "right"].includes(s.align)) out.align = s.align;
  if (s.italic === true) out.italic = true;
  if (s.upper === true) out.upper = true;
  return out;
}

let seq = 0;
export const newEmailBlockId = () => `e_${Date.now().toString(36)}${(seq += 1)}${Math.random().toString(36).slice(2, 5)}`;

export function makeEmailBlock(type, overrides = {}, style = {}) {
  const def = EMAIL_BLOCK_TYPES[type];
  return { id: newEmailBlockId(), type, settings: { onlyIf: "", ...def.defaults, ...overrides }, style: { ...style } };
}

const baseTheme = () => ({
  brand: "#111827", heading: "#111827", text: "#374151", muted: "#6b7280",
  background: "#f4f5f7", card: "#ffffff", cardBorder: "", radius: 14, font: "system", width: 520, pagePad: 32, padX: 32, rowGap: "",
});

const B = (...a) => makeEmailBlock(...a);

// The words of each email. Looks come from the design presets below.
const CONTENT = {
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
      B("text", { text: "Hi {{first_name}}, here is your discount code. Copy it and paste it at checkout:" }),
      B("code", { text: "{{code}}", size: 24 }),
      B("text", { text: "Valid until {{expires_at}}.", muted: true, onlyIf: "expires_at" }),
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

// ---- ready-made designs -------------------------------------------------------------------------
// `styles` maps a block type to its look; `muted` is added to muted text blocks; `append` adds
// closing blocks (links, footer). Applying one rebuilds the email's blocks and design.
const BADGES = { points_earned: "Points earned", redeemed: "Reward code", expiring: "Points expiring", otp: "Login code" };

export const EMAIL_PRESETS = {
  blush: {
    label: "Blush",
    note: "Pink header band, label pill, left-aligned — like the Claura order emails",
    brandColors: true,
    theme: { brand: "#f18599", heading: "#1f1d1e", text: "#3a3a3a", muted: "#8b8b8b", background: "#f4f4f5", card: "#ffffff", radius: 7, font: "system", width: 600, pagePad: 24, padX: 40 },
    styles: {
      brand: { bg: "#d9788a", color: "#ffffff", align: "center", size: 12, weight: "600", upper: true, padTop: 36, padBottom: 36 },
      badge: { box: "#fde8ed", color: "#f0788d", size: 11, weight: "700", radius: 8, boxPad: 6, padTop: 28 },
      heading: { size: 26, weight: "700", padTop: 14, padBottom: 6 },
      text: { size: 15, lineHeight: "1.7" },
      textMuted: { size: 13 },
      code: { box: "#fdf2f4", color: "#d9546b", borderColor: "#f4b8c3", borderW: 1, radius: 10, boxPad: 14 },
      button: { box: "#f18599", radius: 60, boxPad: 12, size: 15, weight: "600", padTop: 18, padBottom: 30 },
    },
    append: [
      ["footer", { text: "**Questions about your points?**\nJust reply to this email or reach us at {{support_email}}. We're happy to help." }, { bg: "#f18599", color: "#ffffff", align: "center", size: 13, padTop: 30, padBottom: 30 }],
    ],
  },
  classic: {
    label: "Classic",
    note: "Clean white card, dark button",
    theme: { brand: "#111827", heading: "#111827", text: "#374151", muted: "#6b7280", background: "#f4f5f7", card: "#ffffff", radius: 14, font: "system", width: 520, pagePad: 32 },
    styles: {
      code: { box: "#f4f5f7", radius: 10, boxPad: 14 },
      button: { radius: 10 },
    },
    append: [],
  },
  midnight: {
    label: "Midnight",
    note: "Dark card with a gold accent",
    theme: { brand: "#f59e0b", heading: "#ffffff", text: "#cbd5e1", muted: "#94a3b8", background: "#0b1020", card: "#151b2e", radius: 20, font: "system", width: 540, pagePad: 32 },
    styles: {
      brand: { color: "#f59e0b", size: 12, weight: "700", upper: true, padTop: 30 },
      heading: { size: 27, weight: "800", padTop: 6 },
      code: { box: "#0b1020", color: "#f59e0b", borderColor: "#334155", borderW: 1, radius: 12, boxPad: 16 },
      button: { color: "#111827", radius: 12, weight: "700", boxPad: 14 },
    },
    append: [["footer", {}, { padTop: 22, padBottom: 28 }]],
  },
  minimal: {
    label: "Minimal",
    note: "Quiet, typographic, no card",
    theme: { brand: "#111827", heading: "#111827", text: "#374151", muted: "#6b7280", background: "#ffffff", card: "#ffffff", cardBorder: "#e5e7eb", radius: 0, font: "serif", width: 520, pagePad: 24 },
    styles: {
      brand: { size: 12, upper: true, weight: "600", padTop: 30 },
      heading: { size: 26, weight: "400", padBottom: 10 },
      text: { size: 16, lineHeight: "1.75" },
      code: { box: "#ffffff", borderColor: "#111827", borderW: 1, radius: 0, boxPad: 14 },
      button: { radius: 0, weight: "600", upper: true, size: 13, boxPad: 14 },
    },
    append: [["footer", {}, { padTop: 22, padBottom: 28 }]],
  },
  vivid: {
    label: "Vivid",
    note: "Bold colour band and big type",
    theme: { brand: "#7c3aed", heading: "#ffffff", text: "#374151", muted: "#6b7280", background: "#f5f3ff", card: "#ffffff", radius: 20, font: "verdana", width: 560, pagePad: 32 },
    styles: {
      brand: { bg: "#7c3aed", color: "#ede9fe", size: 13, weight: "700", upper: true, align: "center", padTop: 26, padBottom: 0 },
      heading: { bg: "#7c3aed", color: "#ffffff", align: "center", size: 32, weight: "800", padTop: 6, padBottom: 30 },
      text: { padX: 36, size: 15, lineHeight: "1.7" },
      code: { align: "center", box: "#ede9fe", color: "#5b21b6", radius: 14, boxPad: 18 },
      button: { align: "center", radius: 12, boxPad: 15, weight: "700" },
    },
    append: [["footer", {}, { padTop: 20, padBottom: 28, padX: 36 }]],
  },
  sage: {
    label: "Sage",
    note: "Calm greens, soft corners",
    theme: { brand: "#4d7c5b", heading: "#1f3a2a", text: "#3f5648", muted: "#7a8f82", background: "#eef4ef", card: "#ffffff", radius: 22, font: "palatino", width: 540, pagePad: 32 },
    styles: {
      brand: { bg: "#dcebe0", color: "#2f5a3e", align: "center", size: 12, weight: "700", upper: true, padTop: 20, padBottom: 20 },
      heading: { align: "center", size: 27, weight: "600", padTop: 28, padBottom: 6 },
      text: { align: "center", size: 15, lineHeight: "1.75", padX: 40 },
      code: { align: "center", box: "#eef4ef", color: "#2f5a3e", borderColor: "#4d7c5b", borderW: 1, radius: 12, boxPad: 16 },
      button: { align: "center", radius: 999, boxPad: 14, weight: "600", padTop: 22 },
    },
    append: [["footer", {}, { align: "center", padTop: 18, padBottom: 28, padX: 40 }]],
  },
  ocean: {
    label: "Ocean",
    note: "Deep blue header, crisp white body",
    theme: { brand: "#0369a1", heading: "#ffffff", text: "#334155", muted: "#64748b", background: "#e0f2fe", card: "#ffffff", radius: 16, font: "system", width: 560, pagePad: 28 },
    styles: {
      brand: { bg: "#0c4a6e", color: "#bae6fd", size: 12, weight: "700", upper: true, padTop: 24, padBottom: 0, padX: 36 },
      heading: { bg: "#0c4a6e", color: "#ffffff", size: 30, weight: "800", padTop: 6, padBottom: 28, padX: 36 },
      text: { padX: 36, size: 15, lineHeight: "1.7" },
      code: { box: "#e0f2fe", color: "#075985", radius: 10, boxPad: 16 },
      button: { radius: 8, boxPad: 14, weight: "700", padX: 36 },
    },
    append: [["footer", {}, { padTop: 20, padBottom: 28, padX: 36 }]],
  },
  sunset: {
    label: "Sunset",
    note: "Warm orange, friendly and bold",
    theme: { brand: "#ea580c", heading: "#431407", text: "#57372a", muted: "#a8806f", background: "#fff4ea", card: "#ffffff", radius: 20, font: "trebuchet", width: 540, pagePad: 32 },
    styles: {
      brand: { bg: "#ffedd5", color: "#9a3412", align: "center", size: 13, weight: "700", upper: true, padTop: 20, padBottom: 20 },
      heading: { align: "center", size: 30, weight: "800", padTop: 28, padBottom: 6 },
      text: { align: "center", size: 15, lineHeight: "1.7", padX: 40 },
      code: { align: "center", box: "#fff4ea", color: "#c2410c", borderColor: "#fdba74", borderW: 2, radius: 14, boxPad: 16 },
      button: { align: "center", radius: 14, boxPad: 15, weight: "800", padTop: 22 },
    },
    append: [["footer", {}, { align: "center", padTop: 16, padBottom: 28, padX: 40 }]],
  },
  forest: {
    label: "Forest",
    note: "Dark green with cream text",
    theme: { brand: "#d9c27a", heading: "#f5f0dc", text: "#d6dccb", muted: "#9db0a0", background: "#10231a", card: "#18382a", radius: 18, font: "serif", width: 540, pagePad: 32 },
    styles: {
      brand: { color: "#d9c27a", align: "center", size: 12, weight: "700", upper: true, padTop: 30 },
      heading: { align: "center", size: 28, weight: "600", padBottom: 8 },
      text: { align: "center", size: 16, lineHeight: "1.75", padX: 40 },
      code: { align: "center", box: "#10231a", color: "#d9c27a", borderColor: "#3b6a50", borderW: 1, radius: 12, boxPad: 16 },
      button: { align: "center", color: "#10231a", radius: 10, boxPad: 14, weight: "700", padTop: 22 },
    },
    append: [["footer", {}, { align: "center", padTop: 20, padBottom: 28, padX: 40 }]],
  },
  gold: {
    label: "Gold",
    note: "Black and gold, premium feel",
    theme: { brand: "#c9a227", heading: "#ffffff", text: "#d4d4d8", muted: "#a1a1aa", background: "#000000", card: "#111111", cardBorder: "#2a2a2a", radius: 4, font: "palatino", width: 540, pagePad: 28 },
    styles: {
      brand: { color: "#c9a227", align: "center", size: 12, weight: "600", upper: true, padTop: 34, padBottom: 4 },
      heading: { align: "center", size: 30, weight: "400", padBottom: 10 },
      text: { align: "center", size: 15, lineHeight: "1.75", padX: 44 },
      code: { align: "center", box: "#000000", color: "#c9a227", borderColor: "#c9a227", borderW: 1, radius: 0, boxPad: 16 },
      button: { align: "center", color: "#000000", radius: 0, boxPad: 14, weight: "700", upper: true, size: 13, padTop: 24 },
    },
    append: [["footer", {}, { align: "center", padTop: 22, padBottom: 30, padX: 44 }]],
  },
  candy: {
    label: "Candy",
    note: "Playful pink and purple",
    theme: { brand: "#db2777", heading: "#ffffff", text: "#4a2c4f", muted: "#9b7aa0", background: "#fce7f3", card: "#ffffff", radius: 28, font: "verdana", width: 540, pagePad: 28 },
    styles: {
      brand: { bg: "#db2777", color: "#fce7f3", align: "center", size: 13, weight: "700", upper: true, padTop: 24, padBottom: 0 },
      heading: { bg: "#db2777", align: "center", size: 32, weight: "800", padTop: 6, padBottom: 30 },
      text: { align: "center", size: 15, lineHeight: "1.7", padX: 36 },
      code: { align: "center", box: "#fdf2f8", color: "#9d174d", borderColor: "#f9a8d4", borderW: 2, radius: 18, boxPad: 18 },
      button: { align: "center", box: "#7c3aed", radius: 999, boxPad: 15, weight: "800", padTop: 22 },
    },
    append: [["footer", {}, { align: "center", padTop: 16, padBottom: 28, padX: 36 }]],
  },
  mono: {
    label: "Mono",
    note: "High-contrast black and white, like a receipt",
    theme: { brand: "#000000", heading: "#000000", text: "#222222", muted: "#6b6b6b", background: "#ffffff", card: "#ffffff", cardBorder: "#000000", radius: 0, font: "mono", width: 520, pagePad: 28 },
    styles: {
      brand: { size: 12, weight: "700", upper: true, padTop: 28 },
      heading: { size: 24, weight: "700", padBottom: 10 },
      text: { size: 14, lineHeight: "1.75" },
      code: { box: "#ffffff", borderColor: "#000000", borderW: 2, radius: 0, boxPad: 14 },
      button: { radius: 0, boxPad: 13, weight: "700", upper: true, size: 13 },
    },
    append: [["divider", {}, { borderColor: "#000000", padTop: 18, padBottom: 4 }], ["footer", {}, { padTop: 10, padBottom: 26 }]],
  },
  festive: {
    label: "Festive",
    note: "Red and green for sales and holidays",
    theme: { brand: "#b91c1c", heading: "#ffffff", text: "#3f2a2a", muted: "#8a6f6f", background: "#fef2f2", card: "#ffffff", radius: 18, font: "trebuchet", width: 560, pagePad: 28 },
    styles: {
      brand: { bg: "#166534", color: "#dcfce7", align: "center", size: 13, weight: "700", upper: true, padTop: 20, padBottom: 20 },
      heading: { bg: "#b91c1c", align: "center", size: 30, weight: "800", padTop: 26, padBottom: 26 },
      text: { align: "center", size: 15, lineHeight: "1.7", padX: 40 },
      code: { align: "center", box: "#fef2f2", color: "#991b1b", borderColor: "#b91c1c", borderW: 2, radius: 12, boxPad: 16 },
      button: { align: "center", box: "#166534", radius: 10, boxPad: 15, weight: "700", padTop: 22 },
    },
    append: [["footer", {}, { align: "center", padTop: 16, padBottom: 28, padX: 40 }]],
  },
  lavender: {
    label: "Lavender",
    note: "Gentle purple, airy spacing",
    theme: { brand: "#6d28d9", heading: "#2e1065", text: "#4c4568", muted: "#8b83a8", background: "#f5f3ff", card: "#ffffff", radius: 26, font: "system", width: 540, pagePad: 36 },
    styles: {
      brand: { align: "center", color: "#6d28d9", size: 12, weight: "700", upper: true, padTop: 34, padBottom: 4 },
      heading: { align: "center", size: 28, weight: "700", padBottom: 10 },
      text: { align: "center", size: 15, lineHeight: "2", padX: 44 },
      code: { align: "center", box: "#ede9fe", color: "#5b21b6", radius: 16, boxPad: 18 },
      button: { align: "center", radius: 999, boxPad: 14, weight: "600", padTop: 26, padBottom: 12 },
    },
    append: [["footer", {}, { align: "center", padTop: 20, padBottom: 34, padX: 44 }]],
  },
  paper: {
    label: "Paper",
    note: "Warm cream, handwritten feel",
    theme: { brand: "#7c2d12", heading: "#3b2a20", text: "#52403a", muted: "#8f7b70", background: "#f3ece0", card: "#fffaf0", cardBorder: "#e6d8c1", radius: 6, font: "serif", width: 520, pagePad: 32 },
    styles: {
      brand: { size: 12, weight: "600", upper: true, padTop: 32, padBottom: 4 },
      heading: { size: 28, weight: "400", italic: true, padBottom: 10 },
      text: { size: 16, lineHeight: "1.75" },
      code: { box: "#f3ece0", color: "#7c2d12", borderColor: "#d8c6a8", borderW: 1, radius: 4, boxPad: 14 },
      button: { radius: 4, boxPad: 13, weight: "600" },
    },
    append: [["divider", {}, { borderColor: "#e6d8c1", padTop: 18, padBottom: 6 }], ["footer", {}, { padTop: 10, padBottom: 28 }]],
  },
};

// ---- store brand ----------------------------------------------------------------------------------
// One look for all of a store's emails: logo, colour, corner radius and footer wording, set once.
// Blank fields mean "the design's own". The logo and footer wording go into every design; colours
// and radius only into designs that opt in with `brandColors` (the default, Blush, does).

export const EMPTY_BRAND = { logoUrl: "", logoFull: true, brandColor: "", radius: "", headerColor: "", buttonColor: "", footerColor: "", footerTitle: "", footerText: "" };

const oneLine = (v, max) => String(v ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, max);

export function normalizeBrand(b) {
  const src = b && typeof b === "object" ? b : {};
  const logo = oneLine(src.logoUrl, 500);
  return {
    logoUrl: /^https:\/\//i.test(logo) ? logo : "",
    logoFull: src.logoFull !== false,
    brandColor: hex(src.brandColor, ""),
    radius: src.radius === "" || src.radius == null || !Number.isFinite(Number(src.radius)) ? "" : clamp(src.radius, 0, 48, 14),
    headerColor: hex(src.headerColor, ""),
    buttonColor: hex(src.buttonColor, ""),
    footerColor: hex(src.footerColor, ""),
    footerTitle: oneLine(src.footerTitle, 80),
    footerText: oneLine(src.footerText, 240),
  };
}

/** Mix a #rrggbb colour toward black (negative amount) or white (positive), 0..1. */
export function shade(color, amount) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(color).trim());
  if (!m) return color;
  const h = m[1].length === 3 ? m[1].split("").map((c) => c + c).join("") : m[1];
  const t = amount < 0 ? 0 : 255;
  const k = Math.abs(amount);
  const ch = [0, 2, 4].map((i) => Math.round(parseInt(h.slice(i, i + 2), 16) * (1 - k) + t * k).toString(16).padStart(2, "0"));
  return `#${ch.join("")}`;
}

// The footer wording may say {email}; that is the store's contact address.
const brandText = (v) => String(v).replace(/\{email\}/gi, "{{support_email}}");

function applyBrand(t, preset, brand) {
  const b = normalizeBrand(brand);
  const blocks = t.blocks.map((blk) => ({ ...blk, settings: { ...blk.settings }, style: { ...blk.style } }));
  const theme = { ...t.theme };

  const head = blocks.find((x) => x.type === "brand");
  if (head && b.logoUrl) {
    head.settings.logo = b.logoUrl;
    head.settings.logoWidth = 130;
    head.settings.logoFull = b.logoFull; // the logo image is the whole header
    if (b.logoFull) head.settings.text = "";
  }

  const footer = [...blocks].reverse().find((x) => x.type === "footer");
  if (footer && (b.footerTitle || b.footerText)) {
    const title = b.footerTitle || "Questions about your points?";
    const text = b.footerText || "Just reply to this email or reach us at {email}. We're happy to help.";
    footer.settings.text = `**${title}**\n${brandText(text)}`;
  }

  if (preset.brandColors) {
    if (b.brandColor) theme.brand = b.brandColor;
    if (b.radius !== "") theme.radius = b.radius;
    const base = theme.brand;
    if (head && !(b.logoUrl && b.logoFull)) head.style.bg = b.headerColor || (b.brandColor ? shade(base, -0.08) : head.style.bg);
    for (const blk of blocks) {
      if (blk.type === "button" && (b.buttonColor || b.brandColor)) blk.style.box = b.buttonColor || b.brandColor;
      if (blk.type === "footer" && blk.style.bg && (b.footerColor || b.brandColor)) blk.style.bg = b.footerColor || b.brandColor;
    }
  }
  return { ...t, theme, blocks };
}

/** Build a kind's email from a design: the same words, a different look. */
export function buildPreset(kind, presetId, brand) {
  const p = EMAIL_PRESETS[presetId] || EMAIL_PRESETS.blush;
  const c = (CONTENT[kind] || CONTENT.points_earned)();
  const blocks = c.blocks.map((b) => ({
    ...b,
    style: { ...(p.styles[b.type] || {}), ...(b.type === "text" && b.settings.muted ? p.styles.textMuted || {} : {}) },
  }));
  if (p.styles.badge) blocks.splice(1, 0, makeEmailBlock("badge", { text: BADGES[kind] || "Update" }, p.styles.badge));
  for (const [type, settings, style] of p.append || []) blocks.push(makeEmailBlock(type, settings, style));
  return applyBrand({ kind, mode: "blocks", subject: c.subject, theme: { ...baseTheme(), ...p.theme }, blocks, html: "" }, p, brand);
}

export const DEFAULT_PRESET = "blush";
export const defaultEmailTemplate = (kind, brand) => buildPreset(kind, DEFAULT_PRESET, brand);

const clamp = (n, lo, hi, fb) => {
  const v = Number(n);
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fb;
};
const hex = (v, fb) => (isHex(v) ? v.trim() : fb);

/** Make any stored/incoming template safe to render. */
export function normalizeEmailTemplate(kind, input, brand) {
  const base = defaultEmailTemplate(kind, brand);
  const src = input && typeof input === "object" ? input : {};
  const t = { ...base.theme, ...(src.theme || {}) };
  const theme = {
    brand: hex(t.brand, base.theme.brand), heading: hex(t.heading, base.theme.heading), text: hex(t.text, base.theme.text),
    muted: hex(t.muted, base.theme.muted), background: hex(t.background, base.theme.background), card: hex(t.card, base.theme.card),
    cardBorder: isHex(t.cardBorder) ? t.cardBorder.trim() : "",
    radius: clamp(t.radius, 0, 48, 14), font: FONT_STACKS[t.font] ? t.font : "system", width: clamp(t.width, 360, 700, 520),
    pagePad: clamp(t.pagePad, 0, 80, 32),
    padX: clamp(t.padX, 0, 100, 32),
    // blank = each block keeps its own natural spacing
    rowGap: t.rowGap === "" || t.rowGap == null || !Number.isFinite(Number(t.rowGap)) ? "" : clamp(t.rowGap, 0, 80, 12),
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
    blocks.push({ id, type: b.type, settings, style: normalizeEmailStyle(b.style) });
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

const safeHref = (u) => (/^(https?:\/\/|mailto:)/i.test(u) ? u : "");

// Escape the author's text, fill variables, then apply links, **bold** and line breaks.
function rich(text, vars, linkColor) {
  return fill(esc(text), vars)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, url) => {
      const href = safeHref(url.replace(/&amp;/g, "&"));
      return href ? `<a href="${esc(href)}" style="color:${linkColor};text-decoration:underline">${label}</a>` : label;
    })
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\r?\n/g, "<br>");
}

const px = (v, d) => (v !== "" && v != null && Number.isFinite(Number(v)) ? Number(v) : d);
const urlOf = (u, vars) => safeHref(fill(u, vars).replace(/&amp;/g, "&"));

function textCss(s, d) {
  return [
    `color:${isHex(s.color) ? s.color : d.color}`,
    `font-size:${px(s.size, d.size)}px`,
    `font-weight:${s.weight || d.weight}`,
    `line-height:${s.lineHeight || d.line}`,
    s.italic ? "font-style:italic" : "",
    s.upper ? "text-transform:uppercase;letter-spacing:.07em" : "",
  ].filter(Boolean).join(";");
}

// A callout box around content, when any box property is set.
function boxCss(s, fallbackPad = 14) {
  const has = isHex(s.box) || s.borderW > 0 || s.radius > 0;
  if (!has) return "";
  return [
    isHex(s.box) ? `background:${s.box}` : "",
    s.borderW > 0 ? `border:${s.borderW}px solid ${isHex(s.borderColor) ? s.borderColor : "#e5e7eb"}` : "",
    s.radius > 0 ? `border-radius:${s.radius}px` : "",
    `padding:${px(s.boxPad, fallbackPad)}px`,
  ].filter(Boolean).join(";");
}

// One table row: the full-width band (background, spacing) around a block's content.
function rowBase(s, d, inner) {
  const align = s.align || d.align;
  return `<tr><td style="padding:${px(s.padTop, d.t)}px ${px(s.padX, d.x ?? 32)}px ${px(s.padBottom, d.b)}px;${
    isHex(s.bg) ? `background:${s.bg};` : ""
  }${align ? `text-align:${align};` : ""}">${inner}</td></tr>`;
}

function renderBlock(b, theme, vars) {
  const s = b.settings;
  const st = b.style || {};
  if (s.onlyIf && !String(vars[s.onlyIf] ?? "").trim()) return "";
  const link = theme.brand;
  // The theme sets the default side spacing and (optionally) the vertical spacing of every row;
  // anything set on the block itself still wins.
  const row = (st2, d, inner) =>
    rowBase(st2, { ...d, x: d.x ?? theme.padX, ...(theme.rowGap !== "" ? { t: theme.rowGap, b: theme.rowGap } : {}) }, inner);

  switch (b.type) {
    case "brand": {
      const hasLogo = /^https:\/\//i.test(s.logo || "");
      if (hasLogo && s.logoFull) {
        // A banner-style logo: the header is the image itself.
        return `<tr><td style="padding:0;font-size:0;line-height:0"><img src="${esc(s.logo)}" alt="${esc(vars.store ?? "")}" width="700" style="display:block;width:100%;max-width:100%;height:auto;border:0"></td></tr>`;
      }
      const logo = hasLogo
        ? `<img src="${esc(s.logo)}" alt="${esc(vars.store ?? "")}" width="${px(s.logoWidth, 120)}" style="display:${st.align === "center" ? "inline-block" : "block"};max-width:100%;height:auto;border:0;margin:0 0 8px">`
        : "";
      const text = `<div style="${textCss(st, { color: theme.muted, size: 13, weight: "400", line: "1.4" })}">${rich(s.text, vars, link)}</div>`;
      return row(st, { t: 28, b: 8 }, logo + (String(s.text || "").trim() || !hasLogo ? text : ""));
    }
    case "badge": {
      const bg = isHex(st.box) ? st.box : theme.background;
      const fg = isHex(st.color) ? st.color : theme.brand;
      return row(st, { t: 22, b: 0 },
        `<span style="display:inline-block;background:${bg};color:${fg};border-radius:${st.radius != null ? st.radius : 8}px;padding:${px(st.boxPad, 6)}px ${px(st.boxPad, 6) * 2}px;font-size:${px(st.size, 11)}px;font-weight:${st.weight || 700};letter-spacing:.08em;text-transform:uppercase;line-height:1.2">${rich(s.text, vars, fg)}</span>`);
    }
    case "heading":
      return row(st, { t: 0, b: 8, align: s.align === "center" || s.align === "right" ? s.align : "" },
        `<div style="${textCss(st, { color: theme.heading, size: 22, weight: "700", line: "1.3" })};${boxCss(st)}">${rich(s.text, vars, link)}</div>`);
    case "text": {
      const muted = !!s.muted;
      return row(st, { t: 6, b: 6 },
        `<div style="${textCss(st, { color: muted ? theme.muted : theme.text, size: muted ? 13 : 15, weight: "400", line: "1.55" })};${boxCss(st)}">${rich(s.text, vars, link)}</div>`);
    }
    case "code": {
      const box = boxCss(st, 14) || `background:${theme.background};border-radius:10px;padding:14px 18px`;
      return row(st, { t: 8, b: 8 },
        `<div style="display:inline-block;${box};font-family:ui-monospace,Menlo,Consolas,monospace;font-size:${px(st.size, px(s.size, 24))}px;font-weight:${st.weight || 800};letter-spacing:.08em;color:${isHex(st.color) ? st.color : theme.heading}">${rich(s.text, vars, link)}</div>`);
    }
    case "button": {
      const href = esc(urlOf(s.url, vars) || "#");
      const outline = s.style === "outline";
      const bg = isHex(st.box) ? st.box : theme.brand;
      const fg = isHex(st.color) ? st.color : "#ffffff";
      const radius = st.radius != null ? st.radius : 10;
      const pad = px(st.boxPad, 12);
      const look = outline
        ? `border:${Math.max(2, px(st.borderW, 2))}px solid ${isHex(st.borderColor) ? st.borderColor : bg};color:${isHex(st.color) ? st.color : bg};background:transparent;`
        : `background:${bg};color:${fg};${st.borderW > 0 ? `border:${st.borderW}px solid ${isHex(st.borderColor) ? st.borderColor : bg};` : ""}`;
      return row(st, { t: 18, b: 6 },
        `<a href="${href}" style="display:${s.fullWidth ? "block;text-align:center" : "inline-block"};${look}text-decoration:none;padding:${pad}px ${Math.round(pad * 1.7)}px;border-radius:${radius}px;font-weight:${st.weight || 600};font-size:${px(st.size, 15)}px;${st.upper ? "text-transform:uppercase;letter-spacing:.07em;" : ""}${st.italic ? "font-style:italic;" : ""}">${rich(s.label, vars, fg)}</a>`);
    }
    case "image": {
      const url = fill(s.url, vars).replace(/&amp;/g, "&");
      if (!/^https:\/\//i.test(url)) return "";
      const w = s.fullWidth ? 700 : px(s.width, 200);
      const img = `<img src="${esc(url)}" alt="${esc(s.alt)}" width="${w}" style="display:${st.align === "center" ? "inline-block" : "block"};${s.fullWidth ? "width:100%;" : ""}max-width:100%;height:auto;border:0;${st.radius > 0 ? `border-radius:${st.radius}px;` : ""}">`;
      const href = urlOf(s.link, vars);
      return row({ ...st, padX: s.fullWidth && st.padX == null ? 0 : st.padX }, { t: 8, b: 8 }, href ? `<a href="${esc(href)}" style="text-decoration:none">${img}</a>` : img);
    }
    case "links": {
      const items = String(s.items || "")
        .split(/\r?\n/)
        .map((line) => line.split("|").map((x) => x.trim()))
        .map(([label, url]) => ({ label, href: urlOf(url || "", vars) }))
        .filter((i) => i.label);
      if (!items.length) return "";
      const sep = `<span style="color:${theme.muted};padding:0 8px">${esc(s.separator || "")}</span>`;
      const html = items
        .map((i) => (i.href ? `<a href="${esc(i.href)}" style="color:${isHex(st.color) ? st.color : link};text-decoration:underline">${fill(esc(i.label), vars)}</a>` : fill(esc(i.label), vars)))
        .join(s.separator ? sep : " &nbsp; ");
      return row(st, { t: 10, b: 6 }, `<div style="${textCss({ ...st, color: theme.muted }, { color: theme.muted, size: 13, weight: "400", line: "1.5" })}">${html}</div>`);
    }
    case "divider":
      return row({ ...st, bg: st.bg }, { t: 12, b: 12 },
        `<div style="height:${Math.max(1, px(st.borderW, 1))}px;line-height:${Math.max(1, px(st.borderW, 1))}px;font-size:0;background:${isHex(st.borderColor) ? st.borderColor : theme.background}">&nbsp;</div>`);
    case "spacer": {
      const h = clamp(s.height, 0, 120, 16);
      return `<tr><td style="height:${h}px;line-height:${h}px;font-size:0;${isHex(st.bg) ? `background:${st.bg};` : ""}">&nbsp;</td></tr>`;
    }
    case "footer":
      return row(st, { t: 14, b: 26 },
        `<div style="${textCss(st, { color: theme.muted, size: 12, weight: "400", line: "1.5" })}">${rich(s.text, vars, link)}</div>`);
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

function wrap(th, rows) {
  return `<!doctype html><html><body style="margin:0;background:${th.background};font-family:${FONT_STACKS[th.font]};color:${th.text}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:${th.pagePad}px 16px">
<table role="presentation" width="${th.width}" cellpadding="0" cellspacing="0" style="max-width:${th.width}px;width:100%;background:${th.card};border-radius:${th.radius}px;overflow:hidden;${th.cardBorder ? `border:1px solid ${th.cardBorder};` : ""}">
${rows}
</table></td></tr></table></body></html>`;
}

/** Render a template with variables → { subject, html }. Never throws. */
export function renderEmail(kind, template, vars, brand) {
  const t = normalizeEmailTemplate(kind, template, brand);
  const subject = String(t.subject).replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => String(vars[k] ?? "")).replace(/[\r\n]+/g, " ").trim().slice(0, 200);

  if (t.mode === "html" && t.html.trim()) {
    return { subject, html: cleanEmailHtml(fill(t.html, vars)) };
  }
  return { subject, html: wrap(t.theme, t.blocks.map((b) => renderBlock(b, t.theme, vars)).join("\n")) };
}

/** The editor's "start from blocks" button: the rendered HTML with variables left in place. */
export function blocksToHtml(kind, template, brand) {
  const t = normalizeEmailTemplate(kind, { ...template, mode: "blocks" }, brand);
  const vars = Object.fromEntries((EMAIL_KINDS[kind]?.vars || []).map(([k]) => [k, `{{${k}}}`]));
  const rows = t.blocks.map((b) => renderBlock({ ...b, settings: { ...b.settings, onlyIf: "" } }, t.theme, vars)).join("\n");
  return wrap(t.theme, rows);
}

/** Variables a template must use for the email to make sense (e.g. the login code). */
export function missingRequired(kind, template, sampleVars) {
  const req = EMAIL_KINDS[kind]?.required || [];
  if (!req.length) return [];
  const probe = Object.fromEntries(req.map((k) => [k, `__${k.toUpperCase()}__`]));
  const out = renderEmail(kind, template, { ...sampleVars, ...probe });
  return req.filter((k) => !out.html.includes(`__${k.toUpperCase()}__`));
}
