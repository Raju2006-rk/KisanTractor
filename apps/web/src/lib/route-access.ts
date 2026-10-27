import type { AuthPrincipal, UserRole } from "@kisantractor/domain";

export type RouteAccessFailure =
  | "AUTHENTICATION_REQUIRED"
  | "SESSION_UNAVAILABLE"
  | "ROLE_REQUIRED";

export type RouteAccessDecision =
  | { readonly allowed: true; readonly principal: AuthPrincipal }
  | { readonly allowed: false; readonly reason: RouteAccessFailure };

export type SessionAuthenticator = (
  accessCredential: string,
) => Promise<AuthPrincipal | undefined>;

export async function authorizeRouteAccess(
  accessCredential: string | undefined,
  requiredRole: UserRole,
  authenticate: SessionAuthenticator,
): Promise<RouteAccessDecision> {
  if (!accessCredential) {
    return { allowed: false, reason: "AUTHENTICATION_REQUIRED" };
  }

  let principal: AuthPrincipal | undefined;
  try {
    principal = await authenticate(accessCredential);
  } catch {
    return { allowed: false, reason: "SESSION_UNAVAILABLE" };
  }

  if (!principal) {
    return { allowed: false, reason: "AUTHENTICATION_REQUIRED" };
  }

  if (!principal.roles.includes(requiredRole)) {
    return { allowed: false, reason: "ROLE_REQUIRED" };
  }

  return { allowed: true, principal };
}

export function parseSessionPrincipal(value: unknown): AuthPrincipal | undefined {
  if (!value || typeof value !== "object") return undefined;

  const envelope = value as { principal?: unknown };
  if (!envelope.principal || typeof envelope.principal !== "object") return undefined;

  const principal = envelope.principal as Record<string, unknown>;
  if (
    typeof principal.userId !== "string" ||
    principal.userId.trim().length === 0 ||
    typeof principal.sessionId !== "string" ||
    principal.sessionId.trim().length === 0 ||
    !Array.isArray(principal.roles) ||
    !principal.roles.every(
      (role) =>
        role === "FARMER" || role === "OWNER" || role === "FUTURE_OPERATOR",
    )
  ) {
    return undefined;
  }

  return Object.freeze({
    userId: principal.userId,
    sessionId: principal.sessionId,
    roles: Object.freeze([...principal.roles]) as AuthPrincipal["roles"],
  });
}
