import { randomUUID } from "node:crypto";

import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { accessCookieName, runtimeConfig } from "../../../../lib/server-context";
import { forwardCorrelationId } from "../../../../lib/correlation";

export async function POST(request: Request) {
  const cookieStore = await cookies();
  const accessCredential = cookieStore.get(accessCookieName)?.value;
  if (!accessCredential) return NextResponse.json({ code: "UNAUTHENTICATED" }, { status: 401 });

  try {
    const response = await fetch(`${runtimeConfig().publicApiOrigin}/farmer/bookings`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessCredential}`,
        accept: "application/json",
        "content-type": "application/json",
        "idempotency-key": request.headers.get("idempotency-key") ?? randomUUID(),
        "x-client-channel": "WEB",
        "x-correlation-id": forwardCorrelationId(request),
      },
      body: await request.text(),
      cache: "no-store",
    });
    return new NextResponse(await response.text(), {
      status: response.status,
      headers: { "content-type": response.headers.get("content-type") ?? "application/json" },
    });
  } catch {
    return NextResponse.json({ code: "SERVICE_UNAVAILABLE" }, { status: 503 });
  }
}
