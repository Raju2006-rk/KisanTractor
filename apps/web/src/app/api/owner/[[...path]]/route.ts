import { NextResponse } from "next/server";
import { cookies } from "next/headers";

import { isValidIdempotencyKey } from "../../../../lib/job-tracking";
import { isValidCashIdempotencyKey, parseIndiaLocalDateTime, parseRupeesToPaise } from "../../../../lib/payments";
import { accessCookieName, runtimeConfig } from "../../../../lib/server-context";
import { forwardCorrelationId } from "../../../../lib/correlation";

interface RouteContext {
  readonly params: Promise<{ path?: string[] }>;
}

const optionalText = (form: FormData, name: string): string | undefined => {
  const value = form.get(name);
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
};

const requiredText = (form: FormData, name: string): string => optionalText(form, name) ?? "";
const optionalNumber = (form: FormData, name: string): number | undefined => {
  const value = optionalText(form, name);
  return value === undefined ? undefined : Number(value);
};

const locationBody = (form: FormData) => ({
  state: requiredText(form, "state"),
  district: requiredText(form, "district"),
  mandalOrTaluk: requiredText(form, "mandalOrTaluk"),
  village: requiredText(form, "village"),
  ...(optionalText(form, "postalCode") === undefined ? {} : { postalCode: optionalText(form, "postalCode") }),
  ...(optionalText(form, "landmark") === undefined ? {} : { landmark: optionalText(form, "landmark") }),
  source: requiredText(form, "source"),
  ...(optionalNumber(form, "latitude") === undefined ? {} : { latitude: optionalNumber(form, "latitude") }),
  ...(optionalNumber(form, "longitude") === undefined ? {} : { longitude: optionalNumber(form, "longitude") }),
  capturedAt: requiredText(form, "capturedAt") || new Date().toISOString(),
});

const formBody = (form: FormData, path: readonly string[]) => {
  const expectedVersion = optionalNumber(form, "expectedVersion");
  if (path[0] === "profile") {
    return {
      fullName: requiredText(form, "fullName"),
      preferredLocale: requiredText(form, "preferredLocale"),
      contactSharingConsent: form.get("contactSharingConsent") === "true",
      operatingLocation: locationBody(form),
      ...(expectedVersion === undefined ? {} : { expectedVersion }),
    };
  }
  if (path[0] === "equipment") {
    if (path[2] === "assignment") {
      return {
        tractorId: optionalText(form, "tractorId") ?? null,
        ...(expectedVersion === undefined ? {} : { expectedVersion }),
      };
    }
    return {
      ...(path.length === 1 ? { equipmentTypeId: requiredText(form, "equipmentTypeId") } : {}),
      displayName: requiredText(form, "displayName"),
      availabilityStatus: requiredText(form, "availabilityStatus") || "AVAILABLE",
      ...(optionalText(form, "tractorId") === undefined ? {} : { tractorId: optionalText(form, "tractorId") }),
      ...(expectedVersion === undefined ? {} : { expectedVersion }),
    };
  }
  if (path[0] === "tractors" && path[2] === "service-offerings") {
    return {
      serviceId: requiredText(form, "serviceId"),
      ...(optionalText(form, "equipmentId") === undefined ? {} : { equipmentId: optionalText(form, "equipmentId") }),
      enabled: form.get("enabled") === "true",
      ...(expectedVersion === undefined ? {} : { expectedVersion }),
    };
  }
  if (path[0] === "service-offerings" && path[2] === "pricing-rules") {
    return {
      method: requiredText(form, "method"),
      ratePaise: Number(requiredText(form, "ratePaise")),
      ...(optionalText(form, "roundingPolicy") === undefined
        ? {}
        : { roundingPolicy: optionalText(form, "roundingPolicy") }),
      enabled: form.get("enabled") === "true",
      ...(expectedVersion === undefined ? {} : { expectedVersion }),
    };
  }
  if (path[0] === "bookings") {
    return {
      ...(expectedVersion === undefined ? {} : { expectedVersion }),
      ...(optionalText(form, "reason") === undefined ? {} : { reason: optionalText(form, "reason") }),
    };
  }
  return {
    brand: requiredText(form, "brand"),
    model: requiredText(form, "model"),
    registrationNumber: requiredText(form, "registrationNumber"),
    manufacturingYear: Number(requiredText(form, "manufacturingYear")),
    ...(optionalNumber(form, "horsepower") === undefined ? {} : { horsepower: optionalNumber(form, "horsepower") }),
    operatingLocation: locationBody(form),
    ...(expectedVersion === undefined ? {} : { expectedVersion }),
  };
};

const jobActionPaths = new Set(["start", "pause", "resume", "complete"]);

/**
 * Forwards one Owner job action with its stable idempotency key. Failures return to the booking with
 * the same key so an explicit retry cannot double-record; nothing is queued in the background.
 */
