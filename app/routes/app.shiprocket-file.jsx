import { requireStore } from "../services/auth.server";
import { getFastCheckout, shiprocketSetupFile } from "../services/fastcheckout.server";

// GET /app/shiprocket-file: the setup text for Shiprocket, as a download. The Rules page fetches it
// with the Shopify session token, so only a signed-in merchant can read the key.
export const loader = async ({ request }) => {
  const { store } = await requireStore(request);
  const integration = await getFastCheckout(store.id);
  if (!integration?.enabled) return new Response("Turn on Shiprocket checkout first.", { status: 404 });
  return new Response(shiprocketSetupFile(store, integration), {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Disposition": 'attachment; filename="shiprocket-checkout-setup.txt"',
    },
  });
};
