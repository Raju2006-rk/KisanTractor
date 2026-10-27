import type { SqlConnection, SqlPool, SqlQueryResult } from "@kisantractor/database";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { BOOKING_TRANSITION_TABLE, bookingTransitionRule } from "./booking-lifecycle.js";
import type {
  BookingLifecycleAction,
  BookingLifecycleActorRole,
  BookingStatus,
  ValidatedBookingCreation,
} from "./booking.contracts.js";
import { PostgresBookingStore } from "./postgres-booking-store.js";

const propertyRuns = 150;
const seeds = {
  idempotentCreation: 8_500_401,
  noAcceptedOverlap: 8_600_502,
  adjacentIntervals: 8_700_603,
  lifecycleSafety: 8_910_704,
} as const;
const now = new Date("2026-03-01T10:00:00.000Z");
const context = { correlationId: "booking-property", actorChannel: "WEB" as const };

async function runSeededProperty(name: string, seed: number, assertion: () => Promise<void>): Promise<void> {
  try {
    await assertion();
    console.info(`[PBT] ${name}: seed=${seed} runs=${propertyRuns} minimizedCounterexample=none`);
  } catch (error) {
    console.error(`[PBT] ${name}: seed=${seed} minimizedCounterexample=reported by fast-check below`);
    throw error;
  }
}

const location = {
  state: "Andhra Pradesh", district: "Chittoor", mandalOrTaluk: "Pakala", village: "Village",
  source: "MANUAL_ADDRESS" as const, capturedAt: now, collectionPurpose: "SERVICE_LOCATION" as const,
};

function creationInput(customerId: string, key: string, start: Date, end: Date): ValidatedBookingCreation {
  return {
    customerId,
    command: {
      bookingTarget: "MYSELF", tractorId: "tractor-1", serviceOfferingId: "offering-1",
      pricingRuleId: "price-1", pricingMethod: "HOURLY", expectedQuantity: "2",
      requestedInterval: { start, end }, serviceLocation: location,
    },
    idempotencyKey: key, requestDigest: `digest:${customerId}:${start.toISOString()}:${end.toISOString()}`,
    disclosedAt: now,
  };
}

class IdempotencyConnection implements SqlConnection {
  completed = false;
  bookingCount = 0;
  historyCount = 0;
  outboxCount = 0;
  released = false;
  constructor(private readonly input: ValidatedBookingCreation) {}

  async query<Row extends object>(text: string, values: readonly unknown[] = []): Promise<SqlQueryResult<Row>> {
    let rows: readonly Record<string, unknown>[] = [];
    const booking = {
      id: "booking-1", public_reference: "KT-PROPERTY", customer_id: this.input.customerId,
      owner_id: "owner-1", tractor_id: "tractor-1", service_offering_id: "offering-1",
      requested_start_at: this.input.command.requestedInterval.start,
      requested_end_at: this.input.command.requestedInterval.end, status: "PENDING_OWNER_RESPONSE",
      version: 1, created_at: now,
    };
    if (text.includes("SELECT request_digest")) {
      rows = [{ request_digest: this.input.requestDigest, resource_id: this.completed ? "booking-1" : null,
        status: this.completed ? "COMPLETED" : "IN_PROGRESS" }];
    } else if (text.includes("FOR UPDATE OF t, ta, so, pr")) {
      rows = [{ owner_id: "owner-1", tractor_id: "tractor-1", operational_status: "ONLINE",
        availability_status: "ONLINE", eligibility_status: "ELIGIBLE", location_updated_at: now,
        service_offering_id: "offering-1", pricing_rule_id: "price-1", pricing_method: "HOURLY",
        rate_paise: 80000, currency: "INR", rounding_policy: "PROPORTIONAL_MINUTE", pricing_rule_version: 1 }];
    } else if (text.includes("SELECT EXISTS")) {
      rows = [{ found: false }];
    } else if (text.includes("INSERT INTO public.bookings")) {
      this.bookingCount += 1;
      rows = [booking];
    } else if (text.includes("INSERT INTO public.booking_agreements")) {
      rows = [{ id: "agreement-1" }];
    } else if (text.includes("INSERT INTO public.booking_status_history")) {
      this.historyCount += 1;
    } else if (text.includes("INSERT INTO public.outbox_events")) {
      this.outboxCount += 1;
    } else if (text.includes("UPDATE public.idempotency_records")) {
      this.completed = true;
    } else if (text.includes("jsonb_build_object")) {
      rows = [{ ...booking, service_location_snapshot: location,
        quote_snapshot: { pricingRuleId: "price-1", pricingRuleVersion: 1, method: "HOURLY",
          ratePaise: 80000, currency: "INR", roundingPolicy: "PROPORTIONAL_MINUTE",
          estimatedQuantity: "2", estimatedTotalPaise: 160000, disclosedAt: now.toISOString() },
        recipient_name: null, coordination_consent: null, landmark_or_directions: null }];
    }
    return { rows: rows as readonly Row[], rowCount: rows.length };
  }
  release(): void { this.released = true; }
}

