import type { SqlConnection, SqlPool, SqlQueryResult } from "@kisantractor/database";
import { describe, expect, it } from "vitest";

import type { BookingStatus, ValidatedBookingCreation } from "./booking.contracts.js";
import { BookingConflictError } from "./booking.service.js";
import { PostgresBookingStore } from "./postgres-booking-store.js";

const now = new Date("2026-03-01T10:00:00.000Z");
const start = new Date("2026-03-02T08:00:00.000Z");
const end = new Date("2026-03-02T10:00:00.000Z");
const input: ValidatedBookingCreation = {
  customerId: "00000000-0000-4000-8000-000000000001",
  command: {
    bookingTarget: "MYSELF", tractorId: "00000000-0000-4000-8000-000000000002",
    serviceOfferingId: "00000000-0000-4000-8000-000000000003",
    pricingRuleId: "00000000-0000-4000-8000-000000000004", pricingMethod: "HOURLY",
    expectedQuantity: "2", requestedInterval: { start, end },
    serviceLocation: { state: "AP", district: "Chittoor", mandalOrTaluk: "Pakala",
      village: "Village", source: "MANUAL_ADDRESS", capturedAt: now,
      collectionPurpose: "SERVICE_LOCATION" },
  },
  idempotencyKey: "same-key", requestDigest: "digest-1", disclosedAt: now,
};

class BookingConnection implements SqlConnection {
  readonly calls: { text: string; values: readonly unknown[] }[] = [];
  released = false;
  completed = false;
  outboxCount = 0;
  failOverlap = false;

  async query<Row extends object>(text: string, values: readonly unknown[] = []): Promise<SqlQueryResult<Row>> {
    this.calls.push({ text, values });
    let rows: readonly Record<string, unknown>[] = [];
    if (text.includes("SELECT request_digest")) {
      rows = [{ request_digest: "digest-1", resource_id: this.completed ? "booking-1" : null,
        status: this.completed ? "COMPLETED" : "IN_PROGRESS" }];
    } else if (text.includes("FOR UPDATE OF t, ta, so, pr")) {
      rows = [{ owner_id: "owner-1", tractor_id: input.command.tractorId,
        operational_status: "ONLINE", availability_status: "ONLINE", eligibility_status: "ELIGIBLE",
        location_updated_at: new Date("2026-03-01T09:00:00Z"), service_offering_id: input.command.serviceOfferingId,
        pricing_rule_id: input.command.pricingRuleId, pricing_method: "HOURLY", rate_paise: "80000",
        currency: "INR", rounding_policy: "PROPORTIONAL_MINUTE", pricing_rule_version: 3 }];
    } else if (text.includes("SELECT EXISTS")) {
      rows = [{ found: this.failOverlap }];
    } else if (text.includes("INSERT INTO public.bookings")) {
      rows = [{ id: "booking-1", public_reference: "KT-ABC123", customer_id: input.customerId,
        owner_id: "owner-1", tractor_id: input.command.tractorId,
        service_offering_id: input.command.serviceOfferingId, requested_start_at: start,
        requested_end_at: end, status: "PENDING_OWNER_RESPONSE", version: 1, created_at: now }];
    } else if (text.includes("INSERT INTO public.booking_agreements")) {
      rows = [{ id: "agreement-1" }];
    } else if (text.includes("INSERT INTO public.outbox_events")) {
      this.outboxCount += 1;
    } else if (text.includes("UPDATE public.idempotency_records")) {
      this.completed = true;
    } else if (text.includes("jsonb_build_object")) {
      rows = [{ id: "booking-1", public_reference: "KT-ABC123", customer_id: input.customerId,
        owner_id: "owner-1", tractor_id: input.command.tractorId,
        service_offering_id: input.command.serviceOfferingId, requested_start_at: start,
        requested_end_at: end, status: "PENDING_OWNER_RESPONSE", version: 1, created_at: now,
        service_location_snapshot: input.command.serviceLocation,
        quote_snapshot: { pricingRuleId: input.command.pricingRuleId, pricingRuleVersion: 3,
          method: "HOURLY", ratePaise: 80000, currency: "INR", roundingPolicy: "PROPORTIONAL_MINUTE",
          estimatedQuantity: "2", estimatedTotalPaise: 160000, disclosedAt: now.toISOString() },
        recipient_name: null, coordination_consent: null, landmark_or_directions: null }];
    }
    return { rows: rows as readonly Row[], rowCount: rows.length };
  }
  release(): void { this.released = true; }
}
class BookingPool implements SqlPool {
  constructor(readonly connection: BookingConnection) {}
  async connect(): Promise<SqlConnection> { this.connection.released = false; return this.connection; }
  async query<Row extends object>(): Promise<SqlQueryResult<Row>> { throw new Error("must use transaction connection"); }
}

