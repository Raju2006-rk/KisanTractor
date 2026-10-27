import type { AuthPrincipal, UserRole } from "./identity.js";

export const authorizationActions = [
  "booking:read",
  "booking:command",
  "tractor:read",
  "tractor:command",
  "document:read",
  "document:command",
] as const;

export type AuthorizationAction = (typeof authorizationActions)[number];

export interface BookingAuthorizationResource {
  readonly kind: "BOOKING";
  readonly id: string;
  readonly customerId: string;
  readonly ownerId: string;
}

export interface TractorAuthorizationResource {
  readonly kind: "TRACTOR";
  readonly id: string;
  readonly ownerId: string;
}

export interface DocumentAuthorizationResource {
  readonly kind: "DOCUMENT";
  readonly id: string;
  readonly ownerId: string;
  readonly tractorId?: string;
}

export type AuthorizationResource =
  | BookingAuthorizationResource
  | TractorAuthorizationResource
  | DocumentAuthorizationResource;

export type AuthorizationDecision =
  | { readonly allowed: true; readonly reason: "EXPLICIT_POLICY" }
  | {
      readonly allowed: false;
      readonly reason:
        | "UNAUTHENTICATED"
        | "ROLE_OR_OWNERSHIP_REQUIRED"
        | "ACTION_RESOURCE_MISMATCH";
    };

const ALLOW: AuthorizationDecision = Object.freeze({
  allowed: true,
  reason: "EXPLICIT_POLICY",
});

const deny = (
  reason: Extract<AuthorizationDecision, { allowed: false }>['reason'],
): AuthorizationDecision => Object.freeze({ allowed: false, reason });

const hasRole = (principal: AuthPrincipal, role: UserRole): boolean =>
  principal.roles.includes(role);

const actionMatchesResource = (
  action: AuthorizationAction,
  resource: AuthorizationResource,
): boolean => action.startsWith(resource.kind.toLowerCase());

/**
 * Pure, default-deny authorization policy. `hasExplicitSupportAccess` must only
 * be true after a server-side policy has matched this actor, action, and exact
 * resource. FUTURE_OPERATOR membership alone never grants access.
 */
export function authorize(
  principal: AuthPrincipal | undefined,
  action: AuthorizationAction,
  resource: AuthorizationResource,
  hasExplicitSupportAccess = false,
): AuthorizationDecision {
  if (principal === undefined) return deny("UNAUTHENTICATED");
  if (!actionMatchesResource(action, resource)) {
    return deny("ACTION_RESOURCE_MISMATCH");
  }

  if (
    hasExplicitSupportAccess &&
    hasRole(principal, "FUTURE_OPERATOR")
  ) {
    return ALLOW;
  }

  if (resource.kind === "BOOKING") {
    if (
      (hasRole(principal, "FARMER") && resource.customerId === principal.userId) ||
      (hasRole(principal, "OWNER") && resource.ownerId === principal.userId)
    ) {
      return ALLOW;
    }
  } else if (
    (resource.kind === "TRACTOR" || resource.kind === "DOCUMENT") &&
    hasRole(principal, "OWNER") &&
    resource.ownerId === principal.userId
  ) {
    return ALLOW;
  }

  return deny("ROLE_OR_OWNERSHIP_REQUIRED");
}
