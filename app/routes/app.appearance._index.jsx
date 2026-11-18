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

// Each card is a 4-row subgrid (title, description, link, button), so side by side the rows line up:
// the title, the description (as tall as the longer one), the link and the button all sit on the same
// line in both cards, whatever the text length.
const LINK_STYLE = { color: "#111827", textDecoration: "underline", textUnderlineOffset: 3, fontSize: 14 };

function ModeCard({ value, title, text, current, onPick, linkHref, linkText }) {
  const active = current === value;
  return (
    <div
      style={{
        gridRow: "span 4", display: "grid", gridTemplateRows: "subgrid", rowGap: 12, padding: 16, borderRadius: 12,
        border: "1px solid #e4e6ea", background: active ? "#f7f7f8" : "#fff",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <div style={{ fontSize: 15, fontWeight: 650, color: "#111827" }}>{title}</div>
        {active && <s-badge tone="success">In use</s-badge>}
      </div>
      <div style={{ fontSize: 14, color: "#374151", lineHeight: 1.5 }}>{text}</div>
      <div>
        <a href={linkHref} target="_blank" rel="noreferrer" style={LINK_STYLE}>{linkText}</a>
      </div>
      <div>
        <s-button variant={active ? "secondary" : "primary"} disabled={active || undefined} onClick={() => onPick(value)}>
          {active ? "Selected" : `Use ${title.toLowerCase()}`}
        </s-button>
      </div>
    </div>
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
        <s-paragraph>
          Choose where customers find their points and rewards. You can switch at any time. Nothing is deleted when you switch.
        </s-paragraph>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", columnGap: 16, rowGap: 12, marginTop: 12 }}>
          <ModeCard
            value="WIDGET"
            title="Floating widget"
            text="A small button on every page that opens a rewards panel. Customers stay on the page they are browsing."
            current={current}
            onPick={pick}
            linkHref={embedUrl}
            linkText="Turn on the app embed in your theme"
          />
          <ModeCard
            value="PAGE"
            title="Rewards page"
            text="A full page in your theme at its own address. Add a link to it in your menu or footer."
            current={current}
            onPick={pick}
            linkHref={`https://${shop}/apps/loyalty/rewards`}
            linkText="/apps/loyalty/rewards"
          />
        </div>
      </s-section>

      <s-section heading="Design it your way">
        <s-stack gap="base">
          <s-paragraph>
            The editor works like the theme editor: drag blocks into the order you want, add or remove them, and change
            colours, corners, fonts and wording while watching a live preview. Five starting templates are included,
            currently using <s-text type="strong">{TEMPLATES[template]?.label ?? "Classic"}</s-text>, and you can add
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
