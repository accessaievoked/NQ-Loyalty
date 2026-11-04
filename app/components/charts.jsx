import { forwardRef, useEffect, useId, useMemo, useRef, useState } from "react";

// Small dependency-free SVG charts for the Analytics and Home pages. Everything is responsive
// (SVG viewBox), readable without colour alone (legends and tooltips carry the numbers), and
// shows an honest empty state instead of a flat line.

export const COLORS = { blue: "#2563eb", orange: "#ea580c", green: "#16a34a", purple: "#7c3aed", pink: "#db2777", teal: "#0d9488", amber: "#d97706", grey: "#94a3b8" };
const AXIS = "#6b7280";
const GRID = "#eceef1";

export const compact = (n) => new Intl.NumberFormat("en-IN", { notation: "compact", maximumFractionDigits: 1 }).format(n);
export const whole = (n) => new Intl.NumberFormat("en-IN").format(Math.round(n));
export const moneyFmt = (currency) => (n) => {
  try {
    return new Intl.NumberFormat("en-IN", { style: "currency", currency, maximumFractionDigits: 0 }).format(n);
  } catch {
    return `${Math.round(n)} ${currency}`;
  }
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-10-06" → "6 Oct" */
export const shortDate = (iso) => {
  const [, m, d] = String(iso).split("-");
  return m && d ? `${Number(d)} ${MONTHS[Number(m) - 1]}` : String(iso);
};

/** Round the top of an axis up to a tidy number so gridlines land on friendly values. */
function niceMax(max) {
  if (max <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(max));
  const f = max / pow;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nice * pow;
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

// ---- legend ------------------------------------------------------------------------------------

export function Legend({ items }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 18px", fontSize: 13, color: "#374151" }}>
      {items.map((i) => (
        <span key={i.label} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 10, height: 10, borderRadius: 3, background: i.color, display: "inline-block" }} />
          {i.label}
        </span>
      ))}
    </div>
  );
}

function Tooltip({ left, title, rows }) {
  return (
    <div
      style={{
        position: "absolute", top: 4, left: `${left}%`, transform: `translateX(${left > 70 ? "-104%" : "8%"})`, pointerEvents: "none", zIndex: 3,
        background: "#111827", color: "#fff", borderRadius: 8, padding: "8px 10px", fontSize: 12, lineHeight: 1.45, boxShadow: "0 6px 20px rgba(0,0,0,.25)", whiteSpace: "nowrap",
      }}
    >
      <div style={{ opacity: 0.7, marginBottom: 2 }}>{title}</div>
      {rows.map((r) => (
        <div key={r.label} style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 8, height: 8, borderRadius: 2, background: r.color, display: "inline-block" }} />
          <span style={{ opacity: 0.85 }}>{r.label}</span>
          <b style={{ marginLeft: "auto", paddingLeft: 12 }}>{r.value}</b>
        </div>
      ))}
    </div>
  );
}

function Empty({ height, text = "Nothing to show for this period yet." }) {
  return (
    <div style={{ height, display: "flex", alignItems: "center", justifyContent: "center", color: AXIS, fontSize: 13, border: "1px dashed #d8dce2", borderRadius: 12, background: "#fafbfc" }}>
      {text}
    </div>
  );
}

/** Evenly thin x labels to at most `max` so they never collide. */
function xLabelIdx(n, max) {
  if (n <= max) return Array.from({ length: n }, (_, i) => i);
  const step = Math.ceil((n - 1) / (max - 1));
  const out = [];
  for (let i = 0; i < n; i += step) out.push(i);
  if (out[out.length - 1] !== n - 1) out[out.length - 1] = n - 1;
  return out;
}

// ---- area / line chart -------------------------------------------------------------------------

