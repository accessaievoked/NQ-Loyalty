import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { requireStore } from "../services/auth.server";
import { getEmailBrand, isKind, listEmailTemplates, resetEmailTemplate, saveEmailBrand, saveEmailTemplate } from "../services/emailtemplates.server";
import { sendTemplateTest, smtpConfigured } from "../services/mailer.server";
import { getRedis } from "../queue/queue.server";
import db from "../db.server";
import {
  EMAIL_BLOCK_TYPES,
  EMAIL_KINDS,
  EMAIL_PRESETS,
  EMAIL_STYLE_FIELDS,
  FONT_LABELS,
  blocksToHtml,
  buildPreset,
  defaultEmailTemplate,
  makeEmailBlock,
  normalizeEmailTemplate,
  renderEmail,
} from "../lib/email/templates";
import { BlockField, ColorField, OptionalColorField, OptionalRangeField, RangeField, Row, SelectField, StyleField, Toggle } from "../components/EditorControls";
import { ArrowLeft } from "../components/BackButton";
import "../styles/editor.css";

// One page for everything email: how each message looks (blocks or your own HTML), and when
// and from whom they are sent.

async function redisUp() {
  try {
    const pong = await Promise.race([getRedis().ping(), new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 1500))]);
    return pong === "PONG";
  } catch {
    return false;
  }
}

export const loader = async ({ request }) => {
  const { store, session } = await requireStore(request);
  const s = store.settings;
  return {
    shop: store.name || store.shop,
    storeEmail: store.email || session.email || "",
    smtp: smtpConfigured(),
    redis: await redisUp(),
    templates: await listEmailTemplates(store.id),
    brand: await getEmailBrand(store.id),
    settings: {
      emailsEnabled: s.emailsEnabled,
      notifyPointsEarned: s.notifyPointsEarned,
      notifyRedeemed: s.notifyRedeemed,
      notifyExpiring: s.notifyExpiring,
      expiryReminderDays: s.expiryReminderDays,
      senderName: s.senderName || "",
      replyTo: s.replyTo || "",
      expiryDays: s.expiryDays,
    },
  };
};

export const action = async ({ request }) => {
  const { store } = await requireStore(request);
  const f = await request.formData();
  const intent = String(f.get("intent"));

  if (intent === "settings") {
    const on = (k) => f.get(k) === "on";
    await db.storeSettings.update({
      where: { storeId: store.id },
      data: {
        emailsEnabled: on("emailsEnabled"),
        notifyPointsEarned: on("notifyPointsEarned"),
        notifyRedeemed: on("notifyRedeemed"),
        notifyExpiring: on("notifyExpiring"),
        expiryReminderDays: Math.max(1, Math.min(90, Math.floor(Number(f.get("expiryReminderDays"))) || 7)),
        senderName: String(f.get("senderName") || "").trim().slice(0, 60) || null,
        replyTo: String(f.get("replyTo") || "").trim().slice(0, 120) || null,
      },
    });
    return { ok: true, intent, message: "Email settings saved" };
  }

  if (intent === "brand") {
    let input;
    try {
      input = JSON.parse(String(f.get("brand") || "{}"));
    } catch {
      return { ok: false, intent, errors: ["Couldn't read the brand settings"] };
    }
    const brand = await saveEmailBrand(store.id, input);
    return { ok: true, intent, brand, message: "Brand saved" };
  }

  const kind = String(f.get("kind"));
  if (!isKind(kind)) return { ok: false, errors: ["Unknown email"] };

  let template;
  try {
    template = f.get("template") ? JSON.parse(String(f.get("template"))) : undefined;
  } catch {
    return { ok: false, errors: ["Couldn't read the template"] };
  }

  if (intent === "save") {
    const r = await saveEmailTemplate(store.id, kind, template);
    return r.ok ? { ok: true, intent, kind, message: "Email saved" } : r;
  }
  if (intent === "reset") {
    await resetEmailTemplate(store.id, kind);
    return { ok: true, intent, kind, message: "Restored the default email" };
  }
  if (intent === "test") {
    const to = String(f.get("to") || "").trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return { ok: false, errors: ["Enter a valid email address"] };
    try {
      await sendTemplateTest({ store, kind, template: normalizeEmailTemplate(kind, template, await getEmailBrand(store.id)), to });
      return { ok: true, intent, kind, message: `Test sent to ${to}` };
    } catch (e) {
      return { ok: false, errors: [`Couldn't send: ${e.message}`] };
    }
  }
  return { ok: false, errors: ["Unknown action"] };
};

