import { useEffect } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { newToken } from "../lib/crypto.server";
import { requireStore } from "../services/auth.server";
import {
  connectJudgeMe,
  connectShiprocket,
  disconnect,
  getIntegration,
  syncJudgeMe,
  webhookUrl,
} from "../services/integrations.server";
import db from "../db.server";

const when = (d) => (d ? new Date(d).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "never");

export const loader = async ({ request }) => {
  const { store } = await requireStore(request);
  const [jm, sr, reviewRule] = await Promise.all([
    getIntegration(store.id, "JUDGEME"),
    getIntegration(store.id, "SHIPROCKET"),
    db.earnRule.findFirst({ where: { storeId: store.id, type: "REVIEW" } }),
  ]);
  return {
    appUrlOk: (process.env.SHOPIFY_APP_URL || "").startsWith("https://"),
    trigger: store.settings.earnTrigger,
    holdDays: store.settings.holdDays,
    reviewRule: reviewRule ? { active: reviewRule.active, value: reviewRule.value } : null,
    judgeme: jm && {
      enabled: jm.enabled && !!jm.secretEnc,
      minRating: jm.config?.minRating ?? 4,
      lastSync: when(jm.lastSyncAt),
      lastEvent: when(jm.lastEventAt),
      lastError: jm.lastError,
      url: webhookUrl("JUDGEME", jm),
    },
    shiprocket: sr && {
      enabled: sr.enabled,
      lastEvent: when(sr.lastEventAt),
      lastError: sr.lastError,
      url: webhookUrl("SHIPROCKET", sr),
      token: sr.webhookToken,
      url_base: webhookUrl("SHIPROCKET", sr).split("?")[0],
    },
  };
};

export const action = async ({ request }) => {
  const { store } = await requireStore(request);
  const f = await request.formData();
  const intent = String(f.get("intent"));

  try {
    if (intent === "judgeme-connect") {
      await connectJudgeMe({ store, apiToken: f.get("apiToken"), minRating: f.get("minRating") });
      return { ok: "Judge.me connected" };
    }
    if (intent === "judgeme-sync") {
      const jm = await getIntegration(store.id, "JUDGEME");
      if (!jm?.enabled) return { error: "Connect Judge.me first" };
      const r = await syncJudgeMe(jm);
      return { ok: `Checked ${r.processed} reviews, rewarded ${r.rewarded}` };
    }
    if (intent === "judgeme-disconnect") {
      await disconnect(store.id, "JUDGEME");
      return { ok: "Judge.me disconnected" };
    }
    if (intent === "shiprocket-enable") {
      await connectShiprocket({ store });
      return { ok: "Shiprocket enabled" };
    }
    if (intent === "shiprocket-disable") {
      await disconnect(store.id, "SHIPROCKET");
      return { ok: "Shiprocket disabled" };
    }
    if (intent === "shiprocket-rotate") {
      await db.integration.updateMany({
        where: { storeId: store.id, kind: "SHIPROCKET" },
        data: { webhookToken: newToken(24) },
      });
      return { ok: "New token created. Update it in Shiprocket." };
    }
  } catch (e) {
    return { error: e.message || "Something went wrong" };
  }
  return { error: "Unknown action" };
};

function useToast(fetcher) {
  const shopify = useAppBridge();
  useEffect(() => {
    if (fetcher.data?.ok) shopify.toast.show(fetcher.data.ok);
    if (fetcher.data?.error) shopify.toast.show(fetcher.data.error, { isError: true });
  }, [fetcher.data, shopify]);
}

function Status({ on, text }) {
  return <s-badge tone={on ? "success" : "neutral"}>{text ?? (on ? "Connected" : "Not connected")}</s-badge>;
}

