import { getPublicRuntimeConfig, validateEnvironment } from "@kisantractor/config";
import {
  defaultLocale,
  resolveLocale,
  type CatalogLocale,
} from "@kisantractor/i18n";
import type { AuthPrincipal, UserRole } from "@kisantractor/domain";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import {
  authorizeRouteAccess,
  parseSessionPrincipal,
} from "./route-access";

export const accessCookieName = "kt_access_token";
export const localeCookieName = "kt_locale";

export function runtimeConfig() {
  const inferredEnvironment =
    process.env.APP_ENV ?? (process.env.NODE_ENV === "test" ? "test" : "local");
  const input = process.env.APP_ENV
    ? process.env
    : {
        ...process.env,
        APP_ENV: inferredEnvironment,
        NODE_ENV: inferredEnvironment === "test" ? "test" : "development",
      };
  return getPublicRuntimeConfig(validateEnvironment(input));
}

export async function loadLocale(): Promise<CatalogLocale> {
  const cookieStore = await cookies();
  return resolveLocale(cookieStore.get(localeCookieName)?.value ?? defaultLocale);
}

export async function authenticateServerSession(
  accessCredential: string,
): Promise<AuthPrincipal | undefined> {
  const config = runtimeConfig();
  const response = await fetch(`${config.publicApiOrigin}/identity/session`, {
    method: "GET",
    headers: {
      authorization: `Bearer ${accessCredential}`,
      accept: "application/json",
    },
    cache: "no-store",
  });

  if (!response.ok) return undefined;
  return parseSessionPrincipal(await response.json());
}

export async function loadAuthorizedRoute(
  requiredRole: Extract<UserRole, "FARMER" | "OWNER">,
  returnTo: string,
): Promise<{ readonly principal: AuthPrincipal; readonly locale: CatalogLocale }> {
  const cookieStore = await cookies();
  const decision = await authorizeRouteAccess(
    cookieStore.get(accessCookieName)?.value,
    requiredRole,
    authenticateServerSession,
  );

  if (!decision.allowed) {
    const parameters = new URLSearchParams({
      next: returnTo.startsWith("/") ? returnTo : "/",
      reason: decision.reason.toLowerCase(),
    });
    redirect(`/login?${parameters.toString()}`);
  }

  return {
    principal: decision.principal,
    locale: resolveLocale(cookieStore.get(localeCookieName)?.value),
  };
}
