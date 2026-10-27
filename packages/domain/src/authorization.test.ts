import { describe, expect, it } from "vitest";

import type { AuthPrincipal } from "./identity.js";
import { authorize, type AuthorizationResource } from "./authorization.js";

const principal = (
  userId: string,
  roles: AuthPrincipal["roles"],
): AuthPrincipal => ({ userId, sessionId: `session-${userId}`, roles });

const booking: AuthorizationResource = {
  kind: "BOOKING",
  id: "booking-1",
  customerId: "farmer-1",
  ownerId: "owner-1",
};

const tractor: AuthorizationResource = {
  kind: "TRACTOR",
  id: "tractor-1",
  ownerId: "owner-1",
};

const document: AuthorizationResource = {
  kind: "DOCUMENT",
  id: "document-1",
  ownerId: "owner-1",
  tractorId: "tractor-1",
};

describe("authorize", () => {
  it("allows a Farmer to read and command only their own booking", () => {
    expect(authorize(principal("farmer-1", ["FARMER"]), "booking:read", booking).allowed).toBe(true);
    expect(authorize(principal("farmer-2", ["FARMER"]), "booking:command", booking).allowed).toBe(false);
  });

  it("allows an Owner to access only assigned bookings and owned Tractors", () => {
    const owner = principal("owner-1", ["OWNER"]);
    const otherOwner = principal("owner-2", ["OWNER"]);

    expect(authorize(owner, "booking:command", booking).allowed).toBe(true);
    expect(authorize(owner, "tractor:read", tractor).allowed).toBe(true);
    expect(authorize(otherOwner, "booking:read", booking).allowed).toBe(false);
    expect(authorize(otherOwner, "tractor:command", tractor).allowed).toBe(false);
  });

  it("requires document ownership or an explicit support grant", () => {
    expect(authorize(principal("owner-1", ["OWNER"]), "document:read", document).allowed).toBe(true);
    expect(authorize(principal("owner-2", ["OWNER"]), "document:read", document).allowed).toBe(false);
    expect(authorize(principal("support-1", ["FUTURE_OPERATOR"]), "document:read", document).allowed).toBe(false);
    expect(authorize(principal("support-1", ["FUTURE_OPERATOR"]), "document:read", document, true).allowed).toBe(true);
  });

  it("never treats a support grant as access without FUTURE_OPERATOR membership", () => {
    expect(authorize(principal("farmer-2", ["FARMER"]), "booking:read", booking, true).allowed).toBe(false);
  });

  it("defaults to deny for missing roles, unauthenticated actors, and mismatched resources", () => {
    expect(authorize(undefined, "booking:read", booking).allowed).toBe(false);
    expect(authorize(principal("farmer-1", []), "booking:read", booking).allowed).toBe(false);
    expect(authorize(principal("owner-1", ["OWNER"]), "booking:read", tractor).reason).toBe("ACTION_RESOURCE_MISMATCH");
  });
});
