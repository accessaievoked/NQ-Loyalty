// BullMQ queues. The database is the source of truth (PointsAward.releaseAt); the queue only
// adds precise delayed delivery and retries. A repeating "sweep" job re-checks the database,
// so lost Redis data or a missed enqueue never leaves points stuck.
import { Queue } from "bullmq";
import IORedis from "ioredis";

let connection;
export function getRedis() {
  if (!connection) {
    connection = new IORedis(process.env.REDIS_URL || "redis://localhost:6379", {
      maxRetriesPerRequest: null, // required by BullMQ workers
      lazyConnect: false,
    });
    connection.on("error", (e) => console.warn("[redis]", e.message));
  }
  return connection;
}

export const QUEUE_NAME = "loyalty";

let queue;
export function getQueue() {
  if (!queue) queue = new Queue(QUEUE_NAME, { connection: getRedis() });
  return queue;
}

// ioredis buffers commands while Redis is down; don't let a webhook wait on that.
const withTimeout = (p, ms = 2500) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("redis timeout")), ms))]);

const retry = { attempts: 5, backoff: { type: "exponential", delay: 5000 }, removeOnComplete: 1000, removeOnFail: 5000 };

/** Schedule the release of a pending award. Deduped by award id. Never throws. */
export async function enqueueAwardRelease(awardId, releaseAt) {
  try {
    const delay = Math.max(0, new Date(releaseAt).getTime() - Date.now());
    await withTimeout(
      getQueue().add("release-award", { awardId }, { jobId: `award-${awardId}`, delay, ...retry }),
    );
  } catch (e) {
    console.warn("[queue] could not enqueue release-award (sweeper will pick it up):", e.message);
  }
}

export const SAFETY_NET_EVERY_MS = 6 * 60 * 60 * 1000; // sweep + Judge.me poll + reminders
const JUDGEME_SCHEDULE = "judgeme-poll-6h";

/**
 * Judge.me is polled only while at least one store has it connected, so stores that don't use it
 * cost nothing. Called when a merchant connects (and by the worker at start-up). Never throws.
 */
export async function ensureJudgeMeSchedule() {
  try {
    await withTimeout(getQueue().upsertJobScheduler(JUDGEME_SCHEDULE, { every: SAFETY_NET_EVERY_MS }, { name: "judgeme-sync" }));
  } catch (e) {
    console.warn("[queue] could not schedule Judge.me polling (the worker will on its next start):", e.message);
  }
}

export async function removeJudgeMeSchedule() {
  try {
    await withTimeout(getQueue().removeJobScheduler(JUDGEME_SCHEDULE));
  } catch (e) {
    console.warn("[queue] could not remove Judge.me polling:", e.message);
  }
}

/** Queue an email. Returns false if Redis is unreachable so the caller can send inline. */
export async function enqueueEmail(payload, jobId) {
  try {
    await withTimeout(
      getQueue().add("send-email", payload, { jobId: String(jobId).replace(/:/g, "-"), ...retry }),
    );
    return true;
  } catch (e) {
    console.warn("[queue] could not enqueue email:", e.message);
    return false;
  }
}
