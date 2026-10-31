import prisma from "../db.server.js";
import { compileSource } from "../lib/widget/render.js";
import { normalizeConfig } from "../lib/widget/defaults.js";

// Developer source: full CSS + HTML shells stored per store, for total customisation.
//
// Safety net (developers can break things):
//   - saves are validated, so the obvious breakages (no {{content}}, no way to open the panel,
//     <script>, @import, javascript: URLs) are refused before they go live;
//   - the renderer falls back to the generated defaults if a shell can't be used;
//   - `devLastGood` always holds a copy that was marked as working (initially the generated
//     default), and `devPrevious` the version that was live before the last save.

const MAX_CSS = 80000;
const MAX_SHELL = 20000;

export function validateSource({ css = "", shell = "", pageShell = "" }) {
  const errors = [];
  const text = (v) => (typeof v === "string" ? v : "");
  css = text(css);
  shell = text(shell);
  pageShell = text(pageShell);

  if (css.length > MAX_CSS) errors.push(`CSS is too long (max ${MAX_CSS} characters).`);
  if (/<\/?\s*style/i.test(css)) errors.push("Remove <style> tags from the CSS — paste plain CSS only.");
  if (/@import/i.test(css)) errors.push("@import isn't allowed (it would load outside code). Paste the CSS in directly.");
  if (/javascript\s*:|expression\s*\(|behavior\s*:/i.test(css)) errors.push("The CSS contains an unsafe construct (javascript:, expression() or behavior:).");

  for (const [name, html, needsToggle] of [["Widget HTML", shell, true], ["Page HTML", pageShell, false]]) {
    if (!html.trim()) continue; // blank = use the generated default
    if (html.length > MAX_SHELL) errors.push(`${name} is too long (max ${MAX_SHELL} characters).`);
    if (!/\{\{\s*content\s*\}\}/.test(html)) errors.push(`${name} must contain {{content}}, or nothing would be shown.`);
    if (/<\s*script/i.test(html)) errors.push(`${name}: <script> isn't allowed.`);
    if (/\son\w+\s*=/i.test(html)) errors.push(`${name}: inline event handlers (onclick=…) aren't allowed. Use data-action="toggle" to open/close.`);
    if (needsToggle && !/data-action\s*=\s*["']toggle["']/.test(html)) {
      errors.push(`${name} needs an element with data-action="toggle" so shoppers can open and close the panel.`);
    }
  }
  return errors;
}

const snapshot = (s) => ({
  css: s.devCss ?? "",
  shell: s.devShell ?? "",
  pageShell: s.devPageShell ?? "",
  savedAt: new Date().toISOString(),
});

async function settingsFor(storeId) {
  const s = await prisma.storeSettings.findUnique({ where: { storeId } });
  if (!s) throw new Error("Store settings not found");
  return s;
}

/** What the developer page needs, including the generated default and rollback info. */
export async function getDevSource(storeId) {
  const s = await settingsFor(storeId);
  const visual = normalizeConfig({ ...(s.widgetConfig || {}), dev: null });
  const generated = compileSource(visual);
  const meta = (j) => (j ? { savedAt: j.savedAt ?? null } : null);
  return {
    enabled: s.devEnabled,
    css: s.devCss ?? "",
    shell: s.devShell ?? "",
    pageShell: s.devPageShell ?? "",
    updatedAt: s.devUpdatedAt ? s.devUpdatedAt.toISOString() : null,
    lastGood: meta(s.devLastGood),
    previous: meta(s.devPrevious),
    generated,
    visual,
    displayMode: s.displayMode,
  };
}

/** Save and publish. The version that was live moves to `devPrevious`. */
export async function saveDevSource(storeId, { css, shell, pageShell, enabled }) {
  const errors = validateSource({ css, shell, pageShell });
  if (errors.length) return { ok: false, errors };

  const s = await settingsFor(storeId);
  const hadLive = s.devEnabled && (s.devCss || s.devShell || s.devPageShell);
  const data = {
    devCss: css?.trim() ? css : null,
    devShell: shell?.trim() ? shell : null,
    devPageShell: pageShell?.trim() ? pageShell : null,
    devEnabled: !!enabled,
    devUpdatedAt: new Date(),
  };
  if (hadLive) data.devPrevious = snapshot(s);
  // First time: the generated default is the known-good fallback to roll back to.
  if (!s.devLastGood) {
    const visual = normalizeConfig({ ...(s.widgetConfig || {}), dev: null });
    data.devLastGood = { ...compileSource(visual), savedAt: new Date().toISOString(), generated: true };
  }
  await prisma.storeSettings.update({ where: { storeId }, data });
  return { ok: true };
}

/** The merchant confirms what's live works: remember it as the rollback target. */
export async function markWorking(storeId) {
  const s = await settingsFor(storeId);
  if (!s.devEnabled) return { ok: false, errors: ["Developer source isn't live, so there's nothing to mark."] };
  await prisma.storeSettings.update({ where: { storeId }, data: { devLastGood: snapshot(s) } });
  return { ok: true };
}

/** Put the last working copy live again (the replaced version is kept as `devPrevious`). */
export async function revertToLastWorking(storeId) {
  const s = await settingsFor(storeId);
  const good = s.devLastGood;
  if (!good) return { ok: false, errors: ["There's no saved working copy yet."] };
  await prisma.storeSettings.update({
    where: { storeId },
    data: {
      devCss: good.css || null,
      devShell: good.shell || null,
      devPageShell: good.pageShell || null,
      devEnabled: true,
      devUpdatedAt: new Date(),
      devPrevious: snapshot(s),
    },
  });
  return { ok: true };
}

/** Undo the last save. */
export async function revertToPrevious(storeId) {
  const s = await settingsFor(storeId);
  const prev = s.devPrevious;
  if (!prev) return { ok: false, errors: ["There's no previous version."] };
  await prisma.storeSettings.update({
    where: { storeId },
    data: {
      devCss: prev.css || null,
      devShell: prev.shell || null,
      devPageShell: prev.pageShell || null,
      devEnabled: true,
      devUpdatedAt: new Date(),
      devPrevious: snapshot(s),
    },
  });
  return { ok: true };
}

/** Back to the visual editor. The source is kept, just not used. */
export async function disableDevSource(storeId) {
  await prisma.storeSettings.update({ where: { storeId }, data: { devEnabled: false } });
  return { ok: true };
}
