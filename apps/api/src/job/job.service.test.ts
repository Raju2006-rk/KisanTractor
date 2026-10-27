import type { AuthPrincipal } from "@kisantractor/domain";
import { describe, expect, it } from "vitest";

import type {
  JobStore,
  ValidatedJobAction,
  ValidatedWorkEventCorrection,
  ValidatedWorkMeasurementCorrection,
  WorkSessionProjection,
  WorkSessionQuery,
} from "./job.contracts.js";
import {
  JobAuthorizationError,
  JobService,
  JobValidationError,
  normalizeWorkQuantity,
  validateCompletionQuantity,
} from "./job.service.js";

const owner: AuthPrincipal = { userId: "owner-1", sessionId: "session-1", roles: ["OWNER"] };
const farmer: AuthPrincipal = { userId: "farmer-1", sessionId: "session-2", roles: ["FARMER"] };
const now = new Date("2026-03-01T10:00:00.000Z");
const context = { correlationId: "corr-1", actorChannel: "WEB" as const };

const session: WorkSessionProjection = {
  bookingId: "booking-1",
  bookingStatus: "IN_PROGRESS",
  bookingVersion: 2,
  pricingMethod: "HOURLY",
  state: "ACTIVE",
  validNextActions: ["PAUSE", "COMPLETE"],
  events: [],
  measurements: [],
  activeIntervals: [],
  activeMilliseconds: 0,
  activeMinutes: 0,
  openStartedAt: now,
};

class CapturingJobStore implements JobStore {
  action?: ValidatedJobAction;
  eventCorrection?: ValidatedWorkEventCorrection;
  measurementCorrection?: ValidatedWorkMeasurementCorrection;
  sessionQuery?: WorkSessionQuery;

  async loadWorkSession(query: WorkSessionQuery) { this.sessionQuery = query; return session; }

  async recordAction(input: ValidatedJobAction) { this.action = input; return session; }
  async correctWorkEvent(input: ValidatedWorkEventCorrection) { this.eventCorrection = input; return session; }
  async correctWorkMeasurement(input: ValidatedWorkMeasurementCorrection) {
    this.measurementCorrection = input;
    return session;
  }
}

