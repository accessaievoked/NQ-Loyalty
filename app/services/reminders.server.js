import prisma from "../db.server.js";
import { notifyCustomer } from "./notify.server.js";

/**
 * Email customers whose points expire within the store's reminder window. One email per
 * customer per batch of expiring lots (dedupe key includes the earliest lot id).
 */
export async function sendExpiryReminders(now = new Date()) {
  const stores = await prisma.storeSettings.findMany({
    where: { emailsEnabled: true, notifyExpiring: true, expiryDays: { gt: 0 }, store: { uninstalledAt: null } },
    select: { storeId: true, expiryReminderDays: true },
  });

  let sent = 0;
  for (const s of stores) {
    const horizon = new Date(now.getTime() + s.expiryReminderDays * 86400000);
    const lots = await prisma.pointsTransaction.findMany({
      where: { storeId: s.storeId, remaining: { gt: 0 }, expiresAt: { gt: now, lte: horizon } },
      orderBy: { expiresAt: "asc" },
      take: 2000,
    });
    const byCustomer = new Map();
    for (const lot of lots) {
      const g = byCustomer.get(lot.customerId) ?? { points: 0, first: lot };
      g.points += lot.remaining;
      byCustomer.set(lot.customerId, g);
    }
    for (const [customerId, g] of byCustomer) {
      await notifyCustomer({
        storeId: s.storeId,
        customerId,
        kind: "expiring",
        dedupeKey: `expiring:${customerId}:${g.first.id}`,
        data: { points: g.points, expiresAt: g.first.expiresAt.toISOString().slice(0, 10) },
      });
      sent += 1;
    }
  }
  return sent;
}
