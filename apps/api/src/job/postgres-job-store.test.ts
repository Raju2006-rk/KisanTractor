import type { SqlConnection, SqlPool, SqlQueryResult } from "@kisantractor/database";
import { describe, expect, it } from "vitest";

import type {
  ValidatedJobAction,
  ValidatedWorkEventCorrection,
  ValidatedWorkMeasurementCorrection,
} from "./job.contracts.js";
import { InvalidJobSequenceError } from "./job.service.js";
import { PostgresJobStore } from "./postgres-job-store.js";

type Row = Record<string, unknown>;

class JobConnection implements SqlConnection {
  released = false;
  booking: Row & { status: string; version: number } = {
    id: "booking-1", owner_id: "owner-1", status: "SCHEDULED", version: 1, method: "PER_ACRE",
    agreement_id: "agreement-1", agreement_version: 2, pricing_rule_id: "rule-1", pricing_rule_version: 5,
    rate_paise: "120000", currency: "INR", rounding_policy: null,
  };
  readonly events: Row[] = [];
  readonly measurements: Row[] = [];
  readonly invoices: Row[] = [];
  readonly outboxTypes: string[] = [];
  readonly auditActions: string[] = [];
  readonly idempotency = new Map<string, { request_digest: string; status: string; response_body: unknown | null }>();
  statusHistoryCount = 0;
  auditCount = 0;
  outboxCount = 0;
  rollbacks = 0;
  private sequence = 0;