function JudgeMe({ jm, reviewRule }) {
  const fetcher = useFetcher();
  useToast(fetcher);
  const busy = fetcher.state !== "idle" || undefined;
  const send = (intent) => fetcher.submit({ intent }, { method: "post" });

  return (
    <s-section heading="Judge.me — points for reviews">
      <s-stack gap="base">
        <s-stack direction="inline" gap="small" alignItems="center">
          <Status on={!!jm?.enabled} />
          {jm?.enabled && <s-text color="subdued">Last sync: {jm.lastSync}</s-text>}
        </s-stack>
        <s-paragraph>
          Members earn points when they leave a good product review on Judge.me. Each member is rewarded once per product,
          and only when we can be sure who they are (their store account, or an email they've verified with a login code).
        </s-paragraph>
        {!reviewRule?.active && (
          <s-banner tone="warning">
            Add an earning rule of type <s-text type="strong">Product review</s-text> on the{" "}
            <s-link href="/app/rules">Earning rules</s-link> page, set to active, or no points will be given.
          </s-banner>
        )}
        {jm?.lastError && <s-banner tone="critical">Last error: {jm.lastError}</s-banner>}

        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="judgeme-connect" />
          <s-stack gap="base">
            <s-grid gridTemplateColumns="repeat(auto-fit, minmax(220px, 1fr))" gap="base">
              <s-password-field
                label="Judge.me private API token"
                name="apiToken"
                placeholder={jm?.enabled ? "•••••••• (saved)" : "Paste your token"}
                details="Judge.me admin → Settings → General → Integrations → Judge.me API token (private)"
              />
              <s-number-field label="Minimum star rating" name="minRating" min="1" max="5" step="1" value={String(jm?.minRating ?? 4)} />
            </s-grid>
            <s-stack direction="inline" gap="small">
              <s-button type="submit" variant="primary" loading={busy}>
                {jm?.enabled ? "Update" : "Connect Judge.me"}
              </s-button>
              {jm?.enabled && (
                <>
                  <s-button onClick={() => send("judgeme-sync")} loading={busy}>
                    Sync now
                  </s-button>
                  <s-button tone="critical" variant="tertiary" onClick={() => send("judgeme-disconnect")}>
                    Disconnect
                  </s-button>
                </>
              )}
            </s-stack>
          </s-stack>
        </fetcher.Form>
        <s-text color="subdued">
          New reviews are picked up within 30 minutes (and instantly when Judge.me can push them to us). Your token is
          stored encrypted.
        </s-text>
      </s-stack>
    </s-section>
  );
}

function Shiprocket({ sr, trigger, holdDays, appUrlOk }) {
  const fetcher = useFetcher();
  useToast(fetcher);
  const busy = fetcher.state !== "idle" || undefined;
  const send = (intent) => fetcher.submit({ intent }, { method: "post" });
  const good = trigger === "DELIVERED";

  return (
    <s-section heading="Shiprocket — pay points after delivery">
      <s-stack gap="base">
        <s-stack direction="inline" gap="small" alignItems="center">
          <Status on={!!sr?.enabled} text={sr?.enabled ? "Enabled" : "Not enabled"} />
          {sr?.enabled && <s-text color="subdued">Last update from Shiprocket: {sr.lastEvent}</s-text>}
        </s-stack>
        <s-paragraph>
          Shiprocket tells us when a parcel is delivered or comes back. Points are then credited after the return window
          you set, and taken back if the parcel is returned to you (RTO), lost or cancelled.
        </s-paragraph>

        {!good && (
          <s-banner tone="warning">
            Your points are currently credited when the order is <s-text type="strong">{trigger.toLowerCase()}</s-text>, so
            Shiprocket delivery isn't used for crediting yet. Set “Credit points when” to{" "}
            <s-text type="strong">Order is delivered</s-text> on the <s-link href="/app/rules">Earning rules</s-link> page
            (return window now: {holdDays} days). Returns still cancel points either way.
          </s-banner>
        )}
        {good && (
          <s-banner tone="success">
            Points are credited {holdDays === 0 ? "as soon as" : `${holdDays} days after`} Shiprocket reports delivery.
          </s-banner>
        )}
        {!appUrlOk && (
          <s-banner tone="warning">
            The app's public address isn't https yet, so Shiprocket can't reach it. This is normal in local development
            until the tunnel is running.
          </s-banner>
        )}
        {sr?.lastError && <s-banner tone="critical">Last error: {sr.lastError}</s-banner>}

        {sr?.enabled ? (
          <s-stack gap="base">
            <s-text-field label="Webhook URL (paste into Shiprocket)" readOnly value={sr.url_base} />
            <s-text-field
              label="Security token (paste into Shiprocket's token field)"
              readOnly
              value={sr.token}
              details="Shiprocket: Settings → API → Webhooks → add the URL, switch it on, and enter this token. Or use the full URL below, which already includes it."
            />
            <s-text-field label="Full URL with token" readOnly value={sr.url} />
            <s-stack direction="inline" gap="small">
              <s-button onClick={() => send("shiprocket-rotate")} loading={busy}>
                Create a new token
              </s-button>
              <s-button tone="critical" variant="tertiary" onClick={() => send("shiprocket-disable")}>
                Disable
              </s-button>
            </s-stack>
            <s-text color="subdued">
              Orders are matched by AWB number (copied from the Shopify fulfillment) or by order number, so make sure
              Shiprocket syncs tracking back to Shopify.
            </s-text>
          </s-stack>
        ) : (
          <s-stack direction="inline">
            <s-button variant="primary" onClick={() => send("shiprocket-enable")} loading={busy}>
              Enable Shiprocket
            </s-button>
          </s-stack>
        )}
      </s-stack>
    </s-section>
  );
}

export default function Integrations() {
  const { judgeme, shiprocket, reviewRule, trigger, holdDays, appUrlOk } = useLoaderData();
  return (
    <s-page heading="Integrations">
      <JudgeMe jm={judgeme} reviewRule={reviewRule} />
      <Shiprocket sr={shiprocket} trigger={trigger} holdDays={holdDays} appUrlOk={appUrlOk} />
    </s-page>
  );
}
