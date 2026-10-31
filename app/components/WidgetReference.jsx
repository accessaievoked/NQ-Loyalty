import {
  BLOCK_DOCS,
  BLOCK_TYPES,
  CSS_VARIABLES,
  GLOBAL_CLASSES,
  SHELL_PLACEHOLDERS,
} from "../lib/widget/defaults";

const VARIABLE_DOCS = [
  ["{{first_name}}", "Customer's first name (‘there’ if unknown)"],
  ["{{email}}", "Customer's email"],
  ["{{points}}", "Current points balance"],
  ["{{lifetime_points}}", "Total points ever earned"],
  ["{{store}}", "Your store name"],
  ["{{referral_code}}", "Their referral code (when referrals are on)"],
  ["{{referral_link}}", "Their share link"],
  ["{{expiring_points}}", "Points expiring within 30 days"],
  ["{{expiring_date}}", "Date those points expire"],
];

function Chip({ text, onInsert }) {
  const copy = () => {
    try {
      navigator.clipboard?.writeText(text);
    } catch {
      /* ignore */
    }
  };
  return (
    <span className="ed-chip">
      <code>{text}</code>
      {onInsert && (
        <button type="button" title="Insert at cursor" onClick={() => onInsert(text)}>
          Insert
        </button>
      )}
      <button type="button" title="Copy" onClick={copy}>
        Copy
      </button>
    </span>
  );
}

/**
 * Plain-language reference for people writing custom HTML/CSS: what to type, what each block
 * outputs, and the class names to style. `onInsert` adds text to whichever editor is open.
 */
export default function WidgetReference({ onInsert, showShell = false, htmlMode = true }) {
  return (
    <div className="ed-ref">
      <details open>
        <summary>How this works</summary>
        <div className="ed-ref-body">
          {htmlMode && (
            <p>
              In <strong>Custom HTML</strong> mode you write the layout. Type normal HTML, and where you want a working
              part of the widget, add its token — for example <code>{"{{block:redeem}}"}</code>. Tokens drop in the real
              block with its settings and live data. Anything you don't place doesn't show.
            </p>
          )}
          <p>
            Style it with CSS: every block uses the class names listed below, so you can target them in{" "}
            <strong>Custom CSS</strong>. The widget lives in an isolated area, so your theme's CSS can't leak in and yours
            can't leak out.
          </p>
        </div>
      </details>

      {htmlMode && (
        <details>
          <summary>Variables (fill in customer details)</summary>
          <ul className="ed-ref-list">
            {VARIABLE_DOCS.map(([v, d]) => (
              <li key={v}>
                <Chip text={v} onInsert={onInsert} />
                <span>{d}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      <details>
        <summary>Blocks &amp; their classes</summary>
        <ul className="ed-ref-list">
          {Object.entries(BLOCK_DOCS).map(([type, doc]) => (
            <li key={type} className="ed-ref-block">
              <div className="ed-ref-head">
                <strong>{BLOCK_TYPES[type]?.label ?? type}</strong>
                {htmlMode && type !== "html" && type !== "spacer" && <Chip text={`{{block:${type}}}`} onInsert={onInsert} />}
              </div>
              <span>{doc.what}</span>
              {doc.classes.length > 0 && (
                <ul className="ed-ref-classes">
                  {doc.classes.map(([cls, d]) => (
                    <li key={cls}>
                      <code>{cls}</code> <span>{d}</span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      </details>

      <details>
        <summary>Shared classes</summary>
        <ul className="ed-ref-classes">
          {GLOBAL_CLASSES.map(([cls, d]) => (
            <li key={cls}>
              <code>{cls}</code> <span>{d}</span>
            </li>
          ))}
        </ul>
      </details>

      <details>
        <summary>CSS variables (theme colours)</summary>
        <p className="ed-ref-note">Use them so your CSS follows the theme: <code>color: var(--p);</code></p>
        <ul className="ed-ref-classes">
          {CSS_VARIABLES.map(([v, d]) => (
            <li key={v}>
              <code>{v}</code> <span>{d}</span>
            </li>
          ))}
        </ul>
      </details>

      {showShell && (
        <details open>
          <summary>HTML shell placeholders</summary>
          <p className="ed-ref-note">
            The shell is the outer structure around your content. Keep <code>{"{{content}}"}</code>, and keep one element
            with <code>data-action="toggle"</code> so shoppers can open and close the panel.
          </p>
          <ul className="ed-ref-list">
            {SHELL_PLACEHOLDERS.map(([v, d]) => (
              <li key={v}>
                <Chip text={v} onInsert={onInsert} />
                <span>{d}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
