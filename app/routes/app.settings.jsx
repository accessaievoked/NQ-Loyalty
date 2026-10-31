import { useEffect } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { requireStore } from "../services/auth.server";
import { sendNotification, smtpConfigured } from "../services/mailer.server";
import { getRedis } from "../queue/queue.server";
import { REPORT_CURRENCIES, getFx, refreshRate, setDisplayCurrency, setManualRate, switchToLiveRate } from "../services/currency.server";
import db from "../db.server";

async function redisUp() {
  try {
    const pong = await Promise.race([
      getRedis().ping(),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 1500)),
    ]);
    return pong === "PONG";
  } catch {
    return false;
  }
}

export const loader = async ({ request }) => {
  const { store, session } = await requireStore(request);
  const s = store.settings;
  const fx = await getFx(store);
  return {
    currency: {
      store: store.currency,
      display: fx.converted ? fx.to : store.currency,
      options: { [store.currency]: `${store.currency} — your store currency`, ...Object.fromEntries(Object.entries(REPORT_CURRENCIES).filter(([k]) => k !== store.currency)) },
      converted: fx.converted,
      rate: fx.rate,
      manual: !!fx.manual,
      stale: !!fx.stale,
      error: fx.error,
      updatedAt: fx.updatedAt ? new Date(fx.updatedAt).toISOString().slice(0, 16).replace("T", " ") + " UTC" : null,
    },
    smtp: smtpConfigured(),
    redis: await redisUp(),
    storeEmail: store.email || session.email || "",
    settings: {
      emailsEnabled: s.emailsEnabled,
      notifyPointsEarned: s.notifyPointsEarned,
      notifyRedeemed: s.notifyRedeemed,
      notifyExpiring: s.notifyExpiring,
      expiryReminderDays: s.expiryReminderDays,
      senderName: s.senderName || "",
      replyTo: s.replyTo || "",
      expiryDays: s.expiryDays,
    },
  };
};

export const action = async ({ request }) => {
  const { store } = await requireStore(request);
  const f = await request.formData();

  if (f.get("intent") === "test") {
    const to = String(f.get("to") || "").trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return { error: "Enter a valid email address" };
    try {
      const res = await sendNotification({ store, kind: "test", to, dedupeKey: `test:${Date.now()}`, data: {} });
      if (res.skipped === "smtp-not-configured") return { error: "SMTP isn't configured on the server" };
      return { ok: `Test email sent to ${to}` };
    } catch (e) {
      return { error: `Could not send: ${e.message}` };
    }
  }

  // Reporting currency (admin reports only; rewards and customer-facing amounts stay in the store currency)
  const intent = f.get("intent");
  try {
    if (intent === "currency-save") {
      const chosen = await setDisplayCurrency(store, String(f.get("displayCurrency") || ""));
      return { ok: chosen ? `Reports will show ${chosen}` : `Reports will show ${store.currency}` };
    }
    if (intent === "fx-refresh") {
      const rate = await refreshRate(store);
      return { ok: `Updated: 1 ${store.currency} = ${rate.toFixed(4)}` };
    }
    if (intent === "fx-manual") {
      await setManualRate(store, f.get("rate"));
      return { ok: "Using your rate" };
    }
    if (intent === "fx-live") {
      await switchToLiveRate(store);
      return { ok: "Back to the live rate" };
    }
  } catch (e) {
    return { error: e.message || "Couldn't update the currency" };
  }

  const on = (k) => f.get(k) === "on";
  await db.storeSettings.update({
    where: { storeId: store.id },
    data: {
      emailsEnabled: on("emailsEnabled"),
      notifyPointsEarned: on("notifyPointsEarned"),
      notifyRedeemed: on("notifyRedeemed"),
      notifyExpiring: on("notifyExpiring"),
      expiryReminderDays: Math.max(1, Math.min(90, Math.floor(Number(f.get("expiryReminderDays"))) || 7)),
      senderName: String(f.get("senderName") || "").trim().slice(0, 60) || null,
      replyTo: String(f.get("replyTo") || "").trim().slice(0, 120) || null,
    },
  });
  return { ok: "Settings saved" };
};

