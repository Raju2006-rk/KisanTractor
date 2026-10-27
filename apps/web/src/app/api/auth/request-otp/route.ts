import { NextResponse } from "next/server";

import { runtimeConfig } from "../../../../lib/server-context";

function redirectTo(request: Request, path: string) {
  return NextResponse.redirect(new URL(path, request.url), 303);
}

export async function POST(request: Request) {
  const config = runtimeConfig();
  if (!config.capabilities.OTP.isOperational) {
    return redirectTo(request, "/capabilities/otp");
  }

  const formData = await request.formData();
  const role = formData.get("role") === "owner" ? "owner" : "farmer";
  const phone = formData.get("phone");
  const locale = formData.get("locale");
  if (typeof phone !== "string" || phone.trim().length === 0) {
    return redirectTo(request, `/login?role=${role}&error=invalid-phone`);
  }

  try {
    const response = await fetch(`${config.publicApiOrigin}/identity/otp/challenges`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      cache: "no-store",
      body: JSON.stringify({
        phone,
        purpose: role === "owner" ? "REGISTER_OWNER" : "REGISTER_FARMER",
        locale: typeof locale === "string" ? locale : "en",
      }),
    });
    const body = (await response.json()) as { challengeId?: unknown };
    if (!response.ok || typeof body.challengeId !== "string") {
      return redirectTo(request, `/login?role=${role}&error=request-failed`);
    }
    const query = new URLSearchParams({ challengeId: body.challengeId, role });
    return redirectTo(request, `/login/verify?${query.toString()}`);
  } catch {
    return redirectTo(request, `/login?role=${role}&error=request-failed`);
  }
}
