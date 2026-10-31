import { authenticate } from "../shopify.server";

// GET /apps/loyalty/rewards — the full-page rewards experience, rendered inside the
// merchant's theme layout (Shopify processes `application/liquid` responses from app proxies).
export const loader = async ({ request }) => {
  await authenticate.public.appProxy(request);
  const html = `<div style="max-width:800px;margin:0 auto;padding:32px 16px">
<div id="loyalty-page" style="min-height:240px"></div>
</div>
<script src="/apps/loyalty/widget.js" defer></script>`;
  return new Response(html, { headers: { "Content-Type": "application/liquid" } });
};
