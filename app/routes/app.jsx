import { Outlet, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { requireStore } from "../services/auth.server";
import { AppErrorBoundary } from "../components/AppErrorBoundary";

export const loader = async ({ request }) => {
  // Also provisions the Store row (and its defaults) the first time a shop opens the app.
  await requireStore(request);

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData();

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
export const ErrorBoundary = AppErrorBoundary;

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