class SingleConnectionPool implements SqlPool {
  constructor(readonly connection: SqlConnection) {}
  async connect(): Promise<SqlConnection> { return this.connection; }
  async query<Row extends object>(): Promise<SqlQueryResult<Row>> { throw new Error("transaction required"); }
}

interface BookingRecord {
  readonly id: string;
  readonly start: Date;
  readonly end: Date;
  status: BookingStatus;
  version: number;
}
interface TransactionState {
  records: Map<string, BookingRecord>;
  history: number;
  outbox: number;
}

const blocking = new Set<BookingStatus>(["ACCEPTED", "SCHEDULED", "IN_PROGRESS"]);
const cloneState = (state: TransactionState): TransactionState => ({
  records: new Map([...state.records].map(([id, record]) => [id, { ...record }])),
  history: state.history,
  outbox: state.outbox,
});

class ConcurrentLifecyclePool implements SqlPool {
  state: TransactionState;
  private tail: Promise<void> = Promise.resolve();
  constructor(records: readonly BookingRecord[]) {
    this.state = { records: new Map(records.map((record) => [record.id, { ...record }])), history: 0, outbox: 0 };
  }
  async connect(): Promise<SqlConnection> { return new ConcurrentLifecycleConnection(this); }
  async query<Row extends object>(): Promise<SqlQueryResult<Row>> { throw new Error("transaction required"); }
  async lock(): Promise<() => void> {
    let release!: () => void;
    const previous = this.tail;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    return release;
  }
}

class ConcurrentLifecycleConnection implements SqlConnection {
  private local?: TransactionState;
  private unlock?: () => void;
  constructor(private readonly pool: ConcurrentLifecyclePool) {}

  async query<Row extends object>(text: string, values: readonly unknown[] = []): Promise<SqlQueryResult<Row>> {
    if (text.startsWith("BEGIN")) {
      this.unlock = await this.pool.lock();
      this.local = cloneState(this.pool.state);
      return { rows: [], rowCount: 0 };
    }
    if (text === "COMMIT") {
      this.pool.state = this.requiredState();
      this.finish();
      return { rows: [], rowCount: 0 };
    }
    if (text === "ROLLBACK") {
      this.finish();
      return { rows: [], rowCount: 0 };
    }
    if (text.includes("set_config") || text.includes("FROM public.tractors")) return { rows: [], rowCount: 0 };

    const state = this.requiredState();
    const id = String(values[0]);
    const record = state.records.get(id);
    let rows: readonly Record<string, unknown>[] = [];
    if (text.includes("FROM public.bookings WHERE id = $1 FOR UPDATE")) {
      if (record !== undefined) rows = [this.row(record)];
    } else if (text.includes("SELECT EXISTS")) {
      const current = state.records.get(String(values[1]));
      const found = current !== undefined && [...state.records.values()].some((candidate) =>
        candidate.id !== current.id && blocking.has(candidate.status)
          && candidate.start < current.end && current.start < candidate.end);
      rows = [{ found }];
    } else if (text.includes("UPDATE public.bookings SET status")) {
      if (record !== undefined && record.version === values[3]) {
        record.status = values[1] as BookingStatus;
        record.version += 1;
        rows = [this.row(record)];
      }
    } else if (text.includes("INSERT INTO public.booking_status_history")) {
      state.history += 1;
    } else if (text.includes("INSERT INTO public.outbox_events")) {
      state.outbox += 1;
    } else if (text.includes("jsonb_build_object") && record !== undefined) {
      rows = [{ ...this.row(record), service_location_snapshot: location,
        quote_snapshot: { pricingRuleId: "price-1", pricingRuleVersion: 1, method: "HOURLY",
          ratePaise: 80000, currency: "INR", roundingPolicy: "PROPORTIONAL_MINUTE",
          estimatedQuantity: "2", estimatedTotalPaise: 160000, disclosedAt: now.toISOString() },
        recipient_name: null, coordination_consent: null, landmark_or_directions: null }];
    }
    return { rows: rows as readonly Row[], rowCount: rows.length };
  }