  async query<Result extends object>(sql: string, values: readonly unknown[] = []): Promise<SqlQueryResult<Result>> {
    const text = sql.replace(/\s+/gu, " ").trim();
    if (text.startsWith("BEGIN") || text === "COMMIT" || text.startsWith("SELECT set_config")) return this.result([]);
    if (text === "ROLLBACK") { this.rollbacks += 1; return this.result([]); }

    if (text.startsWith("INSERT INTO public.idempotency_records")) {
      const key = `${values[0]}:${values[1]}`;
      if (!this.idempotency.has(key)) {
        this.idempotency.set(key, { request_digest: String(values[2]), status: "IN_PROGRESS", response_body: null });
      }
      return this.result([]);
    }
    if (text.startsWith("SELECT request_digest, status, response_body FROM public.idempotency_records")) {
      const row = this.idempotency.get(`${values[0]}:${values[1]}`);
      return this.result(row === undefined ? [] : [row]);
    }
    if (text.startsWith("UPDATE public.idempotency_records SET status")) {
      this.idempotency.set(`${values[0]}:${values[1]}`, {
        request_digest: this.idempotency.get(`${values[0]}:${values[1]}`)!.request_digest,
        status: "COMPLETED",
        response_body: JSON.parse(String(values[2])),
      });
      return this.result([]);
    }
    if (text.startsWith("SELECT b.id, b.owner_id")) return this.result([{ ...this.booking }]);
    if (text.startsWith("SELECT id, booking_id, event_type")) return this.result([...this.events]);
    if (text.startsWith("INSERT INTO public.work_events") && text.includes("VALUES ($1, $2")) {
      this.events.push({
        id: `event-${++this.sequence}`, booking_id: values[0], event_type: values[1],
        effective_at: new Date(String(values[2])), received_at: new Date(String(values[2])),
        device_observed_at: values[3] === null ? null : new Date(String(values[3])), actor_id: values[4],
        actor_channel: values[5], correction_of_id: null, reason: null,
      });
      return this.result([]);
    }
    if (text.startsWith("INSERT INTO public.work_events") && text.includes("'CORRECTION'")) {
      this.events.push({
        id: `event-${++this.sequence}`, booking_id: values[0], event_type: "CORRECTION",
        effective_at: new Date(String(values[1])), received_at: new Date(String(values[2])), device_observed_at: null,
        actor_id: values[3], actor_channel: values[4], correction_of_id: values[6], reason: values[7],
      });
      return this.result([]);
    }
    if (text.startsWith("INSERT INTO public.work_measurements") && text.includes("VALUES ($1, $2, $3, $4, $5)")) {
      this.measurements.push({
        id: `measurement-${++this.sequence}`, booking_id: values[0], method: values[1], quantity: String(values[2]),
        unit: values[3], submitted_by_user_id: values[4], correction_of_id: null, reason: null,
        created_at: new Date("2026-03-01T10:00:00.000Z"),
      });
      return this.result([]);
    }
    if (text.startsWith("SELECT id, booking_id, method") && text.includes("WHERE id = $1")) {
      const row = this.measurements.find((item) => item.id === values[0] && item.booking_id === values[1]);
      return this.result(row === undefined ? [] : [row]);
    }
    if (text.startsWith("INSERT INTO public.work_measurements")) {
      this.measurements.push({
        id: `measurement-${++this.sequence}`, booking_id: values[0], method: values[1], quantity: String(values[2]),
        unit: values[3], submitted_by_user_id: values[4], correction_of_id: values[5], reason: values[6],
        created_at: new Date("2026-03-01T11:00:00.000Z"),
      });
      return this.result([]);
    }
    if (text.startsWith("SELECT id, booking_id, method")) return this.result([...this.measurements]);
    if (text.startsWith("SELECT i.id, i.booking_id")) {
      const latest = [...this.invoices].sort((a, b) => Number(b.invoice_version) - Number(a.invoice_version))[0];
      return this.result(latest === undefined ? [] : [{
        ...latest, agreement_version: this.booking.agreement_version, method: this.booking.method,
      }]);
    }
    if (text.startsWith("INSERT INTO public.invoices")) {
      const row = {
        id: `invoice-${++this.sequence}`, booking_id: values[0], supersedes_invoice_id: values[1],
        agreement_id: values[2], invoice_version: values[3], status: "ISSUED", rate_paise: String(values[4]),
        currency: values[5], billable_quantity: String(values[6]), subtotal_paise: String(values[7]),
        adjustments_paise: String(values[8]), total_paise: String(values[9]),
        evidence_references: JSON.parse(String(values[10])), calculation_formula: values[11],
        rounding_trace: JSON.parse(String(values[12])), created_at: new Date(String(values[13])),
      };
      this.invoices.push(row);
      return this.result([{ id: row.id }]);
    }
    if (text.startsWith("UPDATE public.bookings SET status")) {
      if (Number(values[3]) !== this.booking.version) return this.result([]);
      this.booking.status = String(values[1]);
      this.booking.version += 1;
      return this.result([{ version: this.booking.version }]);
    }
    if (text.startsWith("UPDATE public.bookings SET version")) {
      if (Number(values[2]) !== this.booking.version) return this.result([]);
      this.booking.version += 1;
      return this.result([{ version: this.booking.version }]);
    }
    if (text.startsWith("INSERT INTO public.booking_status_history")) {
      this.statusHistoryCount += 1;
      return this.result([]);
    }
    if (text.startsWith("INSERT INTO public.outbox_events")) {
      this.outboxCount += 1;
      this.outboxTypes.push(String(values[2]));
      return this.result([{
        id: `outbox-${this.outboxCount}`, aggregate_type: values[0], aggregate_id: values[1], event_type: values[2],
        event_version: values[3], payload: JSON.parse(String(values[4])), status: "PENDING",
        available_at: new Date(), created_at: new Date(),
      }]);
    }
    if (text.startsWith("INSERT INTO public.audit_events")) {
      this.auditCount += 1;
      this.auditActions.push(String(values[2]));
      return this.result([{
        id: `audit-${this.auditCount}`, correlation_id: values[7], pii_safe_metadata: JSON.parse(String(values[8])),
        occurred_at: new Date(String(values[9])),
      }]);
    }
    throw new Error(`Unexpected SQL in test: ${text}`);
  }

  release() { this.released = true; }

  private result<Result extends object>(rows: readonly object[]): SqlQueryResult<Result> {
    return { rows: rows as readonly Result[], rowCount: rows.length };
  }
}

class JobPool implements SqlPool {
  constructor(readonly connection: JobConnection) {}
  async connect() { this.connection.released = false; return this.connection; }
  async query<Result extends object>(): Promise<SqlQueryResult<Result>> { throw new Error("transaction required"); }
}