// ---- brand panel ------------------------------------------------------------------------------------

function BrandSettings({ brand }) {
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const [b, setB] = useState(brand);
  const set = (patch) => setB((x) => ({ ...x, ...patch }));
  const dirty = JSON.stringify(b) !== JSON.stringify(brand);
  useEffect(() => {
    if (fetcher.data?.intent === "brand" && fetcher.data.ok) shopify.toast.show(fetcher.data.message);
  }, [fetcher.data, shopify]);
  const save = () => {
    const fd = new FormData();
    fd.set("intent", "brand");
    fd.set("brand", JSON.stringify(b));
    fetcher.submit(fd, { method: "POST" });
  };

  return (
    <div className="ed-pane-body">
      <div className="ed-section-title">Your brand</div>
      <p className="ed-help">Set your look once; every email you haven&apos;t customised uses it. Leave a field empty to keep the design&apos;s own.</p>
      <Row label="Logo image link" help="A full https:// link, e.g. an image from Shopify → Content → Files.">
        <input className="ed-input" value={b.logoUrl} onChange={(e) => set({ logoUrl: e.target.value })} placeholder="https://cdn.shopify.com/…/logo.png" />
      </Row>
      <Toggle label="Logo fills the whole header" checked={b.logoFull} onChange={(v) => set({ logoFull: v })} help="On: the image is the header, edge to edge (for a banner). Off: a small logo above the store name." />
      <OptionalColorField label="Brand colour" value={b.brandColor} onChange={(v) => set({ brandColor: v })} />
      <OptionalRangeField label="Corner radius" value={b.radius} min={0} max={48} onChange={(v) => set({ radius: v })} />
      <OptionalColorField label="Header colour" value={b.headerColor} onChange={(v) => set({ headerColor: v })} />
      <OptionalColorField label="Button colour" value={b.buttonColor} onChange={(v) => set({ buttonColor: v })} />
      <OptionalColorField label="Footer colour" value={b.footerColor} onChange={(v) => set({ footerColor: v })} />
      <Row label="Footer title">
        <input className="ed-input" value={b.footerTitle} onChange={(e) => set({ footerTitle: e.target.value })} placeholder="Questions about your points?" />
      </Row>
      <Row label="Footer text" help="Use {email} for your contact address (your reply-to address below, or the store email).">
        <textarea className="ed-input" rows={3} value={b.footerText} onChange={(e) => set({ footerText: e.target.value })} placeholder="Just reply to this email or reach us at {email}. We're happy to help." />
      </Row>
      <button type="button" className="ed-btn primary wide" disabled={!dirty || fetcher.state !== "idle"} onClick={save}>
        {fetcher.state !== "idle" ? "Saving…" : "Save brand"}
      </button>
      <p className="ed-help">Emails you&apos;ve already customised keep their own design. To bring one in line, open it and use Design → pick a design, or Reset to the default.</p>
      <div className="ed-divider" />
    </div>
  );
}

// ---- settings panel ---------------------------------------------------------------------------------

