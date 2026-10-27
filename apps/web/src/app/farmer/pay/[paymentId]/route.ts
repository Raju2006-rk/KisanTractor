import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { forwardCorrelationId } from "../../../../lib/correlation";
import {
  buildCheckoutPage,
  buildCheckoutProblemPage,
  checkoutPageHeaders,
  type CheckoutPageProblem,
} from "../../../../lib/payment-checkout-page";
import { normalizeOnlineCheckout } from "../../../../lib/payments";
import { accessCookieName, loadLocale, runtimeConfig } from "../../../../lib/server-context";

export const dynamic = "force-dynamic";

interface RouteContext {
  readonly params: Promise<{ paymentId: string }>;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

const html = (body: string, status: number) => new Response(body, { status, headers: checkoutPageHeaders });

/**
 * The online checkout launcher for one pending payment (task 16.2). It is a route handler, not an
 * app page, so it carries its own strict content security policy and the payment provider's script
 * never loads anywhere else. The provider script is included only when the API returned a SANDBOX
 * or LIVE checkout for the signed-in Farmer's own pending payment.
 */
export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const { paymentId } = await context.params;
  const bookingParameter = new URL(request.url).searchParams.get("booking");
  const bookingId = bookingParameter !== null && UUID_PATTERN.test(bookingParameter) ? bookingParameter : undefined;
  const locale = await loadLocale();
  const problem = (kind: CheckoutPageProblem, status: number) => html(buildCheckoutProblemPage(locale, kind, bookingId), status);

  const credential = (await cookies()).get(accessCookieName)?.value;
  const login = () => NextResponse.redirect(new URL(`/login?${new URLSearchParams({
    next: `/farmer/pay/${encodeURIComponent(paymentId)}${bookingId === undefined ? "" : `?booking=${bookingId}`}`,
    reason: "authentication_required",
  }).toString()}`, request.url), 303);
  if (!credential) return login();
  if (!UUID_PATTERN.test(paymentId)) return problem("not-found", 404);

  try {
    const response = await fetch(`${runtimeConfig().publicApiOrigin}/farmer/payments/${encodeURIComponent(paymentId)}/checkout`, {
      headers: {
        authorization: `Bearer ${credential}`,
        accept: "application/json",
        "x-client-channel": "WEB",
        "x-correlation-id": forwardCorrelationId(request),
      },
      cache: "no-store",
    });
    if (response.status === 401) return login();
    if (response.status === 404) return problem("not-found", 404);
    if (response.status === 409) {
      const body = await response.json().catch(() => undefined) as { readonly code?: unknown } | undefined;
      return problem(body?.code === "PAYMENT_CHECKOUT_EXPIRED" ? "expired" : "not-pending", 409);
    }
    if (response.status === 503) return problem("unavailable", 503);
    if (!response.ok) return problem("failed", 502);
    const view = normalizeOnlineCheckout(await response.json());
    if (view === undefined || view.paymentId !== paymentId) return problem("failed", 502);
    return html(buildCheckoutPage(locale, view), 200);
  } catch {
    return problem("failed", 503);
  }
}