export default function Settings() {
  const { settings, smtp, redis, storeEmail, currency } = useLoaderData();
  const save = useFetcher();
  const test = useFetcher();
  const fxf = useFetcher();
  const shopify = useAppBridge();

  useEffect(() => {
    for (const f of [save, test, fxf]) {
      if (f.data?.ok) shopify.toast.show(f.data.ok);
      if (f.data?.error) shopify.toast.show(f.data.error, { isError: true });
    }
  }, [save, test, fxf, save.data, test.data, fxf.data, shopify]);

  return (
    <s-page heading="Emails & settings">
      <s-section heading="Reporting currency">
        <s-stack gap="base">
          <s-paragraph>
            Your store sells in <s-text type="strong">{currency.store}</s-text>, so orders, rewards and discount codes always use it. For
            reports (analytics and referral revenue) you can view the figures in another currency; they're simply converted at an exchange
            rate. What your customers see is never converted.
          </s-paragraph>
          <fxf.Form method="post">
            <input type="hidden" name="intent" value="currency-save" />
            <s-stack direction="inline" gap="small" alignItems="end">
              <s-select label="Show reports in" name="displayCurrency" value={currency.display}>
                {Object.entries(currency.options).map(([code, label]) => (
                  <s-option key={code} value={code}>
                    {label}
                  </s-option>
                ))}
              </s-select>
              <s-button type="submit" loading={fxf.state !== "idle" || undefined}>
                Save
              </s-button>
            </s-stack>
          </fxf.Form>

          {currency.converted && (
            <s-stack gap="small">
              <s-text>
                1 {currency.store} = <s-text type="strong">{currency.rate.toFixed(4)}</s-text> {currency.display}{" "}
                <s-badge tone={currency.manual ? "info" : currency.stale ? "warning" : "success"}>
                  {currency.manual ? "your own rate" : currency.stale ? "last saved rate" : "live rate"}
                </s-badge>
                {currency.updatedAt ? <s-text color="subdued"> · {currency.updatedAt}</s-text> : null}
              </s-text>
              {currency.error && <s-banner tone="warning">{currency.error}</s-banner>}
              <fxf.Form method="post">
                <input type="hidden" name="intent" value="fx-manual" />
                <s-stack direction="inline" gap="small" alignItems="end">
                  <s-number-field label={`Use my own rate (1 ${currency.store} = ? ${currency.display})`} name="rate" min="0" step="any" />
                  <s-button type="submit">Use this rate</s-button>
                </s-stack>
              </fxf.Form>
              <s-stack direction="inline" gap="small">
                <s-button onClick={() => fxf.submit({ intent: "fx-refresh" }, { method: "post" })}>Refresh live rate</s-button>
                {currency.manual && <s-button variant="tertiary" onClick={() => fxf.submit({ intent: "fx-live" }, { method: "post" })}>Go back to the live rate</s-button>}
              </s-stack>
              <s-text color="subdued">Live rates come from a free public service and refresh once a day.</s-text>
            </s-stack>
          )}
        </s-stack>
      </s-section>

      <s-section heading="Customer emails">
        <save.Form method="post">
          <s-stack gap="base">
            <s-checkbox label="Send loyalty emails" name="emailsEnabled" value="on" checked={settings.emailsEnabled} />
            <s-stack gap="small-200">
              <s-checkbox label="Points earned" name="notifyPointsEarned" value="on" checked={settings.notifyPointsEarned} />
              <s-checkbox label="Reward code issued" name="notifyRedeemed" value="on" checked={settings.notifyRedeemed} />
              <s-checkbox label="Points expiring soon" name="notifyExpiring" value="on" checked={settings.notifyExpiring} />
            </s-stack>
            <s-grid gridTemplateColumns="repeat(auto-fit, minmax(200px, 1fr))" gap="base">
              <s-number-field
                label="Warn this many days before points expire"
                name="expiryReminderDays"
                min="1"
                max="90"
                value={String(settings.expiryReminderDays)}
                details={settings.expiryDays === 0 ? "Points never expire right now (see Earning rules)" : undefined}
              />
              <s-text-field label="Sender name" name="senderName" value={settings.senderName} placeholder="Defaults to your store name" />
              <s-email-field label="Reply-to address" name="replyTo" value={settings.replyTo} />
            </s-grid>
            <s-stack direction="inline" justifyContent="end">
              <s-button type="submit" variant="primary" loading={save.state !== "idle" || undefined}>
                Save
              </s-button>
            </s-stack>
          </s-stack>
        </save.Form>
      </s-section>

      <s-section heading="Email templates">
        <s-stack gap="base">
          <s-paragraph>
            Change how each email looks and reads — with blocks or your own HTML — with a live preview and test sends.
          </s-paragraph>
          <s-stack direction="inline">
            <s-button href="/app/emails" variant="primary">Edit email templates</s-button>
          </s-stack>
        </s-stack>
      </s-section>

      <s-section heading="Send a test email">
        <test.Form method="post">
          <input type="hidden" name="intent" value="test" />
          <s-stack direction="inline" gap="small" alignItems="end">
            <s-email-field label="Send to" name="to" value={storeEmail} />
            <s-button type="submit" loading={test.state !== "idle" || undefined}>
              Send test
            </s-button>
          </s-stack>
        </test.Form>
      </s-section>

      <s-section slot="aside" heading="System status">
        <s-stack gap="small">
          <s-stack direction="inline" gap="small" alignItems="center">
            <s-badge tone={smtp ? "success" : "critical"}>{smtp ? "Connected" : "Missing"}</s-badge>
            <s-text>Email (SMTP)</s-text>
          </s-stack>
          <s-stack direction="inline" gap="small" alignItems="center">
            <s-badge tone={redis ? "success" : "critical"}>{redis ? "Connected" : "Offline"}</s-badge>
            <s-text>Background jobs (Redis)</s-text>
          </s-stack>
          {!redis && (
            <s-text color="subdued">
              Delayed point release needs Redis and the worker running. Run <s-text type="strong">npm run redis</s-text>{" "}
              and <s-text type="strong">npm run worker</s-text>.
            </s-text>
          )}
        </s-stack>
      </s-section>
    </s-page>
  );
}