function EmailSettings({ settings, smtp, redis }) {
  const fetcher = useFetcher();
  const [s, setS] = useState(settings);
  const set = (patch) => setS((x) => ({ ...x, ...patch }));
  const dirty = JSON.stringify(s) !== JSON.stringify(settings);
  const save = () => {
    const fd = new FormData();
    fd.set("intent", "settings");
    for (const k of ["emailsEnabled", "notifyPointsEarned", "notifyRedeemed", "notifyExpiring"]) if (s[k]) fd.set(k, "on");
    fd.set("expiryReminderDays", String(s.expiryReminderDays));
    fd.set("senderName", s.senderName);
    fd.set("replyTo", s.replyTo);
    fetcher.submit(fd, { method: "POST" });
  };
  const shopify = useAppBridge();
  useEffect(() => {
    if (fetcher.data?.ok) shopify.toast.show(fetcher.data.message);
  }, [fetcher.data, shopify]);

  return (
    <div className="ed-pane-body">
      <div className="ed-section-title">When emails are sent</div>
      <Toggle label="Send loyalty emails" checked={s.emailsEnabled} onChange={(v) => set({ emailsEnabled: v })} />
      <Toggle label="Points earned" checked={s.notifyPointsEarned} onChange={(v) => set({ notifyPointsEarned: v })} />
      <Toggle label="Reward code issued" checked={s.notifyRedeemed} onChange={(v) => set({ notifyRedeemed: v })} />
      <Toggle label="Points expiring soon" checked={s.notifyExpiring} onChange={(v) => set({ notifyExpiring: v })} />
      <Row
        label="Warn this many days before points expire"
        help={s.expiryDays === 0 ? "Your points currently never expire (set an expiry on the Rules page), so no reminders go out." : "Customers get one reminder email per batch of expiring points."}
      >
        <input className="ed-input" type="number" min={1} max={90} value={s.expiryReminderDays} onChange={(e) => set({ expiryReminderDays: Number(e.target.value) })} />
      </Row>
      <div className="ed-section-title">Who it comes from</div>
      <Row label="Sender name" help="Defaults to your store name.">
        <input className="ed-input" value={s.senderName} onChange={(e) => set({ senderName: e.target.value })} placeholder="e.g. Claura Rewards" />
      </Row>
      <Row label="Reply-to address" help="Where customers' replies go.">
        <input className="ed-input" type="email" value={s.replyTo} onChange={(e) => set({ replyTo: e.target.value })} />
      </Row>
      <button type="button" className="ed-btn primary wide" disabled={!dirty || fetcher.state !== "idle"} onClick={save}>
        {fetcher.state !== "idle" ? "Saving…" : "Save settings"}
      </button>

      <div className="ed-divider" />
      <div className="ed-section-title">System status</div>
      <ul className="ed-status">
        <li><span className={`ed-dot ${smtp ? "ok" : "bad"}`} /> Email sending (SMTP): <strong>{smtp ? "connected" : "not set up on the server"}</strong></li>
        <li><span className={`ed-dot ${redis ? "ok" : "bad"}`} /> Background jobs (Redis): <strong>{redis ? "connected" : "offline"}</strong></li>
      </ul>
      {!redis && <p className="ed-help">Delayed point release and reminder emails need Redis and the worker: run <code>npm run redis</code> and <code>npm run worker</code>.</p>}
    </div>
  );
}

// ---- the page --------------------------------------------------------------------------------------

