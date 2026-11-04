import { Outlet, useLoaderData, useRouteError } from "react-router";
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

export default function App() {
  const { apiKey } = useLoaderData();

  return (
    <AppProvider apiKey={apiKey}>
      <s-app-nav>
        <s-link href="/app/home">Home</s-link>
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
