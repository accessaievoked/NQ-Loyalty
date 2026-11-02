import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { requireStore } from "../services/auth.server";
import { getWidgetConfig } from "../services/store.server";
import { describeReward, earnLines, variableOf } from "../services/storefront.server";
import db from "../db.server";
import {
  AUDIENCES,
  BLOCK_STYLE_FIELDS,
  BLOCK_TYPES,
  FONTS,
  POSITIONS,
  HTML_VARIABLES,
  STARTER_HTML,
  missingTemplateBlocks,
  TEMPLATES,
  makeBlock,
  normalizeConfig,
} from "../lib/widget/defaults";
import WidgetPreview from "../components/WidgetPreview";
import { formatMoney } from "../lib/widget/render";
import { BlockField, ColorField, RangeField, Row, SelectField, StyleField, Toggle } from "../components/EditorControls";
import WidgetReference from "../components/WidgetReference";
import { ArrowLeft } from "../components/BackButton";
import "../styles/editor.css";

export const loader = async ({ request }) => {
  const { store } = await requireStore(request);
  const [rules, rewards] = await Promise.all([
    db.earnRule.findMany({ where: { storeId: store.id, active: true } }),
    db.reward.findMany({ where: { storeId: store.id, active: true }, orderBy: { pointsCost: "asc" } }),
  ]);
  return {
    shop: store.name || store.shop,
    config: getWidgetConfig(store.settings),
    displayMode: store.settings.displayMode,
    sample: {
      earn: earnLines(rules, store.settings, store.currency),
      rewards: rewards.map((r) => ({
        id: r.id,
        name: r.name,
        cost: r.pointsCost,
        description: describeReward(r, store.currency),
        variable: variableOf(r),
      })),
    },
    currency: store.currency,
  };
};

export const action = async ({ request }) => {
  const { store } = await requireStore(request);
  const form = await request.formData();
  let parsed;
  try {
    parsed = JSON.parse(String(form.get("config") || "{}"));
  } catch {
    return { ok: false, error: "Invalid configuration" };
  }
  const displayMode = form.get("displayMode") === "PAGE" ? "PAGE" : "WIDGET";
  // The developer source is stored in its own columns (see the Developer source page); the
  // preview includes it, but it must never be written into the visual config.
  delete parsed.dev;
  await db.storeSettings.update({
    where: { storeId: store.id },
    data: { widgetConfig: normalizeConfig(parsed), displayMode },
  });
  return { ok: true };
};

function TemplateTile({ id, tpl, active, onPick }) {
  const t = tpl.theme;
  return (
    <button type="button" className={`ed-tpl${active ? " active" : ""}`} onClick={() => onPick(id)}>
      <span className="ed-tpl-art" style={{ background: t.background, borderRadius: Math.min(t.radius, 12), borderColor: t.border }}>
        <span className="ed-tpl-head" style={{ background: t.headerStyle === "plain" ? t.border : t.primary }} />
        <span className="ed-tpl-line" style={{ background: t.surface, borderColor: t.border }} />
        <span className="ed-tpl-line short" style={{ background: t.surface, borderColor: t.border }} />
        <span className="ed-tpl-btn" style={{ background: t.primary, borderRadius: Math.min(t.radius, 8) }} />
      </span>
      <span className="ed-tpl-name">{tpl.label}</span>
    </button>
  );
}

// --- the editor -------------------------------------------------------------------------

