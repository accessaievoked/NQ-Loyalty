import { redirect } from "react-router";

// The app has no public landing page, so the root URL always redirects:
//  - with a `shop` (Shopify opening the app): to /app/home, keeping the query string
//    (shop, host, id_token…) so authentication can finish;
//  - without one (a bookmark, the bare tunnel address): to the log-in page.
export const loader = ({ request }) => {
  const url = new URL(request.url);
  throw redirect(url.searchParams.get("shop") ? `/app/home${url.search}` : `/auth/login${url.search}`);
};

export default function Index() {
  return null;
}
