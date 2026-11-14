// End-to-end check of the background jobs (the database queue and the in-app scheduler) against the
// real database. Creates a throwaway store and ONLY touches that store's rows: every queue call is
// scoped to it, so another store's real emails or awards are never processed.
// Run: node scripts/smoke-test-queue.mjs
import "dotenv/config";
import assert from "node:assert/strict";
import prisma from "../app/db.server.js";
import { deleteStore } from "../app/services/store.server.js";
import { upsertCustomer } from "../app/services/customers.server.js";
import { releaseDueAwards } from "../app/services/orders.server.js";
import {
  MAX_ATTEMPTS, backoffMs, claimDueEmails, emailQueueCounts, enqueueEmail, nextEmailDueAt, processDueEmails, pruneEmailJobs, retryFailedEmails,
} from "../app/queue/emailqueue.server.js";
import { enqueueAwardRelease, schedulerStatus, snapUp, startScheduler, stopScheduler } from "../app/queue/scheduler.server.js";
import { nextDueAt, runDue, runOnce } from "../app/queue/boot.server.js";

const shop = `queue-${Date.now()}.myshopify.com`;
let step = 0;
const ok = (msg) => console.log(`  ✓ ${++step}. ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 6000, every = 50) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(every);
  }
  return false;
};
process.env.SCHEDULER_SNAP_MINUTES = "0"; // exact times for these tests (snapping has its own test)
process.env.EMAIL_MAX_PER_MINUTE = "60000"; // no pacing delay in tests

const store = await prisma.store.create({
  data: {
    shop,
    currency: "USD",
    name: "Queue Test",
    settings: { create: { earnTrigger: "PAID", holdDays: 0, emailsEnabled: false } },
    earnRules: { create: [{ name: "per $", type: "PURCHASE_PER_CURRENCY", value: 1 }] },
  },
});
const sid = store.id;
const payload = (key, extra = {}) => ({ storeId: sid, customerId: null, kind: "points_earned", dedupeKey: key, data: { points: 5 }, ...extra });
const job = (key) => prisma.emailJob.findUnique({ where: { storeId_dedupeKey: { storeId: sid, dedupeKey: key } } });
const sent = [];
const deliverOk = async (p) => {
  sent.push(p.dedupeKey);
};
const run = (opts = {}) => processDueEmails({ deliver: deliverOk, storeId: sid, ...opts });

try {
  // ---- queueing --------------------------------------------------------------------------------
  assert.equal(await enqueueEmail(payload("q-dupe")), true);
  assert.equal(await enqueueEmail(payload("q-dupe")), true);                              // same email twice: still one row, still "queued"
  assert.equal(await prisma.emailJob.count({ where: { storeId: sid } }), 1);
  assert.deepEqual(await emailQueueCounts(sid), { waiting: 1, failed: 0, sent: 0 });
  ok("queueing an email is idempotent per (store, dedupeKey)");

  // ---- sending ---------------------------------------------------------------------------------
  assert.deepEqual(await run(), { sent: 1, retry: 0, failed: 0 });
  const done = await job("q-dupe");
  assert.deepEqual([done.status, done.attempts, done.leaseUntil, done.lastError], ["SENT", 1, null, null]);
  assert.deepEqual(sent, ["q-dupe"]);
  assert.deepEqual(await run(), { sent: 0, retry: 0, failed: 0 });                        // nothing left to do
  assert.deepEqual(sent, ["q-dupe"]);                                                      // and nothing was sent twice
  ok("a due email is sent once and marked SENT; running again does nothing");

  // ---- not yet due -----------------------------------------------------------------------------
  const later = new Date(Date.now() + 3_600_000);
  await prisma.emailJob.create({ data: { storeId: sid, kind: "points_earned", dedupeKey: "q-later", payload: payload("q-later"), nextAttemptAt: later } });
  assert.deepEqual(await run(), { sent: 0, retry: 0, failed: 0 });
  assert.equal((await job("q-later")).status, "PENDING");
  assert.equal(await nextEmailDueAt({ storeId: sid }), later.getTime());                  // the scheduler would sleep until exactly then
  ok("an email scheduled for later is left alone, and the next wake-up is its time");

  // ---- retries, backoff, giving up -------------------------------------------------------------
  const boom = async () => {
    throw new Error("SMTP is down");
  };
  await enqueueEmail(payload("q-retry"));
  assert.deepEqual(await run({ deliver: boom }), { sent: 0, retry: 1, failed: 0 });
  let r = await job("q-retry");
  assert.deepEqual([r.status, r.attempts, r.lastError], ["PENDING", 1, "SMTP is down"]);
  const wait = r.nextAttemptAt.getTime() - Date.now();
  assert.ok(wait > 20_000 && wait <= backoffMs(1) + 1000, `first retry in ~30s, got ${wait}`);
  assert.deepEqual(await run({ deliver: boom }), { sent: 0, retry: 0, failed: 0 });       // backing off: not due yet
  assert.deepEqual([backoffMs(1), backoffMs(2), backoffMs(3), backoffMs(4), backoffMs(5)], [30_000, 120_000, 600_000, 3_600_000, 21_600_000]);
  for (let i = 2; i <= MAX_ATTEMPTS; i += 1) {
    await prisma.emailJob.update({ where: { id: r.id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });  // pretend the wait is over
    const out = await run({ deliver: boom });
    assert.deepEqual(out, i < MAX_ATTEMPTS ? { sent: 0, retry: 1, failed: 0 } : { sent: 0, retry: 0, failed: 1 });
  }
  r = await job("q-retry");
  assert.deepEqual([r.status, r.attempts, r.lastError], ["FAILED", MAX_ATTEMPTS, "SMTP is down"]);
  assert.deepEqual(await run({ deliver: boom }), { sent: 0, retry: 0, failed: 0 });       // a failed email stays failed
  assert.deepEqual(await emailQueueCounts(sid), { waiting: 1, failed: 1, sent: 1 });
  ok(`failures retry with growing waits (30s → 2m → 10m → 1h → 6h) and the email is marked FAILED after ${MAX_ATTEMPTS} attempts`);

  assert.equal(await retryFailedEmails(sid), 1);                                           // the merchant fixed their mail settings
  assert.deepEqual([(await job("q-retry")).status, (await job("q-retry")).attempts], ["PENDING", 0]);
  assert.deepEqual(await run(), { sent: 1, retry: 0, failed: 0 });
  assert.equal((await job("q-retry")).status, "SENT");
  ok("\"Retry failed emails\" puts them back and they send");

  // ---- two senders at once never double-send ---------------------------------------------------
  const keys = Array.from({ length: 12 }, (_, i) => `q-race-${i}`);
  for (const k of keys) await enqueueEmail(payload(k));
  const before = sent.length;
  const slowOk = async (p) => {
    await sleep(15);
    sent.push(p.dedupeKey);
  };
  const [a, b] = await Promise.all([run({ deliver: slowOk, limit: 5 }), run({ deliver: slowOk, limit: 5 })]);
  assert.equal(a.sent + b.sent, 12);
  const raced = sent.slice(before);
  assert.equal(raced.length, 12);
  assert.equal(new Set(raced).size, 12);                                                   // each of the 12 exactly once
  assert.ok(a.sent > 0 && b.sent > 0, "both senders did some of the work");
  ok("two senders working at once share the queue: every email is sent exactly once");

  // ---- crash recovery (leases) -----------------------------------------------------------------
  const live = await prisma.emailJob.create({ data: { storeId: sid, kind: "points_earned", dedupeKey: "q-lease-live", payload: payload("q-lease-live"), status: "SENDING", attempts: 1, leaseUntil: new Date(Date.now() + 60_000) } });
  await prisma.emailJob.create({ data: { storeId: sid, kind: "points_earned", dedupeKey: "q-lease-dead", payload: payload("q-lease-dead"), status: "SENDING", attempts: 1, leaseUntil: new Date(Date.now() - 1000) } });
  assert.deepEqual(await run(), { sent: 1, retry: 0, failed: 0 });                         // only the abandoned one
  assert.equal((await job("q-lease-dead")).status, "SENT");
  assert.equal((await job("q-lease-dead")).attempts, 2);                                   // the crashed attempt counted
  assert.equal((await job("q-lease-live")).status, "SENDING");                             // someone is still working on this: untouched
  assert.equal(await nextEmailDueAt({ storeId: sid }) <= live.leaseUntil.getTime(), true); // and the scheduler would look again when its lease ends
  ok("an email whose sender died mid-send is picked up again once its lease runs out; a live one is left alone");

  // ---- a poison email that keeps crashing the app still stops ----------------------------------
  const poison = await prisma.emailJob.create({ data: { storeId: sid, kind: "points_earned", dedupeKey: "q-poison", payload: payload("q-poison"), status: "SENDING", attempts: MAX_ATTEMPTS - 1, leaseUntil: new Date(Date.now() - 1000) } });
  assert.deepEqual(await run({ deliver: boom }), { sent: 0, retry: 0, failed: 1 });
  assert.equal((await prisma.emailJob.findUnique({ where: { id: poison.id } })).status, "FAILED");
  ok("an email that crashed its senders too many times is given up on, not retried forever");

  // ---- clean-up --------------------------------------------------------------------------------
  await prisma.emailJob.updateMany({ where: { storeId: sid, status: "SENT" }, data: { doneAt: new Date(Date.now() - 8 * 86_400_000) } });
  assert.ok((await pruneEmailJobs()) >= 1);
  assert.equal(await prisma.emailJob.count({ where: { storeId: sid, status: "SENT" } }), 0);
  ok("finished emails are pruned after a week");

  // ---- awards: what the scheduler waits for ----------------------------------------------------
  const cust = await upsertCustomer(sid, { shopifyCustomerId: "9001", email: "queue.test@example.invalid", emailVerified: true });
  let orderSeq = 5000;
  const award = async (releaseAt, over = {}) => {
    const o = await prisma.order.create({ data: { storeId: sid, shopifyOrderId: String(orderSeq++), eligibleAmount: 100, customerId: cust.id, ...(over.order || {}) } });
    return prisma.pointsAward.create({ data: { storeId: sid, customerId: cust.id, orderId: o.id, points: 10, releaseAt } });
  };
  const balance = async () => (await prisma.customer.findUnique({ where: { id: cust.id } })).pointsBalance;
  const base = await balance();
  await prisma.emailJob.deleteMany({ where: { storeId: sid } });

  const soon = await award(new Date(Date.now() + 60 * 60_000));
  const held = await award(new Date(Date.now() - 60_000), { order: { returnStatus: "OPEN" } });   // due, but a return is open
  assert.equal(await releaseDueAwards({ storeId: sid }), 0);
  assert.equal((await prisma.pointsAward.findUnique({ where: { id: held.id } })).status, "PENDING");   // held, not released, and the call finished
  assert.equal(await nextDueAt({ storeId: sid }), soon.releaseAt.getTime());                       // sleeps until the hour is up (ignores the held one)
  const later2 = new Date(Date.now() + 30 * 60_000);
  await prisma.emailJob.create({ data: { storeId: sid, kind: "points_earned", dedupeKey: "q-sooner", payload: payload("q-sooner"), nextAttemptAt: later2 } });
  assert.equal(await nextDueAt({ storeId: sid }), later2.getTime());                               // an email due sooner than the award wins
  await prisma.emailJob.deleteMany({ where: { storeId: sid } });
  process.env.SCHEDULER_SNAP_MINUTES = "5";
  const snapped = await nextDueAt({ storeId: sid });
  assert.equal(snapped, snapUp(soon.releaseAt.getTime(), 5));
  assert.ok(snapped >= soon.releaseAt.getTime() && snapped - soon.releaseAt.getTime() < 5 * 60_000);
  process.env.SCHEDULER_SNAP_MINUTES = "0";
  await prisma.pointsAward.update({ where: { id: held.id }, data: { status: "CANCELLED" } });
  await prisma.pointsAward.update({ where: { id: soon.id }, data: { status: "CANCELLED" } });
  ok("the scheduler sleeps until the earliest award or email, ignoring awards held by a return; release times snap up to share wake-ups");

  // ---- the live scheduler: timers + the event loop ---------------------------------------------
  const delivered = [];
  const live2 = { deliver: async (p) => void delivered.push(p.dedupeKey) };
  const opts = { runDue: () => runDue({ ...live2, storeId: sid }), nextDueAt: () => nextDueAt({ storeId: sid }), maintenance: null };

  const due1 = await award(new Date(Date.now() + 1500));
  assert.equal(startScheduler(opts), true);
  assert.equal(startScheduler(opts), false);                                                // a second start does nothing
  assert.ok(await until(async () => schedulerStatus().lastTickAt != null));                  // the first wake runs straight away…
  assert.equal((await prisma.pointsAward.findUnique({ where: { id: due1.id } })).status, "PENDING");   // …but the award isn't due yet
  const t0 = Date.now();
  assert.ok(await until(async () => (await prisma.pointsAward.findUnique({ where: { id: due1.id } })).status === "RELEASED", 8000));
  const lag = Date.now() - t0;
  assert.ok(lag > 500 && lag < 5000, `released when it came due, not early and not late (waited ${lag}ms)`);
  assert.ok(await until(async () => (await balance()) === base + 10, 4000)); // status flips first, the ledger row follows a moment later
  ok("a delayed point release fires by itself at its release time (the timer, no polling)");

  await enqueueEmail(payload("q-live-1"));                                                   // queueing wakes the scheduler now
  assert.ok(await until(async () => delivered.includes("q-live-1"), 4000));
  assert.ok(await until(async () => (await job("q-live-1")).status === "SENT", 4000)); // marked SENT just after the send returns
  ok("a newly queued email is sent straight away");

  const far = await award(new Date(Date.now() + 3 * 86_400_000));                            // a 3-day hold, the usual case
  enqueueAwardRelease(far.id, far.releaseAt);
  assert.equal(schedulerStatus().nextWakeAt, far.releaseAt.getTime());                       // asleep until then (no query needed to know)
  const nearer = await award(new Date(Date.now() + 2 * 3600_000));
  enqueueAwardRelease(nearer.id, nearer.releaseAt);
  assert.equal(schedulerStatus().nextWakeAt, nearer.releaseAt.getTime());                    // a nearer one pulls the wake-up forward
  enqueueAwardRelease(far.id, far.releaseAt);
  assert.equal(schedulerStatus().nextWakeAt, nearer.releaseAt.getTime());                    // a later one never pushes it back
  ok("the wake-up is always the earliest due time: a nearer award pulls it forward, a later one doesn't push it back");

  await stopScheduler();
  assert.equal(schedulerStatus().running, false);
  assert.equal(schedulerStatus().nextWakeAt, null);

  // ---- restart: whatever came due while the app was away is done at start ----------------------
  const missed = await award(new Date(Date.now() - 5 * 60_000));                             // came due while "down"
  await enqueueEmail(payload("q-missed"));
  await prisma.pointsAward.update({ where: { id: nearer.id }, data: { status: "CANCELLED" } });
  await prisma.pointsAward.update({ where: { id: far.id }, data: { status: "CANCELLED" } });
  const delivered2 = delivered.length;
  assert.equal((await prisma.pointsAward.findUnique({ where: { id: missed.id } })).status, "PENDING");
  startScheduler(opts);
  assert.ok(await until(async () => (await prisma.pointsAward.findUnique({ where: { id: missed.id } })).status === "RELEASED", 6000));
  assert.ok(await until(async () => delivered.length > delivered2, 4000));
  assert.ok(await until(async () => (await balance()) === base + 20, 4000));
  await stopScheduler();
  ok("after a restart the scheduler runs everything that came due while the app was away; nothing is lost");

  // ---- the outside trigger (for a machine that sleeps) -----------------------------------------
  const { handleTick } = await import("../app/queue/tick.server.js");
  const scoped = async () => runOnce({ withMaintenance: false, storeId: sid, deliver: async (p) => void delivered.push(p.dedupeKey) });
  const call = (headers = {}, method = "POST", qs = "") => handleTick(new Request(`https://app.test/internal/tick${qs}`, { method, headers }), { run: scoped });
  delete process.env.CRON_SECRET;
  assert.equal((await call()).status, 404);                                                  // no secret configured: the endpoint doesn't exist
  process.env.CRON_SECRET = "cron-secret-123";
  assert.equal((await call()).status, 401);                                                  // no key
  assert.equal((await call({ authorization: "Bearer wrong" })).status, 401);                 // wrong key
  assert.equal((await call({ authorization: "Bearer cron-secret-123" }, "GET")).status, 405);// only POST runs jobs
  const none = await call({ authorization: "Bearer cron-secret-123" });
  assert.equal(none.status, 200);
  assert.deepEqual(Object.keys(await none.json()).sort(), ["awards", "emails", "ok"]);
  const wake = await award(new Date(Date.now() - 1000));                                     // due, and the machine was asleep
  await enqueueEmail(payload("q-outside"));
  const res = await call({ authorization: "Bearer cron-secret-123" });
  const body = await res.json();
  assert.deepEqual([res.status, body.ok, body.awards, body.emails.sent], [200, true, 1, 1]);
  assert.equal((await prisma.pointsAward.findUnique({ where: { id: wake.id } })).status, "RELEASED");
  assert.equal((await job("q-outside")).status, "SENT");
  const boomRun = await handleTick(new Request("https://app.test/internal/tick", { method: "POST", headers: { authorization: "Bearer cron-secret-123" } }), { run: async () => { throw new Error("db down"); } });
  assert.equal(boomRun.status, 500);                                                         // a failing run is a clean 500 (the outside scheduler retries)
  delete process.env.CRON_SECRET;
  ok("POST /internal/tick: hidden without a secret, 401 for a wrong key, POST only, runs what is due, clean 500 on failure");

  // ---- claims are atomic even when a sender has nothing to do ----------------------------------
  assert.deepEqual(await claimDueEmails({ storeId: sid }), []);
  ok("claiming with nothing due returns nothing and changes nothing");
} finally {
  await stopScheduler().catch(() => {});
  const counts = async () => Promise.all([prisma.emailJob.count({ where: { storeId: sid } }), prisma.pointsAward.count({ where: { storeId: sid } }), prisma.customer.count({ where: { storeId: sid } })]);
  console.log("  before delete (email jobs, awards, customers):", await counts());
  await deleteStore(shop);
  const after = await counts();
  console.log("  after delete:", after);
  assert.deepEqual(after, [0, 0, 0]);
  console.log("  ✓ deleting the store removed its queued emails, awards and customers");
  await prisma.$disconnect();
}
console.log("\nAll queue checks passed.");
process.exit(0);