async function forwardJobAction(request: Request, path: readonly string[], accessCredential: string) {
  const bookingId = path[1]!;
  const action = path[3]!;
  const form = await request.formData();
  const idempotencyKey = optionalText(form, "idempotencyKey");
  const completedQuantity = optionalText(form, "completedQuantity");
  const back = (query: Record<string, string>) => NextResponse.redirect(new URL(
    `/owner/bookings/${encodeURIComponent(bookingId)}?${new URLSearchParams(query).toString()}#job-feedback`,
    request.url,
  ), 303);
  if (idempotencyKey === undefined || !isValidIdempotencyKey(idempotencyKey)) return back({ jobError: "invalid" });
  const retry = { retryAction: action.toUpperCase(), retryKey: idempotencyKey };

  try {
    const response = await fetch(`${runtimeConfig().publicApiOrigin}/owner/bookings/${encodeURIComponent(bookingId)}/job/${action}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessCredential}`,
        accept: "application/json",
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
        "x-client-channel": "WEB",
        "x-correlation-id": forwardCorrelationId(request),
      },
      body: JSON.stringify({
        idempotencyKey,
        ...(action === "complete" && completedQuantity !== undefined ? { completedQuantity } : {}),
      }),
      cache: "no-store",
    });
    if (response.ok) return back({ job: "saved" });
    if (response.status === 409) {
      const body = await response.json().catch(() => undefined) as { readonly code?: unknown } | undefined;
      return back({ jobError: body?.code === "WORK_EVENT_OUT_OF_SEQUENCE" ? "sequence" : "conflict" });
    }
    // A definite rejection committed nothing, so the next attempt may use a fresh key. Only an
    // unknown outcome (server failure or lost connection) must retry with the same key.
    if (response.status === 422) return back({ jobError: "invalid" });
    return back({ jobError: "failed", ...retry });
  } catch {
    return back({ jobError: "offline", ...retry });
  }
}

/**
 * Forwards the Owner's cash confirmation as integer paise with its stable idempotency key.
 * After an unknown outcome the booking page offers an explicit retry carrying the same key and
 * values, so the cash cannot be recorded twice; nothing is queued in the background.
 */
