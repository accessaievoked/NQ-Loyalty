import { redirect } from "react-router";

// The app has no public landing page, so the root URL always redirects to /app, keeping the query
// string (shop, host, id_token…) so authentication can finish.
//
// Always /app, even with no `shop` param: that also covers a bare "/" reached by the merchant
// pressing Back inside the embedded admin iframe (its history can pop to a plain "/" with no
// query string). /app's loader re-authenticates via the session token, and — if that genuinely
// has nothing to go on — shopify-app-react-router itself renders the App Bridge recovery page
// and bounces back into the embedded session. Sending that case to /auth/login instead skipped
// that recovery and dead-ended on a blank "enter your shop domain" form.
export const loader = ({ request }) => {
  const url = new URL(request.url);
  throw redirect(`/app${url.search}`);
};

export default function Index() {
  return null;
}