const context = { correlationId: "corr-job", actorChannel: "WEB" as const };
const action = (type: ValidatedJobAction["action"], iso: string, key: string,
  completedQuantity?: string): ValidatedJobAction => ({
  bookingId: "booking-1", action: type, actorId: "owner-1", idempotencyKey: key,
  requestDigest: `digest-${key}`, receivedAt: new Date(iso),
  ...(completedQuantity === undefined ? {} : { completedQuantity }),
});

/** Validates: Requirements 9.1, 9.2, 9.3, 9.4, 9.5 */
describe("PostgresJobStore ordered and idempotent commands", () => {
  it("records one effect per key, folds active intervals, and persists acreage at completion", async () => {
    const connection = new JobConnection();
    const store = new PostgresJobStore(new JobPool(connection));

    const started = await store.recordAction(action("START", "2026-03-01T08:00:00Z", "start"), context);
    const replayed = await store.recordAction(action("START", "2026-03-01T08:00:00Z", "start"), context);
    await store.recordAction(action("PAUSE", "2026-03-01T08:30:00Z", "pause"), context);
    await store.recordAction(action("RESUME", "2026-03-01T09:00:00Z", "resume"), context);
    const completed = await store.recordAction(action("COMPLETE", "2026-03-01T10:00:00Z", "complete", "3.5"), context);

    expect(started).toEqual(replayed);
    expect(connection.events).toHaveLength(4);
    expect(completed).toMatchObject({
      bookingStatus: "FINAL_BILL_GENERATED", state: "COMPLETED", activeMinutes: 90,
      measurements: [{ method: "PER_ACRE", quantity: "3.5", unit: "ACRE" }],
    });
    // START, COMPLETE_WORK, and the system GENERATE_FINAL_BILL transition.
    expect(connection.statusHistoryCount).toBe(3);
    expect(connection.outboxCount).toBe(5);
  });

  it("rejects an out-of-order command with valid-next-action information and rolls back", async () => {
    const connection = new JobConnection();
    const store = new PostgresJobStore(new JobPool(connection));

    await expect(store.recordAction(action("PAUSE", "2026-03-01T08:00:00Z", "pause-first"), context))
      .rejects.toMatchObject({
        name: "InvalidJobSequenceError", currentState: "NOT_STARTED", validNextActions: ["START"],
      } satisfies Partial<InvalidJobSequenceError>);
    expect(connection.events).toHaveLength(0);
    expect(connection.rollbacks).toBe(1);
  });
});

/** Validates: Requirements 9.7 */
describe("PostgresJobStore append-only corrections", () => {
  it("appends event and measurement corrections and audits both without changing originals", async () => {
    const connection = new JobConnection();
    const store = new PostgresJobStore(new JobPool(connection));
    await store.recordAction(action("START", "2026-03-01T08:00:00Z", "start"), context);
    await store.recordAction(action("PAUSE", "2026-03-01T08:30:00Z", "pause"), context);
    await store.recordAction(action("RESUME", "2026-03-01T09:00:00Z", "resume"), context);
    await store.recordAction(action("COMPLETE", "2026-03-01T10:00:00Z", "complete", "3.5"), context);
    const pauseId = String(connection.events[1]!.id);
    const measurementId = String(connection.measurements[0]!.id);

    const eventCorrection: ValidatedWorkEventCorrection = {
      bookingId: "booking-1", eventId: pauseId, correctedEffectiveAt: new Date("2026-03-01T08:20:00Z"),
      reason: "Verified field note", actorId: "owner-1", idempotencyKey: "correct-event",
      requestDigest: "digest-correct-event", receivedAt: new Date("2026-03-01T11:00:00Z"),
    };
    const correctedEventSession = await store.correctWorkEvent(eventCorrection, context);
    const measurementCorrection: ValidatedWorkMeasurementCorrection = {
      bookingId: "booking-1", measurementId, correctedQuantity: "3.25", reason: "Verified field area",
      actorId: "owner-1", idempotencyKey: "correct-measurement", requestDigest: "digest-correct-measurement",
      receivedAt: new Date("2026-03-01T11:05:00Z"),
    };
    const correctedMeasurementSession = await store.correctWorkMeasurement(measurementCorrection, context);

    expect(correctedEventSession.activeMinutes).toBe(80);
    expect(connection.events).toHaveLength(5);
    expect(connection.events[1]).toMatchObject({ id: pauseId, effective_at: new Date("2026-03-01T08:30:00Z") });
    expect(connection.measurements).toHaveLength(2);
    expect(connection.measurements[0]).toMatchObject({ id: measurementId, quantity: "3.5", correction_of_id: null });
    expect(correctedMeasurementSession.measurements[1]).toMatchObject({ quantity: "3.25", correctionOfId: measurementId });
    expect(connection.auditActions).toEqual([
      "INVOICE_ISSUED",
      "WORK_EVENT_CORRECTED", "INVOICE_REISSUED",
      "WORK_MEASUREMENT_CORRECTED", "INVOICE_REISSUED",
    ]);
  });
});

