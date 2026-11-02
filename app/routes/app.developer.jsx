import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { requireStore } from "../services/auth.server";
import {
  disableDevSource,
  getDevSource,
  markWorking,
  revertToLastWorking,
  revertToPrevious,
  saveDevSource,
} from "../services/devsource.server";
import { describeReward, earnLines, variableOf } from "../services/storefront.server";
import db from "../db.server";
import WidgetPreview from "../components/WidgetPreview";
import { formatMoney } from "../lib/widget/render";
import WidgetReference from "../components/WidgetReference";
import { ArrowLeft } from "../components/BackButton";
import "../styles/editor.css";

export const loader = async ({ request }) => {
  const { store } = await requireStore(request);
  const [source, rules, rewards] = await Promise.all([
    getDevSource(store.id),
    db.earnRule.findMany({ where: { storeId: store.id, active: true } }),
    db.reward.findMany({ where: { storeId: store.id, active: true }, orderBy: { pointsCost: "asc" } }),
  ]);
  return {
    shop: store.name || store.shop,
    currency: store.currency,
    source,
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
  };
};

export const action = async ({ request }) => {
  const { store } = await requireStore(request);
  const f = await request.formData();
  const intent = String(f.get("intent"));
  let result;
  if (intent === "save") {
    result = await saveDevSource(store.id, {
      css: String(f.get("css") ?? ""),
      shell: String(f.get("shell") ?? ""),
      pageShell: String(f.get("pageShell") ?? ""),
      enabled: true,
    });
    if (result.ok) result.message = "Published. Check your storefront, then mark it as working.";
  } else if (intent === "mark-working") {
    result = await markWorking(store.id);
    if (result.ok) result.message = "Saved as your last working copy.";
  } else if (intent === "revert-good") {
    result = await revertToLastWorking(store.id);
    if (result.ok) result.message = "Reverted to your last working copy.";
  } else if (intent === "revert-previous") {
    result = await revertToPrevious(store.id);
    if (result.ok) result.message = "Restored the version before your last save.";
  } else if (intent === "disable") {
    result = await disableDevSource(store.id);
    if (result.ok) result.message = "Switched back to the visual editor. Your code is kept.";
  } else {
    result = { ok: false, errors: ["Unknown action"] };
  }
  return result;
};

const when = (iso) => (iso ? new Date(iso).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "never");

