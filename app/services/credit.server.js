import prisma from "../db.server.js";
import { postTransaction, expiryDate } from "./ledger.server.js";
import { notifyCustomer } from "./notify.server.js";

/**
 * Credit points that are not tied to an order award (signup, referral, review, manual), apply
 * the store's expiry setting, and email the customer. Idempotent on `key`.
 */
export async function creditPoints({ storeId, customerId, points, source, key, reason, type = "EARN", orderId, note, notify = true }) {
  if (!Number.isInteger(points) || points <= 0) return null;
  const settings = await prisma.storeSettings.findUnique({ where: { storeId } });
  const expiresAt = expiryDate(settings?.expiryDays ?? 0);
  const result = await postTransaction({
    storeId,
    customerId,
    type,
    points,
    source,
    idempotencyKey: key,
    expiresAt,
    orderId,
    note: note ?? reason,
  });
  if (!result.duplicate && notify) {
    await notifyCustomer({
      storeId,
      customerId,
      kind: "points_earned",
      dedupeKey: `credit:${key}`,
      data: {
        points,
        balance: result.transaction.balanceAfter,
        reason,
        expiresAt: expiresAt ? expiresAt.toISOString().slice(0, 10) : null,
      },
    });
  }
  return result;
}
