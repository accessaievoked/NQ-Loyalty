import { useEffect, useRef } from "react";
import { createWidget } from "../lib/widget/render";

/**
 * Live preview of the storefront widget inside an isolated shadow root, used by the visual
 * editor and the developer source page. Content updates go through `update()`; the widget is
 * rebuilt only when its structural mode (widget/page, desktop/mobile) changes.
 * A bug in custom CSS/HTML can't affect the admin UI around it.
 */
export default function WidgetPreview({ config, state, mode, mobile, selectedId, onSelect }) {
  const hostRef = useRef(null);
  const apiRef = useRef(null);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  useEffect(() => {
    const api = createWidget(hostRef.current, config, state, {
      mode: mode.toLowerCase(),
      preview: true,
      forceMobile: mobile,
      startOpen: true,
      onSelectBlock: (id) => onSelectRef.current?.(id),
    });
    apiRef.current = api;
    return () => {
      api.destroy();
      apiRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, mobile]);

  useEffect(() => {
    try {
      apiRef.current?.update(config, state);
    } catch (e) {
      console.warn("[preview] render failed", e);
    }
  }, [config, state, mode, mobile]);

  useEffect(() => {
    apiRef.current?.select(selectedId ?? null);
  }, [selectedId, mode, mobile]);

  return <div ref={hostRef} className={`ed-host ${mode === "PAGE" ? "page" : ""}`} />;
}
