import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { requireStore } from "../services/auth.server";
import {
  isKind,
  listEmailTemplates,
  resetEmailTemplate,
  saveEmailTemplate,
} from "../services/emailtemplates.server";
import { sendTemplateTest, smtpConfigured } from "../services/mailer.server";
import { normalizeEmailTemplate } from "../lib/email/templates";
import {
  EMAIL_BLOCK_TYPES,
  EMAIL_KINDS,
  FONT_STACKS,
  blocksToHtml,
  defaultEmailTemplate,
  makeEmailBlock,
  renderEmail,
} from "../lib/email/templates";
import { BlockField, ColorField, Row, SelectField, RangeField } from "../components/EditorControls";
import "../styles/editor.css";

export const loader = async ({ request }) => {
  const { store } = await requireStore(request);
  return {
    shop: store.name || store.shop,
    storeEmail: store.email || "",
    smtp: smtpConfigured(),
    templates: await listEmailTemplates(store.id),
  };
};

export const action = async ({ request }) => {
  const { store } = await requireStore(request);
  const f = await request.formData();
  const intent = String(f.get("intent"));
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
      await sendTemplateTest({ store, kind, template: normalizeEmailTemplate(kind, template), to });
      return { ok: true, intent, kind, message: `Test sent to ${to}` };
    } catch (e) {
      return { ok: false, errors: [`Couldn't send: ${e.message}`] };
    }
  }
  return { ok: false, errors: ["Unknown action"] };
};

export default function Emails() {
  const data = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();

  const [drafts, setDrafts] = useState(() => Object.fromEntries(data.templates.map((t) => [t.kind, t.template])));
  const [saved, setSaved] = useState(() => Object.fromEntries(data.templates.map((t) => [t.kind, JSON.stringify(t.template)])));
  const [custom, setCustom] = useState(() => Object.fromEntries(data.templates.map((t) => [t.kind, t.customised])));
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
  const selected = draft.blocks.find((b) => b.id === selectedId) || null;

  // React to the server's answer to save / reset / test
  useEffect(() => {
    const d = fetcher.data;
    if (!d) return;
    if (d.ok) {
      shopify.toast.show(d.message || "Done");
      if (d.intent === "save") {
        setSaved((s) => ({ ...s, [d.kind]: JSON.stringify(drafts[d.kind]) }));
        setCustom((c) => ({ ...c, [d.kind]: true }));
      }
      if (d.intent === "reset") {
        const fresh = defaultEmailTemplate(d.kind);
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

  const VarList = () => (
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
          <Link to="/app/settings" className="ed-back" aria-label="Back">←</Link>
          <div>
            <div className="ed-title">Email templates</div>
            <div className="ed-sub">{dirty ? "Unsaved changes" : custom[kind] ? "Customised" : "Using the default"}</div>
          </div>
        </div>
        <div className="ed-top-center">
          <div className="ed-seg" role="group" aria-label="Email">
            {Object.entries(EMAIL_KINDS).map(([k, v]) => (
              <button key={k} type="button" className={kind === k ? "on" : ""} onClick={() => { setKind(k); setSelectedId(null); }}>
                {v.label}
                {JSON.stringify(drafts[k]) !== saved[k] ? " •" : ""}
              </button>
            ))}
          </div>
          <div className="ed-seg" role="group" aria-label="Device">
            <button type="button" className={device === "desktop" ? "on" : ""} onClick={() => setDevice("desktop")}>Desktop</button>
            <button type="button" className={device === "mobile" ? "on" : ""} onClick={() => setDevice("mobile")}>Mobile</button>
          </div>
        </div>
        <div className="ed-top-right">
          <button type="button" className="ed-btn" disabled={busy || !custom[kind]} onClick={() => window.confirm("Throw away your changes to this email and use the default?") && send("reset")}>
            Reset to default
          </button>
          <button type="button" className="ed-btn primary" disabled={busy || !dirty} onClick={() => send("save")}>
            {busy ? "Working…" : "Save"}
          </button>
        </div>
      </header>

      <div className="ed-main">
        <aside className="ed-side">
          {selected ? (
            <div className="ed-pane">
              <div className="ed-pane-head">
                <button type="button" className="ed-back" onClick={() => setSelectedId(null)} aria-label="Back to blocks">←</button>
                <div>
                  <div className="ed-pane-title">{def.label}</div>
                  <div className="ed-sub">Block settings</div>
                </div>
              </div>
              <div className="ed-pane-body">
                {def.fields.map((f) => (
                  <BlockField key={f.key} def={f} value={selected.settings[f.key]} onChange={(v) => setBlock(selected.id, (b) => ({ ...b, settings: { ...b.settings, [f.key]: v } }))} />
                ))}
                <div className="ed-divider" />
                <SelectField
                  label="Show this block"
                  value={selected.settings.onlyIf || ""}
                  options={varOptions}
                  onChange={(v) => setBlock(selected.id, (b) => ({ ...b, settings: { ...b.settings, onlyIf: v } }))}
                />
                <button type="button" className="ed-btn danger wide" onClick={() => { update((t) => ({ ...t, blocks: t.blocks.filter((b) => b.id !== selected.id) })); setSelectedId(null); }}>
                  Remove block
                </button>
                <VarList />
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
                              <span className="ed-block-name">{b.settings.text || b.settings.label || d.label}</span>
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
                    <p className="ed-help">Drag to reorder. Click a block to edit it.</p>
                    <VarList />
                  </>
                )}

                {tab === "design" && (
                  <>
                    <div className="ed-section-title">Colours</div>
                    <ColorField label="Brand (buttons)" value={draft.theme.brand} onChange={(v) => setTheme({ brand: v })} />
                    <ColorField label="Headings" value={draft.theme.heading} onChange={(v) => setTheme({ heading: v })} />
                    <ColorField label="Text" value={draft.theme.text} onChange={(v) => setTheme({ text: v })} />
                    <ColorField label="Muted text" value={draft.theme.muted} onChange={(v) => setTheme({ muted: v })} />
                    <ColorField label="Page background" value={draft.theme.background} onChange={(v) => setTheme({ background: v })} />
                    <ColorField label="Card background" value={draft.theme.card} onChange={(v) => setTheme({ card: v })} />
                    <div className="ed-section-title">Shape &amp; type</div>
                    <RangeField label="Corner radius" value={draft.theme.radius} min={0} max={32} onChange={(v) => setTheme({ radius: v })} />
                    <RangeField label="Width" value={draft.theme.width} min={360} max={700} onChange={(v) => setTheme({ width: v })} />
                    <SelectField label="Font" value={draft.theme.font} options={{ system: "Sans-serif", serif: "Serif", mono: "Monospace" }} onChange={(v) => setTheme({ font: FONT_STACKS[v] ? v : "system" })} />
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
                    <VarList />
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
          <div className="ed-subject"><span>Subject</span><strong>{preview.subject}</strong></div>
          <div className={`ed-mailframe ${device === "mobile" ? "mobile" : ""}`}>
            <iframe title="Email preview" sandbox="" srcDoc={preview.html} />
          </div>
        </main>
      </div>
    </div>
  );
}
