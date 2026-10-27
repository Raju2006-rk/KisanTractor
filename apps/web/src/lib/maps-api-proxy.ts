import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { forwardCorrelationId } from "./correlation";
import { accessCookieName, runtimeConfig } from "./server-context";

export async function forwardMapOperation(request: Request, operation: "map-search" | "map-pin") {
  const config = runtimeConfig();
  const capability = config.capabilities.MAPS_GEOCODING;
  if (!capability.isOperational) {
    return NextResponse.json({
      kind: "UNAVAILABLE",
      state: capability.state,
      retryable: capability.canRetry,
      manualAlternativeAvailable: true,
      message: capability.state === "DEGRADED"
        ? "Maps and geocoding are temporarily unavailable. Retry safely or enter the location manually."
        : "Maps and geocoding are not configured. Enter the location manually.",
    }, { status: 503 });
  }

  const accessCredential = (await cookies()).get(accessCookieName)?.value;
  if (!accessCredential) return NextResponse.json({ code: "UNAUTHENTICATED" }, { status: 401 });

  try {
    const response = await fetch(
      `${config.publicApiOrigin}/locations/${operation}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessCredential}`,
          accept: "application/json",
          "content-type": "application/json",
          "x-correlation-id": forwardCorrelationId(request),
        },
        body: await request.text(),
        cache: "no-store",
      },
    );
    return new NextResponse(await response.text(), {
      status: response.status,
      headers: { "content-type": response.headers.get("content-type") ?? "application/json" },
    });
  } catch {
    return NextResponse.json({
      kind: "UNAVAILABLE",
      state: "DEGRADED",
      retryable: true,
      manualAlternativeAvailable: true,
      message: "Maps and geocoding are temporarily unavailable. Retry safely or enter the location manually.",
    }, { status: 503 });
  }
}