// Smooth curve through the points (Catmull-Rom → cubic Bézier), flattened so it never overshoots below zero.
function curve(pts) {
  if (pts.length < 2) return "";
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i += 1) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${c1[0]},${clamp(c1[1], Math.min(p1[1], p2[1]), Math.max(p1[1], p2[1]))} ${c2[0]},${clamp(c2[1], Math.min(p1[1], p2[1]), Math.max(p1[1], p2[1]))} ${p2[0]},${p2[1]}`;
  }
  return d;
}

/**
 * @param {{label:string,color:string,values:number[],format?:(n:number)=>string}[]} series
 * @param {string[]} labels  ISO dates (one per value)
 */
export function AreaChart({ series, labels, height = 240, format = whole, axisFormat = compact, ariaLabel = "Trend chart" }) {
  const uid = useId().replace(/:/g, "");
  const [hover, setHover] = useState(null);
  const W = 760;
  const pad = { l: 46, r: 12, t: 14, b: 28 };
  const iw = W - pad.l - pad.r;
  const ih = height - pad.t - pad.b;
  const n = labels.length;
  const rawMax = Math.max(0, ...series.flatMap((s) => s.values));
  const max = niceMax(rawMax);
  const x = (i) => pad.l + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
  const y = (v) => pad.t + ih - (v / max) * ih;

  if (!n || rawMax === 0) return <Empty height={height} />;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => max * t);
  const xs = xLabelIdx(n, 6);

  const onMove = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const vx = ((e.clientX - r.left) / r.width) * W;
    setHover(clamp(Math.round(((vx - pad.l) / iw) * (n - 1)), 0, n - 1));
  };

  return (
    <div style={{ position: "relative" }} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${height}`} width="100%" role="img" aria-label={ariaLabel} style={{ display: "block", touchAction: "pan-y" }}>
        <defs>
          {series.map((s, k) => (
            <linearGradient key={k} id={`${uid}g${k}`} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor={s.color} stopOpacity="0.28" />
              <stop offset="100%" stopColor={s.color} stopOpacity="0.02" />
            </linearGradient>
          ))}
        </defs>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} stroke={GRID} strokeWidth="1" />
            <text x={pad.l - 8} y={y(t) + 4} textAnchor="end" fontSize="11" fill={AXIS}>
              {axisFormat(t)}
            </text>
          </g>
        ))}
        {series.map((s, k) => {
          const pts = s.values.map((v, i) => [x(i), y(v)]);
          const line = curve(pts);
          return (
            <g key={s.label}>
              {n > 1 && <path d={`${line} L${x(n - 1)},${y(0)} L${x(0)},${y(0)} Z`} fill={`url(#${uid}g${k})`} />}
              <path d={line || `M${pts[0][0]},${pts[0][1]}`} fill="none" stroke={s.color} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
            </g>
          );
        })}
        {xs.map((i) => (
          <text key={i} x={x(i)} y={height - 8} textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"} fontSize="11" fill={AXIS}>
            {shortDate(labels[i])}
          </text>
        ))}
        {hover != null && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={pad.t + ih} stroke="#9ca3af" strokeDasharray="3 3" />
            {series.map((s) => (
              <circle key={s.label} cx={x(hover)} cy={y(s.values[hover])} r="4.5" fill="#fff" stroke={s.color} strokeWidth="2.2" />
            ))}
          </g>
        )}
      </svg>
      {hover != null && (
        <Tooltip
          left={(x(hover) / W) * 100}
          title={shortDate(labels[hover])}
          rows={series.map((s) => ({ label: s.label, color: s.color, value: (s.format || format)(s.values[hover]) }))}
        />
      )}
    </div>
  );
}

// ---- bar chart -----------------------------------------------------------------------------------------

// Scrolls sideways without showing a scrollbar: swipe, trackpad, shift+wheel, or drag with the mouse.
const HIDE_SCROLLBAR = ".lw-chart-scroll{scrollbar-width:none;-ms-overflow-style:none}.lw-chart-scroll::-webkit-scrollbar{display:none}";

export const HiddenScroll = forwardRef(function HiddenScroll({ children, style, className = "", ...rest }, ref) {
  return (
    <>
      <style>{HIDE_SCROLLBAR}</style>
      <div ref={ref} className={`lw-chart-scroll ${className}`} style={style} {...rest}>
        {children}
      </div>
    </>
  );
});

/**
 * One bar per label. With a second series the first is drawn wide and light and the second narrow
 * and dark inside it ("of which …"). `scrollable` keeps every bar a readable width and lets the
 * chart scroll sideways (scrollbar hidden), starting at the latest day.
 */
