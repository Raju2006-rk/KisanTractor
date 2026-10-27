import { NextResponse } from "next/server";

import { parseSessionPrincipal } from "../../../../lib/route-access";
import { accessCookieName, runtimeConfig } from "../../../../lib/server-context";

function redirectTo(request: Request, path: string) {
  return NextResponse.redirect(new URL(path, request.url), 303);
}

export async function POST(request: Request) {
  const formData = await request.formData();
  const challengeId = formData.get("challengeId");
  const phone = formData.get("phone");
  const code = formData.get("code");
  const role = formData.get("role") === "owner" ? "owner" : "farmer";
  if (![challengeId, phone, code].every((value) => typeof value === "string" && value.trim().length > 0)) {
    return redirectTo(request, "/login?error=invalid-verification");
  }

  const config = runtimeConfig();
  try {
    const response = await fetch(`${config.publicApiOrigin}/identity/otp/verify`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      cache: "no-store",
      body: JSON.stringify({
        challengeId,
        phone,
        code,
        purpose: role === "owner" ? "REGISTER_OWNER" : "REGISTER_FARMER",
      }),
    });
    const body = (await response.json()) as {
      principal?: unknown;
      accessCredential?: unknown;
      refreshCredential?: unknown;
      accessExpiresAt?: unknown;
      refreshExpiresAt?: unknown;
    };
    const principal = parseSessionPrincipal({ principal: body.principal });
    const requiredRole = role === "owner" ? "OWNER" : "FARMER";
    if (
      !response.ok ||
      !principal?.roles.includes(requiredRole) ||
      typeof body.accessCredential !== "string" ||
      typeof body.refreshCredential !== "string"
    ) {
      return redirectTo(request, `/login/verify?challengeId=${encodeURIComponent(String(challengeId))}&role=${role}&error=rejected`);
    }

    const destination = role === "owner" ? "/owner" : "/farmer";
    const result = redirectTo(request, destination);
    const secure = process.env.NODE_ENV === "production";
    result.cookies.set(accessCookieName, body.accessCredential, {
      httpOnly: true,
      secure,
      sameSite: "lax",
      path: "/",
      expires: typeof body.accessExpiresAt === "string" ? new Date(body.accessExpiresAt) : undefined,
    });
    result.cookies.set("kt_refresh_token", body.refreshCredential, {
      httpOnly: true,
      secure,
      sameSite: "strict",
      path: "/api/auth",
      expires: typeof body.refreshExpiresAt === "string" ? new Date(body.refreshExpiresAt) : undefined,
    });
    return result;
  } catch {
    return redirectTo(request, `/login/verify?challengeId=${encodeURIComponent(String(challengeId))}&role=${role}&error=unavailable`);
  }
}
