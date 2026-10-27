import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { forwardCorrelationId } from "../../../../../../lib/correlation";
import type { OnlineFeedback } from "../../../../../../lib/payments";
import { accessCookieName, runtimeConfig } from "../../../../../../lib/server-context";

interface RouteContext {
  readonly params: Promise<{ paymentId: string; action: string }>;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const actions = new Set(["checkout-return", "status-check", "cancel"]);

const text = (form: FormData, name: string): string | undefined => {
  const value = form.get(name);
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
};

/**
 * The Farmer's return from the provider checkout, an explicit status check, or a cancel of one
 * pending online payment. The API decides the outcome from stored, provider-verified state; the
 * checkout's own success claim is never forwarded. Returns to the booking with feedback.
 */
export async function POST(request: Request, context: RouteContext) {
  const { paymentId, action } = await context.params;
  if (!UUID_PATTERN.test(paymentId) || !actions.has(action)) return NextResponse.json({ code: "NOT_FOUND" }, { status: 404 });
  const credential = (await cookies()).get(accessCookieName)?.value;
  if (!credential) return NextResponse.json({ code: "UNAUTHENTICATED" }, { status: 401 });

  const form = await request.formData();
  const bookingId = text(form, "bookingId");
  const dismissed = text(form, "outcome") === "dismissed";
  const target = bookingId !== undefined && UUID_PATTERN.test(bookingId)
    ? `/farmer/bookings/${encodeURIComponent(bookingId)}` : "/farmer/payments";
  const back = (feedback: OnlineFeedback) =>
    NextResponse.redirect(new URL(`${target}?online=${feedback}#payment-feedback`, request.url), 303);

  try {
    const response = await fetch(`${runtimeConfig().publicApiOrigin}/farmer/payments/${encodeURIComponent(paymentId)}/${action}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${credential}`,
        accept: "application/json",
        "content-type": "application/json",
        "x-client-channel": "WEB",
        "x-correlation-id": forwardCorrelationId(request),
      },
      // Deliberately empty: whatever the checkout reported is not evidence of payment.
      body: "{}",
      cache: "no-store",
    });
    const body = await response.json().catch(() => undefined) as {
      readonly code?: unknown; readonly confirmation?: unknown; readonly released?: unknown;
    } | undefined;
    if (response.ok) {
      if (body?.confirmation === "CONFIRMED") return back("confirmed");
      if (action === "cancel" && body?.released === true) return back("cancelled");
      if (body?.confirmation === "NOT_COMPLETED") return back(action === "cancel" ? "cancelled" : "dismissed");
      return back(action === "checkout-return" && dismissed ? "dismissed" : "returned");
    }
    if (response.status === 409) {
      return back(body?.code === "PAYMENT_IN_PROGRESS" ? "in-progress" : body?.code === "PAYMENT_UNDER_REVIEW" ? "review" : "conflict");
    }
    if (action === "checkout-return") return back(dismissed ? "dismissed" : "returned");
    return back(response.status === 503 ? "unavailable" : "failed");
  } catch {
    return back(action === "checkout-return" ? (dismissed ? "dismissed" : "returned") : "offline");
  }
}
