import type { AuditEventInput } from "@kisantractor/database";
import type { AuthPrincipal } from "@kisantractor/domain";
import { ownerContactSharingStatuses } from "@kisantractor/domain";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { NotificationBookingContext } from "./notification.contracts.js";
import { OwnerContactNotFoundError, OwnerContactService } from "./owner-contact.service.js";
import { PushDeviceService, PushDeviceValidationError, PushUnavailableError } from "./push-device.service.js";

const farmerId = "10000000-0000-4000-8000-000000000001";
const ownerId = "10000000-0000-4000-8000-000000000002";
const otherFarmerId = "10000000-0000-4000-8000-000000000003";
const bookingId = "70000000-0000-4000-8000-000000000001";
const OWNER_PHONE = "+919876543210";
const context = { correlationId: "corr-contact-1", actorChannel: "WEB" } as const;

const principal = (userId: string, roles: AuthPrincipal["roles"] = ["FARMER"]): AuthPrincipal =>
  ({ userId, sessionId: "session-1", roles });

const setup = (booking: Partial<NotificationBookingContext> = {}, options: { enabled?: boolean; phone?: string } = {}) => {
  const audits: AuditEventInput[] = [];
  const lookups: string[] = [];
  const context: NotificationBookingContext = {
    bookingId, publicReference: "KT-ABCDEF123456", customerId: farmerId, ownerId,
    status: "ACCEPTED", ownerContactSharingConsent: true, ...booking,
  };
  const service = new OwnerContactService({
    enabled: options.enabled ?? true,
    bookings: { loadBookingContext: async (id) => (id === bookingId ? context : undefined) },
    directory: { ownerPhone: async (id) => { lookups.push(id); return "phone" in options ? options.phone : OWNER_PHONE; } },
    audit: async (event) => { audits.push(event); },
  });
  return { service, audits, lookups };
};

/** Validates: Requirements 2.3, 2.7, 3.4, 12.1, 12.2 */
describe("Owner contact reveal for the booking Farmer", () => {
  it("reveals the number to the booking Farmer with consent in a coordinating state, and audits it without the number", async () => {
    const { service, audits } = setup();
    await expect(service.farmerView(principal(farmerId), bookingId, context)).resolves.toEqual({ shared: true, phone: OWNER_PHONE });
    expect(audits).toEqual([expect.objectContaining({
      actorId: farmerId, action: "booking.owner_contact.revealed", resourceType: "Booking", resourceId: bookingId, outcome: "SUCCESS",
    })]);
    expect(JSON.stringify(audits)).not.toContain(OWNER_PHONE);
  });

  it("answers other Farmers, Owners, and unknown bookings like a missing booking", async () => {
    const { service, lookups } = setup();
    for (const [who, id] of [
      [principal(otherFarmerId), bookingId],
      [principal(ownerId, ["OWNER"]), bookingId],
      [principal(farmerId, ["OWNER"]), bookingId],
      [principal(farmerId), "70000000-0000-4000-8000-000000000999"],
      [principal(farmerId), "not-a-uuid"],
    ] as const) {
      await expect(service.farmerView(who, id, context)).rejects.toBeInstanceOf(OwnerContactNotFoundError);
    }
    expect(lookups).toEqual([]);
  });

  it("withholds the number, without decrypting it, unless every condition holds", async () => {
    const cases = [
      [{}, { enabled: false }, "SHARING_NOT_ENABLED"],
      [{ ownerContactSharingConsent: false }, {}, "OWNER_NOT_CONSENTED"],
      [{ status: "PENDING_OWNER_RESPONSE" }, {}, "BOOKING_STATE"],
      [{ status: "COMPLETED" }, {}, "BOOKING_STATE"],
      [{ status: "CANCELLED" }, {}, "BOOKING_STATE"],
    ] as const;
    for (const [booking, options, reason] of cases) {
      const { service, lookups, audits } = setup(booking, options);
      await expect(service.farmerView(principal(farmerId), bookingId, context), reason).resolves.toEqual({ shared: false, reason });
      expect(lookups, reason).toEqual([]);
      expect(audits, reason).toEqual([]);
    }
    const unavailable = setup({}, { phone: undefined });
    await expect(unavailable.service.farmerView(principal(farmerId), bookingId, context))
      .resolves.toEqual({ shared: false, reason: "CONTACT_UNAVAILABLE" });
    expect(unavailable.audits).toEqual([]);
  });

  it("never returns the number for any combination the policy does not allow", async () => {
    const statuses = [...ownerContactSharingStatuses, "CREATED", "PENDING_OWNER_RESPONSE", "REJECTED", "CANCELLED", "EXPIRED", "COMPLETED", "REFUNDED"];
    await fc.assert(fc.asyncProperty(
      fc.boolean(), fc.boolean(), fc.constantFrom(...statuses), fc.constantFrom(farmerId, otherFarmerId), fc.boolean(),
      async (enabled, consent, status, viewer, viewerIsFarmer) => {
        const { service } = setup({ status, ownerContactSharingConsent: consent }, { enabled });
        const allowed = enabled && consent && ownerContactSharingStatuses.includes(status) && viewer === farmerId && viewerIsFarmer;
        const view = await service.farmerView(principal(viewer, viewerIsFarmer ? ["FARMER"] : ["OWNER"]), bookingId, context)
          .catch((error: unknown) => (error instanceof OwnerContactNotFoundError ? undefined : Promise.reject(error)));
        expect(JSON.stringify(view ?? {}).includes(OWNER_PHONE)).toBe(allowed);
      },
    ), { numRuns: 200 });
  });
});

/** Validates: Requirements 12.1, 12.5, 17.5 */
describe("push device registration", () => {
  const token = "fcm-registration-token-0001:APA91bSynthetic";
  const registry = () => {
    const calls: Array<readonly unknown[]> = [];
    return {
      calls,
      registerPushDevice: async (...args: unknown[]) => { calls.push(["register", ...args]); },
      unregisterPushDevice: async (...args: unknown[]) => { calls.push(["unregister", ...args]); return true; },
    };
  };

  it("accepts a valid token only while push can be sent, and always lets a user remove one", async () => {
    const available = registry();
    const at = new Date("2026-05-12T04:00:00.000Z");
    await new PushDeviceService(available, () => true, () => at).register(principal(farmerId), { token, platform: "WEB" });
    expect(available.calls).toEqual([["register", farmerId, token, "WEB", at]]);

    const off = registry();
    const service = new PushDeviceService(off, () => false);
    await expect(service.register(principal(farmerId), { token, platform: "ANDROID" })).rejects.toBeInstanceOf(PushUnavailableError);
    await service.unregister(principal(farmerId), { token });
    expect(off.calls).toEqual([["unregister", farmerId, token]]);
  });

  it("refuses malformed tokens and platforms before storing anything", async () => {
    const devices = registry();
    const service = new PushDeviceService(devices, () => true);
    for (const input of [{ token: "short", platform: "WEB" }, { token: `${token} <script>`, platform: "WEB" }, { token, platform: "SYMBIAN" }, {}]) {
      await expect(service.register(principal(farmerId), input)).rejects.toBeInstanceOf(PushDeviceValidationError);
    }
    expect(devices.calls).toEqual([]);
  });
});
