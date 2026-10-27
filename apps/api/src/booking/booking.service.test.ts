import type { AuthPrincipal } from "@kisantractor/domain";
import { describe, expect, it } from "vitest";

import type {
  BookingStore,
  CreateBookingCommand,
  ValidatedBookingCreation,
  ValidatedBookingTransition,
} from "./booking.contracts.js";
import { BookingAuthorizationError, BookingService, BookingValidationError } from "./booking.service.js";

const farmer: AuthPrincipal = { userId: "farmer-1", sessionId: "session-1", roles: ["FARMER"] };
const owner: AuthPrincipal = { userId: "owner-1", sessionId: "session-2", roles: ["OWNER"] };
const secrets = { fieldEncryptionKey: new Uint8Array(32).fill(4), lookupHashKey: new Uint8Array(32).fill(9) };
const now = new Date("2026-03-01T10:00:00.000Z");
const command = (target: "MYSELF" | "SOMEONE_ELSE"): CreateBookingCommand => ({
  bookingTarget: target,
  tractorId: "tractor-1",
  serviceOfferingId: "offering-1",
  pricingRuleId: "pricing-1",
  pricingMethod: "HOURLY",
  expectedQuantity: "2.5",
  requestedInterval: { start: new Date("2026-03-02T08:00:00Z"), end: new Date("2026-03-02T10:30:00Z") },
  serviceLocation: {
    state: " Andhra Pradesh ", district: "Chittoor", mandalOrTaluk: "Pakala", village: "Damallacheruvu",
    landmark: "Near the water tank", source: "MANUAL_ADDRESS", capturedAt: now,
  },
  ...(target === "SOMEONE_ELSE" ? { recipient: {
    name: "  Ravi  Kumar ", coordinationPhone: "9876543210", coordinationConsent: true,
    landmarkOrDirections: "Opposite school",
  } } : {}),
});

class CapturingStore implements BookingStore {
  captured?: ValidatedBookingCreation;
  capturedTransition?: ValidatedBookingTransition;
  async createBooking(input: ValidatedBookingCreation) {
    this.captured = input;
    return {
      id: "booking-1", publicReference: "KT-ABC", customerId: input.customerId, ownerId: "owner-1",
      tractorId: input.command.tractorId, serviceOfferingId: input.command.serviceOfferingId,
      status: "PENDING_OWNER_RESPONSE" as const, requestedInterval: input.command.requestedInterval,
      serviceLocationSnapshot: input.command.serviceLocation,
      ...(input.recipient === undefined ? {} : { recipient: { name: input.recipient.name,
        coordinationConsent: input.recipient.coordinationConsent } }),
      quoteSnapshot: { pricingRuleId: "pricing-1", pricingRuleVersion: 1, method: "HOURLY" as const,
        ratePaise: 80_000, currency: "INR" as const, roundingPolicy: "PROPORTIONAL_MINUTE" as const,
        estimatedQuantity: "2.5", estimatedTotalPaise: 200_000, disclosedAt: now.toISOString() },
      version: 1, createdAt: now,
    };
  }

  async changeAgreement(input: Parameters<BookingStore["changeAgreement"]>[0]) {
    return this.transitionBooking({ bookingId: input.bookingId, expectedVersion: input.expectedVersion,
      actorId: input.actorId, actorRole: "OWNER", action: "SCHEDULE", occurredAt: now });
  }

  async expirePendingBookings() { return 0; }

  async transitionBooking(input: ValidatedBookingTransition) {
    this.capturedTransition = input;
    return {
      id: input.bookingId, publicReference: "KT-ABC", customerId: "farmer-1", ownerId: "owner-1",
      tractorId: "tractor-1", serviceOfferingId: "offering-1",
      status: input.action === "ACCEPT" ? "ACCEPTED" as const
        : input.action === "REJECT" ? "REJECTED" as const : "CANCELLED" as const,
      requestedInterval: command("MYSELF").requestedInterval,
      serviceLocationSnapshot: {
        state: "Andhra Pradesh", district: "Chittoor", mandalOrTaluk: "Pakala", village: "Village",
        source: "MANUAL_ADDRESS" as const, capturedAt: now, collectionPurpose: "SERVICE_LOCATION" as const,
      },
      quoteSnapshot: { pricingRuleId: "pricing-1", pricingRuleVersion: 1, method: "HOURLY" as const,
        ratePaise: 80_000, currency: "INR" as const, roundingPolicy: "PROPORTIONAL_MINUTE" as const,
        estimatedQuantity: "2", estimatedTotalPaise: 160_000, disclosedAt: now.toISOString() },
      version: input.expectedVersion + 1, createdAt: now,
    };
  }
}

