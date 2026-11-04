import { useEffect } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { requireStore } from "../services/auth.server";
import db from "../db.server";
import { TEMPLATES } from "../lib/widget/defaults";
import { getWidgetConfig } from "../services/store.server";

export const loader = async ({ request }) => {
  const { store, session } = await requireStore(request);
  return {
    shop: session.shop,
    apiKey: process.env.SHOPIFY_API_KEY || "",
    mode: store.settings.displayMode,
    template: getWidgetConfig(store.settings).template,
  };
};

export const action = async ({ request }) => {
  const { store } = await requireStore(request);
  const f = await request.formData();
  const displayMode = f.get("mode") === "PAGE" ? "PAGE" : "WIDGET";
  await db.storeSettings.update({ where: { storeId: store.id }, data: { displayMode } });
  return { ok: displayMode === "PAGE" ? "Rewards page selected" : "Floating widget selected" };
};

function ModeCard({ value, title, text, current, onPick, children }) {
  const active = current === value;
  return (
    <s-box padding="base" border={active ? "large" : "base"} borderRadius="large" background={active ? "subdued" : "base"}>
      <s-stack gap="base">
        <s-stack direction="inline" justifyContent="space-between" alignItems="center">
          <s-heading>{title}</s-heading>
          {active && <s-badge tone="success">In use</s-badge>}
        </s-stack>
        <s-paragraph>{text}</s-paragraph>
        {children}
        <s-button variant={active ? "secondary" : "primary"} disabled={active || undefined} onClick={() => onPick(value)}>
          {active ? "Selected" : `Use ${title.toLowerCase()}`}
        </s-button>
      </s-stack>
    </s-box>
  );
}

export default function Appearance() {
  const { mode, shop, apiKey, template } = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();

  useEffect(() => {
    if (fetcher.data?.ok) shopify.toast.show(fetcher.data.ok);
  }, [fetcher.data, shopify]);

  const current = fetcher.formData?.get("mode") ?? mode;
  const pick = (value) => fetcher.submit({ mode: value }, { method: "post" });
  const embedUrl = `https://${shop}/admin/themes/current/editor?context=apps&activateAppId=${apiKey}/loyalty-embed`;

  return (
    <s-page heading="Storefront appearance">
      <s-button slot="primary-action" variant="primary" href="/app/appearance/editor">
        Open editor
      </s-button>

      <s-section heading="How should customers see your program?">
        <s-grid gridTemplateColumns="repeat(auto-fit, minmax(280px, 1fr))" gap="base">
          <ModeCard
            value="WIDGET"
            title="Floating widget"
            text="A button on every page that opens a rewards overlay. Customers never leave what they're browsing."
            current={current}
            onPick={pick}
          >
            <s-link href={embedUrl} target="_blank">
              Turn on the app embed in your theme
            </s-link>
          </ModeCard>
          <ModeCard
            value="PAGE"
            title="Rewards page"
            text="A full page inside your theme, at its own address. Link to it from your menu or footer."
            current={current}
            onPick={pick}
          >
            <s-link href={`https://${shop}/apps/loyalty/rewards`} target="_blank">
              /apps/loyalty/rewards
            </s-link>
          </ModeCard>
        </s-grid>
      </s-section>

      <s-section heading="Design it your way">
        <s-stack gap="base">
          <s-paragraph>
            The editor works like the theme editor: drag blocks into the order you want, add or remove them, and change
            colours, corners, fonts and wording while watching a live preview. Four starting templates are included —
            currently using <s-text type="strong">{TEMPLATES[template]?.label ?? "Classic"}</s-text> — and you can add
            your own CSS or HTML for anything beyond that.
          </s-paragraph>
          <s-stack direction="inline" gap="small">
            <s-button href="/app/appearance/editor">Open editor</s-button>
            <s-button href="/app/emails">Emails</s-button>
            <s-button href="/app/appearance/developer">Developer source</s-button>
          </s-stack>
        </s-stack>
      </s-section>

      <s-section heading="My Rewards tab on the account page">
        <s-paragraph>
          Logged-in customers see a <s-text type="strong">My Rewards</s-text> tab in their account menu. It opens their rewards in a centred window, with no
          extra sign-in, and their points account is created automatically the first time. You can change the tab's label and icon in the editor
          (Launcher tab). If a theme's menu can't be matched, a small button appears instead, or add a menu link to <s-text type="strong">#loyalty</s-text>.
        </s-paragraph>
        <s-paragraph>
          <s-text type="strong">To see it:</s-text> turn on the app embed once (this is needed whichever display mode you use), then open your
          store's account page while logged in as a customer.
        </s-paragraph>
        <s-stack direction="inline">
          <s-button href={embedUrl} target="_blank" variant="primary">
            Turn on the app embed
          </s-button>
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="Tip">
        <s-paragraph>
          Customers sign in with their normal store account. Visitors who aren't logged in see a log-in prompt instead of
          a balance.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}