/** Validates: Requirements 10.1, 10.3, 10.5, 10.6, 10.7 */
describe("PostgresJobStore final bill persistence", () => {
  it("bills 90 proportional hourly minutes at ₹800/hour as ₹1,200 on completion", async () => {
    const connection = new JobConnection();
    connection.booking = {
      ...connection.booking, method: "HOURLY", rate_paise: "80000", rounding_policy: "PROPORTIONAL_MINUTE",
    };
    const store = new PostgresJobStore(new JobPool(connection));
    await store.recordAction(action("START", "2026-03-01T08:00:00Z", "start"), context);
    await store.recordAction(action("PAUSE", "2026-03-01T08:30:00Z", "pause"), context);
    await store.recordAction(action("RESUME", "2026-03-01T09:00:00Z", "resume"), context);
    const completed = await store.recordAction(action("COMPLETE", "2026-03-01T10:00:00Z", "complete"), context);
    const replayed = await store.recordAction(action("COMPLETE", "2026-03-01T10:00:00Z", "complete"), context);

    expect(completed.invoice).toMatchObject({
      invoiceVersion: 1, status: "ISSUED", agreementId: "agreement-1", agreementVersion: 2,
      method: "HOURLY", ratePaise: 80_000, billableQuantity: "1.5", billableUnit: "HOUR",
      subtotalPaise: 120_000, adjustmentsPaise: 0, totalPaise: 120_000,
      roundingTrace: { roundingPolicy: "PROPORTIONAL_MINUTE", activeMilliseconds: 90 * 60_000 },
    });
    expect(completed.invoice?.evidenceReferences).toEqual(connection.events.map((row) => `work_event:${String(row.id)}`));
    expect(completed.invoice?.createdAt).toEqual(new Date("2026-03-01T10:00:00Z"));
    expect(replayed).toEqual(completed);
    expect(connection.invoices).toHaveLength(1);
    expect(connection.outboxTypes.at(-1)).toBe("FinalBillGenerated");
  });

  it("uses the agreed snapshot rate, and reissues a superseding version after a measurement correction", async () => {
    const connection = new JobConnection();
    const store = new PostgresJobStore(new JobPool(connection));
    await store.recordAction(action("START", "2026-03-01T08:00:00Z", "start"), context);
    const completed = await store.recordAction(action("COMPLETE", "2026-03-01T10:00:00Z", "complete", "3"), context);
    expect(completed.invoice).toMatchObject({ invoiceVersion: 1, billableQuantity: "3", totalPaise: 360_000 });

    const corrected = await store.correctWorkMeasurement({
      bookingId: "booking-1", measurementId: String(connection.measurements[0]!.id), correctedQuantity: "2.5",
      reason: "Verified field area", actorId: "owner-1", idempotencyKey: "correct-acres",
      requestDigest: "digest-correct-acres", receivedAt: new Date("2026-03-01T11:00:00Z"),
    }, context);

    expect(corrected.bookingStatus).toBe("FINAL_BILL_GENERATED");
    expect(corrected.invoice).toMatchObject({
      invoiceVersion: 2, supersedesInvoiceId: completed.invoice?.id, totalPaise: 300_000, billableQuantity: "2.5",
    });
    expect(connection.invoices).toHaveLength(2);
    expect(connection.invoices[0]).toMatchObject({ invoice_version: 1, total_paise: "360000" });
    expect(connection.outboxTypes.at(-1)).toBe("FinalBillReissued");
  });

  it("rejects evidence corrections once payment has been recorded", async () => {
    const connection = new JobConnection();
    const store = new PostgresJobStore(new JobPool(connection));
    await store.recordAction(action("START", "2026-03-01T08:00:00Z", "start"), context);
    await store.recordAction(action("COMPLETE", "2026-03-01T10:00:00Z", "complete", "3"), context);
    connection.booking.status = "PAYMENT_RECORDED";

    await expect(store.correctWorkMeasurement({
      bookingId: "booking-1", measurementId: String(connection.measurements[0]!.id), correctedQuantity: "2",
      reason: "Late change", actorId: "owner-1", idempotencyKey: "late", requestDigest: "digest-late",
      receivedAt: new Date("2026-03-02T09:00:00Z"),
    }, context)).rejects.toMatchObject({ name: "JobConflictError" });
    expect(connection.measurements).toHaveLength(1);
    expect(connection.invoices).toHaveLength(1);
  });
});

