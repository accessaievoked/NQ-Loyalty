import prisma from "../db.server.js";
import { enqueueEmail } from "../queue/emailqueue.server.js";
import { sendNotification } from "./mailer.server.js";

const TOGGLE = {
  points_earned: "notifyPointsEarned",
  redeemed: "notifyRedeemed",
  expiring: "notifyExpiring",
};

/** Queue a customer email (or, if the database refuses the queue row, send it directly). Never throws. */
export async function notifyCustomer({ storeId, customerId, kind, dedupeKey, data }) {
  try {
    const customer = await prisma.customer.findUnique({ where: { id: customerId } });
    const settings = await prisma.storeSettings.findUnique({ where: { storeId } });
    if (!customer?.email || customer.emailOptOut) return;
    if (!settings?.emailsEnabled || settings[TOGGLE[kind]] === false) return;

    const payload = { storeId, customerId, kind, dedupeKey, data };
    const queued = await enqueueEmail(payload);
    if (!queued) await deliverEmailJob(payload);
  } catch (e) {
    console.warn("[notify] failed", kind, e.message);
  }
}

/** Runs from the email queue (or as the inline fallback). Throws on a failure so the queue retries it. */
export async function deliverEmailJob({ storeId, customerId, kind, dedupeKey, data }) {
  const store = await prisma.store.findUnique({ where: { id: storeId }, include: { settings: true } });
  const customer = customerId ? await prisma.customer.findUnique({ where: { id: customerId } }) : null;
  if (!store || !customer?.email) return;
  return sendNotification({
    store,
    customerId,
    kind,
    to: customer.email,
    dedupeKey,
    data: { firstName: customer.firstName, ...data },
  });
}
