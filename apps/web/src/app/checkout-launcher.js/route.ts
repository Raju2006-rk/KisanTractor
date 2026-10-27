import { checkoutLauncherScript } from "../../lib/payment-checkout-page";

export const dynamic = "force-static";

/** The checkout launcher script; same-origin so the checkout page needs no inline script. */
export function GET(): Response {
  return new Response(checkoutLauncherScript, {
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "public, max-age=0, must-revalidate",
      "x-content-type-options": "nosniff",
    },
  });
}
