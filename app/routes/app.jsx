import { useEffect, useRef } from "react";
import { Outlet, useLoaderData, useLocation, useNavigate, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { requireStore } from "../services/auth.server";
import { maybeSweep } from "../services/sweep.server";

export const loader = async ({ request }) => {
  // Also provisions the Store row (and its defaults) the first time a shop opens the app.
  await requireStore(request);
  maybeSweep();

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

/**
 * Keeps the browser's Back button simple: from any page it returns to Home.
 *  1. Links between inner pages REPLACE the current history entry instead of piling up, so the
 *     history stays [..., Home, <current page>].
 *  2. A link to Home from an inner page goes "back" when Home is the previous entry.
 *  3. If the app was opened directly on an inner page (a bookmark or refresh), Home is slipped in
 *     underneath it, so Back still lands on Home rather than leaving the app.
 */
function useHomeAsBack() {
  const navigate = useNavigate();
  const location = useLocation();
  const homeIdx = useRef(null);
  const here = location.pathname;

  // remember where Home sits in the history stack
  useEffect(() => {
    if (here === "/app") homeIdx.current = window.history.state?.idx ?? null;
  }, [here]);

  // 3. opened directly on an inner page
  useEffect(() => {
    const idx = window.history.state?.idx;
    if (idx === 0 && here.startsWith("/app/")) {
      const target = location.pathname + location.search + location.hash;
      (async () => {
        await navigate(`/app${location.search}`, { replace: true });
        await navigate(target);
      })();
    }
    // only on first load
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 1 + 2. in-app links
  useEffect(() => {
    const onClick = (e) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      if (here === "/app") return; // Home → page: a normal step forward
      const el = e.composedPath().find((n) => n instanceof Element && ["A", "S-LINK", "S-BUTTON"].includes(n.tagName) && n.getAttribute("href"));
      if (!el || el.getAttribute("target") === "_blank") return;
      const href = el.getAttribute("href");
      if (!href.startsWith("/app")) return;
      const path = href.split(/[?#]/)[0];
      if (path === here) return;

      e.preventDefault();
      e.stopPropagation();
      const idx = window.history.state?.idx;
      if (path === "/app" && homeIdx.current != null && idx === homeIdx.current + 1) navigate(-1);
      else navigate(href, { replace: true });
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [here, navigate]);
}

export default function App() {
  const { apiKey } = useLoaderData();
  useHomeAsBack();

  return (
    <AppProvider apiKey={apiKey}>
      <s-app-nav>
        <s-link href="/app">Home</s-link>
        <s-link href="/app/analytics">Analytics</s-link>
        <s-link href="/app/rules">Rules</s-link>
        <s-link href="/app/customers">Customers</s-link>
        <s-link href="/app/appearance">Appearance</s-link>
        <s-link href="/app/emails">Emails</s-link>
      </s-app-nav>
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