/** Validates: Requirements 8.3, 8.4, 8.5 */
describe("PostgresBookingStore", () => {
  it("revalidates and writes booking, quote, history, outbox, and idempotency in one serializable transaction", async () => {
    const connection = new BookingConnection();
    const store = new PostgresBookingStore(new BookingPool(connection));
    const result = await store.createBooking(input, { correlationId: "corr-1", actorChannel: "WEB" });

    expect(result).toMatchObject({ id: "booking-1", customerId: input.customerId,
      status: "PENDING_OWNER_RESPONSE", quoteSnapshot: { pricingRuleVersion: 3, estimatedTotalPaise: 160000 } });
    expect(connection.calls[0]?.text).toContain("BEGIN ISOLATION LEVEL SERIALIZABLE");
    const validation = connection.calls.find((call) => call.text.includes("FOR UPDATE OF t, ta, so, pr"));
    expect(validation?.text).toMatch(/operational_status[\s\S]*eligibility_status[\s\S]*pr\.valid_from/iu);
    expect(connection.calls.some((call) => call.text.includes("booking_status_history"))).toBe(true);
    expect(connection.outboxCount).toBe(1);
    expect(connection.calls.at(-1)?.text).toBe("COMMIT");
    expect(connection.released).toBe(true);
  });

  it("returns the original booking for an equivalent Farmer-scoped retry without another side effect", async () => {
    const connection = new BookingConnection();
    const store = new PostgresBookingStore(new BookingPool(connection));
    const first = await store.createBooking(input, { correlationId: "corr-1", actorChannel: "WEB" });
    const second = await store.createBooking(input, { correlationId: "corr-2", actorChannel: "WEB" });

    expect(second.id).toBe(first.id);
    expect(connection.outboxCount).toBe(1);
    expect(connection.calls.filter((call) => call.text.includes("INSERT INTO public.bookings"))).toHaveLength(1);
    expect(connection.calls.find((call) => call.text.includes("farmer:"))).toBeUndefined();
    const claim = connection.calls.find((call) => call.text.includes("INSERT INTO public.idempotency_records"));
    expect(claim?.values[0]).toBe(`farmer:${input.customerId}:booking:create`);
  });

  it("rolls back without partial writes when a blocking interval now overlaps", async () => {
    const connection = new BookingConnection();
    connection.failOverlap = true;
    const store = new PostgresBookingStore(new BookingPool(connection));

    await expect(store.createBooking(input, { correlationId: "corr-1", actorChannel: "WEB" }))
      .rejects.toBeInstanceOf(BookingConflictError);
    expect(connection.calls.some((call) => call.text === "ROLLBACK")).toBe(true);
    expect(connection.calls.some((call) => call.text.includes("INSERT INTO public.bookings"))).toBe(false);
    expect(connection.outboxCount).toBe(0);
  });
});

class LifecycleConnection implements SqlConnection {
  readonly calls: { text: string; values: readonly unknown[] }[] = [];
  released = false;
  status: BookingStatus = "PENDING_OWNER_RESPONSE";
  version = 2;
  overlap = false;
  databaseConflict = false;
  historyCount = 0;
  outboxCount = 0;

