import prisma from "../db.server.js";
import { MAINTENANCE_EVERY_MS, nudge, snapMinutes, snapUp, startScheduler } from "./scheduler.server.js";
import { nextEmailDueAt, processDueEmails, pruneEmailJobs } from "./emailqueue.server.js";
import { releaseDueAwards } from "../services/orders.server.js";
import { expireDuePoints } from "../services/ledger.server.js";
import { expireOldRedemptions, recoverStaleRedemptions } from "../services/redeem.server.js";
import { purgeExpiredAuth } from "../services/identity.server.js";
import { deliverEmailJob } from "../services/notify.server.js";
import { sendExpiryReminders } from "../services/reminders.server.js";
import { syncAllJudgeMe } from "../services/integrations.server.js";

// Wires the scheduler engine to the app: what "due" means, and the slow maintenance pass.
// Started once per server process from entry.server.jsx. Set DISABLE_SCHEDULER=1 to run no timers
// in this process (e.g. a machine that sleeps and is woken by POST /internal/tick instead).

/** Everything that is due right now: point releases whose hold ended, and queued emails. */
export async function runDue({ deliver = deliverEmailJob, storeId = null } = {}) {
  const awards = await releaseDueAwards({ storeId });
  const emails = await processDueEmails({ deliver, storeId });
  return { awards, emails };
}

/** When the next thing becomes due (ms), or null when nothing is waiting. Release times are snapped so many share a wake. */
export async function nextDueAt({ storeId = null } = {}) {
  const award = await prisma.pointsAward.findFirst({
    where: { status: "PENDING", releaseAt: { gt: new Date() }, ...(storeId ? { storeId } : {}) },
    orderBy: { releaseAt: "asc" },
    select: { releaseAt: true },
  });
  const times = [award ? snapUp(award.releaseAt.getTime(), snapMinutes()) : null, await nextEmailDueAt({ storeId })].filter((t) => t != null);
  return times.length ? Math.min(...times) : null;
}

const safe = async (out, name, fn) => {
  try {
    out[name] = await fn();
  } catch (e) {
    out[name] = `failed: ${e.message}`;
    console.warn(`[maintenance] ${name} failed:`, e.message);
  }
};

/** The slow pass, every 6 hours: catch-up releases, expiry, stuck redemptions, reminders, reviews, clean-up. */
export async function maintenance() {
  const out = {};
  await safe(out, "released", releaseDueAwards);
  await safe(out, "expired", expireDuePoints);
  await safe(out, "refundedStale", recoverStaleRedemptions);
  await safe(out, "codesExpired", expireOldRedemptions);
  await safe(out, "authPurged", purgeExpiredAuth);
  await safe(out, "reminded", sendExpiryReminders); // queues emails
  await safe(out, "reviewsRewarded", syncAllJudgeMe);
  await safe(out, "emailJobsPruned", () => pruneEmailJobs());
  nudge(); // send whatever the pass queued, now
  return out;
}

/** One-off run for an outside trigger (POST /internal/tick) when no timers run in this process. */
export async function runOnce({ withMaintenance = false, deliver, storeId } = {}) {
  const due = await runDue({ deliver, storeId });
  return withMaintenance ? { ...due, maintenance: await maintenance() } : due;
}

/** Start the timers (once per process). Returns true if this call started them. */
export function bootBackgroundJobs() {
  if (process.env.DISABLE_SCHEDULER === "1") return false;
  return startScheduler({ runDue, nextDueAt, maintenance, maintenanceEveryMs: MAINTENANCE_EVERY_MS });
}
