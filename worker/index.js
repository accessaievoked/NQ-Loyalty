// Background worker: node worker/index.js  (npm run worker)
//
// Jobs
//  - release-award : credit a PENDING award when its hold period ends (delayed job per award)
//  - send-email    : deliver a queued customer email (retried with backoff)
//  - sweep         : on start, then every 6 h — release due awards the delayed job missed,
//                    expire points, refund stuck redemptions, expire old codes
//  - judgeme-sync  : on start, then every 6 h, ONLY while a store has Judge.me connected
//  - reminders     : every 6 h — "your points expire soon" emails
import "dotenv/config";
import { Worker } from "bullmq";
import {
  SAFETY_NET_EVERY_MS,
  QUEUE_NAME,
  ensureJudgeMeSchedule,
  getQueue,
  getRedis,
  removeJudgeMeSchedule,
} from "../app/queue/queue.server.js";
import { releaseAward, releaseDueAwards } from "../app/services/orders.server.js";
import { expireDuePoints } from "../app/services/ledger.server.js";
import { deliverEmailJob } from "../app/services/notify.server.js";
import { sendExpiryReminders } from "../app/services/reminders.server.js";
import { recoverStaleRedemptions, expireOldRedemptions } from "../app/services/redeem.server.js";
import { countJudgeMeConnected, syncAllJudgeMe } from "../app/services/integrations.server.js";
import { purgeExpiredAuth } from "../app/services/identity.server.js";

const handlers = {
  "release-award": async (job) => {
    const tx = await releaseAward(job.data.awardId);
    return tx ? { credited: tx.points } : { skipped: true };
  },
  "send-email": async (job) => deliverEmailJob(job.data),
  sweep: async () => ({
    released: await releaseDueAwards(),
    expired: await expireDuePoints(),
    refundedStale: await recoverStaleRedemptions(),
    codesExpired: await expireOldRedemptions(),
    authPurged: await purgeExpiredAuth(),
  }),
  "judgeme-sync": async () => ({ rewarded: await syncAllJudgeMe() }),
  reminders: async () => ({ reminded: await sendExpiryReminders() }),
};

const worker = new Worker(
  QUEUE_NAME,
  async (job) => {
    const handler = handlers[job.name];
    if (!handler) throw new Error(`Unknown job ${job.name}`);
    return handler(job);
  },
  { connection: getRedis(), concurrency: 5 },
);

worker.on("completed", (job, result) => console.log(`[worker] ${job.name} ok`, result ?? ""));
worker.on("failed", (job, err) => console.error(`[worker] ${job?.name} failed (attempt ${job?.attemptsMade}):`, err.message));
worker.on("error", (err) => console.error("[worker] error", err.message));

const queue = getQueue();
// The sweep, the Judge.me poll and the expiry reminders are safety nets / batch work (the precise
// delayed jobs and webhooks do the real-time part), so they run once when the worker starts and
// then every 6 hours. That keeps a serverless database free to sleep in between.
// Older schedules are stored in Redis, so remove them or they would keep firing.
for (const old of ["sweep-every-5m", "sweep-hourly", "judgeme-every-30m"]) await queue.removeJobScheduler(old);
const oneOff = (name) => queue.add(name, {}, { jobId: `${name}-startup-${Date.now()}`, removeOnComplete: true, removeOnFail: 100 });

await queue.upsertJobScheduler("sweep-every-6h", { every: SAFETY_NET_EVERY_MS }, { name: "sweep" });
await queue.upsertJobScheduler("reminders-every-6h", { every: SAFETY_NET_EVERY_MS }, { name: "reminders" });
await oneOff("sweep");

// Judge.me is only polled while some store has it connected.
if ((await countJudgeMeConnected()) > 0) {
  await ensureJudgeMeSchedule();
  await oneOff("judgeme-sync");
} else {
  await removeJudgeMeSchedule();
}
console.log("[worker] started, listening on queue:", QUEUE_NAME);

const shutdown = async () => {
  await worker.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