  async query<Row extends object>(text: string, values: readonly unknown[] = []): Promise<SqlQueryResult<Row>> {
    this.calls.push({ text, values });
    let rows: readonly Record<string, unknown>[] = [];
    const booking = { id: "booking-1", public_reference: "KT-LIFECYCLE", customer_id: "farmer-1",
      owner_id: "owner-1", tractor_id: "tractor-1", service_offering_id: "offering-1",
      requested_start_at: start, requested_end_at: end, status: this.status, version: this.version, created_at: now };
    if (text.includes("WITH candidates AS")) {
      rows = [{ ...booking, status: "EXPIRED", version: this.version + 1 }];
    } else if (text.includes("FROM public.bookings WHERE id = $1 FOR UPDATE")) {
      rows = [booking];
    } else if (text.includes("INSERT INTO public.booking_agreements")) {
      rows = [{ id: "agreement-2" }];
    } else if (text.includes("SELECT EXISTS")) {
      rows = [{ found: this.overlap }];
    } else if (text.includes("UPDATE public.bookings SET status")) {
      if (this.databaseConflict) throw Object.assign(new Error("exclusion violation"), { code: "23P01" });
      if (values[3] !== this.version) rows = [];
      else {
        this.status = values[1] as typeof this.status;
        this.version += 1;
        rows = [{ ...booking, status: this.status, version: this.version }];
      }
    } else if (text.includes("INSERT INTO public.booking_status_history")) {
      this.historyCount += 1;
    } else if (text.includes("INSERT INTO public.outbox_events")) {
      this.outboxCount += 1;
    } else if (text.includes("jsonb_build_object")) {
      rows = [{ ...booking, status: this.status, version: this.version,
        service_location_snapshot: input.command.serviceLocation,
        quote_snapshot: { pricingRuleId: input.command.pricingRuleId, pricingRuleVersion: 3,
          method: "HOURLY", ratePaise: 80000, currency: "INR", roundingPolicy: "PROPORTIONAL_MINUTE",
          estimatedQuantity: "2", estimatedTotalPaise: 160000, disclosedAt: now.toISOString() },
        recipient_name: null, coordination_consent: null, landmark_or_directions: null }];
    }
    return { rows: rows as readonly Row[], rowCount: rows.length };
  }
  release(): void { this.released = true; }
}
class LifecyclePool implements SqlPool {
  constructor(readonly connection: LifecycleConnection) {}
  async connect(): Promise<SqlConnection> { return this.connection; }
  async query<Row extends object>(): Promise<SqlQueryResult<Row>> { throw new Error("must use transaction connection"); }
}

/** Validates: Requirements 8.6, 8.7, 8.9, 8.10 */
describe("PostgresBookingStore lifecycle transitions", () => {
  const context = { correlationId: "lifecycle-1", actorChannel: "WEB" as const };

  it("atomically accepts after locking the Tractor and checking half-open overlap", async () => {
    const connection = new LifecycleConnection();
    const store = new PostgresBookingStore(new LifecyclePool(connection));

    const result = await store.transitionBooking({ bookingId: "booking-1", expectedVersion: 2,
      actorId: "owner-1", actorRole: "OWNER", action: "ACCEPT", occurredAt: now }, context);

    expect(result).toMatchObject({ status: "ACCEPTED", version: 3 });
    expect(connection.calls[0]?.text).toContain("BEGIN ISOLATION LEVEL SERIALIZABLE");
    expect(connection.calls.some((call) => call.text.includes("public.tractors") && call.text.includes("FOR UPDATE"))).toBe(true);
    const overlap = connection.calls.find((call) => call.text.includes("SELECT EXISTS"));
    expect(overlap?.text).toMatch(/requested_start_at < \$4 AND \$3 < conflicting\.requested_end_at/u);
    expect(overlap?.text).not.toContain("<=");
    expect(connection.historyCount).toBe(1);
    expect(connection.outboxCount).toBe(1);
    expect(connection.calls.at(-1)?.text).toBe("COMMIT");
  });

  it("rejects domain overlap before mutation and maps database exclusion races to a conflict", async () => {
    const overlapConnection = new LifecycleConnection();
    overlapConnection.overlap = true;
    const overlapStore = new PostgresBookingStore(new LifecyclePool(overlapConnection));
    await expect(overlapStore.transitionBooking({ bookingId: "booking-1", expectedVersion: 2,
      actorId: "owner-1", actorRole: "OWNER", action: "ACCEPT", occurredAt: now }, context))
      .rejects.toThrow("overlapping interval");
    expect(overlapConnection.historyCount).toBe(0);
    expect(overlapConnection.calls.at(-1)?.text).toBe("ROLLBACK");

    const databaseConnection = new LifecycleConnection();
    databaseConnection.databaseConflict = true;
    const databaseStore = new PostgresBookingStore(new LifecyclePool(databaseConnection));
    await expect(databaseStore.transitionBooking({ bookingId: "booking-1", expectedVersion: 2,
      actorId: "owner-1", actorRole: "OWNER", action: "ACCEPT", occurredAt: now }, context))
      .rejects.toThrow("reserved concurrently");
    expect(databaseConnection.historyCount).toBe(0);
  });

  it("enforces ownership, optimistic versions, and Farmer/Owner cancellation policies without partial state", async () => {
    const stale = new LifecycleConnection();
    const store = new PostgresBookingStore(new LifecyclePool(stale));
    await expect(store.transitionBooking({ bookingId: "booking-1", expectedVersion: 1,
      actorId: "owner-1", actorRole: "OWNER", action: "REJECT", reason: "Unavailable", occurredAt: now }, context))
      .rejects.toThrow("version conflict");
    expect(stale.historyCount).toBe(0);

    const pendingOwnerCancel = new LifecycleConnection();
    await expect(new PostgresBookingStore(new LifecyclePool(pendingOwnerCancel)).transitionBooking({
      bookingId: "booking-1", expectedVersion: 2, actorId: "owner-1", actorRole: "OWNER",
      action: "CANCEL", reason: "Unavailable", occurredAt: now }, context)).rejects.toThrow("cannot cancel");

    const farmerCancel = new LifecycleConnection();
    const cancelled = await new PostgresBookingStore(new LifecyclePool(farmerCancel)).transitionBooking({
      bookingId: "booking-1", expectedVersion: 2, actorId: "farmer-1", actorRole: "FARMER",
      action: "CANCEL", reason: "Plans changed", occurredAt: now }, context);
    expect(cancelled.status).toBe("CANCELLED");
    expect(farmerCancel.historyCount).toBe(1);
  });
});