/** Validates: Requirements 2.3, 2.4, 2.5, 9.1, 10.6 */
describe("PostgresJobStore read-only work session", () => {
  it("returns the billed work record to the assigned Owner and the booking Farmer only, without writes", async () => {
    const connection = new JobConnection();
    connection.booking.customer_id = "farmer-1";
    const store = new PostgresJobStore(new JobPool(connection));
    await store.recordAction(action("START", "2026-03-01T08:00:00Z", "start"), context);
    await store.recordAction(action("COMPLETE", "2026-03-01T09:30:00Z", "complete", "3"), context);
    const outboxBefore = connection.outboxCount;
    const versionBefore = connection.booking.version;

    const ownerView = await store.loadWorkSession({ bookingId: "booking-1", viewerId: "owner-1", viewerRole: "OWNER" }, context);
    const farmerView = await store.loadWorkSession({ bookingId: "booking-1", viewerId: "farmer-1", viewerRole: "FARMER" }, context);

    expect(farmerView).toEqual(ownerView);
    expect(farmerView).toMatchObject({
      bookingStatus: "FINAL_BILL_GENERATED",
      state: "COMPLETED",
      invoice: { invoiceVersion: 1, totalPaise: 360_000, billableUnit: "ACRE" },
    });
    expect(connection.outboxCount).toBe(outboxBefore);
    expect(connection.booking.version).toBe(versionBefore);

    for (const query of [
      { bookingId: "booking-1", viewerId: "farmer-1", viewerRole: "OWNER" as const },
      { bookingId: "booking-1", viewerId: "owner-1", viewerRole: "FARMER" as const },
      { bookingId: "booking-1", viewerId: "stranger", viewerRole: "FARMER" as const },
    ]) {
      await expect(store.loadWorkSession(query, context)).rejects.toMatchObject({ code: "JOB_FORBIDDEN" });
    }
  });
});

