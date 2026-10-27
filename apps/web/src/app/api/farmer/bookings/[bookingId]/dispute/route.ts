import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { accessCookieName, runtimeConfig } from "../../../../../../lib/server-context";
import { forwardCorrelationId } from "../../../../../../lib/correlation";

interface RouteContext {
  readonly params: Promise<{ bookingId: string }>;
}

const text = (form: FormData, name: string): string | undefined => {
  const value = form.get(name);
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
};

/** Forwards a Farmer bill dispute and returns to the booking; nothing is queued when the API is unreachable. */
export async function POST(request: Request, context: RouteContext) {
  const { bookingId } = await context.params;
  if (!bookingId || bookingId === "." || bookingId === "..") return NextResponse.json({ code: "NOT_FOUND" }, { status: 404 });
  const credential = (await cookies()).get(accessCookieName)?.value;
  if (!credential) return NextResponse.json({ code: "UNAUTHENTICATED" }, { status: 401 });

  const back = (feedback: string) => NextResponse.redirect(
    new URL(`/farmer/bookings/${encodeURIComponent(bookingId)}?dispute=${feedback}#job-feedback`, request.url),
    303,
  );

  const form = await request.formData();
  const reason = text(form, "reason");
  const expectedVersion = Number(text(form, "expectedVersion"));
  if (reason === undefined || reason.length > 500 || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
    return back("invalid");
  }

  try {
    const response = await fetch(`${runtimeConfig().publicApiOrigin}/farmer/bookings/${encodeURIComponent(bookingId)}/dispute`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${credential}`,
        accept: "application/json",
        "content-type": "application/json",
        "x-client-channel": "WEB",
        "x-correlation-id": forwardCorrelationId(request),
      },
      body: JSON.stringify({ expectedVersion, reason }),
      cache: "no-store",
    });
    if (response.ok) return back("disputed");
    if (response.status === 409) return back("conflict");
    if (response.status === 422) return back("invalid");
    return back("failed");
  } catch {
    return back("failed");
  }
}
