import { releaseDueAwards } from "./orders.server.js";
import { expireDuePoints } from "./ledger.server.js";
import { recoverStaleRedemptions, expireOldRedemptions } from "./redeem.server.js";
import { purgeExpiredAuth } from "./identity.server.js";
import { syncAllJudgeMe } from "./integrations.server.js";

// The worker normally does this every 5 minutes. If Redis or the worker isn't running (dev,
// a failed deploy), points on hold would otherwise never be credited. So the web app runs the
// same idempotent sweep opportunistically — at most once a minute, never blocking a request.
let last = 0;
let lastReviews = 0;
let running = false;

export function maybeSweep() {
  const now = Date.now();
  if (running || now - last < 60_000) return;
  running = true;
  last = now;
  const jobs = [releaseDueAwards(), expireDuePoints(), recoverStaleRedemptions(), expireOldRedemptions(), purgeExpiredAuth()];
  // Review polling is slower: every 6 hours at most (webhooks cover real-time).
  if (now - lastReviews > 6 * 3600_000) {
    lastReviews = now;
    jobs.push(syncAllJudgeMe());
  }
  Promise.all(jobs)
    .catch((e) => console.warn("[sweep] fallback sweep failed:", e.message))
    .finally(() => {
      running = false;
    });
}
