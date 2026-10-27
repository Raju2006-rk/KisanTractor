import { describe, expect, it, vi } from "vitest";

import { authorizeRouteAccess, parseSessionPrincipal } from "./route-access";

const farmer = {
  userId: "farmer-1",
  sessionId: "session-1",
  roles: ["FARMER"] as const,
};

/** Validates: Requirement 2.6 */
describe("server route authorization", () => {
  it("fails closed before calling the authenticator when no credential exists", async () => {
    const authenticate = vi.fn();
    await expect(authorizeRouteAccess(undefined, "FARMER", authenticate)).resolves.toEqual({
      allowed: false,
      reason: "AUTHENTICATION_REQUIRED",
    });
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("allows only an explicit role returned by server authentication", async () => {
    const authenticate = vi.fn().mockResolvedValue(farmer);
    await expect(authorizeRouteAccess("secret", "FARMER", authenticate)).resolves.toEqual({
      allowed: true,
      principal: farmer,
    });
    await expect(authorizeRouteAccess("secret", "OWNER", authenticate)).resolves.toEqual({
      allowed: false,
      reason: "ROLE_REQUIRED",
    });
  });

  it("fails closed when session validation is unavailable", async () => {
    const authenticate = vi.fn().mockRejectedValue(new Error("network unavailable"));
    await expect(authorizeRouteAccess("secret", "FARMER", authenticate)).resolves.toEqual({
      allowed: false,
      reason: "SESSION_UNAVAILABLE",
    });
  });

  it("rejects malformed and unknown role data from the session endpoint", () => {
    expect(parseSessionPrincipal({ principal: { ...farmer, roles: ["ADMIN"] } })).toBeUndefined();
    expect(parseSessionPrincipal({ principal: { ...farmer, sessionId: "" } })).toBeUndefined();
    expect(parseSessionPrincipal({ principal: farmer })).toEqual(farmer);
  });
});
