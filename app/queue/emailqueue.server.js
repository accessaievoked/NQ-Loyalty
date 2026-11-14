import { Prisma } from "@prisma/client";
import prisma from "../db.server.js";
import { nudge } from "./scheduler.server.js";

// The email queue, in the database. One EmailJob row per email to send.
//
//   PENDING --claim--> SENDING --ok--> SENT
//                         |-- error, attempts left --> PENDING (nextAttemptAt = now + backoff)
//                         `-- error, out of attempts --> FAILED
//
// Claiming is a single UPDATE ... FOR UPDATE SKIP LOCKED, so two app instances (a deploy overlap,
// a second machine) can never send the same row. A claim carries a lease: if the app dies mid-send,
// the row is reclaimed once the lease runs out. Each claim counts as an attempt, so an email that
// keeps crashing the app still stops after MAX_ATTEMPTS.

export const MAX_ATTEMPTS = 6;
export const LEASE_MS = 2 * 60 * 1000;
const BACKOFF_MS = [30_000, 2 * 60_000, 10 * 60_000, 60 * 60_000, 6 * 60 * 60_000]; // after attempt 1, 2, 3, 4, 5

/** How long to wait before retrying after `attempts` failed attempts. */
export const backoffMs = (attempts) => BACKOFF_MS[Math.min(Math.max(attempts, 1), BACKOFF_MS.length) - 1];

const maxPerMinute = () => {
  const n = Number(process.env.EMAIL_MAX_PER_MINUTE);
  return Number.isFinite(n) && n > 0 ? n : 120;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Queue an email. Idempotent per (store, dedupeKey): queueing the same email twice does nothing.
 * Returns false only if the database refused, so the caller can send inline instead.
 */
export async function enqueueEmail(payload) {
  try {
    await prisma.emailJob.create({
      data: { storeId: payload.storeId, kind: payload.kind, customerId: payload.customerId ?? null, dedupeKey: payload.dedupeKey, payload },
    });
  } catch (e) {
    if (e?.code === "P2002") return true; // already queued or already sent
    console.warn("[queue] could not queue email:", e.message);
    return false;
  }
  nudge(); // send now (no-op when no scheduler runs in this process; it'll be found at the next wake)
  return true;
}

/**
 * Take up to `limit` due emails for this caller. Safe to run from several instances at once.
 * `storeId` limits it to one store (used by tests, so they never touch another store's mail).
 */
export async function claimDueEmails({ now = new Date(), limit = 25, leaseMs = LEASE_MS, storeId = null } = {}) {
  const leaseUntil = new Date(now.getTime() + leaseMs);
  const scope = storeId ? Prisma.sql`AND "storeId" = ${storeId}` : Prisma.empty;
  return prisma.$queryRaw`
    UPDATE "EmailJob"
       SET "status" = 'SENDING', "leaseUntil" = ${leaseUntil}, "attempts" = "attempts" + 1, "updatedAt" = ${now}
     WHERE "id" IN (
       SELECT "id" FROM "EmailJob"
        WHERE (("status" = 'PENDING' AND "nextAttemptAt" <= ${now})
           OR ("status" = 'SENDING' AND "leaseUntil" < ${now})) ${scope}
        ORDER BY "nextAttemptAt" ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED)
 RETURNING "id", "storeId", "payload", "attempts"`;
}

async function settle(job, error, now) {
  if (!error) {
    await prisma.emailJob.updateMany({
      where: { id: job.id, status: "SENDING" },
      data: { status: "SENT", doneAt: now, leaseUntil: null, lastError: null },
    });
    return "sent";
  }
  const lastError = String(error.message || error).slice(0, 500);
  if (job.attempts >= MAX_ATTEMPTS) {
    await prisma.emailJob.updateMany({ where: { id: job.id, status: "SENDING" }, data: { status: "FAILED", doneAt: now, leaseUntil: null, lastError } });
    return "failed";
  }
  await prisma.emailJob.updateMany({
    where: { id: job.id, status: "SENDING" },
    data: { status: "PENDING", leaseUntil: null, lastError, nextAttemptAt: new Date(now.getTime() + backoffMs(job.attempts)) },
  });
  return "retry";
}

/**
 * Send every email that is due. `deliver(payload)` does the sending and throws on failure.
 * Paced to EMAIL_MAX_PER_MINUTE (default 120) so a burst doesn't trip the mail provider's limits.
 */
export async function processDueEmails({ deliver, now = () => new Date(), limit = 25, maxBatches = 8, perMinute = maxPerMinute(), storeId = null } = {}) {
  const gap = Math.max(0, Math.ceil(60_000 / perMinute));
  const out = { sent: 0, retry: 0, failed: 0 };
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const jobs = await claimDueEmails({ now: now(), limit, storeId });
    if (!jobs.length) break;
    for (const job of jobs) {
      let error = null;
      try {
        await deliver(job.payload);
      } catch (e) {
        error = e;
      }
      out[await settle(job, error, now())] += 1;
      if (gap) await sleep(gap);
    }
    if (jobs.length < limit) break;
  }
  return out;
}

/** The earliest moment a queued email needs attention (a retry, or a lease that might have expired). */
export async function nextEmailDueAt({ storeId = null } = {}) {
  const scope = storeId ? { storeId } : {};
  const [pending, sending] = await Promise.all([
    prisma.emailJob.findFirst({ where: { status: "PENDING", ...scope }, orderBy: { nextAttemptAt: "asc" }, select: { nextAttemptAt: true } }),
    prisma.emailJob.findFirst({ where: { status: "SENDING", leaseUntil: { not: null }, ...scope }, orderBy: { leaseUntil: "asc" }, select: { leaseUntil: true } }),
  ]);
  const times = [pending?.nextAttemptAt, sending?.leaseUntil].filter(Boolean).map((d) => d.getTime());
  return times.length ? Math.min(...times) : null;
}

/** Counts for the admin screen. */
export async function emailQueueCounts(storeId) {
  const rows = await prisma.emailJob.groupBy({ by: ["status"], where: { storeId }, _count: true });
  const n = (s) => rows.find((r) => r.status === s)?._count ?? 0;
  return { waiting: n("PENDING") + n("SENDING"), failed: n("FAILED"), sent: n("SENT") };
}

/** Failed emails go back in the queue for another go (a merchant fixed their mail settings). */
export async function retryFailedEmails(storeId) {
  const r = await prisma.emailJob.updateMany({
    where: { storeId, status: "FAILED" },
    data: { status: "PENDING", attempts: 0, nextAttemptAt: new Date(), leaseUntil: null, doneAt: null },
  });
  if (r.count) nudge();
  return r.count;
}

/** Delete finished rows: sent after 7 days, failed after 30 (the Notification log keeps the record). */
export async function pruneEmailJobs(now = new Date()) {
  const day = 86_400_000;
  const [sent, failed] = await Promise.all([
    prisma.emailJob.deleteMany({ where: { status: "SENT", doneAt: { lt: new Date(now.getTime() - 7 * day) } } }),
    prisma.emailJob.deleteMany({ where: { status: "FAILED", doneAt: { lt: new Date(now.getTime() - 30 * day) } } }),
  ]);
  return sent.count + failed.count;
}