/** Validates: Requirements 9.1, 9.2, 9.5, 9.6 */
describe("JobService work commands", () => {
  it("uses server time, retains optional device time, and scopes a stable command digest", async () => {
    const store = new CapturingJobStore();
    const service = new JobService(store, () => now);
    const deviceObservedAt = new Date("2026-03-01T09:59:00.000Z");

    await service.startJob(owner, {
      bookingId: " booking-1 ", idempotencyKey: " retry-1 ", deviceObservedAt,
    }, context);

    expect(store.action).toMatchObject({
      bookingId: "booking-1",
      action: "START",
      actorId: "owner-1",
      idempotencyKey: "retry-1",
      receivedAt: now,
      deviceObservedAt,
    });
    expect(store.action?.requestDigest).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("normalizes acre quantities and accepts zero-value completion evidence", async () => {
    const store = new CapturingJobStore();
    const service = new JobService(store, () => now);
    await service.completeJob(owner, {
      bookingId: "booking-1", idempotencyKey: "complete-1", completedQuantity: "3.500",
    }, context);
    expect(store.action).toMatchObject({ action: "COMPLETE", completedQuantity: "3.5" });

    await service.completeJob(owner, {
      bookingId: "booking-1", idempotencyKey: "complete-2", completedQuantity: 0,
    }, context);
    expect(store.action?.completedQuantity).toBe("0");
  });

  it("rejects non-Owners and malformed quantities before persistence", async () => {
    const store = new CapturingJobStore();
    const service = new JobService(store, () => now);
    await expect(service.pauseJob(farmer, { bookingId: "booking-1", idempotencyKey: "pause" }, context))
      .rejects.toBeInstanceOf(JobAuthorizationError);
    await expect(service.completeJob(owner, {
      bookingId: "booking-1", idempotencyKey: "complete", completedQuantity: "1.2345",
    }, context)).rejects.toBeInstanceOf(JobValidationError);
    expect(store.action).toBeUndefined();
  });
});

/** Validates: Requirements 9.5, 9.6 */
describe("completion measurement validation", () => {
  it("requires acreage and whole trip counts while hourly work uses event intervals", () => {
    expect(() => validateCompletionQuantity("PER_ACRE", "1.125")).not.toThrow();
    expect(() => validateCompletionQuantity("PER_ACRE", undefined)).toThrow("Completed acres are required");
    expect(() => validateCompletionQuantity("PER_TRIP", "2")).not.toThrow();
    expect(() => validateCompletionQuantity("PER_TRIP", "2.5")).toThrow("nonnegative integer");
    expect(() => validateCompletionQuantity("HOURLY", undefined)).not.toThrow();
    expect(() => validateCompletionQuantity("HOURLY", "2")).toThrow("derives quantity from active intervals");
    expect(normalizeWorkQuantity("0.000", "quantity")).toBe("0");
  });
});

/** Validates: Requirements 9.7 */
describe("JobService append-only correction commands", () => {
  it("normalizes reasons and correction evidence before persistence", async () => {
    const store = new CapturingJobStore();
    const service = new JobService(store, () => now);
    const correctedEffectiveAt = new Date("2026-03-01T09:30:00.000Z");

    await service.correctWorkEvent(owner, {
      bookingId: "booking-1", eventId: "event-1", correctedEffectiveAt,
      reason: "  Device clock   was wrong ", idempotencyKey: "fix-event-1",
    }, context);
    await service.correctWorkMeasurement(owner, {
      bookingId: "booking-1", measurementId: "measurement-1", correctedQuantity: "2.250",
      reason: "  Field record corrected ", idempotencyKey: "fix-measurement-1",
    }, context);

    expect(store.eventCorrection).toMatchObject({
      eventId: "event-1", correctedEffectiveAt, reason: "Device clock was wrong", receivedAt: now,
    });
    expect(store.measurementCorrection).toMatchObject({
      measurementId: "measurement-1", correctedQuantity: "2.25", reason: "Field record corrected", receivedAt: now,
    });
  });
});

/** Validates: Requirements 2.3, 2.4, 2.5 */
describe("JobService work-session reads", () => {
  it("scopes reads to the requested role relationship and denies principals without that role", async () => {
    const store = new CapturingJobStore();
    const service = new JobService(store, () => now);

    await service.getWorkSession(farmer, " booking-1 ", "FARMER", context);
    expect(store.sessionQuery).toEqual({ bookingId: "booking-1", viewerId: "farmer-1", viewerRole: "FARMER" });

    store.sessionQuery = undefined;
    await expect(service.getWorkSession(farmer, "booking-1", "OWNER", context)).rejects.toBeInstanceOf(JobAuthorizationError);
    expect(store.sessionQuery).toBeUndefined();
  });

  /** Validates: Requirements 12.2 */
  it("omits the Owner's account identifiers from the Farmer's view of work events and measurements", async () => {
    const recorded: WorkSessionProjection = {
      ...session,
      events: [{
        id: "event-1", bookingId: "booking-1", action: "START", sequence: 1, effectiveAt: now, receivedAt: now,
        actorId: "owner-1", actorChannel: "WEB",
      } as unknown as WorkSessionProjection["events"][number]],
      measurements: [{
        id: "measurement-1", bookingId: "booking-1", method: "PER_ACRE", quantity: "2", unit: "ACRE",
        submittedByUserId: "owner-1", createdAt: now,
      }],
    };
    const store = new CapturingJobStore();
    store.loadWorkSession = async () => recorded;
    const service = new JobService(store, () => now);

    const farmerView = await service.getWorkSession(farmer, "booking-1", "FARMER", context);
    expect(JSON.stringify(farmerView)).not.toContain("owner-1");
    expect(farmerView.events[0]).toMatchObject({ id: "event-1", action: "START", actorChannel: "WEB" });
    expect(farmerView.measurements[0]).toMatchObject({ id: "measurement-1", quantity: "2" });

    const ownerView = await service.getWorkSession(owner, "booking-1", "OWNER", context);
    expect(ownerView.events[0]?.actorId).toBe("owner-1");
  });
});