  release(): void { this.finish(); }
  private requiredState(): TransactionState {
    if (this.local === undefined) throw new Error("query outside transaction");
    return this.local;
  }
  private finish(): void {
    this.local = undefined;
    const unlock = this.unlock;
    this.unlock = undefined;
    unlock?.();
  }
  private row(record: BookingRecord): Record<string, unknown> {
    return { id: record.id, public_reference: `KT-${record.id}`, customer_id: "farmer-1", owner_id: "owner-1",
      tractor_id: "tractor-1", service_offering_id: "offering-1", requested_start_at: record.start,
      requested_end_at: record.end, status: record.status, version: record.version, created_at: now };
  }
}

const statusArbitrary = fc.constantFrom<BookingStatus>(
  "CREATED", "PENDING_OWNER_RESPONSE", "ACCEPTED", "SCHEDULED", "IN_PROGRESS", "WORK_COMPLETED",
  "FINAL_BILL_GENERATED", "PAYMENT_RECORDED", "COMPLETED", "REJECTED", "CANCELLED", "EXPIRED",
  "DISPUTED", "REFUND_PENDING", "REFUNDED",
);
const actionArbitrary = fc.constantFrom<BookingLifecycleAction>(
  "SUBMIT", "ACCEPT", "REJECT", "CANCEL", "EXPIRE", "SCHEDULE", "START_WORK", "COMPLETE_WORK",
  "GENERATE_FINAL_BILL", "RECORD_PAYMENT", "COMPLETE", "DISPUTE", "REQUEST_REFUND", "REFUND", "RESOLVE_DISPUTE",
);
const roleArbitrary = fc.constantFrom<BookingLifecycleActorRole>("FARMER", "OWNER", "SYSTEM", "SUPPORT");
const actorId = (role: BookingLifecycleActorRole): string => role === "FARMER" ? "farmer-1"
  : role === "OWNER" ? "owner-1" : `${role.toLowerCase()}-1`;

/** Property 4. **Validates: Requirements 8.5** */
describe("Property 4: Idempotent Booking Creation", () => {
  it("returns one booking and emits one request side effect for every equivalent retry", async () => {
    await runSeededProperty("idempotent-booking-creation", seeds.idempotentCreation, async () => {
      await fc.assert(fc.asyncProperty(
        fc.uuid(), fc.stringMatching(/^[A-Za-z0-9_-]{1,40}$/), fc.integer({ min: 0, max: 30 * 24 * 60 }),
        fc.integer({ min: 1, max: 24 * 60 }),
        async (customerId, key, startOffsetMinutes, durationMinutes) => {
          const start = new Date(now.getTime() + startOffsetMinutes * 60_000);
          const input = creationInput(customerId, key, start, new Date(start.getTime() + durationMinutes * 60_000));
          const connection = new IdempotencyConnection(input);
          const store = new PostgresBookingStore(new SingleConnectionPool(connection));
          const [first, second] = [
            await store.createBooking(input, context),
            await store.createBooking(input, context),
          ];
          expect(second.id).toBe(first.id);
          expect(connection.bookingCount).toBe(1);
          expect(connection.historyCount).toBe(1);
          expect(connection.outboxCount).toBe(1);
        },
      ), { seed: seeds.idempotentCreation, numRuns: propertyRuns, verbose: 2 });
    });
  });
});

/** Property 5. **Validates: Requirements 8.6, 8.10** */
describe("Property 5: No Accepted Overlap", () => {
  it("allows at most one overlapping concurrent acceptance and rolls the loser back without history or outbox", async () => {
    await runSeededProperty("no-accepted-overlap-concurrent-atomicity", seeds.noAcceptedOverlap, async () => {
      await fc.assert(fc.asyncProperty(
        fc.integer({ min: 0, max: 10_000 }), fc.integer({ min: 2, max: 600 }), fc.integer({ min: 1, max: 599 }),
        async (offset, duration, overlapOffsetRaw) => {
          const overlapOffset = overlapOffsetRaw % duration;
          const firstStart = new Date(now.getTime() + offset * 60_000);
          const secondStart = new Date(firstStart.getTime() + overlapOffset * 60_000);
          const pool = new ConcurrentLifecyclePool([
            { id: "a", start: firstStart, end: new Date(firstStart.getTime() + duration * 60_000), status: "PENDING_OWNER_RESPONSE", version: 1 },
            { id: "b", start: secondStart, end: new Date(secondStart.getTime() + duration * 60_000), status: "PENDING_OWNER_RESPONSE", version: 1 },
          ]);
          const store = new PostgresBookingStore(pool);
          const beforeHistory = pool.state.history;
          const beforeOutbox = pool.state.outbox;
          const outcomes = await Promise.allSettled(["a", "b"].map((bookingId) => store.transitionBooking({
            bookingId, expectedVersion: 1, actorId: "owner-1", actorRole: "OWNER", action: "ACCEPT", occurredAt: now,
          }, context)));
          expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
          expect([...pool.state.records.values()].filter((record) => record.status === "ACCEPTED")).toHaveLength(1);
          expect(pool.state.history - beforeHistory).toBe(1);
          expect(pool.state.outbox - beforeOutbox).toBe(1);
          const loser = [...pool.state.records.values()].find((record) => record.status === "PENDING_OWNER_RESPONSE");
          expect(loser).toMatchObject({ status: "PENDING_OWNER_RESPONSE", version: 1 });
        },
      ), { seed: seeds.noAcceptedOverlap, numRuns: propertyRuns, verbose: 2 });
    });
  });
});

