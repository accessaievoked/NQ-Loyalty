import { redirect } from "react-router";

// /app is not a page of its own: it always lands on Home, keeping the query string (shop, host,
// id_token…) so Shopify's authentication can finish.
export const loader = ({ request }) => {
  throw redirect("/app/home" + new URL(request.url).search);
};

export default function Index() {
  return null;
}