/** Validates: Requirements 8.8, 8.10, 8.11, 14.6 */
describe("PostgresBookingStore complete lifecycle operations", () => {
  const context = { correlationId: "lifecycle-complete", actorChannel: "WEB" as const };

  it("applies exceptional outcomes with exactly one history and notification outbox event", async () => {
    const scenarios = [
      { from: "PENDING_OWNER_RESPONSE", action: "REJECT", role: "OWNER", actorId: "owner-1", to: "REJECTED" },
      { from: "FINAL_BILL_GENERATED", action: "DISPUTE", role: "FARMER", actorId: "farmer-1", to: "DISPUTED" },
      { from: "DISPUTED", action: "REQUEST_REFUND", role: "SUPPORT", actorId: "support-1", to: "REFUND_PENDING" },
      { from: "REFUND_PENDING", action: "REFUND", role: "SYSTEM", actorId: "system", to: "REFUNDED" },
    ] as const;
    for (const scenario of scenarios) {
      const connection = new LifecycleConnection();
      connection.status = scenario.from;
      const result = await new PostgresBookingStore(new LifecyclePool(connection)).transitionBooking({
        bookingId: "booking-1", expectedVersion: 2, actorId: scenario.actorId,
        actorRole: scenario.role, action: scenario.action, occurredAt: now,
        ...(["REJECT", "DISPUTE", "REQUEST_REFUND"].includes(scenario.action) ? { reason: "Required reason" } : {}),
      }, context);
      expect(result.status).toBe(scenario.to);
      expect(connection.historyCount).toBe(1);
      expect(connection.outboxCount).toBe(1);
      const payload = connection.calls.find((call) => call.text.includes("INSERT INTO public.outbox_events"))?.values[3];
      expect(String(payload)).toContain("notificationRecipients");
    }
  });

  it("creates an append-only mutually approved agreement version and queues notifications", async () => {
    const connection = new LifecycleConnection();
    connection.status = "ACCEPTED";
    const store = new PostgresBookingStore(new LifecyclePool(connection));
    await store.changeAgreement({
      bookingId: "booking-1", expectedVersion: 2, actorId: "owner-1", reason: "Changed acreage",
      customerApprovedAt: now, ownerApprovedAt: now,
      serviceLocationSnapshot: input.command.serviceLocation,
      quoteSnapshot: { pricingRuleId: input.command.pricingRuleId, pricingRuleVersion: 4,
        method: "PER_ACRE", ratePaise: 120000, currency: "INR", estimatedQuantity: "3",
        estimatedTotalPaise: 360000, disclosedAt: now.toISOString() },
    }, context);
    const insert = connection.calls.find((call) => call.text.includes("INSERT INTO public.booking_agreements"));
    expect(insert?.text).toContain("MAX(agreement_version)");
    expect(insert?.text).toContain("approved_by_customer_at");
    expect(connection.calls.some((call) => call.text.includes("current_agreement_id"))).toBe(true);
    expect(connection.outboxCount).toBe(1);
  });

  it("expires pending requests in a bounded skip-locked job with history and outbox", async () => {
    const connection = new LifecycleConnection();
    const count = await new PostgresBookingStore(new LifecyclePool(connection)).expirePendingBookings({
      pendingBefore: now, occurredAt: now, limit: 25,
    }, { correlationId: "expiry-job", actorChannel: "SYSTEM" });
    expect(count).toBe(1);
    const job = connection.calls.find((call) => call.text.includes("WITH candidates AS"));
    expect(job?.text).toContain("FOR UPDATE SKIP LOCKED LIMIT $2");
    expect(job?.values[1]).toBe(25);
    expect(connection.historyCount).toBe(1);
    expect(connection.outboxCount).toBe(1);
  });
});