/** Property 6. **Validates: Requirements 8.7** */
describe("Property 6: Adjacent Intervals Are Allowed", () => {
  it("commits both concurrently started adjacent half-open intervals", async () => {
    await runSeededProperty("adjacent-half-open-intervals", seeds.adjacentIntervals, async () => {
      await fc.assert(fc.asyncProperty(
        fc.integer({ min: 0, max: 10_000 }), fc.integer({ min: 1, max: 600 }), fc.integer({ min: 1, max: 600 }),
        async (offset, firstDuration, secondDuration) => {
          const firstStart = new Date(now.getTime() + offset * 60_000);
          const boundary = new Date(firstStart.getTime() + firstDuration * 60_000);
          const pool = new ConcurrentLifecyclePool([
            { id: "a", start: firstStart, end: boundary, status: "PENDING_OWNER_RESPONSE", version: 1 },
            { id: "b", start: boundary, end: new Date(boundary.getTime() + secondDuration * 60_000), status: "PENDING_OWNER_RESPONSE", version: 1 },
          ]);
          const store = new PostgresBookingStore(pool);
          const outcomes = await Promise.allSettled(["a", "b"].map((bookingId) => store.transitionBooking({
            bookingId, expectedVersion: 1, actorId: "owner-1", actorRole: "OWNER", action: "ACCEPT", occurredAt: now,
          }, context)));
          expect(outcomes.every((outcome) => outcome.status === "fulfilled")).toBe(true);
          expect([...pool.state.records.values()].every((record) => record.status === "ACCEPTED")).toBe(true);
          expect(pool.state.history).toBe(2);
          expect(pool.state.outbox).toBe(2);
        },
      ), { seed: seeds.adjacentIntervals, numRuns: propertyRuns, verbose: 2 });
    });
  });
});

/** Property 11. **Validates: Requirements 8.8, 8.9, 8.10** */
describe("Property 11: State Machine Safety", () => {
  it("rejects every unauthorized edge without mutation and appends exactly one event for every allowed edge", async () => {
    expect(BOOKING_TRANSITION_TABLE.length).toBeGreaterThan(0);
    await runSeededProperty("booking-lifecycle-state-machine-safety", seeds.lifecycleSafety, async () => {
      await fc.assert(fc.asyncProperty(statusArbitrary, actionArbitrary, roleArbitrary, async (status, action, role) => {
        const pool = new ConcurrentLifecyclePool([
          { id: "booking", start: now, end: new Date(now.getTime() + 60 * 60_000), status, version: 7 },
        ]);
        const store = new PostgresBookingStore(pool);
        const rule = bookingTransitionRule(status, action, role);
        const before = cloneState(pool.state);
        const operation = store.transitionBooking({
          bookingId: "booking", expectedVersion: 7, actorId: actorId(role), actorRole: role, action,
          occurredAt: now, ...(rule?.reasonRequired === true ? { reason: "Generated property reason" } : {}),
        }, context);
        if (rule === undefined) {
          await expect(operation).rejects.toThrow();
          expect(pool.state).toEqual(before);
        } else {
          await expect(operation).resolves.toMatchObject({ status: rule.to, version: 8 });
          expect(pool.state.history - before.history).toBe(1);
          expect(pool.state.outbox - before.outbox).toBe(1);
        }
      }), { seed: seeds.lifecycleSafety, numRuns: propertyRuns, verbose: 2 });
    });
  });
});