export function BarChart({ series, labels, height = 240, format = whole, axisFormat = compact, minBar = 22, scrollable = false, ariaLabel = "Bar chart" }) {
  const [hover, setHover] = useState(null);
  const scroller = useRef(null);
  const drag = useRef(null);
  const n = labels.length;
  const rawMax = Math.max(0, ...series.flatMap((s) => s.values));
  const max = niceMax(rawMax);
  const pad = { t: 14 };
  const labelH = 26;
  const plotH = height - labelH;
  const ih = plotH - pad.t;
  const y = (v) => pad.t + ih - (v / max) * ih;
  const plotW = scrollable ? Math.max(n * minBar, 520) : 720;
  const step = plotW / Math.max(1, n);
  const bw = Math.max(2, Math.min(34, step * 0.66));
  const xs = useMemo(() => xLabelIdx(n, scrollable ? Math.max(6, Math.floor(plotW / 70)) : 7), [n, scrollable, plotW]);

  useEffect(() => {
    if (scrollable && scroller.current) scroller.current.scrollLeft = scroller.current.scrollWidth; // newest first in view
  }, [scrollable, n]);

  if (!n || rawMax === 0) return <Empty height={height} />;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => max * t);

  const onMove = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    setHover(clamp(Math.floor(((e.clientX - r.left) / r.width) * n), 0, n - 1));
  };
  // Mouse drag to pan (touch and trackpads already scroll natively).
  const down = (e) => {
    if (!scrollable || e.pointerType !== "mouse") return;
    drag.current = { x: e.clientX, left: scroller.current.scrollLeft };
  };
  const pan = (e) => {
    if (drag.current) scroller.current.scrollLeft = drag.current.left - (e.clientX - drag.current.x);
  };
  const up = () => {
    drag.current = null;
  };

  return (
    <div style={{ display: "flex", alignItems: "stretch" }}>
      <svg width="46" height={plotH} style={{ flex: "none" }} aria-hidden="true">
        {ticks.map((t) => (
          <text key={t} x="40" y={y(t) + 4} textAnchor="end" fontSize="11" fill={AXIS}>
            {axisFormat(t)}
          </text>
        ))}
      </svg>
      <HiddenScroll
        ref={scroller}
        style={{ flex: 1, minWidth: 0, overflowX: scrollable ? "auto" : "visible", position: "relative", cursor: scrollable ? "grab" : "default" }}
        onPointerDown={down}
        onPointerMove={pan}
        onPointerUp={up}
        onPointerLeave={up}
      >
        <div style={{ position: "relative", width: scrollable ? plotW : "100%", minWidth: scrollable ? plotW : 0 }} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
          <svg viewBox={`0 0 ${plotW} ${plotH}`} width="100%" height={plotH} preserveAspectRatio="none" role="img" aria-label={ariaLabel} style={{ display: "block" }}>
            {ticks.map((t) => (
              <line key={t} x1="0" x2={plotW} y1={y(t)} y2={y(t)} stroke={GRID} strokeWidth="1" />
            ))}
            {hover != null && <rect x={hover * step} y={pad.t} width={step} height={ih} fill="#f3f4f6" />}
            {labels.map((l, i) => {
              const cx = i * step + step / 2;
              return (
                <g key={l}>
                  {series.map((s, k) => {
                    const w = k === 0 ? bw : bw * 0.55;
                    const v = s.values[i] || 0;
                    return <rect key={s.label} x={cx - w / 2} y={y(v)} width={w} height={Math.max(0, pad.t + ih - y(v))} rx={Math.min(3, w / 2)} fill={s.color} opacity={k === 0 && series.length > 1 ? 0.35 : 1} />;
                  })}
                </g>
              );
            })}
          </svg>
          <div style={{ position: "relative", height: labelH }} aria-hidden="true">
            {xs.map((i) => (
              <span key={i} style={{ position: "absolute", top: 8, left: `${((i * step + step / 2) / plotW) * 100}%`, transform: `translateX(${i === 0 ? "-20%" : i === n - 1 ? "-80%" : "-50%"})`, fontSize: 11, color: AXIS, whiteSpace: "nowrap", userSelect: "none" }}>
                {shortDate(labels[i])}
              </span>
            ))}
          </div>
          {hover != null && (
            <Tooltip
              left={((hover * step + step / 2) / plotW) * 100}
              title={shortDate(labels[hover])}
              rows={series.map((s) => ({ label: s.label, color: s.color, value: (s.format || format)(s.values[hover] || 0) }))}
            />
          )}
        </div>
      </HiddenScroll>
    </div>
  );
}

// ---- donut -----------------------------------------------------------------------------------------

