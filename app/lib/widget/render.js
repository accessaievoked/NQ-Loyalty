// Widget renderer. Used by BOTH the admin live preview and the storefront script, so what
// the merchant sees in the editor is exactly what shoppers get.
//
// Keep this file dependency-free and browser-only at runtime: the storefront script is built
// by stripping `export ` from this file (see app/routes/proxy.widget[.]js.jsx).
// The import below is erased in that build.
import { FONTS } from "./defaults.js";

export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c]);
}

// Merchant-authored HTML is rendered inside a shadow root on their own storefront (and in
// the admin preview). Scripts never run via innerHTML, but we still strip active content so
// the preview inside the app's origin can't be used to run code.
export function sanitizeHtml(html) {
  if (typeof DOMParser === "undefined") return "";
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  doc.querySelectorAll("script,iframe,object,embed,link,meta,base,form").forEach((n) => n.remove());
  doc.body.querySelectorAll("*").forEach((el) => {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      const val = attr.value.trim().toLowerCase();
      if (name.startsWith("on") || ((name === "href" || name === "src" || name === "xlink:href") && val.startsWith("javascript:"))) {
        el.removeAttribute(attr.name);
      }
    }
  });
  return doc.body.innerHTML;
}

function fillVars(html, state) {
  const c = state.customer || {};
  const r = state.referral || {};
  const vars = {
    first_name: c.firstName || "there",
    email: c.email || "",
    points: c.points ?? 0,
    lifetime_points: c.lifetime ?? 0,
    store: state.shop?.name || "",
    referral_code: r.code || "",
    referral_link: r.link || "",
    expiring_points: c.expiring ? c.expiring.points : 0,
    expiring_date: c.expiring ? c.expiring.date : "",
  };
  return html.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, key) => (key in vars ? esc(vars[key]) : m));
}

function fillText(text, values) {
  return String(text ?? "").replace(/\{(\w+)\}/g, (m, key) => (key in values ? esc(values[key]) : m));
}

// --- blocks ----------------------------------------------------------------------------

export function formatMoney(amount, currency) {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: currency || "USD" }).format(amount);
  } catch (e) {
    return String(amount);
  }
}

// "Use N points" slider. Shows the live discount value; the server re-validates everything.
export function variableValue(v, points) {
  return Math.floor(points / v.step) * v.unitValue;
}

function renderVariableReward(r, s, state, balance) {
  const v = r.variable;
  const cap = Math.min(balance, v.max || Infinity);
  const top = Math.floor(cap / v.step) * v.step;
  const can = state.loggedIn && top >= v.min;
  const start = can ? Math.max(v.min, Math.min(top, v.min)) : v.min;
  const money = (p) => formatMoney(variableValue(v, p), state.shop && state.shop.currency);
  const info = `<span class="lw-muted lw-small lw-block-text">${esc(r.description)}${
    v.max ? ` · up to ${esc(v.max)} points` : ""
  }</span>`;

  if (!state.loggedIn) {
    return `<li class="lw-card"><span class="lw-strong">${esc(r.name)}</span>${info}</li>`;
  }
  if (!can) {
    return `<li class="lw-card"><span class="lw-strong">${esc(r.name)}</span>${info}<span class="lw-muted lw-small lw-block-text">You need at least ${esc(
      v.min,
    )} points to use this.</span></li>`;
  }
  return `<li class="lw-card lw-var">
    <span class="lw-strong">${esc(r.name)}</span>${info}
    <div class="lw-var-row">
      <input class="lw-range" type="range" min="${v.min}" max="${top}" step="${v.step}" value="${start}" data-points="${esc(r.id)}" aria-label="Points to use" />
    </div>
    <div class="lw-var-foot">
      <span><strong data-calc-points="${esc(r.id)}">${start}</strong> points = <strong data-calc-money="${esc(r.id)}">${esc(money(start))}</strong> off</span>
      <button class="lw-btn lw-btn-sm" data-action="redeem" data-reward="${esc(r.id)}" type="button">${esc(s.buttonText)}</button>
    </div>
  </li>`;
}

