// Widget configuration model — shared by the admin editor, the server (validation/defaults)
// and the storefront renderer. Plain JS, no imports, so it runs anywhere.
//
// A config document looks like:
//   { template, theme: {...}, launcher: {...}, custom: {css}, blocks: [{id, type, visible, settings}] }

export const FONTS = {
  system: {
    label: "System",
    stack:
      'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  },
  rounded: {
    label: "Rounded",
    stack:
      'ui-rounded, "SF Pro Rounded", "Hiragino Maru Gothic ProN", Quicksand, system-ui, sans-serif',
  },
  serif: {
    label: "Serif",
    stack: 'ui-serif, Georgia, Cambria, "Times New Roman", serif',
  },
  mono: {
    label: "Mono",
    stack: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
  },
};

export const POSITIONS = {
  "bottom-right": "Bottom right",
  "bottom-left": "Bottom left",
  "top-right": "Top right",
  "top-left": "Top left",
};

// Block catalogue. `fields` drives the settings panel in the editor.
// field types: text | textarea | number | select | toggle | code
export const BLOCK_TYPES = {
  header: {
    label: "Header",
    icon: "◧",
    audience: "always",
    defaults: { title: "Rewards", subtitle: "Earn points on every order." },
    fields: [
      { key: "title", label: "Title", type: "text" },
      { key: "subtitle", label: "Subtitle", type: "text" },
    ],
  },
  balance: {
    label: "Points balance",
    icon: "◎",
    audience: "logged_in",
    defaults: {
      label: "Your points",
      showLifetime: true,
      lifetimeLabel: "Earned in total",
      showExpiry: true,
      expiryText: "{points} points expire on {date}",
    },
    fields: [
      { key: "label", label: "Label", type: "text" },
      { key: "showLifetime", label: "Show lifetime points", type: "toggle" },
      { key: "lifetimeLabel", label: "Lifetime label", type: "text" },
      { key: "showExpiry", label: "Warn about expiring points", type: "toggle" },
      { key: "expiryText", label: "Expiry warning", type: "text", help: "Use {points} and {date}." },
    ],
  },
  login: {
    label: "Log in",
    icon: "→",
    audience: "logged_out",
    defaults: {
      title: "Join to earn rewards",
      text: "Enter your email and we'll send you a login code. No password needed.",
      emailPlaceholder: "you@example.com",
      buttonText: "Send code",
      codeText: "We sent a 6-digit code to {email}.",
      verifyText: "Log in",
      showStoreLogin: true,
      storeLoginText: "Log in with your store account",
    },
    fields: [
      { key: "title", label: "Title", type: "text" },
      { key: "text", label: "Text", type: "textarea" },
      { key: "emailPlaceholder", label: "Email placeholder", type: "text" },
      { key: "buttonText", label: "Send-code button", type: "text" },
      { key: "codeText", label: "Code step text", type: "text", help: "Use {email}." },
      { key: "verifyText", label: "Verify button", type: "text" },
      { key: "showStoreLogin", label: "Also offer store account login", type: "toggle" },
      { key: "storeLoginText", label: "Store login button", type: "text" },
    ],
  },
  referral: {
    label: "Refer a friend",
    icon: "♡",
    audience: "logged_in",
    defaults: {
      title: "Refer a friend",
      text: "Share your code. When your friend places their first order, you both earn points.",
      copyCode: "Copy code",
      copyLink: "Copy link",
      applyTitle: "Have a friend's code?",
      applyPlaceholder: "Enter code",
      applyButton: "Apply",
    },
    fields: [
      { key: "title", label: "Title", type: "text" },
      { key: "text", label: "Text", type: "textarea" },
      { key: "copyCode", label: "Copy-code button", type: "text" },
      { key: "copyLink", label: "Copy-link button", type: "text" },
      { key: "applyTitle", label: "Apply-a-code title", type: "text" },
      { key: "applyPlaceholder", label: "Code placeholder", type: "text" },
      { key: "applyButton", label: "Apply button", type: "text" },
    ],
  },
  account: {
    label: "Account & log out",
    icon: "☺",
    audience: "logged_in",
    defaults: { label: "Signed in as", logoutText: "Log out" },
    fields: [
      { key: "label", label: "Label", type: "text" },
      { key: "logoutText", label: "Log-out button", type: "text" },
    ],
  },
  earn: {
    label: "Ways to earn",
    icon: "✦",
    audience: "always",
    defaults: { title: "Ways to earn" },
    fields: [{ key: "title", label: "Title", type: "text" }],
  },
  redeem: {
    label: "Rewards to redeem",
    icon: "❖",
    audience: "always",
    defaults: {
      title: "Redeem your points",
      buttonText: "Redeem",
      emptyText: "No rewards available yet.",
    },
    fields: [
      { key: "title", label: "Title", type: "text" },
      { key: "buttonText", label: "Button text", type: "text" },
      { key: "emptyText", label: "Empty text", type: "text" },
    ],
  },
  coupons: {
    label: "My discount codes",
    icon: "✂",
    audience: "logged_in",
    defaults: {
      title: "Your discount codes",
      emptyText: "No codes yet. Redeem a reward above to get one.",
      showUsed: true,
    },
    fields: [
      { key: "title", label: "Title", type: "text" },
      { key: "emptyText", label: "Empty text", type: "text" },
      { key: "showUsed", label: "Keep used & expired codes visible", type: "toggle" },
    ],
  },
  history: {
    label: "Recent activity",
    icon: "≡",
    audience: "logged_in",
    defaults: { title: "Recent activity", limit: 30, height: 260, emptyText: "No activity yet." },
    fields: [
      { key: "title", label: "Title", type: "text" },
      { key: "limit", label: "Rows to keep", type: "number", min: 1, max: 50 },
      {
        key: "height",
        label: "Box height (px)",
        type: "number",
        min: 0,
        max: 800,
        help: "The list scrolls inside this box. 0 = grow to fit.",
      },
      { key: "emptyText", label: "Empty text", type: "text" },
    ],
  },
  text: {
    label: "Text",
    icon: "T",
    audience: "always",
    defaults: { title: "", body: "Write something helpful here." },
    fields: [
      { key: "title", label: "Title", type: "text" },
      { key: "body", label: "Body", type: "textarea" },
    ],
  },
  button: {
    label: "Button",
    icon: "▭",
    audience: "always",
    defaults: { label: "Shop now", url: "/collections/all", style: "solid" },
    fields: [
      { key: "label", label: "Label", type: "text" },
      { key: "url", label: "Link", type: "text" },
      {
        key: "style",
        label: "Style",
        type: "select",
        options: { solid: "Solid", outline: "Outline" },
      },
    ],
  },
  html: {
    label: "Custom HTML",
    icon: "</>",
    audience: "always",
    defaults: {
      html: '<p>Hi {{first_name}}, you have <strong>{{points}}</strong> points.</p>',
    },
    fields: [
      {
        key: "html",
        label: "HTML",
        type: "code",
        help: "Variables: {{first_name}}, {{points}}, {{lifetime_points}}, {{store}}. Scripts are removed.",
      },
    ],
  },
  spacer: {
    label: "Spacer",
    icon: "↕",
    audience: "always",
    defaults: { height: 12 },
    fields: [{ key: "height", label: "Height (px)", type: "number", min: 0, max: 80 }],
  },
};

export const AUDIENCES = {
  always: "Everyone",
  logged_in: "Logged-in customers",
  logged_out: "Visitors only",
};

// --- templates -------------------------------------------------------------------------

const baseTheme = {
  primary: "#111827",
  primaryText: "#ffffff",
  background: "#ffffff",
  surface: "#f4f5f7",
  text: "#111827",
  mutedText: "#6b7280",
  border: "#e5e7eb",
  radius: 14,
  font: "system",
  headerStyle: "solid", // solid | gradient | plain
  shadow: true,
  density: "comfortable", // compact | comfortable
  hideScrollbars: false, // still scrollable, just no visible bar
};

export const TEMPLATES = {
  classic: {
    label: "Classic",
    description: "Clean white panel with a solid header.",
    theme: { ...baseTheme, primary: "#2563eb", headerStyle: "solid", radius: 12 },
  },
  modern: {
    label: "Modern",
    description: "Soft gradient header and rounded cards.",
    theme: {
      ...baseTheme,
      primary: "#7c3aed",
      surface: "#f5f3ff",
      border: "#ede9fe",
      headerStyle: "gradient",
      radius: 20,
      font: "rounded",
    },
  },
  minimal: {
    label: "Minimal",
    description: "Flat, quiet and typographic.",
    theme: {
      ...baseTheme,
      primary: "#111827",
      surface: "#ffffff",
      headerStyle: "plain",
      radius: 4,
      shadow: false,
      font: "serif",
    },
  },
  bold: {
    label: "Bold",
    description: "Dark panel with a vivid accent.",
    theme: {
      ...baseTheme,
      primary: "#f59e0b",
      primaryText: "#111827",
      background: "#0f172a",
      surface: "#1e293b",
      text: "#f8fafc",
      mutedText: "#94a3b8",
      border: "#334155",
      headerStyle: "gradient",
      radius: 16,
    },
  },
};

export const DEFAULT_LAUNCHER = {
  style: "pill", // pill | circle
  label: "Rewards",
  icon: "🎁",
  position: "bottom-right",
  offsetX: 20,
  offsetY: 20,
  visibility: "all", // all | desktop | mobile
  panelWidth: 380,
  mobileFullscreen: true,
};

let idCounter = 0;
export function newBlockId() {
  idCounter += 1;
  return `b_${Date.now().toString(36)}${idCounter}${Math.random().toString(36).slice(2, 5)}`;
}

// Per-block look. Every value is optional: empty means "inherit the theme".
export const BLOCK_STYLE_FIELDS = [
  { key: "bg", label: "Background", type: "color" },
  { key: "text", label: "Text colour", type: "color" },
  { key: "accent", label: "Accent (buttons, numbers)", type: "color" },
  { key: "cardBg", label: "Card colour", type: "color" },
  { key: "border", label: "Border colour", type: "color" },
  { key: "radius", label: "Corner radius", type: "range", min: 0, max: 40 },
  { key: "pad", label: "Inner spacing", type: "range", min: 0, max: 40 },
  { key: "padBottom", label: "Space below", type: "range", min: 0, max: 60 },
  { key: "fontSize", label: "Text size", type: "range", min: 10, max: 28 },
  { key: "weight", label: "Text weight", type: "select", options: { "": "Theme default", "400": "Regular", "500": "Medium", "600": "Semi-bold", "700": "Bold", "800": "Extra bold" } },
  { key: "align", label: "Alignment", type: "select", options: { "": "Theme default", left: "Left", center: "Centre", right: "Right" } },
  { key: "hideOn", label: "Hide on", type: "select", options: { "": "Show everywhere", mobile: "Phones", desktop: "Desktop" } },
];

const STYLE_COLORS = ["bg", "text", "accent", "cardBg", "border"];
const STYLE_NUMBERS = { radius: [0, 40], pad: [0, 40], padBottom: [0, 60], fontSize: [10, 28] };

export function normalizeStyle(s) {
  const out = {};
  if (!s || typeof s !== "object") return out;
  for (const k of STYLE_COLORS) {
    const v = typeof s[k] === "string" ? s[k].trim() : "";
    if (/^#[0-9a-fA-F]{3,8}$/.test(v)) out[k] = v;
  }
  for (const [k, [lo, hi]] of Object.entries(STYLE_NUMBERS)) {
    if (s[k] === "" || s[k] == null) continue;
    const n = Number(s[k]);
    if (Number.isFinite(n)) out[k] = Math.min(hi, Math.max(lo, n));
  }
  if (["400", "500", "600", "700", "800"].includes(String(s.weight))) out.weight = String(s.weight);
  if (["left", "center", "right"].includes(s.align)) out.align = s.align;
  if (["mobile", "desktop"].includes(s.hideOn)) out.hideOn = s.hideOn;
  return out;
}

export function makeBlock(type, overrides = {}) {
  const def = BLOCK_TYPES[type];
  return {
    id: newBlockId(),
    type,
    visible: true,
    settings: { audience: def.audience, ...def.defaults, ...overrides },
    style: {},
  };
}

export function defaultBlocks() {
  return [
    makeBlock("header"),
    makeBlock("login"),
    makeBlock("balance"),
    makeBlock("earn"),
    makeBlock("redeem"),
    makeBlock("referral"),
    makeBlock("coupons"),
    makeBlock("history"),
    makeBlock("account"),
  ];
}

// Starting point for "Custom HTML" layout mode. {{block:redeem}} etc. drop in the real,
// working blocks (with their settings); everything else is plain HTML/CSS you control.
export const STARTER_HTML = `<div class="my-hero">
  <h2>Hi {{first_name}} 👋</h2>
  <p>You have <strong>{{points}}</strong> points to spend at {{store}}.</p>
</div>

{{block:login}}
{{block:balance}}
{{block:earn}}
{{block:redeem}}
{{block:referral}}
{{block:coupons}}
{{block:history}}
{{block:account}}`;

// The first starter left out "earn" and "coupons", so shoppers never saw their discount codes.
// Anyone still on that unedited text is moved to the current starter automatically.
const OLD_STARTER_HTML = `<div class="my-hero">
  <h2>Hi {{first_name}} 👋</h2>
  <p>You have <strong>{{points}}</strong> points to spend at {{store}}.</p>
</div>

{{block:login}}
{{block:balance}}
{{block:redeem}}
{{block:referral}}
{{block:history}}
{{block:account}}`;

const sameText = (a, b) => String(a).replace(/\r\n/g, "\n").trim() === String(b).replace(/\r\n/g, "\n").trim();

/** Block types that are visible in the layout but not referenced by a custom HTML template. */
export function missingTemplateBlocks(config) {
  if (config.custom?.mode !== "html") return [];
  const used = new Set([...String(config.custom.html || "").matchAll(/\{\{\s*block:(\w+)\s*\}\}/g)].map((m) => m[1]));
  const want = [...new Set(config.blocks.filter((b) => b.visible && b.type !== "header" && b.type !== "spacer").map((b) => b.type))];
  return want.filter((t) => !used.has(t));
}

export const HTML_VARIABLES = [
  "{{first_name}}",
  "{{email}}",
  "{{points}}",
  "{{lifetime_points}}",
  "{{store}}",
  "{{referral_code}}",
  "{{referral_link}}",
  "{{expiring_points}}",
  "{{expiring_date}}",
];

export function defaultWidgetConfig(template = "classic") {
  const t = TEMPLATES[template] ?? TEMPLATES.classic;
  return {
    version: 1,
    template: TEMPLATES[template] ? template : "classic",
    theme: { ...t.theme },
    launcher: { ...DEFAULT_LAUNCHER },
    // mode "blocks": the block list below. mode "html": `html` is the whole layout.
    custom: { css: "", mode: "blocks", html: "" },
    // The "My Rewards" tab added to the customer account page; opens the side drawer.
    account: { tab: true, label: "My Rewards", icon: "🎁", selector: "", drawerWidth: 420 },
    // Developer source (full CSS / HTML shell). Stored separately in the database and merged in
    // by the server when enabled; never part of what the visual editor saves.
    dev: null,
    blocks: defaultBlocks(),
  };
}

function normalizeDev(d) {
  if (!d || typeof d !== "object") return null;
  const s = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");
  const css = s(d.css, 80000);
  const shell = s(d.shell, 20000);
  const pageShell = s(d.pageShell, 20000);
  return css || shell || pageShell ? { css, shell, pageShell } : null;
}

// --- reference for people writing custom HTML / CSS ------------------------------------

export const CSS_VARIABLES = [
  ["--p", "Primary colour (buttons, highlights)"],
  ["--pt", "Text colour on primary"],
  ["--bg", "Panel background"],
  ["--sf", "Card background"],
  ["--tx", "Main text colour"],
  ["--mu", "Muted text colour"],
  ["--bd", "Border colour"],
  ["--r", "Corner radius"],
  ["--pad", "Base spacing (12px compact, 18px comfortable)"],
];

export const GLOBAL_CLASSES = [
  [".lw-root", "Outermost element. Holds the CSS variables above. Gets .lw-mobile on small screens."],
  [".lw-launcher-wrap", "Fixed-position holder for the floating button."],
  [".lw-launcher", "The floating button. Contains .lw-launcher-icon and the label."],
  [".lw-panel", "The overlay panel that opens above the button."],
  [".lw-close", "Close (×) button inside the panel."],
  [".lw-body", "Scrolling content area. Everything below renders in here."],
  [".lw-page", "The page-mode container (used instead of .lw-panel)."],
  [".lw-bw", "Wrapper around every block. Has data-bid; handy for spacing between blocks."],
  [".lw-block", "Padding wrapper inside most blocks."],
  [".lw-card", "A boxed surface (balance, rewards, login, referral)."],
  [".lw-title", "Block heading."],
  [".lw-muted / .lw-small / .lw-strong", "Text helpers."],
  [".lw-btn", "Primary button. Modifiers: .lw-btn-sm, .lw-btn-block, .lw-btn-outline."],
  [".lw-input", "Text inputs (email, code, referral)."],
  [".lw-badge", "Small status pill (Used / Expired)."],
  [".lw-toast", "The short confirmation message at the bottom of the panel."],
];

// What each block outputs. `token` is what you put in Custom HTML mode.
export const BLOCK_DOCS = {
  header: {
    what: "Coloured title area at the top.",
    classes: [[".lw-header", "the whole banner"], [".lw-header-title", "title text"], [".lw-header-sub", "subtitle"]],
  },
  balance: {
    what: "The customer's points, lifetime total and an expiry warning.",
    classes: [[".lw-balance", "the card"], [".lw-balance-num", "the big number"], [".lw-warn", "expiry warning strip"]],
  },
  login: {
    what: "Email-code login form (and optional store-account login). Only shown to visitors.",
    classes: [
      [".lw-form", "stack of input + button"], [".lw-input", "email / code field"], [".lw-code-input", "the 6-digit field"],
      [".lw-links", "‘different email’ / ‘resend’ row"], [".lw-or", "the ‘or’ divider"], [".lw-error", "error message"],
    ],
  },
  earn: {
    what: "List of ways to earn points, built from your earning rules.",
    classes: [[".lw-list", "the list"], [".lw-row", "one rule"], [".lw-dot", "the ✦ marker"], [".lw-strong", "rule name"]],
  },
  redeem: {
    what: "Rewards a customer can redeem, including the points slider.",
    classes: [
      [".lw-reward", "one reward card"], [".lw-var", "card with a slider"], [".lw-range", "the slider"],
      [".lw-var-foot", "‘N points = $X off’ + button row"], [".lw-btn-sm", "the Redeem button"],
    ],
  },
  coupons: {
    what: "The customer's discount codes (active, used and expired).",
    classes: [
      [".lw-reward", "one code card"], [".lw-code", "the code text"], [".lw-badge", "Used / Expired pill"],
      [".lw-btns", "the Copy button"], [".lw-dim", "used or expired card"],
    ],
  },
  history: {
    what: "Scrolling activity list. Redeem rows expand to show their code.",
    classes: [
      [".lw-scroll", "the scrolling list"], [".lw-boxed", "bordered box (when a height is set)"], [".lw-row", "one entry"],
      [".lw-points", "the +/- amount (.lw-pos / .lw-neg)"], [".lw-act", "an expandable redeem entry"],
      [".lw-sum", "its clickable header"], [".lw-chev", "the arrow"], [".lw-act-body", "the revealed code area"],
    ],
  },
  referral: {
    what: "The customer's referral code, share buttons, stats and ‘apply a code’ box.",
    classes: [[".lw-refcode", "code box wrapper"], [".lw-code", "the code"], [".lw-btns", "copy buttons"], [".lw-sub", "‘apply a code’ section"], [".lw-inline", "input + Apply row"]],
  },
  account: {
    what: "‘Signed in as …’ with a Log out button.",
    classes: [[".lw-account", "the row"], [".lw-row", "layout"], [".lw-btn-outline", "the button"]],
  },
  text: { what: "A heading and paragraph.", classes: [[".lw-title", "heading"], [".lw-pre", "paragraph"]] },
  button: { what: "A link styled as a button.", classes: [[".lw-btn-block", "full width"], [".lw-btn-outline", "outline style"]] },
  html: { what: "Your own HTML block (a block-mode feature).", classes: [[".lw-custom", "wrapper"]] },
  spacer: { what: "Empty vertical space.", classes: [] },
};

export const SHELL_PLACEHOLDERS = [
  ["{{content}}", "Required. The rendered blocks / custom HTML."],
  ["{{root_classes}}", "Classes for the outer element (lw-root, lw-mobile, …)."],
  ["{{panel_classes}}", "Classes for the panel (lw-panel, plus lw-anim while opening)."],
  ["{{panel_hidden}}", "Outputs ‘hidden’ while the panel is closed."],
  ["{{expanded}}", "‘true’ or ‘false’ for aria-expanded."],
  ["{{launcher_label}}", "The floating button's label."],
  ["{{launcher_inner}}", "Icon + label markup for inside the button."],
  ["{{store_name}}", "Your store name."],
];

const clamp = (n, min, max, fallback) => {
  const v = Number(n);
  return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
};
const color = (v, fallback) =>
  typeof v === "string" && /^#[0-9a-fA-F]{3,8}$/.test(v.trim()) ? v.trim() : fallback;

// Make any stored/incoming document safe to render: fill gaps, drop junk, clamp numbers.
// Runs on the server before saving and again before rendering.
export function normalizeConfig(input) {
  const base = defaultWidgetConfig(input?.template);
  const src = input && typeof input === "object" ? input : {};
  const t = { ...base.theme, ...(src.theme || {}) };
  const l = { ...base.launcher, ...(src.launcher || {}) };

  const theme = {
    primary: color(t.primary, base.theme.primary),
    primaryText: color(t.primaryText, base.theme.primaryText),
    background: color(t.background, base.theme.background),
    surface: color(t.surface, base.theme.surface),
    text: color(t.text, base.theme.text),
    mutedText: color(t.mutedText, base.theme.mutedText),
    border: color(t.border, base.theme.border),
    radius: clamp(t.radius, 0, 32, base.theme.radius),
    font: FONTS[t.font] ? t.font : "system",
    headerStyle: ["solid", "gradient", "plain"].includes(t.headerStyle)
      ? t.headerStyle
      : "solid",
    shadow: t.shadow !== false,
    density: t.density === "compact" ? "compact" : "comfortable",
    hideScrollbars: t.hideScrollbars === true,
  };

  const launcher = {
    style: l.style === "circle" ? "circle" : "pill",
    label: String(l.label ?? "Rewards").slice(0, 40),
    icon: String(l.icon ?? "🎁").slice(0, 8),
    position: POSITIONS[l.position] ? l.position : "bottom-right",
    offsetX: clamp(l.offsetX, 0, 200, 20),
    offsetY: clamp(l.offsetY, 0, 200, 20),
    visibility: ["all", "desktop", "mobile"].includes(l.visibility) ? l.visibility : "all",
    panelWidth: clamp(l.panelWidth, 300, 520, 380),
    mobileFullscreen: l.mobileFullscreen !== false,
  };

  const rawBlocks = Array.isArray(src.blocks) ? src.blocks : base.blocks;
  const seen = new Set();
  const blocks = [];
  for (const b of rawBlocks.slice(0, 40)) {
    const def = BLOCK_TYPES[b?.type];
    if (!def) continue;
    let id = typeof b.id === "string" && b.id ? b.id.slice(0, 40) : newBlockId();
    if (seen.has(id)) id = newBlockId();
    seen.add(id);
    const settings = { audience: def.audience, ...def.defaults, ...(b.settings || {}) };
    if (!AUDIENCES[settings.audience]) settings.audience = def.audience;
    blocks.push({ id, type: b.type, visible: b.visible !== false, settings, style: normalizeStyle(b.style) });
  }

  const a = { ...base.account, ...(src.account || {}) };
  const account = {
    tab: a.tab !== false,
    label: String(a.label ?? "My Rewards").slice(0, 40) || "My Rewards",
    icon: String(a.icon ?? "🎁").slice(0, 8),
    selector: String(a.selector ?? "").slice(0, 200),
    drawerWidth: clamp(a.drawerWidth, 320, 560, 420),
  };

  return {
    version: 1,
    template: TEMPLATES[src.template] ? src.template : "classic",
    theme,
    launcher,
    account,
    custom: {
      css: String(src.custom?.css ?? "").slice(0, 20000),
      mode: src.custom?.mode === "html" ? "html" : "blocks",
      html: sameText(src.custom?.html ?? "", OLD_STARTER_HTML)
        ? STARTER_HTML
        : String(src.custom?.html ?? "").slice(0, 40000),
    },
    dev: normalizeDev(src.dev),
    blocks,
  };
}