export default function Emails() {
  const data = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();

  const [drafts, setDrafts] = useState(() => Object.fromEntries(data.templates.map((t) => [t.kind, t.template])));
  const [saved, setSaved] = useState(() => Object.fromEntries(data.templates.map((t) => [t.kind, JSON.stringify(t.template)])));
  const [custom, setCustom] = useState(() => Object.fromEntries(data.templates.map((t) => [t.kind, t.customised])));
  const [section, setSection] = useState("emails"); // emails | settings
  const [kind, setKind] = useState("points_earned");
  const [tab, setTab] = useState("blocks"); // blocks | design | html
  const [selectedId, setSelectedId] = useState(null);
  const [adding, setAdding] = useState(false);
  const [device, setDevice] = useState("desktop");
  const [drag, setDrag] = useState({ id: null, over: null, pos: "before" });
  const [testTo, setTestTo] = useState(data.storeEmail);
  const htmlRef = useRef(null);

  const info = EMAIL_KINDS[kind];
  const draft = drafts[kind];
  const dirty = JSON.stringify(draft) !== saved[kind];
  const busy = fetcher.state !== "idle";
  const errors = fetcher.data && fetcher.data.ok === false ? fetcher.data.errors : [];

  const update = (fn) => setDrafts((d) => ({ ...d, [kind]: fn(d[kind]) }));
  const setTheme = (patch) => update((t) => ({ ...t, theme: { ...t.theme, ...patch } }));
  const setBlock = (id, fn) => update((t) => ({ ...t, blocks: t.blocks.map((b) => (b.id === id ? fn(b) : b)) }));
  const setStyle = (id, k, v) =>
    setBlock(id, (b) => {
      const style = { ...(b.style || {}) };
      if (v === "" || v === undefined || v === null || v === false) delete style[k];
      else style[k] = v;
      return { ...b, style };
    });
  const selected = draft.blocks.find((b) => b.id === selectedId) || null;

  useEffect(() => {
    const d = fetcher.data;
    if (!d || d.intent === "settings") return;
    if (d.ok) {
      shopify.toast.show(d.message || "Done");
      if (d.intent === "save") {
        setSaved((s) => ({ ...s, [d.kind]: JSON.stringify(drafts[d.kind]) }));
        setCustom((c) => ({ ...c, [d.kind]: true }));
      }
      if (d.intent === "reset") {
        const fresh = defaultEmailTemplate(d.kind, data.brand);
        setDrafts((x) => ({ ...x, [d.kind]: fresh }));
        setSaved((s) => ({ ...s, [d.kind]: JSON.stringify(fresh) }));
        setCustom((c) => ({ ...c, [d.kind]: false }));
        setSelectedId(null);
      }
    } else {
      shopify.toast.show("Couldn't complete that — see the message on the left", { isError: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.data]);

  const send = (intent, extra = {}) => {
    const fd = new FormData();
    fd.set("intent", intent);
    fd.set("kind", kind);
    fd.set("template", JSON.stringify(draft));
    for (const [k, v] of Object.entries(extra)) fd.set(k, v);
    fetcher.submit(fd, { method: "POST" });
  };

  const preview = useMemo(() => renderEmail(kind, draft, info.sample), [kind, draft, info]);

  // When the brand changes, emails still on the default (and not mid-edit) pick it up.
  const brandKey = JSON.stringify(data.brand);
  useEffect(() => {
    setDrafts((d) => {
      const next = { ...d };
      for (const k of Object.keys(EMAIL_KINDS)) if (!custom[k] && JSON.stringify(d[k]) === saved[k]) next[k] = defaultEmailTemplate(k, data.brand);
      return next;
    });
    setSaved((sv) => {
      const next = { ...sv };
      for (const k of Object.keys(EMAIL_KINDS)) if (!custom[k] && JSON.stringify(drafts[k]) === sv[k]) next[k] = JSON.stringify(defaultEmailTemplate(k, data.brand));
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brandKey]);

  const addBlock = (type) => {
    const block = makeEmailBlock(type);
    update((t) => {
      const idx = selectedId ? t.blocks.findIndex((b) => b.id === selectedId) : -1;
      const blocks = [...t.blocks];
      blocks.splice(idx >= 0 ? idx + 1 : blocks.length, 0, block);
      return { ...t, blocks };
    });
    setAdding(false);
    setSelectedId(block.id);
  };
  const moveBlock = (id, overId, pos) => {
    if (id === overId) return;
    update((t) => {
      const moving = t.blocks.find((b) => b.id === id);
      const blocks = t.blocks.filter((b) => b.id !== id);
      let idx = blocks.findIndex((b) => b.id === overId);
      if (idx < 0 || !moving) return t;
      if (pos === "after") idx += 1;
      blocks.splice(idx, 0, moving);
      return { ...t, blocks };
    });
  };
  const applyPreset = (id, everywhere) => {
    if (!window.confirm(everywhere ? "Restyle all four emails with this design? Their wording is reset to the defaults." : "Restyle this email with this design? Its blocks are rebuilt with the default wording.")) return;
    setDrafts((d) => {
      const next = { ...d };
      for (const k of everywhere ? Object.keys(EMAIL_KINDS) : [kind]) next[k] = { ...buildPreset(k, id, data.brand), subject: d[k].subject };
      return next;
    });
    setSelectedId(null);
  };
  const insertVar = (name) => {
    const text = `{{${name}}}`;
    if (tab === "html" && htmlRef.current) {
      const at = htmlRef.current.selectionStart ?? draft.html.length;
      update((t) => ({ ...t, html: `${t.html.slice(0, at)}${text}${t.html.slice(at)}` }));
    } else {
      try {
        navigator.clipboard?.writeText(text);
        shopify.toast.show(`Copied ${text}`);
      } catch {
        /* ignore */
      }
    }
  };

  const varOptions = { "": "Always", ...Object.fromEntries(info.vars.map(([k]) => [k, `Only when ${k} has a value`])) };
  const def = selected ? EMAIL_BLOCK_TYPES[selected.type] : null;

  const varList = (
    <div className="ed-vars">
      <div className="ed-section-title">Variables for this email</div>
      <ul className="ed-ref-list">
        {info.vars.map(([k, d]) => (
          <li key={k}>
            <span className="ed-chip">
              <code>{`{{${k}}}`}</code>
              <button type="button" onClick={() => insertVar(k)}>{tab === "html" ? "Insert" : "Copy"}</button>
            </span>
            <span>{d}</span>
          </li>
        ))}
      </ul>
    </div>
  );

  return (
    <div className="ed">
      <header className="ed-top">
        <div className="ed-top-left">
          <Link to="/app/home" className="ed-back" aria-label="Back to home"><ArrowLeft /></Link>
          <div>
            <div className="ed-title">Emails</div>
            <div className="ed-sub">{section === "settings" ? "Sending settings" : dirty ? "Unsaved changes" : custom[kind] ? "Customised" : "Using the default"}</div>
          </div>
        </div>
        <div className="ed-top-center">
          <div className="ed-seg" role="group" aria-label="Email">
            {Object.entries(EMAIL_KINDS).map(([k, v]) => (
              <button key={k} type="button" className={section === "emails" && kind === k ? "on" : ""} onClick={() => { setKind(k); setSection("emails"); setSelectedId(null); }}>
                {v.label}
                {JSON.stringify(drafts[k]) !== saved[k] ? " •" : ""}
              </button>
            ))}
            <button type="button" className={section === "settings" ? "on" : ""} onClick={() => setSection("settings")}>Settings</button>
          </div>
          {section === "emails" && (
            <div className="ed-seg" role="group" aria-label="Device">
              <button type="button" className={device === "desktop" ? "on" : ""} onClick={() => setDevice("desktop")}>Desktop</button>
              <button type="button" className={device === "mobile" ? "on" : ""} onClick={() => setDevice("mobile")}>Mobile</button>
            </div>
          )}
        </div>
        <div className="ed-top-right">
          {section === "emails" && (
            <>
              <button type="button" className="ed-btn" disabled={busy || !custom[kind]} onClick={() => window.confirm("Throw away your changes to this email and use the default?") && send("reset")}>
                Reset to default
              </button>
              <button type="button" className="ed-btn primary" disabled={busy || !dirty} onClick={() => send("save")}>
                {busy ? "Working…" : "Save"}
              </button>
            </>
          )}
        </div>
      </header>

      <div className="ed-main">
        <aside className="ed-side">
          {section === "settings" ? (
            <div className="ed-pane">
              <BrandSettings brand={data.brand} />
              <EmailSettings settings={data.settings} smtp={data.smtp} redis={data.redis} />
            </div>
          ) : selected ? (
            <div className="ed-pane">
              <div className="ed-pane-head">
                <button type="button" className="ed-back" onClick={() => setSelectedId(null)} aria-label="Back to blocks"><ArrowLeft /></button>
                <div>
                  <div className="ed-pane-title">{def.label}</div>
                  <div className="ed-sub">Block settings</div>
                </div>
              </div>
              <div className="ed-pane-body">
                {def.fields.map((f) => (
                  <BlockField key={f.key} def={f} value={selected.settings[f.key]} onChange={(v) => setBlock(selected.id, (b) => ({ ...b, settings: { ...b.settings, [f.key]: v } }))} />
                ))}
                <SelectField
                  label="Show this block"
                  value={selected.settings.onlyIf || ""}
                  options={varOptions}
                  onChange={(v) => setBlock(selected.id, (b) => ({ ...b, settings: { ...b.settings, onlyIf: v } }))}
                />

                <div className="ed-divider" />
                <div className="ed-section-title">Style</div>
                <p className="ed-help">Colours, size, spacing and borders for just this block. Anything left on default follows the email's design.</p>
                {EMAIL_STYLE_FIELDS.map((f) => (
                  <StyleField key={f.key} def={f} value={selected.style?.[f.key]} onChange={(v) => setStyle(selected.id, f.key, v)} />
                ))}
                {selected.style && Object.keys(selected.style).length > 0 && (
                  <button type="button" className="ed-btn wide" onClick={() => setBlock(selected.id, (b) => ({ ...b, style: {} }))}>
                    Reset this block's style
                  </button>
                )}

                <div className="ed-divider" />
                <button type="button" className="ed-btn danger wide" onClick={() => { update((t) => ({ ...t, blocks: t.blocks.filter((b) => b.id !== selected.id) })); setSelectedId(null); }}>
                  Remove block
                </button>
                {varList}
              </div>
            </div>
          ) : (
            <div className="ed-pane">
              <div className="ed-tabs" role="tablist">
                {[["blocks", "Blocks"], ["design", "Design"], ["html", "HTML"]].map(([id, label]) => (
                  <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? "on" : ""} onClick={() => setTab(id)}>{label}</button>
                ))}
              </div>

              <div className="ed-pane-body">
                {errors.length > 0 && (
                  <div className="ed-note ed-note-error" role="alert">
                    <strong>Not saved:</strong>
                    <ul>{errors.map((e) => <li key={e}>{e}</li>)}</ul>
                  </div>
                )}
                <p className="ed-help">{info.when}</p>

                {tab !== "design" && (
                  <Row label="Subject line" help="Variables work here too.">
                    <input className="ed-input" value={draft.subject} onChange={(e) => update((t) => ({ ...t, subject: e.target.value }))} />
                  </Row>
                )}

                {tab === "blocks" && (
                  <>
                    {draft.mode === "html" && (
                      <div className="ed-note">
                        This email is using your <strong>custom HTML</strong>, so blocks and design are ignored.
                        <button type="button" className="ed-btn wide" onClick={() => update((t) => ({ ...t, mode: "blocks" }))}>Use blocks instead</button>
                      </div>
                    )}
                    <div className="ed-section-title">Blocks</div>
                    <ul className="ed-blocks">
                      {draft.blocks.map((b) => {
                        const d = EMAIL_BLOCK_TYPES[b.type];
                        const cls = ["ed-block", drag.id === b.id ? "dragging" : "", drag.over === b.id ? `over-${drag.pos}` : ""].join(" ");
                        return (
                          <li
                            key={b.id}
                            className={cls}
                            draggable
                            onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", b.id); setDrag({ id: b.id, over: null, pos: "before" }); }}
                            onDragOver={(e) => {
                              e.preventDefault();
                              if (!drag.id || drag.id === b.id) return;
                              const r = e.currentTarget.getBoundingClientRect();
                              const pos = e.clientY - r.top > r.height / 2 ? "after" : "before";
                              if (drag.over !== b.id || drag.pos !== pos) setDrag((s) => ({ ...s, over: b.id, pos }));
                            }}
                            onDrop={(e) => { e.preventDefault(); if (drag.id) moveBlock(drag.id, b.id, drag.pos); setDrag({ id: null, over: null, pos: "before" }); }}
                            onDragEnd={() => setDrag({ id: null, over: null, pos: "before" })}
                          >
                            <span className="ed-grip" aria-hidden>⋮⋮</span>
                            <button type="button" className="ed-block-main" onClick={() => setSelectedId(b.id)}>
                              <span className="ed-block-icon">{d.icon}</span>
                              <span className="ed-block-name">{b.settings.text || b.settings.label || b.settings.items || d.label}</span>
                              <span className="ed-block-type">{d.label}{b.settings.onlyIf ? " · conditional" : ""}</span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                    <div className="ed-add-wrap">
                      <button type="button" className="ed-btn wide" onClick={() => setAdding((v) => !v)} aria-expanded={adding}>+ Add block</button>
                      {adding && (
                        <div className="ed-popover" role="menu">
                          {Object.entries(EMAIL_BLOCK_TYPES).map(([type, d]) => (
                            <button key={type} type="button" role="menuitem" className="ed-pop-item" onClick={() => addBlock(type)}>
                              <span className="ed-block-icon">{d.icon}</span>{d.label}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                    <p className="ed-help">Drag to reorder, click a block to change its text and style.</p>
                    {varList}
                  </>
                )}

                {tab === "design" && (
                  <>
                    <div className="ed-section-title">Ready-made designs</div>
                    <div className="ed-tpls">
                      {Object.entries(EMAIL_PRESETS).map(([id, p]) => (
                        <div key={id} className="ed-tpl-wrap">
                          <button type="button" className="ed-tpl" onClick={() => applyPreset(id, false)} title={p.note}>
                            <span className="ed-tpl-art" style={{ background: p.theme.background, borderRadius: 10, borderColor: p.theme.cardBorder || "#e5e7eb", padding: 6, justifyContent: "flex-start" }}>
                              <span className="ed-tpl-card" style={{ background: p.theme.card, borderRadius: Math.min(p.theme.radius, 10) }}>
                                <span className="ed-tpl-head" style={{ background: p.styles.brand?.bg || p.theme.card }} />
                                <span className="ed-tpl-line" style={{ background: p.theme.heading, width: "55%", height: 5, border: 0 }} />
                                <span className="ed-tpl-btn" style={{ background: p.theme.brand, borderRadius: p.styles.button?.radius > 20 ? 99 : Math.min(p.styles.button?.radius ?? 8, 8) }} />
                              </span>
                            </span>
                            <span className="ed-tpl-name">{p.label}</span>
                          </button>
                          <button type="button" className="ed-linkbtn" onClick={() => applyPreset(id, true)}>Use for all emails</button>
                        </div>
                      ))}
                    </div>
                    <p className="ed-help">Picking a design rebuilds this email with its default wording in that style. Everything can still be changed block by block.</p>

                    <div className="ed-section-title">Colours</div>
                    <ColorField label="Brand (buttons, links)" value={draft.theme.brand} onChange={(v) => setTheme({ brand: v })} />
                    <ColorField label="Headings" value={draft.theme.heading} onChange={(v) => setTheme({ heading: v })} />
                    <ColorField label="Text" value={draft.theme.text} onChange={(v) => setTheme({ text: v })} />
                    <ColorField label="Muted text" value={draft.theme.muted} onChange={(v) => setTheme({ muted: v })} />
                    <ColorField label="Page background" value={draft.theme.background} onChange={(v) => setTheme({ background: v })} />
                    <ColorField label="Card background" value={draft.theme.card} onChange={(v) => setTheme({ card: v })} />
                    <OptionalColorField label="Card border" value={draft.theme.cardBorder} onChange={(v) => setTheme({ cardBorder: v })} />
                    <div className="ed-section-title">Shape &amp; type</div>
                    <RangeField label="Corner radius" value={draft.theme.radius} min={0} max={48} onChange={(v) => setTheme({ radius: v })} />
                    <RangeField label="Card width" value={draft.theme.width} min={360} max={700} onChange={(v) => setTheme({ width: v })} />
                    <RangeField label="Space around the card" value={draft.theme.pagePad} min={0} max={80} onChange={(v) => setTheme({ pagePad: v })} />
                    <RangeField label="Side spacing (all rows)" value={draft.theme.padX} min={0} max={100} onChange={(v) => setTheme({ padX: v })} />
                    <OptionalRangeField label="Space above & below every row" value={draft.theme.rowGap} min={0} max={80} onChange={(v) => setTheme({ rowGap: v })} />
                    <SelectField label="Font" value={draft.theme.font} options={FONT_LABELS} onChange={(v) => setTheme({ font: v })} />
                  </>
                )}

                {tab === "html" && (
                  <>
                    <div className="ed-seg ed-seg-block" role="group" aria-label="Email source">
                      <button type="button" className={draft.mode !== "html" ? "on" : ""} onClick={() => update((t) => ({ ...t, mode: "blocks" }))}>Blocks</button>
                      <button type="button" className={draft.mode === "html" ? "on" : ""} onClick={() => update((t) => ({ ...t, mode: "html", html: t.html || blocksToHtml(kind, t) }))}>Custom HTML</button>
                    </div>
                    {draft.mode === "html" ? (
                      <>
                        <Row label="Email HTML" help="A full HTML email. Use inline styles (email apps ignore most <style> blocks) and https:// images. Scripts and forms are removed.">
                          <textarea ref={htmlRef} className="ed-input ed-code ed-code-xl" spellCheck={false} value={draft.html} onChange={(e) => update((t) => ({ ...t, html: e.target.value }))} />
                        </Row>
                        <button type="button" className="ed-btn wide" onClick={() => window.confirm("Replace your HTML with one generated from your blocks and design?") && update((t) => ({ ...t, html: blocksToHtml(kind, t) }))}>
                          Regenerate from my blocks
                        </button>
                      </>
                    ) : (
                      <p className="ed-help">Switch to Custom HTML to write the whole email yourself. It starts from your current blocks, so you keep the look.</p>
                    )}
                    {varList}
                  </>
                )}

                <div className="ed-divider" />
                <div className="ed-section-title">Send a test</div>
                <Row label="Send to" help={data.smtp ? "Sends the draft above with sample data." : "SMTP isn't configured on the server."}>
                  <input className="ed-input" type="email" value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="you@example.com" />
                </Row>
                <button type="button" className="ed-btn wide" disabled={busy || !data.smtp || !testTo} onClick={() => send("test", { to: testTo })}>Send test email</button>
              </div>
            </div>
          )}
        </aside>

        <main className="ed-stage ed-stage-col">
          {section === "settings" ? (
            <div className="ed-note" style={{ maxWidth: 560 }}>
              <strong>Emails are sent for you</strong>
              <span>
                Points earned, reward codes and expiry reminders go out automatically from your own mailbox settings. Pick any email in the bar above to
                change how it looks, and send yourself a test.
              </span>
            </div>
          ) : (
            <>
              <div className="ed-subject"><span>Subject</span><strong>{preview.subject}</strong></div>
              <div className={`ed-mailframe ${device === "mobile" ? "mobile" : ""}`}>
                <iframe title="Email preview" sandbox="" srcDoc={preview.html} />
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  );
}