export default function Editor() {
  const data = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();

  const [config, setConfig] = useState(data.config);
  const [mode, setMode] = useState(data.displayMode); // saved: WIDGET | PAGE
  const [view, setView] = useState(data.displayMode); // what the preview shows: WIDGET | PAGE | DRAWER
  const [savedKey, setSavedKey] = useState(() => JSON.stringify([data.config, data.displayMode]));
  const [tab, setTab] = useState("layout"); // layout | theme | launcher | code
  const [selectedId, setSelectedId] = useState(null);
  const [device, setDevice] = useState("desktop");
  const [viewer, setViewer] = useState("customer"); // customer | visitor
  const [adding, setAdding] = useState(false);
  const [drag, setDrag] = useState({ id: null, over: null, pos: "before" });

  // Undo/redo: snapshots of the config; edits to the same field within 800ms coalesce.
  const configRef = useRef(config);
  const past = useRef([]);
  const future = useRef([]);
  const last = useRef({ key: null, at: 0 });
  const [, bump] = useState(0);

  const apply = useCallback((updater, key) => {
    const prev = configRef.current;
    const next = updater(prev);
    if (next === prev) return;
    const now = Date.now();
    if (!(key && last.current.key === key && now - last.current.at < 800)) {
      past.current.push(prev);
      if (past.current.length > 100) past.current.shift();
    }
    last.current = { key, at: now };
    future.current = [];
    configRef.current = next;
    setConfig(next);
    bump((n) => n + 1);
  }, []);

  const undo = () => {
    const prev = past.current.pop();
    if (!prev) return;
    future.current.push(configRef.current);
    configRef.current = prev;
    last.current = { key: null, at: 0 };
    setConfig(prev);
    bump((n) => n + 1);
  };
  const redo = () => {
    const next = future.current.pop();
    if (!next) return;
    past.current.push(configRef.current);
    configRef.current = next;
    last.current = { key: null, at: 0 };
    setConfig(next);
    bump((n) => n + 1);
  };

  const dirty = JSON.stringify([config, mode]) !== savedKey;
  const saving = fetcher.state !== "idle";

  const save = useCallback(() => {
    const fd = new FormData();
    fd.set("config", JSON.stringify(configRef.current));
    fd.set("displayMode", mode);
    fetcher.submit(fd, { method: "POST" });
    setSavedKey(JSON.stringify([configRef.current, mode]));
  }, [fetcher, mode]);

  useEffect(() => {
    if (fetcher.data?.ok) shopify.toast.show("Saved — live on your storefront");
    if (fetcher.data && fetcher.data.ok === false) shopify.toast.show(fetcher.data.error || "Could not save", { isError: true });
  }, [fetcher.data, shopify]);

  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        e.shiftKey ? redo() : undo();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const selected = config.blocks.find((b) => b.id === selectedId) || null;

  // --- mutations
  const setTheme = (patch, key) => apply((c) => ({ ...c, theme: { ...c.theme, ...patch } }), key);
  const setAccount = (patch, key) => apply((c) => ({ ...c, account: { ...c.account, ...patch } }), key);
  // Style values: "" clears the key so the block inherits the theme again.
  const setStyle = (id, k, v) =>
    setBlock(
      id,
      (b) => {
        const style = { ...(b.style || {}) };
        if (v === "" || v === undefined || v === null) delete style[k];
        else style[k] = v;
        return { ...b, style };
      },
      `${id}.style.${k}`,
    );
  const setLauncher = (patch, key) => apply((c) => ({ ...c, launcher: { ...c.launcher, ...patch } }), key);
  const setBlock = (id, fn, key) =>
    apply((c) => ({ ...c, blocks: c.blocks.map((b) => (b.id === id ? fn(b) : b)) }), key);
  const setSetting = (id, k, v) =>
    setBlock(id, (b) => ({ ...b, settings: { ...b.settings, [k]: v } }), `${id}.${k}`);
  const removeBlock = (id) => {
    apply((c) => ({ ...c, blocks: c.blocks.filter((b) => b.id !== id) }));
    if (selectedId === id) setSelectedId(null);
  };
  const addBlock = (type) => {
    const block = makeBlock(type);
    apply((c) => {
      const idx = selectedId ? c.blocks.findIndex((b) => b.id === selectedId) : -1;
      const blocks = [...c.blocks];
      blocks.splice(idx >= 0 ? idx + 1 : blocks.length, 0, block);
      return { ...c, blocks };
    });
    setAdding(false);
    setSelectedId(block.id);
  };
  const moveBlock = (id, overId, pos) => {
    if (id === overId) return;
    apply((c) => {
      const blocks = c.blocks.filter((b) => b.id !== id);
      const moving = c.blocks.find((b) => b.id === id);
      let idx = blocks.findIndex((b) => b.id === overId);
      if (idx < 0 || !moving) return c;
      if (pos === "after") idx += 1;
      blocks.splice(idx, 0, moving);
      return { ...c, blocks };
    });
  };
  const applyTemplate = (id) =>
    apply((c) => ({ ...c, template: id, theme: { ...TEMPLATES[id].theme } }));

  // --- preview data
  const m = useCallback((n) => formatMoney(n, data.currency), [data.currency]); // sample text uses the store's own currency
  const state = useMemo(
    () => ({
      preview: true,
      shop: { name: data.shop, currency: data.currency },
      loggedIn: viewer === "customer",
      via: viewer === "customer" ? "otp" : null,
      customer:
        viewer === "customer"
          ? { firstName: "Alex", email: "alex@example.com", points: 1250, lifetime: 3400, expiring: { points: 200, date: "2026-12-15" } }
          : null,
      referral: {
        code: "ALEX7K2QX9",
        link: `https://${data.shop}/?ref=ALEX7K2QX9`,
        friendPoints: 100,
        referrerPoints: 200,
        invited: 3,
        rewarded: 1,
        earned: 200,
        canApply: true,
        applied: false,
      },
      earn: data.sample.earn.length
        ? data.sample.earn
        : [{ text: "Place an order", detail: `1 point for every ${m(1)} spent` }],
      rewards: data.sample.rewards.length
        ? data.sample.rewards
        : [
            { id: "x", name: `${m(5)} off your order`, cost: 500, description: `${m(5)} off` },
            { id: "y", name: "Use points at checkout", cost: 100, description: `${m(1)} for every 100 points`, variable: { step: 100, unitValue: 1, min: 100, max: 2000 } },
          ],
      coupons: [
        { code: "LOY-8F2A91C0DE", rewardName: "Use points at checkout (500 points)", status: "ACTIVE", expiresAt: "2026-12-01" },
        { code: "LOY-3B7D20A4C1", rewardName: `${m(5)} off your order`, status: "USED", expiresAt: "2026-11-02" },
      ],
      history: [
        { label: "Order #1042", points: 120, date: "2026-10-21", redeem: null },
        {
          label: "Reward redeemed · Use points at checkout (500 points)",
          points: -500,
          date: "2026-10-12",
          redeem: { code: "LOY-8F2A91C0DE", status: "ACTIVE", expiresAt: "2026-12-01" },
        },
        {
          label: `Reward redeemed · ${m(5)} off`,
          points: -500,
          date: "2026-10-02",
          redeem: { code: "LOY-3B7D20A4C1", status: "USED", expiresAt: "2026-11-02" },
        },
        { label: "Order #1031", points: 80, date: "2026-10-01", redeem: null },
        { label: "Order #1019", points: 45, date: "2026-09-28", redeem: null },
        { label: "Welcome bonus", points: 50, date: "2026-09-30", redeem: null },
      ],
    }),
    [data.sample, data.shop, data.currency, viewer, m],
  );

  const missing = missingTemplateBlocks(config);

  // Reference panel → drop a token/variable into the HTML template at the cursor.
  const htmlRef = useRef(null);
  const insertIntoHtml = (text) => {
    const at = htmlRef.current ? htmlRef.current.selectionStart : null;
    apply(
      (c) => {
        if (c.custom.mode !== "html") return c;
        const h = c.custom.html || "";
        const pos = at == null || at > h.length ? h.length : at;
        return { ...c, custom: { ...c.custom, html: `${h.slice(0, pos)}${text}${h.slice(pos)}` } };
      },
      `insert-${Date.now()}`,
    );
  };
  const mobile = device === "mobile";
  const def = selected ? BLOCK_TYPES[selected.type] : null;

  return (
    <div className="ed">
      {/* top bar */}
      <header className="ed-top">
        <div className="ed-top-left">
          <Link to="/app" replace className="ed-back" aria-label="Back to home">
            <ArrowLeft />
          </Link>
          <div>
            <div className="ed-title">Storefront editor</div>
            <div className="ed-sub">{dirty ? "Unsaved changes" : "All changes saved"}</div>
          </div>
        </div>

        <div className="ed-top-center">
          <div className="ed-seg" role="group" aria-label="Display">
            <button type="button" className={view === "WIDGET" ? "on" : ""} onClick={() => { setMode("WIDGET"); setView("WIDGET"); }}>
              Floating widget
            </button>
            <button type="button" className={view === "PAGE" ? "on" : ""} onClick={() => { setMode("PAGE"); setView("PAGE"); }}>
              Rewards page
            </button>
            <button type="button" className={view === "DRAWER" ? "on" : ""} onClick={() => setView("DRAWER")} title="The side drawer opened by the My Rewards tab (preview only)">
              Account drawer
            </button>
          </div>
          <div className="ed-seg" role="group" aria-label="Device">
            <button type="button" className={device === "desktop" ? "on" : ""} onClick={() => setDevice("desktop")}>
              Desktop
            </button>
            <button type="button" className={device === "mobile" ? "on" : ""} onClick={() => setDevice("mobile")}>
              Mobile
            </button>
          </div>
          <div className="ed-seg" role="group" aria-label="Viewer">
            <button type="button" className={viewer === "customer" ? "on" : ""} onClick={() => setViewer("customer")}>
              Logged in
            </button>
            <button type="button" className={viewer === "visitor" ? "on" : ""} onClick={() => setViewer("visitor")}>
              Visitor
            </button>
          </div>
        </div>

        <div className="ed-top-right">
          <button type="button" className="ed-icon-btn" onClick={undo} disabled={!past.current.length} title="Undo (Ctrl+Z)">
            ↶
          </button>
          <button type="button" className="ed-icon-btn" onClick={redo} disabled={!future.current.length} title="Redo (Ctrl+Shift+Z)">
            ↷
          </button>
          <button type="button" className="ed-btn primary" onClick={save} disabled={!dirty || saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </header>

      <div className="ed-main">
        {/* sidebar */}
        <aside className="ed-side">
          {selected ? (
            <div className="ed-pane">
              <div className="ed-pane-head">
                <button type="button" className="ed-back" onClick={() => setSelectedId(null)} aria-label="Back to layout">
                  <ArrowLeft />
                </button>
                <div>
                  <div className="ed-pane-title">{def.label}</div>
                  <div className="ed-sub">Block settings</div>
                </div>
              </div>
              <div className="ed-pane-body">
                {def.fields.map((f) => (
                  <BlockField key={f.key} def={f} value={selected.settings[f.key]} onChange={(v) => setSetting(selected.id, f.key, v)} />
                ))}
                <div className="ed-divider" />
                <SelectField
                  label="Show to"
                  value={selected.settings.audience}
                  options={AUDIENCES}
                  onChange={(v) => setSetting(selected.id, "audience", v)}
                />
                <Toggle label="Visible" checked={selected.visible} onChange={(v) => setBlock(selected.id, (b) => ({ ...b, visible: v }))} />
                <div className="ed-divider" />
                <div className="ed-section-title">Style</div>
                <p className="ed-help">Colours, spacing and text for just this block. Anything left on “theme default” follows your Theme tab.</p>
                {BLOCK_STYLE_FIELDS.map((f) => (
                  <StyleField
                    key={f.key}
                    def={f}
                    value={selected.style?.[f.key]}
                    onChange={(v) => setStyle(selected.id, f.key, v)}
                  />
                ))}
                {selected.style && Object.keys(selected.style).length > 0 && (
                  <button type="button" className="ed-btn wide" onClick={() => setBlock(selected.id, (b) => ({ ...b, style: {} }))}>
                    Reset this block's style
                  </button>
                )}
                <div className="ed-divider" />
                <button type="button" className="ed-btn danger wide" onClick={() => removeBlock(selected.id)}>
                  Remove block
                </button>
              </div>
            </div>
          ) : (
            <div className="ed-pane">
              <div className="ed-tabs" role="tablist">
                {[
                  ["layout", "Layout"],
                  ["theme", "Theme"],
                  ["launcher", "Launcher"],
                  ["code", "Code"],
                ].map(([id, label]) => (
                  <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? "on" : ""} onClick={() => setTab(id)}>
                    {label}
                  </button>
                ))}
              </div>

              <div className="ed-pane-body">
                {config.dev && (
                  <div className="ed-note" role="status">
                    <strong>Developer source is live.</strong> Your custom CSS / HTML shell is being used, so Theme and
                    Launcher style settings won't change how it looks. Block content and wording still apply.
                    <Link to="/app/developer" className="ed-btn wide" style={{ textAlign: "center", textDecoration: "none" }}>
                      Open developer source
                    </Link>
                  </div>
                )}
                {tab === "layout" && (
                  <>
                    <div className="ed-section-title">Blocks</div>
                    <ul className="ed-blocks">
                      {config.blocks.map((b) => {
                        const d = BLOCK_TYPES[b.type];
                        const cls = [
                          "ed-block",
                          b.visible ? "" : "hidden",
                          drag.id === b.id ? "dragging" : "",
                          drag.over === b.id ? `over-${drag.pos}` : "",
                        ].join(" ");
                        return (
                          <li
                            key={b.id}
                            className={cls}
                            draggable
                            onDragStart={(e) => {
                              e.dataTransfer.effectAllowed = "move";
                              e.dataTransfer.setData("text/plain", b.id);
                              setDrag({ id: b.id, over: null, pos: "before" });
                            }}
                            onDragOver={(e) => {
                              e.preventDefault();
                              if (!drag.id || drag.id === b.id) return;
                              const r = e.currentTarget.getBoundingClientRect();
                              const pos = e.clientY - r.top > r.height / 2 ? "after" : "before";
                              if (drag.over !== b.id || drag.pos !== pos) setDrag((s) => ({ ...s, over: b.id, pos }));
                            }}
                            onDrop={(e) => {
                              e.preventDefault();
                              if (drag.id) moveBlock(drag.id, b.id, drag.pos);
                              setDrag({ id: null, over: null, pos: "before" });
                            }}
                            onDragEnd={() => setDrag({ id: null, over: null, pos: "before" })}
                          >
                            <span className="ed-grip" aria-hidden>
                              ⋮⋮
                            </span>
                            <button type="button" className="ed-block-main" onClick={() => setSelectedId(b.id)}>
                              <span className="ed-block-icon">{d.icon}</span>
                              <span className="ed-block-name">{b.settings.title || b.settings.label || d.label}</span>
                              <span className="ed-block-type">{d.label}</span>
                            </button>
                            <button
                              type="button"
                              className="ed-icon-btn sm"
                              title={b.visible ? "Hide" : "Show"}
                              onClick={() => setBlock(b.id, (x) => ({ ...x, visible: !x.visible }))}
                            >
                              {b.visible ? "◉" : "◌"}
                            </button>
                          </li>
                        );
                      })}
                    </ul>

                    <div className="ed-add-wrap">
                      <button type="button" className="ed-btn wide" onClick={() => setAdding((v) => !v)} aria-expanded={adding}>
                        + Add block
                      </button>
                      {adding && (
                        <div className="ed-popover" role="menu">
                          {Object.entries(BLOCK_TYPES).map(([type, d]) => (
                            <button key={type} type="button" role="menuitem" className="ed-pop-item" onClick={() => addBlock(type)}>
                              <span className="ed-block-icon">{d.icon}</span>
                              {d.label}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                    <p className="ed-help">Drag to reorder. Click a block (here or in the preview) to edit it.</p>
                  </>
                )}

                {tab === "theme" && (
                  <>
                    <div className="ed-section-title">Templates</div>
                    <div className="ed-tpls">
                      {Object.entries(TEMPLATES).map(([id, tpl]) => (
                        <TemplateTile key={id} id={id} tpl={tpl} active={config.template === id} onPick={applyTemplate} />
                      ))}
                    </div>
                    <p className="ed-help">Picking a template resets the colours and shape below. Your blocks stay as they are.</p>

                    <div className="ed-section-title">Colours</div>
                    <ColorField label="Primary" value={config.theme.primary} onChange={(v) => setTheme({ primary: v }, "primary")} />
                    <ColorField label="Text on primary" value={config.theme.primaryText} onChange={(v) => setTheme({ primaryText: v }, "primaryText")} />
                    <ColorField label="Background" value={config.theme.background} onChange={(v) => setTheme({ background: v }, "background")} />
                    <ColorField label="Cards" value={config.theme.surface} onChange={(v) => setTheme({ surface: v }, "surface")} />
                    <ColorField label="Text" value={config.theme.text} onChange={(v) => setTheme({ text: v }, "text")} />
                    <ColorField label="Muted text" value={config.theme.mutedText} onChange={(v) => setTheme({ mutedText: v }, "mutedText")} />
                    <ColorField label="Borders" value={config.theme.border} onChange={(v) => setTheme({ border: v }, "border")} />

                    <div className="ed-section-title">Shape &amp; type</div>
                    <RangeField label="Corner radius" value={config.theme.radius} min={0} max={32} onChange={(v) => setTheme({ radius: v }, "radius")} />
                    <SelectField label="Font" value={config.theme.font} options={Object.fromEntries(Object.entries(FONTS).map(([k, v]) => [k, v.label]))} onChange={(v) => setTheme({ font: v })} />
                    <SelectField
                      label="Header style"
                      value={config.theme.headerStyle}
                      options={{ solid: "Solid", gradient: "Gradient", plain: "Plain" }}
                      onChange={(v) => setTheme({ headerStyle: v })}
                    />
                    <SelectField
                      label="Spacing"
                      value={config.theme.density}
                      options={{ comfortable: "Comfortable", compact: "Compact" }}
                      onChange={(v) => setTheme({ density: v })}
                    />
                    <Toggle label="Drop shadow" checked={config.theme.shadow} onChange={(v) => setTheme({ shadow: v })} />
                    <Toggle label="Hide scrollbars (still scrollable)" checked={config.theme.hideScrollbars} onChange={(v) => setTheme({ hideScrollbars: v })} />
                  </>
                )}

                {tab === "launcher" && (
                  <>
                    <div className="ed-section-title">Button</div>
                    <SelectField label="Style" value={config.launcher.style} options={{ pill: "Pill with label", circle: "Round icon" }} onChange={(v) => setLauncher({ style: v })} />
                    <Row label="Label">
                      <input className="ed-input" value={config.launcher.label} onChange={(e) => setLauncher({ label: e.target.value }, "label")} />
                    </Row>
                    <Row label="Icon" help="Any emoji or short character.">
                      <input className="ed-input" value={config.launcher.icon} onChange={(e) => setLauncher({ icon: e.target.value }, "icon")} />
                    </Row>

                    <div className="ed-section-title">Position</div>
                    <SelectField label="Corner" value={config.launcher.position} options={POSITIONS} onChange={(v) => setLauncher({ position: v })} />
                    <RangeField label="Horizontal offset" value={config.launcher.offsetX} min={0} max={120} onChange={(v) => setLauncher({ offsetX: v }, "ox")} />
                    <RangeField label="Vertical offset" value={config.launcher.offsetY} min={0} max={120} onChange={(v) => setLauncher({ offsetY: v }, "oy")} />
                    <RangeField label="Panel width" value={config.launcher.panelWidth} min={300} max={520} onChange={(v) => setLauncher({ panelWidth: v }, "pw")} />

                    <div className="ed-section-title">Visibility</div>
                    <SelectField
                      label="Show on"
                      value={config.launcher.visibility}
                      options={{ all: "Desktop and mobile", desktop: "Desktop only", mobile: "Mobile only" }}
                      onChange={(v) => setLauncher({ visibility: v })}
                    />
                    <Toggle label="Full-screen panel on mobile" checked={config.launcher.mobileFullscreen} onChange={(v) => setLauncher({ mobileFullscreen: v })} />

                    <div className="ed-section-title">Account page tab</div>
                    <p className="ed-help">
                      Adds a “My Rewards” entry to your customer account menu. It opens your rewards in a side drawer, and shoppers are already logged in, so there's no extra sign-in.
                    </p>
                    <Toggle label="Add the tab automatically" checked={config.account.tab} onChange={(v) => setAccount({ tab: v })} />
                    <Row label="Tab label">
                      <input className="ed-input" value={config.account.label} onChange={(e) => setAccount({ label: e.target.value }, "alabel")} />
                    </Row>
                    <Row label="Tab icon" help="An emoji or short character.">
                      <input className="ed-input" value={config.account.icon} onChange={(e) => setAccount({ icon: e.target.value }, "aicon")} />
                    </Row>
                    <RangeField label="Drawer width" value={config.account.drawerWidth} min={320} max={560} onChange={(v) => setAccount({ drawerWidth: v }, "adw")} />
                    <Row label="Menu selector (optional)" help="Only if the tab doesn't appear: a CSS selector for your account menu, like .account-nav. The tab is added before its last item.">
                      <input className="ed-input" value={config.account.selector} onChange={(e) => setAccount({ selector: e.target.value }, "asel")} placeholder=".account-nav" spellCheck={false} />
                    </Row>
                    <p className="ed-help">
                      Prefer your own link? Add a menu item (or any button) that links to <code>#loyalty</code>, or give it the attribute <code>data-loyalty-open</code>, and it opens the same drawer.
                    </p>
                  </>
                )}

                {tab === "code" && (
                  <>
                    <div className="ed-section-title">Layout source</div>
                    <div className="ed-seg ed-seg-block" role="group" aria-label="Layout source">
                      <button
                        type="button"
                        className={config.custom.mode !== "html" ? "on" : ""}
                        onClick={() => apply((c) => ({ ...c, custom: { ...c.custom, mode: "blocks" } }))}
                      >
                        Blocks
                      </button>
                      <button
                        type="button"
                        className={config.custom.mode === "html" ? "on" : ""}
                        onClick={() =>
                          apply((c) => ({
                            ...c,
                            custom: { ...c.custom, mode: "html", html: c.custom.html || STARTER_HTML },
                          }))
                        }
                      >
                        Custom HTML
                      </button>
                    </div>
                    {config.custom.mode === "html" ? (
                      <>
                        <Row
                          label="Template HTML"
                          help={`Variables: ${HTML_VARIABLES.join(" ")}. Use {{block:redeem}}, {{block:login}}, {{block:balance}}, {{block:referral}}, {{block:coupons}}, {{block:history}}, {{block:account}} to drop in working blocks. Scripts are removed.`}
                        >
                          <textarea
                            ref={htmlRef}
                            className="ed-input ed-code"
                            rows={16}
                            spellCheck={false}
                            value={config.custom.html}
                            onChange={(e) => apply((c) => ({ ...c, custom: { ...c.custom, html: e.target.value } }), "html")}
                          />
                        </Row>
                        {missing.length > 0 && (
                          <div className="ed-note" role="status">
                            <strong>Not in your template yet:</strong> {missing.map((t) => BLOCK_TYPES[t].label).join(", ")}.
                            In Custom HTML mode only blocks you place with <code>{"{{block:name}}"}</code> are shown to shoppers.
                            <button
                              type="button"
                              className="ed-btn wide"
                              onClick={() =>
                                apply((c) => ({
                                  ...c,
                                  custom: { ...c.custom, html: `${c.custom.html.trimEnd()}\n${missingTemplateBlocks(c).map((t) => `{{block:${t}}}`).join("\n")}` },
                                }))
                              }
                            >
                              Add them to the template
                            </button>
                          </div>
                        )}
                        <button
                          type="button"
                          className="ed-btn wide"
                          onClick={() => apply((c) => ({ ...c, custom: { ...c.custom, html: STARTER_HTML } }))}
                        >
                          Reset to starter template
                        </button>
                      </>
                    ) : (
                      <p className="ed-help">Blocks mode uses the block list in the Layout tab. Switch to Custom HTML to write the whole layout yourself.</p>
                    )}

                    <div className="ed-section-title">Custom CSS</div>
                    <Row
                      label="Styles"
                      help="Applied inside the widget only, so it can't leak into your theme. Hooks: .lw-launcher, .lw-panel, .lw-header, .lw-card, .lw-title, .lw-btn, .lw-balance-num."
                    >
                      <textarea
                        className="ed-input ed-code"
                        rows={14}
                        spellCheck={false}
                        placeholder={".lw-card { border-style: dashed; }"}
                        value={config.custom.css}
                        onChange={(e) => apply((c) => ({ ...c, custom: { ...c.custom, css: e.target.value } }), "css")}
                      />
                    </Row>
                    <p className="ed-help">
                      Need raw HTML? Add a <strong>Custom HTML</strong> block in Layout, or switch Layout source to Custom HTML above.
                    </p>

                    <div className="ed-section-title">Reference</div>
                    <WidgetReference htmlMode={config.custom.mode === "html"} onInsert={insertIntoHtml} />

                    <div className="ed-section-title">Total control</div>
                    <p className="ed-help">
                      Want to edit the full generated HTML and CSS (with a safe rollback)? Use the developer source page.
                    </p>
                    <Link to="/app/developer" className="ed-btn wide" style={{ textAlign: "center", textDecoration: "none" }}>
                      Open developer source
                    </Link>
                  </>
                )}
              </div>
            </div>
          )}
        </aside>

        {/* preview */}
        <main className="ed-stage">
          <div className={`ed-device ${mobile ? "mobile" : "desktop"}`}>
            {!mobile && (
              <div className="ed-chrome">
                <i />
                <i />
                <i />
                <span>{data.shop}</span>
              </div>
            )}
            <div className="ed-screen">
              <div className="ed-mock" aria-hidden>
                <div className="ed-mock-nav" />
                <div className="ed-mock-hero" />
                <div className="ed-mock-grid">
                  <span />
                  <span />
                  <span />
                  <span />
                </div>
              </div>
              <WidgetPreview
                key={`${view}-${mobile}`}
                config={config}
                state={state}
                mode={view}
                mobile={mobile}
                selectedId={selectedId}
                onSelect={(id) => setSelectedId(id)}
              />
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