/** Validates: Requirements 8.8, 10.5, 11.7 */
describe("PostgresJobStore zero-total auto-completion", () => {
  it("auto-completes a zero-total final bill with one COMPLETED status-history row, a BookingCompleted outbox event, and an audit", async () => {
    const connection = new JobConnection();
    const store = new PostgresJobStore(new JobPool(connection));
    await store.recordAction(action("START", "2026-03-01T08:00:00Z", "start"), context);
    const completed = await store.recordAction(action("COMPLETE", "2026-03-01T10:00:00Z", "complete", "0"), context);
    expect(completed.invoice).toMatchObject({ invoiceVersion: 1, billableQuantity: "0", totalPaise: 0 });
    // The booking short-circuits straight to COMPLETED instead of resting at FINAL_BILL_GENERATED.
    expect(completed.bookingStatus).toBe("COMPLETED");
    expect(connection.booking.status).toBe("COMPLETED");
    // START -> IN_PROGRESS, COMPLETE_WORK -> WORK_COMPLETED, GENERATE_FINAL_BILL, and exactly one COMPLETE.
    expect(connection.statusHistoryCount).toBe(4);
    expect(connection.outboxTypes.filter((type) => type === "BookingCompleted")).toHaveLength(1);
    expect(connection.outboxTypes.at(-1)).toBe("BookingCompleted");
    expect(connection.auditActions.filter((a) => a === "BOOKING_AUTO_COMPLETED")).toHaveLength(1);
    expect(connection.invoices).toHaveLength(1);
  });
  it("does not auto-complete a positive-total bill", async () => {
    const connection = new JobConnection();
    const store = new PostgresJobStore(new JobPool(connection));
    await store.recordAction(action("START", "2026-03-01T08:00:00Z", "start"), context);
    const completed = await store.recordAction(action("COMPLETE", "2026-03-01T10:00:00Z", "complete", "3"), context);
    expect(completed.invoice?.totalPaise).toBe(360_000);
    expect(completed.bookingStatus).toBe("FINAL_BILL_GENERATED");
    expect(connection.outboxTypes).not.toContain("BookingCompleted");
    expect(connection.auditActions).not.toContain("BOOKING_AUTO_COMPLETED");
  });
  it("auto-completes when an evidence correction reissues a zero-total bill from FINAL_BILL_GENERATED", async () => {
    const connection = new JobConnection();
    const store = new PostgresJobStore(new JobPool(connection));
    await store.recordAction(action("START", "2026-03-01T08:00:00Z", "start"), context);
    const completed = await store.recordAction(action("COMPLETE", "2026-03-01T10:00:00Z", "complete", "3"), context);
    expect(completed.bookingStatus).toBe("FINAL_BILL_GENERATED");
    const corrected = await store.correctWorkMeasurement({
      bookingId: "booking-1", measurementId: String(connection.measurements[0]!.id), correctedQuantity: "0",
      reason: "No acreage was actually worked", actorId: "owner-1", idempotencyKey: "correct-to-zero",
      requestDigest: "digest-correct-to-zero", receivedAt: new Date("2026-03-01T11:00:00Z"),
    }, context);
    expect(corrected.invoice).toMatchObject({ invoiceVersion: 2, totalPaise: 0 });
    expect(corrected.bookingStatus).toBe("COMPLETED");
    expect(connection.outboxTypes.filter((type) => type === "BookingCompleted")).toHaveLength(1);
    expect(connection.auditActions.filter((a) => a === "BOOKING_AUTO_COMPLETED")).toHaveLength(1);
  });
  it("does not auto-complete a DISPUTED booking whose reissued bill is zero", async () => {
    const connection = new JobConnection();
    const store = new PostgresJobStore(new JobPool(connection));
    await store.recordAction(action("START", "2026-03-01T08:00:00Z", "start"), context);
    await store.recordAction(action("COMPLETE", "2026-03-01T10:00:00Z", "complete", "3"), context);
    connection.booking.status = "DISPUTED";
    const corrected = await store.correctWorkMeasurement({
      bookingId: "booking-1", measurementId: String(connection.measurements[0]!.id), correctedQuantity: "0",
      reason: "Disputed acreage resolved to zero", actorId: "owner-1", idempotencyKey: "dispute-zero",
      requestDigest: "digest-dispute-zero", receivedAt: new Date("2026-03-01T11:00:00Z"),
    }, context);
    expect(corrected.invoice).toMatchObject({ invoiceVersion: 2, totalPaise: 0 });
    // The booking stays DISPUTED for review; the lifecycle has no DISPUTED -> COMPLETED path for SYSTEM.
    expect(corrected.bookingStatus).toBe("DISPUTED");
    expect(connection.booking.status).toBe("DISPUTED");
    expect(connection.outboxTypes).not.toContain("BookingCompleted");
    expect(connection.auditActions).not.toContain("BOOKING_AUTO_COMPLETED");
  });
});
