import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { AppErrorBoundary } from "../components/AppErrorBoundary";

export const loader = async ({ request }) => {
  await authenticate.admin(request);

  return null;
};

export const ErrorBoundary = AppErrorBoundary;

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