/** Validates: Requirements 8.1, 8.2, 8.3, 8.4, 8.5 */
describe("BookingService creation commands", () => {
  it("creates a self-booking with a normalized immutable service-location input", async () => {
    const store = new CapturingStore();
    const service = new BookingService(store, secrets, () => now);
    await service.createBooking(farmer, command("MYSELF"), " retry-key-1 ", { correlationId: "corr-1", actorChannel: "WEB" });

    expect(store.captured).toMatchObject({ customerId: "farmer-1", idempotencyKey: "retry-key-1" });
    expect(store.captured?.command.serviceLocation).toMatchObject({ state: "Andhra Pradesh", collectionPurpose: "SERVICE_LOCATION" });
    expect(store.captured?.recipient).toBeUndefined();
    expect(store.captured?.requestDigest).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("stores Recipient independently with encrypted normalized coordination phone", async () => {
    const store = new CapturingStore();
    const service = new BookingService(store, secrets, () => now);
    await service.createBooking(farmer, command("SOMEONE_ELSE"), "retry-key-2", { correlationId: "corr-2", actorChannel: "WEB" });

    expect(store.captured?.recipient).toMatchObject({ name: "Ravi Kumar", coordinationConsent: true,
      landmarkOrDirections: "Opposite school" });
    expect(store.captured?.recipient?.coordinationPhoneCiphertext).toBeInstanceOf(Uint8Array);
    expect(store.captured?.recipient?.coordinationPhoneLookupHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(Buffer.from(store.captured!.recipient!.coordinationPhoneCiphertext!).toString()).not.toContain("+919876543210");
  });

  it("rejects missing Recipient, invalid intervals, and phone storage without consent before persistence", async () => {
    const store = new CapturingStore();
    const service = new BookingService(store, secrets, () => now);
    const missing = { ...command("SOMEONE_ELSE"), recipient: undefined };
    await expect(service.createBooking(farmer, missing, "key-a", { correlationId: "c", actorChannel: "WEB" }))
      .rejects.toBeInstanceOf(BookingValidationError);
    const invalid = { ...command("MYSELF"), requestedInterval: { start: now, end: now } };
    await expect(service.createBooking(farmer, invalid, "key-b", { correlationId: "c", actorChannel: "WEB" }))
      .rejects.toThrow("Booking start must be before booking end");
    const noConsent = { ...command("SOMEONE_ELSE"), recipient: { name: "Ravi", coordinationPhone: "9876543210" } };
    await expect(service.createBooking(farmer, noConsent, "key-c", { correlationId: "c", actorChannel: "WEB" }))
      .rejects.toThrow("Consent is required");
    expect(store.captured).toBeUndefined();
  });
});

/** Validates: Requirements 8.6, 8.9, 8.10 */
describe("BookingService owner decisions and cancellation commands", () => {
  it("passes an Owner acceptance with the expected version and authoritative time", async () => {
    const store = new CapturingStore();
    const service = new BookingService(store, secrets, () => now);

    const result = await service.acceptBooking(owner, { bookingId: "booking-1", expectedVersion: 3 },
      { correlationId: "accept-1", actorChannel: "WEB" });

    expect(result).toMatchObject({ status: "ACCEPTED", version: 4 });
    expect(store.capturedTransition).toEqual({ bookingId: "booking-1", expectedVersion: 3,
      actorId: "owner-1", actorRole: "OWNER", action: "ACCEPT", occurredAt: now });
  });

  it("requires a normalized reason for rejection and cancellation", async () => {
    const store = new CapturingStore();
    const service = new BookingService(store, secrets, () => now);

    await service.rejectBooking(owner, { bookingId: "booking-1", expectedVersion: 1,
      reason: "  Cannot   serve this village " }, { correlationId: "reject-1", actorChannel: "MOBILE" });
    expect(store.capturedTransition).toMatchObject({ action: "REJECT", reason: "Cannot serve this village" });

    await expect(service.cancelBooking(farmer, { bookingId: "booking-1", expectedVersion: 2 },
      { correlationId: "cancel-1", actorChannel: "WEB" }, "FARMER")).rejects.toBeInstanceOf(BookingValidationError);
  });

  it("rejects wrong roles and invalid optimistic versions before persistence", async () => {
    const store = new CapturingStore();
    const service = new BookingService(store, secrets, () => now);

    await expect(service.acceptBooking(farmer, { bookingId: "booking-1", expectedVersion: 1 },
      { correlationId: "accept-2", actorChannel: "WEB" })).rejects.toBeInstanceOf(BookingAuthorizationError);
    await expect(service.cancelBooking(owner, { bookingId: "booking-1", expectedVersion: 0, reason: "Unavailable" },
      { correlationId: "cancel-2", actorChannel: "WEB" }, "OWNER")).rejects.toThrow("positive safe integer");
    expect(store.capturedTransition).toBeUndefined();
  });
});