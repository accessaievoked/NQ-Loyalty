import prisma from "../db.server.js";
import { notifyCustomer } from "./notify.server.js";

/**
 * Which customers of one store have points expiring within `reminderDays`, and how many.
 * One entry per customer: all their soon-to-expire lots are summed, and `firstLotId` / `date`
 * describe the earliest one (the reminder's dedupe key is built from it).
 * Lots that have already expired belong to the expiry job, not here.
 */
export async function expiringBatches(storeId, reminderDays, now = new Date()) {
  const horizon = new Date(now.getTime() + reminderDays * 86400000);
  const lots = await prisma.pointsTransaction.findMany({
    where: { storeId, remaining: { gt: 0 }, expiresAt: { gt: now, lte: horizon } },
    orderBy: { expiresAt: "asc" },
    take: 2000,
  });
  const byCustomer = new Map();
  for (const lot of lots) {
    const g = byCustomer.get(lot.customerId) ?? { customerId: lot.customerId, points: 0, firstLotId: lot.id, date: lot.expiresAt.toISOString().slice(0, 10) };
    g.points += lot.remaining;
    byCustomer.set(lot.customerId, g);
  }
  return [...byCustomer.values()];
}

/**
 * Email customers whose points expire within the store's reminder window. One email per
 * customer per batch of expiring points (the dedupe key includes the earliest lot).
 */
export async function sendExpiryReminders(now = new Date()) {
  const stores = await prisma.storeSettings.findMany({
    where: { emailsEnabled: true, notifyExpiring: true, expiryDays: { gt: 0 }, store: { uninstalledAt: null } },
    select: { storeId: true, expiryReminderDays: true },
  });

  let sent = 0;
  for (const s of stores) {
    for (const b of await expiringBatches(s.storeId, s.expiryReminderDays, now)) {
      await notifyCustomer({
        storeId: s.storeId,
        customerId: b.customerId,
        kind: "expiring",
        dedupeKey: `expiring:${b.customerId}:${b.firstLotId}`,
        data: { points: b.points, expiresAt: b.date },
      });
      sent += 1;
    }
  }
  return sent;
}
