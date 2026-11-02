// Small form controls shared by the storefront editor and the email editor.

export function Row({ label, help, children }) {
  return (
    <label className="ed-field">
      <span className="ed-label">{label}</span>
      {children}
      {help ? <span className="ed-help">{help}</span> : null}
    </label>
  );
}

export function ColorField({ label, value, onChange }) {
  return (
    <Row label={label}>
      <div className="ed-color">
        <input type="color" value={/^#[0-9a-f]{6}$/i.test(value) ? value : "#000000"} onChange={(e) => onChange(e.target.value)} />
        <input className="ed-input" value={value} onChange={(e) => onChange(e.target.value)} spellCheck={false} />
      </div>
    </Row>
  );
}

export function Toggle({ label, checked, onChange, help }) {
  return (
    <div className="ed-field">
      <div className="ed-toggle-row">
        <span className="ed-label">{label}</span>
        <button type="button" role="switch" aria-checked={checked} className={`ed-switch${checked ? " on" : ""}`} onClick={() => onChange(!checked)}>
          <span />
        </button>
      </div>
      {help ? <span className="ed-help">{help}</span> : null}
    </div>
  );
}

export function SelectField({ label, value, options, onChange, help }) {
  return (
    <Row label={label} help={help}>
      <select className="ed-input" value={value} onChange={(e) => onChange(e.target.value)}>
        {Object.entries(options).map(([k, v]) => (
          <option key={k} value={k}>
            {v}
          </option>
        ))}
      </select>
    </Row>
  );
}

/** An exact value you can type (the slider is for rough adjustments). Empty = unset. */
function NumberBox({ value, min, max, unit, placeholder, onChange }) {
  return (
    <label className="ed-num">
      <input
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        value={value}
        placeholder={placeholder}
        onChange={(e) => (e.target.value === "" ? onChange(placeholder ? "" : min) : onChange(Math.min(max, Math.max(min, Math.round(Number(e.target.value))))))}
      />
      <span>{unit}</span>
    </label>
  );
}

export function RangeField({ label, value, min, max, unit = "px", onChange }) {
  return (
    <Row label={label}>
      <div className="ed-slider">
        <input type="range" className="ed-range" min={min} max={max} value={value} onChange={(e) => onChange(Number(e.target.value))} />
        <NumberBox value={value} min={min} max={max} unit={unit} onChange={onChange} />
      </div>
    </Row>
  );
}

/** A colour that can be left unset (= inherit the theme), with a clear button. */
export function OptionalColorField({ label, value, onChange }) {
  return (
    <Row label={label}>
      <div className="ed-color">
        <input type="color" value={/^#[0-9a-f]{6}$/i.test(value || "") ? value : "#888888"} onChange={(e) => onChange(e.target.value)} />
        <input className="ed-input" value={value || ""} placeholder="Theme default" onChange={(e) => onChange(e.target.value)} spellCheck={false} />
        {value ? (
          <button type="button" className="ed-icon-btn sm" title="Use the theme default" onClick={() => onChange("")}>
            ×
          </button>
        ) : null}
      </div>
    </Row>
  );
}

/** A slider that can be left unset (= inherit the theme). */
export function OptionalRangeField({ label, value, min, max, onChange }) {
  const set = value !== undefined && value !== "" && value !== null;
  return (
    <Row label={label}>
      <div className="ed-slider">
        <input type="range" className="ed-range" min={min} max={max} value={set ? value : Math.round((min + max) / 2)} onChange={(e) => onChange(Number(e.target.value))} />
        <NumberBox value={set ? value : ""} placeholder="auto" min={min} max={max} unit="px" onChange={onChange} />
        {set ? (
          <button type="button" className="ed-icon-btn sm" title="Use the theme default" onClick={() => onChange("")}>
            ×
          </button>
        ) : null}
      </div>
    </Row>
  );
}

/** One field from BLOCK_STYLE_FIELDS. */
export function StyleField({ def, value, onChange }) {
  if (def.type === "color") return <OptionalColorField label={def.label} value={value} onChange={onChange} />;
  if (def.type === "range") return <OptionalRangeField label={def.label} value={value} min={def.min} max={def.max} onChange={onChange} />;
  if (def.type === "toggle") return <Toggle label={def.label} checked={!!value} onChange={(v) => onChange(v ? true : "")} help={def.help} />;
  return <SelectField label={def.label} value={value ?? ""} options={def.options} onChange={onChange} />;
}

/** Renders one setting from a block definition: { key, label, type, options?, min?, max?, help? } */
export function BlockField({ def, value, onChange }) {
  switch (def.type) {
    case "text":
      return (
        <Row label={def.label} help={def.help}>
          <input className="ed-input" value={value ?? ""} onChange={(e) => onChange(e.target.value)} />
        </Row>
      );
    case "textarea":
      return (
        <Row label={def.label} help={def.help}>
          <textarea className="ed-input" rows={3} value={value ?? ""} onChange={(e) => onChange(e.target.value)} />
        </Row>
      );
    case "code":
      return (
        <Row label={def.label} help={def.help}>
          <textarea className="ed-input ed-code" rows={8} spellCheck={false} value={value ?? ""} onChange={(e) => onChange(e.target.value)} />
        </Row>
      );
    case "number":
      return (
        <Row label={def.label} help={def.help}>
          <input type="number" className="ed-input" min={def.min} max={def.max} value={value ?? 0} onChange={(e) => onChange(Number(e.target.value))} />
        </Row>
      );
    case "select":
      return <SelectField label={def.label} value={value} options={def.options} onChange={onChange} help={def.help} />;
    case "toggle":
      return <Toggle label={def.label} checked={!!value} onChange={onChange} help={def.help} />;
    default:
      return null;
  }
}
