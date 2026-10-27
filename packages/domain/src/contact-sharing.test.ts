import { describe, expect, it } from "vitest";

import { canShareOwnerContact, ownerContactSharingStatuses, SHAREABLE_PHONE_PATTERN } from "./contact-sharing.js";

/** Validates: Requirements 3.4, 12.2 */
describe("Owner contact sharing policy", () => {
  const shareable = { viewerRole: "FARMER", ownerConsented: true, bookingStatus: "ACCEPTED", sharingEnabled: true } as const;

  it("shares only with the booking Farmer, with consent, while the parties coordinate work", () => {
    expect(canShareOwnerContact(shareable)).toBe(true);
    expect(canShareOwnerContact({ ...shareable, ownerConsented: false })).toBe(false);
    expect(canShareOwnerContact({ ...shareable, viewerRole: "OWNER" })).toBe(false);
    expect(canShareOwnerContact({ ...shareable, viewerRole: "PUBLIC" })).toBe(false);
    expect(canShareOwnerContact({ ...shareable, sharingEnabled: false })).toBe(false);
    expect(canShareOwnerContact({ ...shareable, bookingStatus: undefined })).toBe(false);
  });

  it("shares nothing before acceptance or after the booking closes", () => {
    for (const status of ["CREATED", "PENDING_OWNER_RESPONSE", "REJECTED", "CANCELLED", "EXPIRED", "COMPLETED", "REFUNDED"]) {
      expect(canShareOwnerContact({ ...shareable, bookingStatus: status }), status).toBe(false);
    }
    for (const status of ownerContactSharingStatuses) {
      expect(canShareOwnerContact({ ...shareable, bookingStatus: status }), status).toBe(true);
    }
  });

  it("accepts only E.164 Indian mobile numbers as shareable contacts", () => {
    expect(SHAREABLE_PHONE_PATTERN.test("+919876543210")).toBe(true);
    for (const value of ["9876543210", "+91 98765 43210", "+15005550006", "+911234567890", ""]) {
      expect(SHAREABLE_PHONE_PATTERN.test(value), value).toBe(false);
    }
  });
});
