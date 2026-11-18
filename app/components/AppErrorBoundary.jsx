import { isRouteErrorResponse, useRouteError } from "react-router";

// Replaces `boundary.error` from @shopify/shopify-app-react-router.
//
// Shopify's helper recognises its own "load App Bridge, then reload with a session" response by
// checking `error.constructor.name === "ErrorResponse"`. In the minified production client bundle
// that class is renamed (e.g. `Ge`), so the check failed on the client, the helper re-threw, and
// React Router's default error page printed the response status: a bold "200" on a blank page.
// This happens whenever a page is opened or refreshed without Shopify's signed URL parameters.
// `isRouteErrorResponse` doesn't depend on class names, so it survives minification.
export function AppErrorBoundary() {
  const error = useRouteError();

  // 2xx/3xx thrown by Shopify's auth helpers are handshake pages (App Bridge bootstrap, exit-iframe
  // redirect). Render their HTML as-is; the browser runs it and carries on to the real page.
  if (isRouteErrorResponse(error) && error.status < 400) {
    return <div dangerouslySetInnerHTML={{ __html: typeof error.data === "string" && error.data ? error.data : "Loading..." }} />;
  }

  const notFound = isRouteErrorResponse(error) && error.status === 404;
  const title = notFound ? "We couldn't find that page" : "Something went wrong";
  const text = notFound
    ? "The page or customer you're looking for may have been removed, or the link is out of date."
    : "Please try again. If it keeps happening, reload the app from your Shopify admin.";

  return (
    <div style={{ fontFamily: "Inter, system-ui, sans-serif", maxWidth: 480, margin: "15vh auto", padding: "0 16px", textAlign: "center", color: "#111827" }}>
      <h1 style={{ fontSize: 20, margin: "0 0 8px" }}>{title}</h1>
      <p style={{ fontSize: 14, color: "#6b7280", margin: "0 0 20px", lineHeight: 1.5 }}>{text}</p>
      <a href="/app" style={{ display: "inline-block", background: "#111827", color: "#fff", textDecoration: "none", borderRadius: 8, padding: "9px 16px", fontSize: 14, fontWeight: 600 }}>
        Back to Home
      </a>
    </div>
  );
}
