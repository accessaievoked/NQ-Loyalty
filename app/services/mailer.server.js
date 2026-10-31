import nodemailer from "nodemailer";
import prisma from "../db.server.js";
import { EMAIL_KINDS, renderEmail } from "../lib/email/templates.js";
import { buildEmailVars, renderStoreEmail } from "./emailtemplates.server.js";

let transporter;
function getTransporter() {
  if (!transporter) {
    const port = Number(process.env.SMTP_PORT || 465);
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: port === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  }
  return transporter;
}

export const smtpConfigured = () =>
  !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);

async function deliver({ store, settings, to, subject, html }) {
  const storeName = store.name || store.shop;
  const fromName = settings?.senderName || storeName;
  const fromAddr = process.env.MAIL_FROM || process.env.SMTP_USER;
  await getTransporter().sendMail({
    from: `"${fromName.replace(/"/g, "")}" <${fromAddr}>`,
    to,
    replyTo: settings?.replyTo || store.email || undefined,
    subject,
    html,
  });
}

/**
 * Send once per (store, dedupeKey). The Notification row is claimed first, so a retried job
 * can never double-send; if SMTP fails the claim is released so the job retry can resend.
 * The content comes from the store's template for this kind (or the built-in default).
 */
export async function sendNotification({ store, customerId = null, kind, to, dedupeKey, data }) {
  if (!to) return { skipped: "no-recipient" };
  if (!smtpConfigured()) return { skipped: "smtp-not-configured" };
  const settings = store.settings ?? (await prisma.storeSettings.findUnique({ where: { storeId: store.id } }));
  // Login codes and tests are transactional: they ignore the merchant's marketing toggles.
  if (!["test", "otp"].includes(kind) && settings && !settings.emailsEnabled) return { skipped: "disabled" };

  const { subject, html } =
    kind === "test"
      ? renderEmail("points_earned", undefined, { ...EMAIL_KINDS.points_earned.sample, store: store.name || store.shop })
      : await renderStoreEmail(store, kind, data);

  let row;
  try {
    row = await prisma.notification.create({
      data: { storeId: store.id, customerId, kind, toEmail: to, subject, status: "SENDING", dedupeKey },
    });
  } catch (e) {
    if (e?.code === "P2002") return { skipped: "duplicate" };
    throw e;
  }

  try {
    await deliver({ store, settings, to, subject, html });
    await prisma.notification.update({ where: { id: row.id }, data: { status: "SENT" } });
    return { sent: true };
  } catch (e) {
    await prisma.notification.delete({ where: { id: row.id } }).catch(() => {});
    throw e;
  }
}

/** Editor "Send test": render a draft template with sample data and send it to one address. */
export async function sendTemplateTest({ store, kind, template, to }) {
  if (!smtpConfigured()) throw new Error("SMTP isn't configured on the server");
  const settings = store.settings ?? (await prisma.storeSettings.findUnique({ where: { storeId: store.id } }));
  const vars = buildEmailVars(store, {});
  const sample = { ...EMAIL_KINDS[kind].sample, store: vars.store, shop_url: vars.shop_url };
  const { subject, html } = renderEmail(kind, template, sample);
  await deliver({ store, settings, to, subject: `[Test] ${subject}`, html });
}