function renderBlock(block, state) {
  const s = block.settings;
  switch (block.type) {
    case "header":
      return `<div class="lw-header"><div class="lw-header-title">${esc(s.title)}</div>${
        s.subtitle ? `<div class="lw-header-sub">${esc(s.subtitle)}</div>` : ""
      }</div>`;

    case "balance": {
      const c = state.customer || {};
      const warn =
        s.showExpiry && c.expiring
          ? `<div class="lw-warn">${fillText(s.expiryText, { points: c.expiring.points, date: c.expiring.date })}</div>`
          : "";
      return `<div class="lw-block"><div class="lw-card lw-balance">
        <div class="lw-muted lw-small">${esc(s.label)}</div>
        <div class="lw-balance-num">${esc(c.points ?? 0)}</div>
        ${s.showLifetime ? `<div class="lw-muted lw-small">${esc(s.lifetimeLabel)}: ${esc(c.lifetime ?? 0)}</div>` : ""}
        ${warn}
      </div></div>`;
    }

    case "login": {
      const ui = state.ui || {};
      const step = ui.step === "code" ? "code" : "email";
      const err = ui.error ? `<div class="lw-error" role="alert">${esc(ui.error)}</div>` : "";
      const form =
        step === "email"
          ? `<div class="lw-form">
              <input class="lw-input" type="email" autocomplete="email" inputmode="email" data-field="email" data-enter="otp-send" value="${esc(ui.email || "")}" placeholder="${esc(s.emailPlaceholder)}" aria-label="Email" ${ui.focus ? "autofocus data-autofocus" : ""} />
              <button class="lw-btn lw-btn-block" data-action="otp-send" type="button" ${ui.busy ? "disabled" : ""}>${esc(ui.busy ? "Sending…" : s.buttonText)}</button>
            </div>`
          : `<p class="lw-muted lw-small">${fillText(s.codeText, { email: ui.email || "" })}</p>
            <div class="lw-form">
              <input class="lw-input lw-code-input" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" data-field="code" data-enter="otp-verify" placeholder="000000" aria-label="6-digit code" value="${esc(ui.code || "")}" ${ui.focus ? "autofocus data-autofocus" : ""} />
              <button class="lw-btn lw-btn-block" data-action="otp-verify" type="button" ${ui.busy ? "disabled" : ""}>${esc(ui.busy ? "Checking…" : s.verifyText)}</button>
              <div class="lw-links"><button class="lw-link" data-action="otp-back" type="button">Use a different email</button><button class="lw-link" data-action="otp-send" type="button">Resend code</button></div>
            </div>`;
      const store = s.showStoreLogin
        ? `<div class="lw-or"><span>or</span></div><button class="lw-btn lw-btn-outline lw-btn-block" data-action="login" type="button">${esc(s.storeLoginText)}</button>`
        : "";
      return `<div class="lw-block"><div class="lw-card lw-center">
        <div class="lw-title">${esc(s.title)}</div>
        ${step === "email" ? `<p class="lw-muted">${esc(s.text)}</p>` : ""}
        ${form}${err}${store}
      </div></div>`;
    }

    case "referral": {
      const r = state.referral;
      if (!r) return "";
      const ui = state.ui || {};
      const perks = [
        r.friendPoints ? `Your friend gets ${r.friendPoints} bonus points` : "",
        r.referrerPoints ? `you get ${r.referrerPoints} points` : "",
      ]
        .filter(Boolean)
        .join(" · ");
      const apply = r.canApply
        ? `<div class="lw-sub"><div class="lw-title lw-title-sm">${esc(s.applyTitle)}</div>
            <div class="lw-inline"><input class="lw-input" type="text" data-field="refcode" data-enter="ref-apply" maxlength="12" placeholder="${esc(s.applyPlaceholder)}" value="${esc(ui.refcode || "")}" aria-label="Referral code" />
            <button class="lw-btn lw-btn-sm" data-action="ref-apply" type="button">${esc(s.applyButton)}</button></div>${
              ui.refError ? `<div class="lw-error" role="alert">${esc(ui.refError)}</div>` : ""
            }</div>`
        : r.applied
          ? `<div class="lw-sub lw-muted lw-small">✓ You're using a friend's referral code.</div>`
          : "";
      return `<div class="lw-block"><div class="lw-card">
        <div class="lw-title">${esc(s.title)}</div>
        <p class="lw-muted lw-small lw-tight">${esc(s.text)}</p>
        ${perks ? `<p class="lw-small lw-tight"><strong>${esc(perks)}</strong></p>` : ""}
        <div class="lw-refcode"><span class="lw-code">${esc(r.code)}</span></div>
        <div class="lw-btns lw-left"><button class="lw-btn lw-btn-sm lw-btn-outline" data-action="copy" data-code="${esc(r.code)}" type="button">${esc(s.copyCode)}</button><button class="lw-btn lw-btn-sm lw-btn-outline" data-action="copy" data-code="${esc(r.link)}" type="button">${esc(s.copyLink)}</button></div>
        <p class="lw-muted lw-small lw-tight">${esc(r.invited)} invited · ${esc(r.rewarded)} rewarded${r.earned ? ` · ${esc(r.earned)} points earned` : ""}</p>
        ${apply}
      </div></div>`;
    }

    case "account": {
      const c = state.customer || {};
      return `<div class="lw-block lw-account"><div class="lw-row"><span class="lw-grow lw-small lw-muted">${esc(s.label)} <strong>${esc(
        c.email || c.firstName || "",
      )}</strong></span><button class="lw-btn lw-btn-sm lw-btn-outline" data-action="logout" type="button">${esc(s.logoutText)}</button></div></div>`;
    }

    case "earn": {
      const rows = (state.earn || [])
        .map(
          (e) => `<li class="lw-row"><span class="lw-dot">✦</span><span class="lw-grow"><span class="lw-strong">${esc(
            e.text,
          )}</span>${e.detail ? `<span class="lw-muted lw-small lw-block-text">${esc(e.detail)}</span>` : ""}</span></li>`,
        )
        .join("");
      return `<div class="lw-block">${s.title ? `<div class="lw-title">${esc(s.title)}</div>` : ""}<ul class="lw-list">${
        rows || `<li class="lw-muted lw-small">No earning rules yet.</li>`
      }</ul></div>`;
    }

    case "redeem": {
      const points = state.customer?.points ?? 0;
      const rows = (state.rewards || [])
        .map((r) => {
          if (r.variable) return renderVariableReward(r, s, state, points);
          const can = state.loggedIn && points >= r.cost;
          const action = state.loggedIn
            ? `<button class="lw-btn lw-btn-sm" data-action="redeem" data-reward="${esc(r.id)}" type="button" ${
                can ? "" : "disabled"
              }>${esc(s.buttonText)}</button>`
            : "";
          return `<li class="lw-card lw-reward"><span class="lw-grow"><span class="lw-strong">${esc(
            r.name,
          )}</span><span class="lw-muted lw-small lw-block-text">${esc(r.cost)} points${
            r.description ? ` · ${esc(r.description)}` : ""
          }</span></span>${action}</li>`;
        })
        .join("");
      return `<div class="lw-block">${s.title ? `<div class="lw-title">${esc(s.title)}</div>` : ""}<ul class="lw-list lw-gap">${
        rows || `<li class="lw-muted lw-small">${esc(s.emptyText)}</li>`
      }</ul></div>`;
    }

    case "coupons": {
      const list = (state.coupons || [])
        // "Used" and "expired" codes stay visible as history, so a customer can always see what they claimed.
        .filter((c) => s.showUsed !== false || !c.status || c.status === "ACTIVE")
        .map((c) => {
          const active = !c.status || c.status === "ACTIVE";
          const badge = active
            ? ""
            : `<span class="lw-badge">${c.status === "USED" ? "Used" : "Expired"}</span>`;
          const actions = active
            ? `<span class="lw-btns"><button class="lw-btn lw-btn-sm lw-btn-outline" data-action="copy" data-code="${esc(
                c.code,
              )}" type="button">Copy</button><button class="lw-btn lw-btn-sm" data-action="apply" data-code="${esc(
                c.code,
              )}" type="button">Use at checkout</button></span>`
            : "";
          return `<li class="lw-card lw-reward${active ? "" : " lw-dim"}"><span class="lw-grow"><span class="lw-code">${esc(
            c.code,
          )}</span> ${badge}<span class="lw-muted lw-small lw-block-text">${esc(c.rewardName)}${
            c.expiresAt && active ? ` · expires ${esc(c.expiresAt)}` : ""
          }</span></span>${actions}</li>`;
        })
        .join("");
      return `<div class="lw-block">${s.title ? `<div class="lw-title">${esc(s.title)}</div>` : ""}<ul class="lw-list lw-gap">${
        list || `<li class="lw-muted lw-small">${esc(s.emptyText)}</li>`
      }</ul></div>`;
    }

    case "history": {
      const rows = (state.history || [])
        .slice(0, Number(s.limit) || 30)
        .map((h) => {
          const points = `<span class="lw-points ${h.points < 0 ? "lw-neg" : "lw-pos"}">${h.points > 0 ? "+" : ""}${esc(h.points)}</span>`;
          const head = `<span class="lw-grow"><span class="lw-strong">${esc(h.label)}</span><span class="lw-muted lw-small lw-block-text">${esc(
            h.date,
          )}${h.redeem ? " · tap to see your code" : ""}</span></span>${points}`;
          if (!h.redeem) return `<li class="lw-row">${head}</li>`;

          // A redemption opens (native <details>, so no script and no redraw) to show its code.
          const r = h.redeem;
          const active = r.status === "ACTIVE";
          const badge = active ? "" : `<span class="lw-badge">${r.status === "USED" ? "Used" : "Expired"}</span>`;
          const actions = active
            ? `<span class="lw-btns"><button class="lw-btn lw-btn-sm lw-btn-outline" data-action="copy" data-code="${esc(
                r.code,
              )}" type="button">Copy</button><button class="lw-btn lw-btn-sm" data-action="apply" data-code="${esc(
                r.code,
              )}" type="button">Use at checkout</button></span>`
            : "";
          return `<li class="lw-act"><details><summary class="lw-row lw-sum">${head}<span class="lw-chev" aria-hidden="true">›</span></summary>
            <div class="lw-act-body"><span class="lw-grow"><span class="lw-code">${esc(r.code)}</span> ${badge}${
              r.expiresAt && active ? `<span class="lw-muted lw-small lw-block-text">expires ${esc(r.expiresAt)}</span>` : ""
            }</span>${actions}</div></details></li>`;
        })
        .join("");
      const height = Number(s.height) || 0;
      return `<div class="lw-block">${s.title ? `<div class="lw-title">${esc(s.title)}</div>` : ""}<ul class="lw-list lw-scroll${
        height ? " lw-boxed" : ""
      }" data-scroll="history-${esc(block.id)}"${height ? ` style="max-height:${height}px"` : ""}>${
        rows || `<li class="lw-muted lw-small">${esc(s.emptyText)}</li>`
      }</ul></div>`;
    }

    case "text":
      return `<div class="lw-block">${s.title ? `<div class="lw-title">${esc(s.title)}</div>` : ""}<p class="lw-muted lw-pre">${esc(
        s.body,
      )}</p></div>`;

    case "button": {
      const href = /^(https?:\/\/|\/|#|mailto:)/i.test(s.url || "") ? s.url : "#";
      return `<div class="lw-block"><a class="lw-btn lw-btn-block ${
        s.style === "outline" ? "lw-btn-outline" : ""
      }" href="${esc(href)}">${esc(s.label)}</a></div>`;
    }

    case "html":
      return `<div class="lw-block lw-custom">${sanitizeHtml(fillVars(String(s.html ?? ""), state))}</div>`;

    case "spacer":
      return `<div style="height:${Number(s.height) || 0}px"></div>`;

    default:
      return "";
  }
}

function blockVisible(block, state) {
  if (!block.visible) return false;
  const a = block.settings.audience;
  if (a === "logged_in") return !!state.loggedIn;
  if (a === "logged_out") return !state.loggedIn;
  return true;
}

// Each block is wrapped so the editor preview can map a click back to its block.
export function renderBlocks(config, state, selectedId) {
  if (config.custom && config.custom.mode === "html") return renderHtmlTemplate(config, state, selectedId);
  return config.blocks
    .filter((b) => blockVisible(b, state))
    .map((b) => {
      const html = renderBlock(b, state);
      if (!html) return "";
      return `<div class="lw-bw${b.id === selectedId ? " lw-selected" : ""}" data-bid="${esc(b.id)}">${html}</div>`;
    })
    .join("");
}

// Custom HTML layout: the merchant writes the whole body. {{variables}} are filled and
// {{block:type}} drops in the real working block (first block of that type in the list, so its
// settings still apply). The result is sanitised like any other custom HTML.
function renderHtmlTemplate(config, state, selectedId) {
  const html = String(config.custom.html || "").replace(/\{\{\s*block:(\w+)\s*\}\}/g, (m, type) => {
    const block = config.blocks.find((b) => b.type === type);
    if (!block || !blockVisible(block, state)) return "";
    const inner = renderBlock(block, state);
    return inner ? `<div class="lw-bw${block.id === selectedId ? " lw-selected" : ""}" data-bid="${esc(block.id)}">${inner}</div>` : "";
  });
  return `<div class="lw-tpl">${sanitizeHtml(fillVars(html, state))}</div>`;
}

// --- styles ----------------------------------------------------------------------------

export function widgetCss(config) {
  const t = config.theme;
  const l = config.launcher;
  const font = (FONTS[t.font] || FONTS.system).stack;
  const pad = t.density === "compact" ? 12 : 18;
  const [v, h] = l.position.split("-");
  const header =
    t.headerStyle === "gradient"
      ? `background: linear-gradient(135deg, ${t.primary}, color-mix(in srgb, ${t.primary} 60%, #ec4899)); color: ${t.primaryText};`
      : t.headerStyle === "plain"
        ? `background: transparent; color: ${t.text}; border-bottom: 1px solid ${t.border};`
        : `background: ${t.primary}; color: ${t.primaryText};`;

  return `
:host { all: initial; }
* { box-sizing: border-box; }
.lw-root {
  --p: ${t.primary}; --pt: ${t.primaryText}; --bg: ${t.background}; --sf: ${t.surface};
  --tx: ${t.text}; --mu: ${t.mutedText}; --bd: ${t.border}; --r: ${t.radius}px; --pad: ${pad}px;
  font-family: ${font}; color: var(--tx); font-size: 14px; line-height: 1.45;
}
.lw-root button, .lw-root a { font-family: inherit; }
.lw-launcher-wrap { position: fixed; z-index: 2147483000; ${v}: ${l.offsetY}px; ${h}: ${l.offsetX}px; }
.lw-preview .lw-launcher-wrap, .lw-preview .lw-panel { position: absolute; }
.lw-launcher {
  display: inline-flex; align-items: center; gap: 8px; cursor: pointer; border: 0;
  background: var(--p); color: var(--pt); font-weight: 600; font-size: 14px;
  padding: ${l.style === "circle" ? "0" : "0 18px"}; height: 48px; ${l.style === "circle" ? "width: 48px; justify-content: center;" : ""}
  border-radius: ${l.style === "circle" ? "999px" : "calc(var(--r) + 14px)"};
  ${t.shadow ? "box-shadow: 0 6px 20px rgba(0,0,0,.22);" : ""}
  transition: transform .15s ease;
}
.lw-launcher:hover { transform: translateY(-1px); }
.lw-launcher-icon { font-size: 18px; line-height: 1; }
.lw-panel {
  position: fixed; z-index: 2147483001; ${v}: ${l.offsetY + 60}px; ${h}: ${l.offsetX}px;
  width: ${l.panelWidth}px; max-width: calc(100vw - 24px); max-height: min(640px, calc(100vh - ${l.offsetY + 80}px));
  display: flex; flex-direction: column; overflow: hidden;
  background: var(--bg); border: 1px solid var(--bd); border-radius: calc(var(--r) + 4px);
  ${t.shadow ? "box-shadow: 0 18px 50px rgba(0,0,0,.28);" : ""}
  transform-origin: ${v} ${h};
}
.lw-panel.lw-anim { animation: lw-pop .18s ease-out; }
.lw-panel[hidden] { display: none; }
.lw-preview .lw-panel { max-height: calc(100% - ${l.offsetY + 76}px); }
@keyframes lw-pop { from { opacity: 0; transform: scale(.96) translateY(6px); } to { opacity: 1; transform: none; } }
.lw-close {
  position: absolute; top: 10px; right: 10px; z-index: 2; width: 30px; height: 30px; border-radius: 999px;
  border: 0; cursor: pointer; font-size: 18px; line-height: 1; background: rgba(0,0,0,.18); color: #fff;
}
.lw-body { overflow-y: auto; flex: 1; padding-bottom: var(--pad); }
.lw-page { background: var(--bg); border: 1px solid var(--bd); border-radius: calc(var(--r) + 4px); overflow: hidden; max-width: 760px; margin: 0 auto; ${t.shadow ? "box-shadow: 0 8px 30px rgba(0,0,0,.08);" : ""} }
.lw-header { ${header} padding: calc(var(--pad) + 8px) var(--pad) calc(var(--pad) + 4px); padding-right: 48px; }
.lw-header-title { font-size: 20px; font-weight: 700; letter-spacing: -.01em; }
.lw-header-sub { margin-top: 4px; opacity: .85; font-size: 13px; }
.lw-block { padding: var(--pad) var(--pad) 0; }
.lw-title { font-weight: 700; font-size: 15px; margin-bottom: 10px; }
.lw-card { background: var(--sf); border: 1px solid var(--bd); border-radius: var(--r); padding: 14px; }
.lw-center { text-align: center; }
.lw-center p { margin: 6px 0 14px; }
.lw-balance { text-align: center; padding: 18px; }
.lw-balance-num { font-size: 40px; font-weight: 800; letter-spacing: -.02em; color: var(--p); line-height: 1.1; margin: 2px 0; }
.lw-muted { color: var(--mu); }
.lw-small { font-size: 12px; }
.lw-strong { font-weight: 600; }
.lw-pre { white-space: pre-wrap; margin: 0; }
.lw-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.lw-gap { gap: 10px; }
.lw-row { display: flex; align-items: center; gap: 12px; padding: 10px 0; border-bottom: 1px solid var(--bd); }
.lw-row:last-child { border-bottom: 0; }
.lw-dot { color: var(--p); width: 20px; text-align: center; }
.lw-grow { flex: 1; min-width: 0; }
.lw-block-text { display: block; }
.lw-reward { display: flex; align-items: center; gap: 12px; }
.lw-code { font-family: ui-monospace, Menlo, Consolas, monospace; font-weight: 700; letter-spacing: .04em; }
.lw-points { font-weight: 700; font-variant-numeric: tabular-nums; }
.lw-pos { color: #16a34a; } .lw-neg { color: #dc2626; }
.lw-btn {
  display: inline-block; text-align: center; text-decoration: none; cursor: pointer; border: 1px solid var(--p);
  background: var(--p); color: var(--pt); font-weight: 600; font-size: 14px; padding: 10px 18px; border-radius: var(--r);
}
.lw-btn:disabled { opacity: .45; cursor: not-allowed; }
.lw-btn-sm { padding: 7px 12px; font-size: 13px; white-space: nowrap; }
.lw-btn-block { display: block; width: 100%; }
.lw-btn-outline { background: transparent; color: var(--p); }
.lw-custom img { max-width: 100%; }
.lw-scroll { overflow-y: auto; overscroll-behavior: contain; }
.lw-boxed { border: 1px solid var(--bd); border-radius: var(--r); padding: 0 12px; background: var(--sf); }
.lw-act { border-bottom: 1px solid var(--bd); }
.lw-act:last-child { border-bottom: 0; }
.lw-act summary { list-style: none; cursor: pointer; }
.lw-act summary::-webkit-details-marker { display: none; }
.lw-act .lw-sum { border-bottom: 0; }
.lw-act .lw-sum:hover .lw-strong { text-decoration: underline; }
.lw-chev { color: var(--mu); font-size: 18px; line-height: 1; transition: transform .15s; width: 14px; text-align: center; }
.lw-act details[open] .lw-chev { transform: rotate(90deg); }
.lw-code { white-space: nowrap; }
.lw-act-body { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 0 0 12px; }
.lw-dim { opacity: .6; }
.lw-badge { display: inline-block; padding: 1px 8px; border-radius: 999px; background: var(--bd); color: var(--mu); font-size: 11px; font-weight: 700; vertical-align: middle; }
.lw-btns { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
.lw-btns.lw-left { justify-content: flex-start; margin: 10px 0; }
.lw-form { display: flex; flex-direction: column; gap: 10px; text-align: left; }
.lw-input {
  width: 100%; padding: 11px 12px; border: 1px solid var(--bd); border-radius: var(--r); background: var(--bg);
  color: var(--tx); font: inherit; font-size: 15px;
}
.lw-input:focus { outline: 2px solid var(--p); outline-offset: 1px; }
.lw-code-input { text-align: center; letter-spacing: .4em; font-size: 20px; font-weight: 700; font-variant-numeric: tabular-nums; }
.lw-inline { display: flex; gap: 8px; align-items: center; }
.lw-inline .lw-input { flex: 1; min-width: 0; text-transform: uppercase; }
.lw-link { background: none; border: 0; padding: 4px 0; color: var(--p); cursor: pointer; font-size: 13px; text-decoration: underline; }
.lw-links { display: flex; justify-content: space-between; gap: 12px; }
.lw-or { display: flex; align-items: center; gap: 10px; margin: 14px 0 10px; color: var(--mu); font-size: 12px; }
.lw-or::before, .lw-or::after { content: ""; flex: 1; height: 1px; background: var(--bd); }
.lw-error { margin-top: 10px; padding: 8px 10px; border-radius: calc(var(--r) - 4px); background: #fee2e2; color: #991b1b; font-size: 13px; text-align: left; }
.lw-warn { margin-top: 10px; padding: 7px 10px; border-radius: calc(var(--r) - 4px); background: #fef3c7; color: #92400e; font-size: 12px; font-weight: 600; }
.lw-title-sm { font-size: 13px; margin-bottom: 8px; }
.lw-tight { margin: 4px 0 8px; }
.lw-sub { margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--bd); }
.lw-refcode { margin: 12px 0 0; }
.lw-refcode .lw-code { display: block; text-align: center; padding: 12px; border: 2px dashed var(--bd); border-radius: var(--r); font-size: 20px; background: var(--bg); }
.lw-account { padding-bottom: 4px; }
.lw-tpl { padding: var(--pad); }
.lw-tpl .lw-block { padding-left: 0; padding-right: 0; }
.lw-var { display: flex; flex-direction: column; gap: 6px; }
.lw-var-row { padding: 6px 0 2px; }
.lw-range { width: 100%; accent-color: var(--p); }
.lw-var-foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }

/* Page mode: a real page, not a panel. Hero header, roomier blocks, reward cards in a grid. */
.lw-is-page .lw-page { max-width: 960px; ${t.shadow ? "box-shadow: 0 10px 40px rgba(0,0,0,.08);" : ""} }
.lw-is-page .lw-header { padding: 44px calc(var(--pad) + 14px) 36px; text-align: center; }
.lw-is-page .lw-header-title { font-size: 32px; }
.lw-is-page .lw-header-sub { font-size: 16px; margin-top: 8px; }
.lw-is-page .lw-block { padding: calc(var(--pad) + 8px) calc(var(--pad) + 14px) 0; }
.lw-is-page .lw-title { font-size: 18px; margin-bottom: 14px; }
.lw-is-page .lw-balance { padding: 28px; }
.lw-is-page .lw-balance-num { font-size: 56px; }
.lw-is-page .lw-list.lw-gap { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 14px; }
.lw-is-page .lw-reward { flex-wrap: wrap; }
.lw-is-page .lw-body { padding-bottom: calc(var(--pad) + 14px); }
.lw-is-page.lw-mobile .lw-header { padding: 28px var(--pad); }
.lw-is-page.lw-mobile .lw-header-title { font-size: 24px; }
.lw-is-page.lw-mobile .lw-block { padding: var(--pad) var(--pad) 0; }
.lw-is-page.lw-mobile .lw-list.lw-gap { grid-template-columns: 1fr; }
.lw-preview .lw-bw { cursor: pointer; outline: 2px solid transparent; outline-offset: -2px; transition: outline-color .12s; }
.lw-preview .lw-bw:hover { outline-color: color-mix(in srgb, var(--p) 45%, transparent); }
.lw-preview .lw-bw.lw-selected { outline-color: var(--p); }
.lw-toast { position: absolute; left: 16px; right: 16px; bottom: 16px; padding: 10px 14px; border-radius: var(--r); background: var(--tx); color: var(--bg); font-size: 13px; text-align: center; z-index: 3; }

.lw-root.lw-mobile .lw-launcher-wrap { ${v}: ${Math.min(l.offsetY, 24)}px; ${h}: ${Math.min(l.offsetX, 16)}px; }
${
  l.mobileFullscreen
    ? `.lw-root.lw-mobile .lw-panel { inset: 0; width: 100%; max-width: none; max-height: none; border-radius: 0; border: 0; }
.lw-root.lw-mobile.lw-preview .lw-panel { inset: 0; max-height: none; }`
    : `.lw-root.lw-mobile .lw-panel { left: 12px; right: 12px; width: auto; ${v}: ${Math.min(l.offsetY, 24) + 58}px; }`
}
.lw-root.lw-mobile .lw-hide-mobile, .lw-root:not(.lw-mobile) .lw-hide-desktop { display: none !important; }
${
  t.hideScrollbars
    ? `/* scrolling still works, the bars are just hidden */
.lw-body, .lw-scroll, .lw-page { scrollbar-width: none; -ms-overflow-style: none; }
.lw-body::-webkit-scrollbar, .lw-scroll::-webkit-scrollbar, .lw-page::-webkit-scrollbar { display: none; width: 0; height: 0; }`
    : ""
}
${config.custom?.css ? `\n/* merchant css */\n${String(config.custom.css).replace(/<\/?style[^>]*>/gi, "")}` : ""}
`;
}

// --- HTML shells (the outer structure; developers can replace these) -------------------
//
// Placeholders: {{root_classes}} {{panel_classes}} {{panel_hidden}} {{expanded}}
//               {{launcher_label}} {{launcher_inner}} {{store_name}} {{content}}
// {{content}} is the rendered blocks / custom HTML and is required.

export const DEFAULT_SHELL = `<div class="{{root_classes}}">
  <div class="lw-launcher-wrap">
    <button class="lw-launcher" data-action="toggle" type="button" aria-expanded="{{expanded}}" aria-label="{{launcher_label}}">{{launcher_inner}}</button>
  </div>
  <div class="{{panel_classes}}" role="dialog" aria-label="{{launcher_label}}" {{panel_hidden}}>
    <button class="lw-close" data-action="toggle" type="button" aria-label="Close">×</button>
    <div class="lw-body">{{content}}</div>
  </div>
</div>`;

export const DEFAULT_PAGE_SHELL = `<div class="{{root_classes}}">
  <div class="lw-page">
    <div class="lw-body">{{content}}</div>
  </div>
</div>`;

export function fillShell(shell, values, rawKeys) {
  return String(shell).replace(/\{\{\s*(\w+)\s*\}\}/g, (m, key) =>
    key in values ? (rawKeys.indexOf(key) >= 0 ? values[key] : esc(values[key])) : m,
  );
}

/** The generated, editable starting point for the developer source page. */
export function compileSource(config) {
  return {
    css: widgetCss({ ...config, dev: null }),
    shell: DEFAULT_SHELL,
    pageShell: DEFAULT_PAGE_SHELL,
  };
}

// --- mounting --------------------------------------------------------------------------

/**
 * Mounts the widget (or inline page) into `host` using a shadow root.
 * opts: { mode: 'widget'|'page', preview: bool, forceMobile: bool|undefined, onAction(name, el) }
 * Returns { update(config, state), setOpen(bool), destroy() }.
 */
export function createWidget(host, initialConfig, initialState, opts = {}) {
  const root = host.shadowRoot || host.attachShadow({ mode: "open" });
  let config = initialConfig;
  let state = initialState;
  // The editor passes "PAGE"/"WIDGET" (database enum), the storefront "page"/"widget".
  const isPage = String(opts.mode).toLowerCase() === "page";
  let open = isPage ? true : !!opts.startOpen;
  let selectedId = null;
  let toastTimer;
  // Transient UI state (login form step, typed email/code, errors). Kept here so a redraw
  // triggered by new data doesn't wipe what the shopper is typing.
  let ui = {};

  const isMobile = () =>
    opts.forceMobile !== undefined
      ? opts.forceMobile
      : typeof window !== "undefined" && window.matchMedia("(max-width: 640px)").matches;

  // A redraw replaces the DOM; remember scroll positions so new data (or a redeem) doesn't throw
  // the shopper back to the top of the panel or of a scrolling list.
  function draw() {
    const keep = {};
    const body = root.querySelector(".lw-body");
    if (body) keep.__body = body.scrollTop;
    root.querySelectorAll("[data-scroll]").forEach((el) => {
      keep[el.getAttribute("data-scroll")] = el.scrollTop;
    });
    paint();
    const body2 = root.querySelector(".lw-body");
    if (body2 && keep.__body) body2.scrollTop = keep.__body;
    root.querySelectorAll("[data-scroll]").forEach((el) => {
      const v = keep[el.getAttribute("data-scroll")];
      if (v) el.scrollTop = v;
    });
  }

  // Only the open transition animates. Redraws caused by new data (e.g. after a redeem) must not
  // replay it, or the panel appears to close and reopen.
  let justOpened = false;

  function paint() {
    const mobile = isMobile();
    const vis = config.launcher.visibility;
    const hiddenHere = !opts.preview && ((vis === "desktop" && mobile) || (vis === "mobile" && !mobile));
    const body = renderBlocks(config, { ...state, ui }, selectedId);
    const l = config.launcher;
    const anim = justOpened;
    justOpened = false;

    if (!isPage && hiddenHere) {
      root.innerHTML = "";
      return;
    }

    const values = {
      root_classes: `lw-root${mobile ? " lw-mobile" : ""}${opts.preview ? " lw-preview" : ""}${isPage ? " lw-is-page" : ""}`,
      panel_classes: `lw-panel${anim ? " lw-anim" : ""}`,
      panel_hidden: open ? "" : "hidden",
      expanded: String(open),
      launcher_label: l.label || "Rewards",
      launcher_inner: `<span class="lw-launcher-icon">${esc(l.icon)}</span>${l.style === "circle" ? "" : `<span>${esc(l.label)}</span>`}`,
      store_name: (state.shop && state.shop.name) || "",
      content: body,
    };
    const RAW = ["panel_hidden", "launcher_inner", "content"];

    // Developer source (stored per store): custom CSS and/or HTML shell. Anything that fails
    // falls back to the generated defaults, so a broken source can never blank the widget.
    const dev = config.dev || null;
    let css = dev && dev.css ? dev.css : "";
    let html = "";
    try {
      const customShell = dev && (isPage ? dev.pageShell : dev.shell);
      // A shell without {{content}} would hide everything, so it is ignored.
      if (customShell && /\{\{\s*content\s*\}\}/.test(customShell)) {
        html = sanitizeHtml(fillShell(customShell, values, RAW));
      }
    } catch (e) {
      html = "";
    }
    if (!html) html = fillShell(isPage ? DEFAULT_PAGE_SHELL : DEFAULT_SHELL, values, RAW);
    if (!css) css = widgetCss(config);
    root.innerHTML = `<style>${css}</style>${html}`;
  }

  function onClick(e) {
    const el = e.target.closest?.("[data-action]");
    if (opts.preview) {
      // Editor preview: clicking a block selects it; the launcher still toggles the panel.
      if (el?.dataset.action === "toggle") {
        open = !open;
        justOpened = open;
        draw();
        return;
      }
      const bw = e.target.closest?.("[data-bid]");
      if (bw) opts.onSelectBlock?.(bw.dataset.bid);
      return;
    }
    if (!el || el.disabled) return;
    const action = el.dataset.action;
    if (action === "toggle") {
      open = !open;
      justOpened = open;
      draw();
      return;
    }
    if (action === "copy") {
      navigator.clipboard?.writeText(el.dataset.code).catch(() => {});
      api.toast("Code copied");
      return;
    }
    opts.onAction?.(action, el, api);
  }
  root.addEventListener("click", onClick);

  // Slider moves update the "N points = $X off" label in place (no full redraw, so the
  // thumb isn't reset while dragging).
  function onInput(e) {
    const input = e.target;
    if (input && input.dataset && input.dataset.field) {
      ui[input.dataset.field] = input.value; // no redraw: keep focus and caret
      return;
    }
    const id = input && input.dataset && input.dataset.points;
    if (!id) return;
    const reward = (state.rewards || []).find((r) => String(r.id) === id);
    if (!reward || !reward.variable) return;
    const pts = Number(input.value);
    const p = root.querySelector(`[data-calc-points="${id}"]`);
    const m = root.querySelector(`[data-calc-money="${id}"]`);
    if (p) p.textContent = pts;
    if (m) m.textContent = formatMoney(variableValue(reward.variable, pts), state.shop && state.shop.currency);
  }
  root.addEventListener("input", onInput);

  // Enter in a login/referral field runs that field's action (e.g. send the code).
  function onKeydown(e) {
    if (e.key !== "Enter" || opts.preview) return;
    const el = e.target;
    const action = el && el.dataset && el.dataset.enter;
    if (action) {
      e.preventDefault();
      ui[el.dataset.field] = el.value;
      if (opts.onAction) opts.onAction(action, el, api);
    }
  }
  root.addEventListener("keydown", onKeydown);

  const api = {
    update(nextConfig, nextState) {
      config = nextConfig ?? config;
      state = nextState ?? state;
      draw();
    },
    setOpen(v) {
      open = !!v;
      justOpened = open;
      draw();
    },
    select(id) {
      selectedId = id;
      draw();
    },
    // Read/merge the transient UI state (login step, typed values, errors) and redraw.
    getUi() {
      return ui;
    },
    setUi(patch) {
      ui = Object.assign({}, ui, patch);
      draw();
      if (ui.focus) {
        const f = root.querySelector("[data-autofocus]");
        if (f) f.focus();
        ui.focus = false;
      }
    },
    toast(message) {
      clearTimeout(toastTimer);
      root.querySelector(".lw-toast")?.remove();
      const panel = root.querySelector(".lw-panel:not([hidden])") || root.querySelector(".lw-page");
      if (!panel) return;
      const t = document.createElement("div");
      t.className = "lw-toast";
      t.textContent = message;
      panel.style.position ||= "relative";
      panel.appendChild(t);
      toastTimer = setTimeout(() => t.remove(), 2600);
    },
    destroy() {
      root.removeEventListener("click", onClick);
      root.removeEventListener("input", onInput);
      root.removeEventListener("keydown", onKeydown);
      window.removeEventListener("resize", draw);
      root.innerHTML = "";
    },
  };

  if (opts.forceMobile === undefined && typeof window !== "undefined") {
    window.addEventListener("resize", draw);
  }
  draw();
  return api;
}