export function Donut({ items, center, centerLabel, format = whole, size = 168, thickness = 24 }) {
  const total = items.reduce((s, i) => s + i.value, 0);
  const r = (size - thickness) / 2;
  const c = size / 2;
  const circ = 2 * Math.PI * r;
  let offset = 0;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 24, flexWrap: "wrap" }}>
      <div style={{ position: "relative", width: size, height: size, flex: "none" }}>
        <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} role="img" aria-label="Breakdown chart">
          <circle cx={c} cy={c} r={r} fill="none" stroke="#eef0f3" strokeWidth={thickness} />
          {total > 0 &&
            items.map((i) => {
              const len = (i.value / total) * circ;
              const el = (
                <circle
                  key={i.label}
                  cx={c}
                  cy={c}
                  r={r}
                  fill="none"
                  stroke={i.color}
                  strokeWidth={thickness}
                  strokeDasharray={`${Math.max(0, len - 2)} ${circ - Math.max(0, len - 2)}`}
                  strokeDashoffset={-offset}
                  transform={`rotate(-90 ${c} ${c})`}
                >
                  <title>{`${i.label}: ${format(i.value)} (${Math.round((i.value / total) * 100)}%)`}</title>
                </circle>
              );
              offset += len;
              return el;
            })}
        </svg>
        <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center" }}>
          <div style={{ fontSize: 22, fontWeight: 700, color: "#111827", lineHeight: 1.1 }}>{center ?? compact(total)}</div>
          {centerLabel && <div style={{ fontSize: 12, color: AXIS, marginTop: 2 }}>{centerLabel}</div>}
        </div>
      </div>
      <div style={{ flex: 1, minWidth: 180, display: "flex", flexDirection: "column", gap: 10 }}>
        {items.map((i) => (
          <div key={i.label} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
            <span style={{ width: 10, height: 10, borderRadius: 3, background: i.color, flex: "none" }} />
            <span style={{ color: "#374151", flex: 1, minWidth: 0 }}>{i.label}</span>
            <b style={{ color: "#111827" }}>{format(i.value)}</b>
            <span style={{ color: AXIS, width: 38, textAlign: "right" }}>{total ? `${Math.round((i.value / total) * 100)}%` : "–"}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---- sparkline ---------------------------------------------------------------------------------------

export function Sparkline({ values, color = COLORS.blue, width = 110, height = 34 }) {
  const uid = useId().replace(/:/g, "");
  const max = Math.max(...values, 0);
  if (values.length < 2 || max === 0) {
    return (
      <svg width={width} height={height} aria-hidden="true">
        <line x1="0" x2={width} y1={height - 2} y2={height - 2} stroke={GRID} strokeWidth="2" strokeLinecap="round" />
      </svg>
    );
  }
  const pts = values.map((v, i) => [(i / (values.length - 1)) * width, height - 3 - (v / max) * (height - 8)]);
  const line = curve(pts);
  return (
    <svg width={width} height={height} aria-hidden="true">
      <defs>
        <linearGradient id={uid} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.3" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${line} L${width},${height} L0,${height} Z`} fill={`url(#${uid})`} />
      <path d={line} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

// ---- horizontal bars ----------------------------------------------------------------------------------

export function HBars({ items, color = COLORS.blue, format = whole, empty = "Nothing here yet." }) {
  const max = Math.max(0, ...items.map((i) => i.value));
  if (!items.length || max === 0) return <Empty height={96} text={empty} />;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {items.map((i) => (
        <div key={i.label}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 13, marginBottom: 5 }}>
            <span style={{ color: "#1f2937", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{i.href ? <a href={i.href}>{i.label}</a> : i.label}</span>
            <span style={{ color: "#111827", fontWeight: 600, flex: "none" }}>
              {format(i.value)}
              {i.sub ? <span style={{ color: AXIS, fontWeight: 400 }}> · {i.sub}</span> : null}
            </span>
          </div>
          <div style={{ height: 8, borderRadius: 99, background: "#eef0f3", overflow: "hidden" }}>
            <div style={{ width: `${Math.max(2, (i.value / max) * 100)}%`, height: "100%", borderRadius: 99, background: i.color || color }} />
          </div>
        </div>
      ))}
    </div>
  );
}

// ---- a card to hold a chart ---------------------------------------------------------------------------

export function Panel({ title, subtitle, right, children, style }) {
  return (
    <div style={{ background: "#fff", border: "1px solid #e4e6ea", borderRadius: 14, padding: 18, minWidth: 0, ...style }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, marginBottom: 14, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 650, color: "#111827" }}>{title}</div>
          {subtitle ? <div style={{ fontSize: 13, color: AXIS, marginTop: 2 }}>{subtitle}</div> : null}
        </div>
        {right}
      </div>
      {children}
    </div>
  );
}

/** A number with its trend: one cell of a "key figures" strip. */
export function Figure({ label, value, hint, values, color }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
      <span style={{ fontSize: 13, color: AXIS }}>{label}</span>
      <span style={{ fontSize: 24, fontWeight: 700, color: "#111827", letterSpacing: "-.01em" }}>{value}</span>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <span style={{ fontSize: 12, color: AXIS }}>{hint}</span>
        {values ? <Sparkline values={values} color={color} width={84} height={26} /> : null}
      </div>
    </div>
  );
}

export function FiguresStrip({ children }) {
  // Hairline gaps over a grey backing draw the dividers, whether the figures sit in a row or stack.
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 1, background: "#e4e6ea", border: "1px solid #e4e6ea", borderRadius: 14, overflow: "hidden", minWidth: 0 }}>
      {children.map((c, i) => (
        <div key={i} style={{ padding: "16px 20px", background: "#fff", minWidth: 0 }}>
          {c}
        </div>
      ))}
    </div>
  );
}

export function Columns({ children, min = 340 }) {
  return <div style={{ display: "grid", gridTemplateColumns: `repeat(auto-fit, minmax(min(${min}px, 100%), 1fr))`, gap: 16, minWidth: 0 }}>{children}</div>;
}
