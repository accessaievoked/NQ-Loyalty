// The in-app scheduler: ONE timer, set for the next moment something is due. No Redis, no polling.
//
//  - Delayed point releases live in the database (PointsAward.releaseAt) and queued emails live in the
//    database (EmailJob). The database is the source of truth, so nothing is ever lost when the app
//    restarts, deploys or sleeps: on start the scheduler runs everything that came due meanwhile.
//  - Between events the app does not touch the database at all (a serverless database can sleep).
//    It asks the database for "when is the next thing due?" only at start, after doing work, and
//    when a new item is queued (and then it already knows the time, so no query).
//  - A maintenance pass (expiry, reminders, Judge.me, clean-up) runs at start and every 6 hours.
//
// This file is only the engine (timers + state). What "due work" means is wired in boot.server.js,
// which keeps this file free of imports from the rest of the app.

export const MAX_TIMER_MS = 2 ** 31 - 1; // the longest setTimeout allows (~24.8 days); longer waits re-arm
export const MAINTENANCE_EVERY_MS = 6 * 60 * 60 * 1000;

/** Round a time UP to the next multiple of `minutes` so many awards share one wake. 0 = exact. */
export const snapUp = (ms, minutes) => {
  const step = Number(minutes) * 60_000;
  return step > 0 ? Math.ceil(ms / step) * step : ms;
};

/** How long a timer for `atMs` should wait right now, within what setTimeout can do. */
export const timerDelay = (atMs, nowMs = Date.now()) => Math.min(MAX_TIMER_MS, Math.max(0, atMs - nowMs));

export const snapMinutes = () => {
  const n = Number(process.env.SCHEDULER_SNAP_MINUTES);
  return Number.isFinite(n) && n >= 0 ? n : 5;
};

// One scheduler per process, even if the module is loaded twice (dev reloads).
const state = () =>
  (globalThis.__loyaltyScheduler ??= {
    running: false,
    timer: null,
    targetAt: null,
    ticking: false,
    again: false,
    opts: null,
    maintenanceTimer: null,
    maintaining: false,
    startedAt: null,
    lastTickAt: null,
    lastTick: null,
    lastMaintenanceAt: null,
    lastMaintenance: null,
    lastError: null,
  });

/** Make sure a wake-up is set for `atMs` (a ms timestamp), unless an earlier one already is. */
export function armAt(atMs) {
  const st = state();
  if (!st.running || !Number.isFinite(atMs)) return;
  if (st.timer && st.targetAt != null && st.targetAt <= atMs) return; // already waking sooner
  if (st.timer) clearTimeout(st.timer);
  st.targetAt = atMs;
  st.timer = setTimeout(() => {
    st.timer = null;
    st.targetAt = null;
    void tick();
  }, timerDelay(atMs));
  st.timer.unref?.();
}

/** Something new was queued: wake now. Safe to call from anywhere, even when no scheduler runs. */
export const nudge = () => armAt(Date.now());

/** A delayed point release was scheduled for `releaseAt`: wake then (snapped). Never throws. */
export function enqueueAwardRelease(_awardId, releaseAt) {
  try {
    armAt(snapUp(new Date(releaseAt).getTime(), snapMinutes()));
  } catch {
    /* the next start or maintenance pass finds it in the database */
  }
}

async function tick() {
  const st = state();
  if (!st.running) return;
  if (st.ticking) {
    st.again = true; // something arrived while working: go round once more
    return;
  }
  st.ticking = true;
  try {
    do {
      st.again = false;
      st.lastTick = await st.opts.runDue();
      st.lastTickAt = Date.now();
    } while (st.again && st.running);
    st.lastError = null;
    const next = await st.opts.nextDueAt();
    if (next != null) armAt(next);
  } catch (e) {
    // The database may be waking up or briefly unreachable: look again soon, don't give up.
    st.lastError = e?.message || String(e);
    console.warn("[scheduler] tick failed, will retry in 60s:", st.lastError);
    armAt(Date.now() + 60_000);
  } finally {
    st.ticking = false;
  }
}

export async function runMaintenance() {
  const st = state();
  if (!st.opts?.maintenance || st.maintaining) return null;
  st.maintaining = true;
  try {
    st.lastMaintenance = await st.opts.maintenance();
    st.lastMaintenanceAt = Date.now();
    return st.lastMaintenance;
  } catch (e) {
    st.lastError = e?.message || String(e);
    console.warn("[scheduler] maintenance failed:", st.lastError);
    return null;
  } finally {
    st.maintaining = false;
  }
}

/**
 * @param {object} opts
 * @param {() => Promise<object>} opts.runDue          do everything that is due now
 * @param {() => Promise<number|null>} opts.nextDueAt  ms timestamp of the next thing due, or null
 * @param {() => Promise<object>} [opts.maintenance]   the slow clean-up pass
 * @param {number} [opts.maintenanceEveryMs]           0 = don't schedule it
 * @param {number} [opts.maintenanceDelayMs]           first run after this long (default 5s)
 * @returns {boolean} true if this call started it
 */
export function startScheduler(opts) {
  const st = state();
  st.opts = opts; // always take the newest functions (matters when a dev reload re-runs this)
  if (st.running) return false;
  st.running = true;
  st.startedAt = Date.now();
  armAt(Date.now()); // first wake: run whatever came due while we were away, then arm the next
  const every = opts.maintenanceEveryMs ?? MAINTENANCE_EVERY_MS;
  if (opts.maintenance && every > 0) {
    st.maintenanceTimer = setInterval(() => void runMaintenance(), every);
    st.maintenanceTimer.unref?.();
    const first = setTimeout(() => void runMaintenance(), opts.maintenanceDelayMs ?? 5000);
    first.unref?.();
    st.firstMaintenance = first;
  }
  return true;
}

export async function stopScheduler() {
  const st = state();
  st.running = false;
  if (st.timer) clearTimeout(st.timer);
  if (st.maintenanceTimer) clearInterval(st.maintenanceTimer);
  if (st.firstMaintenance) clearTimeout(st.firstMaintenance);
  st.timer = st.maintenanceTimer = st.firstMaintenance = null;
  st.targetAt = null;
  for (let i = 0; i < 100 && (st.ticking || st.maintaining); i += 1) await new Promise((r) => setTimeout(r, 20)); // let work in flight finish
}

export function schedulerStatus() {
  const st = state();
  return {
    running: st.running,
    startedAt: st.startedAt,
    nextWakeAt: st.targetAt,
    lastTickAt: st.lastTickAt,
    lastMaintenanceAt: st.lastMaintenanceAt,
    lastError: st.lastError,
  };
}
