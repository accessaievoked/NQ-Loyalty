import { safeEqual } from "../lib/crypto.server.js";
import { runOnce } from "./boot.server.js";

// POST /internal/tick                  run everything due now (point releases, queued emails)
// POST /internal/tick?maintenance=1    also run the 6-hourly pass (expiry, reminders, reviews, clean-up)
//
// For a deployment where the machine SLEEPS between requests (so no in-app timer can fire): a free
// outside scheduler (GitHub Actions, cron-job.org…) calls this, which wakes the machine and runs what
// is due. Authenticated with `Authorization: Bearer $CRON_SECRET`; with no CRON_SECRET set the endpoint
// doesn't exist. Not needed when the app runs all the time: the in-app scheduler does this itself.

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

export async function handleTick(request, { run = runOnce } = {}) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return json({ error: "Not found" }, 404);
  if (request.method === "GET") return json({ error: "Use POST" }, 405);
  const given = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!given || !safeEqual(given, secret)) return json({ error: "Unauthorized" }, 401);
  try {
    const withMaintenance = new URL(request.url).searchParams.get("maintenance") === "1";
    return json({ ok: true, ...(await run({ withMaintenance })) });
  } catch (e) {
    console.error("[internal.tick]", e);
    return json({ error: "Something went wrong" }, 500);
  }
}