export default function Developer() {
  const data = useLoaderData();
  const { source } = data;
  const fetcher = useFetcher();
  const shopify = useAppBridge();

  // Textareas start from the saved source, or from the generated code if nothing is saved yet.
  const hasSaved = !!(source.css || source.shell || source.pageShell);
  const [css, setCss] = useState(source.css || source.generated.css);
  const [shell, setShell] = useState(source.shell || source.generated.shell);
  const [pageShell, setPageShell] = useState(source.pageShell || source.generated.pageShell);
  const [tab, setTab] = useState("shell"); // shell | page | css | help
  const [mode, setMode] = useState(source.displayMode === "PAGE" ? "PAGE" : "WIDGET");
  const [device, setDevice] = useState("desktop");
  const [viewer, setViewer] = useState("customer");

  // Re-sync after the server changes what's live (revert, undo…).
  const liveKey = `${source.updatedAt}|${source.enabled}`;
  const seen = useRef(liveKey);
  useEffect(() => {
    if (seen.current !== liveKey) {
      seen.current = liveKey;
      if (source.css || source.shell || source.pageShell) {
        setCss(source.css || source.generated.css);
        setShell(source.shell || source.generated.shell);
        setPageShell(source.pageShell || source.generated.pageShell);
      }
    }
  }, [liveKey, source]);

  const savedKey = JSON.stringify([source.css || source.generated.css, source.shell || source.generated.shell, source.pageShell || source.generated.pageShell]);
  const dirty = JSON.stringify([css, shell, pageShell]) !== savedKey || (!hasSaved);
  const busy = fetcher.state !== "idle";
  const errors = fetcher.data && fetcher.data.ok === false ? fetcher.data.errors : [];

  useEffect(() => {
    if (fetcher.data?.ok) shopify.toast.show(fetcher.data.message || "Done");
    if (fetcher.data?.ok === false) shopify.toast.show("Couldn't save — see the messages on the left", { isError: true });
  }, [fetcher.data, shopify]);

  const submit = useCallback(
    (intent, extra = {}) => {
      const fd = new FormData();
      fd.set("intent", intent);
      for (const [k, v] of Object.entries(extra)) fd.set(k, v);
      fetcher.submit(fd, { method: "POST" });
    },
    [fetcher],
  );

  const save = () => submit("save", { css, shell, pageShell });
  const confirmThen = (message, fn) => () => {
    if (window.confirm(message)) fn();
  };

  const regenerate = confirmThen("Replace the code below with freshly generated code from your visual editor settings? Your current edits here will be lost.", () => {
    setCss(source.generated.css);
    setShell(source.generated.shell);
    setPageShell(source.generated.pageShell);
  });

  // Insert from the reference panel into whichever code box is showing
  const areaRef = useRef(null);
  const insert = (text) => {
    const ta = areaRef.current;
    const set = tab === "page" ? setPageShell : tab === "css" ? setCss : setShell;
    const cur = tab === "page" ? pageShell : tab === "css" ? css : shell;
    const at = ta ? ta.selectionStart : cur.length;
    set(`${cur.slice(0, at)}${text}${cur.slice(at)}`);
  };

  // Tab key inserts two spaces instead of leaving the box.
  const onKeyDown = (set) => (e) => {
    if (e.key === "Tab" && !e.shiftKey) {
      e.preventDefault();
      const ta = e.currentTarget;
      const { selectionStart: s, selectionEnd: en, value } = ta;
      set(`${value.slice(0, s)}  ${value.slice(en)}`);
      requestAnimationFrame(() => ta.setSelectionRange(s + 2, s + 2));
    }
  };

  // Preview with the draft code (not yet published)
  const config = useMemo(
    () => ({ ...source.visual, dev: { css, shell, pageShell } }),
    [source.visual, css, shell, pageShell],
  );
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
      referral: { code: "ALEX7K2QX9", link: `https://${data.shop}/?ref=ALEX7K2QX9`, friendPoints: 100, referrerPoints: 200, invited: 3, rewarded: 1, earned: 200, canApply: true, applied: false },
      earn: data.sample.earn.length ? data.sample.earn : [{ text: "Place an order", detail: `1 point for every ${m(1)} spent` }],
      rewards: data.sample.rewards.length
        ? data.sample.rewards
        : [{ id: "y", name: "Use points at checkout", cost: 100, description: `${m(1)} for every 100 points`, variable: { step: 100, unitValue: 1, min: 100, max: 2000 } }],
      coupons: [
        { code: "LOY-8F2A91C0DE", rewardName: "Use points at checkout (500 points)", status: "ACTIVE", expiresAt: "2026-12-01" },
        { code: "LOY-3B7D20A4C1", rewardName: `${m(5)} off your order`, status: "USED", expiresAt: "2026-11-02" },
      ],
      history: [
        { label: "Order #1042", points: 120, date: "2026-10-21", redeem: null },
        { label: `Reward redeemed · ${m(5)} off`, points: -500, date: "2026-10-12", redeem: { code: "LOY-8F2A91C0DE", status: "ACTIVE", expiresAt: "2026-12-01" } },
      ],
    }),
    [data, viewer, m],
  );
  const mobile = device === "mobile";

  const current = tab === "page" ? { v: pageShell, set: setPageShell, label: "Page HTML shell" } : tab === "css" ? { v: css, set: setCss, label: "Compiled CSS" } : { v: shell, set: setShell, label: "Widget HTML shell" };

  return (
    <div className="ed">
      <header className="ed-top">
        <div className="ed-top-left">
          <Link to="/app" replace className="ed-back" aria-label="Back to home">
            <ArrowLeft />
          </Link>
          <div>
            <div className="ed-title">Developer source</div>
            <div className="ed-sub">
              {source.enabled ? "Live on your storefront" : "Not live — the visual editor is in use"}
              {dirty ? " · unpublished edits" : ""}
            </div>
          </div>
        </div>

        <div className="ed-top-center">
          <div className="ed-seg" role="group" aria-label="Display">
            <button type="button" className={mode === "WIDGET" ? "on" : ""} onClick={() => setMode("WIDGET")}>Floating widget</button>
            <button type="button" className={mode === "PAGE" ? "on" : ""} onClick={() => setMode("PAGE")}>Rewards page</button>
          </div>
          <div className="ed-seg" role="group" aria-label="Device">
            <button type="button" className={device === "desktop" ? "on" : ""} onClick={() => setDevice("desktop")}>Desktop</button>
            <button type="button" className={device === "mobile" ? "on" : ""} onClick={() => setDevice("mobile")}>Mobile</button>
          </div>
          <div className="ed-seg" role="group" aria-label="Viewer">
            <button type="button" className={viewer === "customer" ? "on" : ""} onClick={() => setViewer("customer")}>Logged in</button>
            <button type="button" className={viewer === "visitor" ? "on" : ""} onClick={() => setViewer("visitor")}>Visitor</button>
          </div>
        </div>

        <div className="ed-top-right">
          <button type="button" className="ed-btn primary" onClick={save} disabled={busy}>
            {busy ? "Working…" : source.enabled ? "Save & publish" : "Publish"}
          </button>
        </div>
      </header>

      <div className="ed-main">
        <aside className="ed-side ed-side-wide">
          <div className="ed-pane">
            <div className="ed-tabs" role="tablist">
              {[["shell", "Widget HTML"], ["page", "Page HTML"], ["css", "CSS"], ["help", "Reference"]].map(([id, label]) => (
                <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? "on" : ""} onClick={() => setTab(id)}>
                  {label}
                </button>
              ))}
            </div>

            <div className="ed-pane-body">
              {errors.length > 0 && (
                <div className="ed-note ed-note-error" role="alert">
                  <strong>Not published — please fix:</strong>
                  <ul>{errors.map((e) => <li key={e}>{e}</li>)}</ul>
                </div>
              )}

              {tab !== "help" && (
                <>
                  <p className="ed-help">
                    {tab === "css"
                      ? "The complete stylesheet, generated from your visual settings. Edit anything. Your theme's CSS can't reach it."
                      : "The outer HTML structure. Keep {{content}} and an element with data-action=\"toggle\". Everything inside {{content}} comes from your blocks."}
                  </p>
                  <textarea
                    ref={areaRef}
                    className="ed-input ed-code ed-code-xl"
                    spellCheck={false}
                    aria-label={current.label}
                    value={current.v}
                    onChange={(e) => current.set(e.target.value)}
                    onKeyDown={onKeyDown(current.set)}
                  />
                  <p className="ed-help">{current.v.length.toLocaleString()} characters{!hasSaved ? " · generated code, not saved yet" : ""}</p>
                </>
              )}
              {tab === "help" && <WidgetReference showShell htmlMode={false} onInsert={insert} />}

              <div className="ed-divider" />
              <div className="ed-section-title">Safety</div>
              <div className="ed-safe">
                <div>
                  <strong>Last working copy</strong>
                  <span className="ed-help">
                    {source.lastGood ? `${when(source.lastGood.savedAt)}` : "none yet (created when you first publish)"}
                  </span>
                </div>
                <button type="button" className="ed-btn" disabled={busy || !source.lastGood} onClick={confirmThen("Put your last working copy live now?", () => submit("revert-good"))}>
                  Revert to it
                </button>
              </div>
              <button type="button" className="ed-btn wide" disabled={busy || !source.enabled} onClick={() => submit("mark-working")}>
                Mark what's live as working
              </button>
              <button type="button" className="ed-btn wide" disabled={busy || !source.previous} onClick={confirmThen("Restore the version that was live before your last save?", () => submit("revert-previous"))}>
                Undo last publish{source.previous ? ` (${when(source.previous.savedAt)})` : ""}
              </button>
              <button type="button" className="ed-btn wide" onClick={regenerate}>
                Reload generated code from visual editor
              </button>
              <button type="button" className="ed-btn danger wide" disabled={busy || !source.enabled} onClick={confirmThen("Stop using your code and go back to the visual editor? Your code is kept.", () => submit("disable"))}>
                Switch off (use visual editor)
              </button>
              <p className="ed-help">
                Published code is checked before it goes live, and the widget falls back to the generated version if
                a shell can't be used. After you publish, look at your storefront, then press “Mark what's live as
                working” so you always have something safe to return to.
              </p>
            </div>
          </div>
        </aside>

        <main className="ed-stage">
          <div className={`ed-device ${mobile ? "mobile" : "desktop"}`}>
            {!mobile && (
              <div className="ed-chrome"><i /><i /><i /><span>{data.shop}</span></div>
            )}
            <div className="ed-screen">
              <div className="ed-mock" aria-hidden>
                <div className="ed-mock-nav" /><div className="ed-mock-hero" />
                <div className="ed-mock-grid"><span /><span /><span /><span /></div>
              </div>
              <WidgetPreview key={`${mode}-${mobile}`} config={config} state={state} mode={mode} mobile={mobile} />
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
