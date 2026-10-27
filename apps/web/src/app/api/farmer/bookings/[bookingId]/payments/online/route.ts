import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { forwardCorrelationId } from "../../../../../../../lib/correlation";
import { isValidCashIdempotencyKey, MINIMUM_ONLINE_PAYMENT_PAISE } from "../../../../../../../lib/payments";
import { accessCookieName, runtimeConfig } from "../../../../../../../lib/server-context";

interface RouteContext {
  readonly params: Promise<{ bookingId: string }>;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

const text = (form: FormData, name: string): string | undefined => {
  const value = form.get(name);
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
};

/**
 * Starts (or, with the same key, reopens) an online payment for the current bill and sends the
 * Farmer to the checkout launcher. Nothing is paid here: the API creates a pending intent, and the
 * bill counts the money only after verified provider evidence. After an unknown outcome the booking
 * page offers an explicit retry with the same key; nothing is queued in the background.
 */
export async function POST(request: Request, context: RouteContext) {
  const { bookingId } = await context.params;
  if (!UUID_PATTERN.test(bookingId)) return NextResponse.json({ code: "NOT_FOUND" }, { status: 404 });
  const credential = (await cookies()).get(accessCookieName)?.value;
  if (!credential) return NextResponse.json({ code: "UNAUTHENTICATED" }, { status: 401 });

  const back = (query: Record<string, string>) => NextResponse.redirect(new URL(
    `/farmer/bookings/${encodeURIComponent(bookingId)}?${new URLSearchParams(query).toString()}#payment-feedback`,
    request.url,
  ), 303);
  const form = await request.formData();
  const idempotencyKey = text(form, "idempotencyKey");
  const invoiceId = text(form, "invoiceId");
  const amountText = text(form, "amountPaise");
  const amountPaise = amountText !== undefined && /^\d{1,15}$/u.test(amountText) ? Number(amountText) : undefined;
  if (idempotencyKey === undefined || !isValidCashIdempotencyKey(idempotencyKey) || invoiceId === undefined ||
      !UUID_PATTERN.test(invoiceId) || amountPaise === undefined || amountPaise < MINIMUM_ONLINE_PAYMENT_PAISE) {
    return back({ online: "invalid" });
  }
  const retry = { onlineKey: idempotencyKey, onlineAmount: String(amountPaise) };

  try {
    const response = await fetch(`${runtimeConfig().publicApiOrigin}/farmer/bookings/${encodeURIComponent(bookingId)}/payments/online`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${credential}`,
        accept: "application/json",
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
        "x-client-channel": "WEB",
        "x-correlation-id": forwardCorrelationId(request),
      },
      body: JSON.stringify({ invoiceId, amountPaise, idempotencyKey }),
      cache: "no-store",
    });
    const body = await response.json().catch(() => undefined) as {
      readonly code?: unknown; readonly payment?: { readonly id?: unknown }; readonly retryable?: unknown;
    } | undefined;
    if (response.ok) {
      const paymentId = body?.payment?.id;
      if (typeof paymentId !== "string" || !UUID_PATTERN.test(paymentId)) return back({ online: "failed", ...retry });
      return NextResponse.redirect(new URL(
        `/farmer/pay/${encodeURIComponent(paymentId)}?booking=${encodeURIComponent(bookingId)}`, request.url,
      ), 303);
    }
    // Definite refusals created nothing, so the next attempt may use a fresh key.
    if (response.status === 409) {
      return back({
        online: body?.code === "PAYMENT_OVERPAYMENT" ? "overpayment"
          : body?.code === "PAYMENT_SETTLEMENT_BLOCKED" ? "blocked" : "conflict",
      });
    }
    if (response.status === 422) return back({ online: "invalid" });
    if (response.status === 401 || response.status === 403 || response.status === 404) return back({ online: "conflict" });
    if (response.status === 503 && body?.code === "CAPABILITY_UNAVAILABLE") return back({ online: "unavailable" });
    // The provider refused the request outright: nothing was charged or recorded.
    if (response.status === 502) return back({ online: "failed" });
    // Only an unknown outcome must retry with the same key.
    return back({ online: "failed", ...retry });
  } catch {
    return back({ online: "offline", ...retry });
  }
}