async function forwardCashPayment(request: Request, bookingId: string, accessCredential: string) {
  const form = await request.formData();
  const idempotencyKey = optionalText(form, "idempotencyKey");
  const invoiceId = optionalText(form, "invoiceId");
  const amountRupees = optionalText(form, "amountRupees");
  const receivedAtText = optionalText(form, "receivedAt");
  const back = (query: Record<string, string>) => NextResponse.redirect(new URL(
    `/owner/bookings/${encodeURIComponent(bookingId)}?${new URLSearchParams(query).toString()}#payment-feedback`,
    request.url,
  ), 303);

  const amountPaise = amountRupees === undefined ? undefined : parseRupeesToPaise(amountRupees);
  const receivedAt = receivedAtText === undefined ? undefined : parseIndiaLocalDateTime(receivedAtText);
  if (idempotencyKey === undefined || !isValidCashIdempotencyKey(idempotencyKey) || invoiceId === undefined ||
      amountPaise === undefined || (receivedAtText !== undefined && receivedAt === undefined) ||
      (receivedAt !== undefined && receivedAt.getTime() > Date.now())) {
    return back({ cashError: "invalid" });
  }
  const retry = {
    cashKey: idempotencyKey,
    cashAmount: amountRupees!,
    ...(receivedAtText === undefined ? {} : { cashReceivedAt: receivedAtText }),
  };

  try {
    const response = await fetch(`${runtimeConfig().publicApiOrigin}/owner/bookings/${encodeURIComponent(bookingId)}/payments/cash`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessCredential}`,
        accept: "application/json",
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
        "x-client-channel": "WEB",
        "x-correlation-id": forwardCorrelationId(request),
      },
      body: JSON.stringify({
        invoiceId,
        amountPaise,
        idempotencyKey,
        ...(receivedAt === undefined ? {} : { receivedAt: receivedAt.toISOString() }),
      }),
      cache: "no-store",
    });
    if (response.ok) return back({ cash: "recorded" });
    // Definite rejections committed nothing, so the next attempt may use a fresh key.
    if (response.status === 409) {
      const body = await response.json().catch(() => undefined) as { readonly code?: unknown } | undefined;
      return back({
        cashError: body?.code === "PAYMENT_OVERPAYMENT" ? "overpayment"
          : body?.code === "PAYMENT_SETTLEMENT_BLOCKED" ? "blocked" : "conflict",
      });
    }
    if (response.status === 422) return back({ cashError: "invalid" });
    if (response.status === 401 || response.status === 403 || response.status === 404) return back({ cashError: "conflict" });
    // Only an unknown outcome (server failure) must retry with the same key and values.
    return back({ cashError: "failed", ...retry });
  } catch {
    return back({ cashError: "offline", ...retry });
  }
}

async function forward(request: Request, context: RouteContext, method: "GET" | "POST") {
  const { path = [] } = await context.params;
  if (path.length === 0 || path.some((part) => part.length === 0 || part === "." || part === "..")) {
    return NextResponse.json({ code: "NOT_FOUND" }, { status: 404 });
  }

  const cookieStore = await cookies();
  const accessCredential = cookieStore.get(accessCookieName)?.value;
  if (!accessCredential) return NextResponse.json({ code: "UNAUTHENTICATED" }, { status: 401 });

  if (path[0] === "bookings" && path[2] === "job") {
    if (method !== "POST" || path.length !== 4 || !jobActionPaths.has(path[3]!)) {
      return NextResponse.json({ code: "NOT_FOUND" }, { status: 404 });
    }
    return forwardJobAction(request, path, accessCredential);
  }

  if (path[0] === "bookings" && path[2] === "payments" && path[3] === "cash") {
    if (method !== "POST" || path.length !== 4) return NextResponse.json({ code: "NOT_FOUND" }, { status: 404 });
    return forwardCashPayment(request, path[1]!, accessCredential);
  }

  const contentType = request.headers.get("content-type") ?? "";
  const isForm = method === "POST" && contentType.includes("form");
  const body = method === "POST"
    ? (isForm ? JSON.stringify(formBody(await request.formData(), path)) : await request.text())
    : undefined;
  const backendMethod = method === "GET"
    ? "GET"
    : (path.length === 1 && (path[0] === "tractors" || path[0] === "equipment")) ||
        (path[0] === "documents" && (path[1] === "upload-grants" || path[2] === "complete")) ||
        (path[0] === "tractors" && path[2] === "eligibility") ||
        (path[0] === "bookings" && (path[2] === "accept" || path[2] === "reject"))
      ? "POST"
      : "PUT";

  try {
    const response = await fetch(`${runtimeConfig().publicApiOrigin}/owner/${path.map(encodeURIComponent).join("/")}`, {
      method: backendMethod,
      headers: {
        authorization: `Bearer ${accessCredential}`,
        accept: "application/json",
        "content-type": "application/json",
        "x-client-channel": "WEB",
        "x-correlation-id": forwardCorrelationId(request),
      },
      ...(body === undefined ? {} : { body }),
      cache: "no-store",
    });

    if (isForm) {
      const successPath = path[0] === "profile"
        ? "/owner/profile"
        : path[0] === "equipment"
          ? "/owner/equipment"
          : path[0] === "documents"
            ? "/owner/documents"
            : path[0] === "bookings"
              ? `/owner/bookings/${encodeURIComponent(path[1] ?? "")}`
              : path[0] === "service-offerings" || (path[0] === "tractors" && path[2] === "service-offerings")
                ? "/owner/pricing"
                : path.length === 2
                  ? `/owner/tractors/${encodeURIComponent(path[1]!)}`
                  : "/owner/tractors";
      return NextResponse.redirect(new URL(`${successPath}?${response.ok ? "saved=1" : response.status === 409 ? "error=schedule-conflict" : "error=save-failed"}`, request.url), 303);
    }
    if (method === "GET" && path[0] === "documents" && path[2] === "download-grant" && response.ok) {
      const body = await response.json() as { readonly grant?: { readonly url?: unknown } };
      if (typeof body.grant?.url !== "string") return NextResponse.json({ code: "INVALID_DOWNLOAD_GRANT" }, { status: 502 });
      const downloadUrl = new URL(body.grant.url);
      if (downloadUrl.protocol !== "https:" && downloadUrl.protocol !== "http:") {
        return NextResponse.json({ code: "INVALID_DOWNLOAD_GRANT" }, { status: 502 });
      }
      return NextResponse.redirect(downloadUrl, 303);
    }
    return new NextResponse(await response.text(), {
      status: response.status,
      headers: { "content-type": response.headers.get("content-type") ?? "application/json" },
    });
  } catch {
    if (isForm) {
      const failurePath = path[0] === "service-offerings" || (path[0] === "tractors" && path[2] === "service-offerings")
        ? "/owner/pricing"
        : path[0] === "equipment"
          ? "/owner/equipment"
          : path[0] === "documents"
            ? "/owner/documents"
            : path[0] === "bookings"
              ? `/owner/bookings/${encodeURIComponent(path[1] ?? "")}`
              : "/owner/tractors";
      return NextResponse.redirect(new URL(`${failurePath}?error=service-unavailable`, request.url), 303);
    }
    return NextResponse.json({ code: "SERVICE_UNAVAILABLE" }, { status: 503 });
  }
}

export function GET(request: Request, context: RouteContext) {
  return forward(request, context, "GET");
}

export function POST(request: Request, context: RouteContext) {
  return forward(request, context, "POST");
}
