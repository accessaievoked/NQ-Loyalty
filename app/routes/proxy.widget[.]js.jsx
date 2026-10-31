import defaultsSrc from "../lib/widget/defaults.js?raw";
import renderSrc from "../lib/widget/render.js?raw";
import runtimeSrc from "../lib/widget/runtime.js?raw";

// The storefront script is the same source the admin preview imports, flattened into one
// browser-ready IIFE (imports removed, `export` stripped). Served from the app, so editor
// changes and fixes reach every store without touching the theme.
const strip = (src) => src.replace(/^import .*$/gm, "").replace(/^export (async )?(function|const|let|class)/gm, "$1$2");

const script = `(function(){\n${strip(defaultsSrc)}\n${strip(renderSrc)}\n${runtimeSrc}\n})();`;

export const loader = () =>
  new Response(script, {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
