import {
  calculateFinalBill,
  evaluateWorkSequence,
  foldActiveWorkIntervals,
  WorkSequenceError,
  type BillableUnit,
  type BillingAgreementTerms,
  type BillingWorkEvidence,
  type FinalBillRoundingTrace,
  type HourlyRoundingPolicy,
  type PricingMethod,
  type RecordedWorkEvent,
  type WorkAction,
} from "@kisantractor/domain";
import {
  type AuditActorChannel,
  type DomainTransaction,
  type SqlConnection,
  type SqlPool,
  withDomainTransaction,
  withTransaction,
} from "@kisantractor/database";

import type { BookingStatus } from "../booking/booking.contracts.js";
import { bookingTransitionEventType, bookingTransitionRule } from "../booking/booking-lifecycle.js";
import { retrySerializationFailures } from "../serialization-retry.js";
import type {
  InvoiceProjection,
  InvoiceStatus,
  JobRequestContext,
  JobStore,
  ValidatedJobAction,
  ValidatedWorkEventCorrection,
  ValidatedWorkMeasurementCorrection,
  WorkEventProjection,
  WorkMeasurementProjection,
  WorkSessionProjection,
  WorkSessionQuery,
} from "./job.contracts.js";
import {
  InvalidJobSequenceError,
  JobAuthorizationError,
  JobConflictError,
  validateCompletionQuantity,
} from "./job.service.js";

interface IdempotencyRow extends Record<string, unknown> {
  readonly request_digest: string;
  readonly status: "IN_PROGRESS" | "COMPLETED" | "FAILED";
  readonly response_body: unknown | null;
}

interface JobBookingRow extends Record<string, unknown> {
  readonly id: string;
  readonly owner_id: string;
  readonly status: BookingStatus;
  readonly version: number;
  readonly method: PricingMethod;
  readonly agreement_id: string;
  readonly agreement_version: number;
  readonly pricing_rule_id: string;
  readonly pricing_rule_version: number;
  /** bigint columns arrive as strings from node-postgres. */
  readonly rate_paise: string | number;
  readonly currency: string;
  readonly rounding_policy: HourlyRoundingPolicy | null;
}

interface InvoiceRow extends Record<string, unknown> {
  readonly id: string;
  readonly booking_id: string;
  readonly supersedes_invoice_id: string | null;
  readonly agreement_id: string;
  readonly agreement_version: number;
  readonly invoice_version: number;
  readonly status: InvoiceStatus;
  readonly method: PricingMethod;
  readonly rate_paise: string | number;
  readonly currency: string;
  readonly billable_quantity: string;
  readonly subtotal_paise: string | number;
  readonly adjustments_paise: string | number;
  readonly total_paise: string | number;
  readonly evidence_references: readonly string[];
  readonly calculation_formula: string;
  readonly rounding_trace: FinalBillRoundingTrace;
  readonly created_at: Date;
}

/** Booking statuses where corrected evidence must reissue the final bill. */
const REISSUABLE_BILLED_STATUSES: ReadonlySet<BookingStatus> = new Set(["FINAL_BILL_GENERATED", "DISPUTED"]);
/** Booking statuses where payment has been recorded, so work evidence can no longer change. */
const SETTLEMENT_LOCKED_STATUSES: ReadonlySet<BookingStatus> = new Set([
  "PAYMENT_RECORDED", "COMPLETED", "REFUND_PENDING", "REFUNDED",
]);

const billableUnitFor = (method: PricingMethod): BillableUnit =>
  method === "HOURLY" ? "HOUR" : method === "PER_ACRE" ? "ACRE" : "TRIP";

const agreementTerms = (booking: JobBookingRow): BillingAgreementTerms => {
  if (booking.currency.trim() !== "INR") throw new Error("Only INR booking agreements can be billed");
  return {
    agreementId: booking.agreement_id,
    agreementVersion: Number(booking.agreement_version),
    pricingRuleId: booking.pricing_rule_id,
    pricingRuleVersion: Number(booking.pricing_rule_version),
    method: booking.method,
    ratePaise: Number(booking.rate_paise),
    currency: "INR",
    ...(booking.rounding_policy === null ? {} : { roundingPolicy: booking.rounding_policy }),
  };
};

const toInvoiceProjection = (row: InvoiceRow): InvoiceProjection => Object.freeze({
  id: row.id,
  bookingId: row.booking_id,
  invoiceVersion: Number(row.invoice_version),
  ...(row.supersedes_invoice_id === null ? {} : { supersedesInvoiceId: row.supersedes_invoice_id }),
  status: row.status,
  agreementId: row.agreement_id,
  agreementVersion: Number(row.agreement_version),
  method: row.method,
  ratePaise: Number(row.rate_paise),
  currency: "INR",
  billableQuantity: row.billable_quantity,
  billableUnit: billableUnitFor(row.method),
  subtotalPaise: Number(row.subtotal_paise),
  adjustmentsPaise: Number(row.adjustments_paise),
  totalPaise: Number(row.total_paise),
  evidenceReferences: Object.freeze([...row.evidence_references]),
  formula: row.calculation_formula,
  roundingTrace: Object.freeze({ ...row.rounding_trace }),
  createdAt: new Date(row.created_at),
});

interface WorkEventRow extends Record<string, unknown> {
  readonly id: string;
  readonly booking_id: string;
  readonly event_type: "START" | "PAUSE" | "RESUME" | "COMPLETE" | "CORRECTION";
  readonly effective_at: Date;
  readonly received_at: Date;
  readonly device_observed_at: Date | null;
  readonly actor_id: string;
  readonly actor_channel: AuditActorChannel;
  readonly correction_of_id: string | null;
  readonly reason: string | null;
}

interface WorkMeasurementRow extends Record<string, unknown> {
  readonly id: string;
  readonly booking_id: string;
  readonly method: "PER_ACRE" | "PER_TRIP";
  readonly quantity: string;
  readonly unit: "ACRE" | "TRIP";
  readonly submitted_by_user_id: string;
  readonly correction_of_id: string | null;
  readonly reason: string | null;
  readonly created_at: Date;
}

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1_000;
const scopeFor = (actorId: string, bookingId: string): string => `owner:${actorId}:booking:${bookingId}:job`;

const asDate = (value: unknown, field: string): Date => {
  const result = value instanceof Date ? new Date(value) : new Date(String(value));
  if (Number.isNaN(result.getTime())) throw new Error(`Stored job response has invalid ${field}`);
  return result;
};

const serializeSession = (session: WorkSessionProjection): object => ({
  ...session,
  events: session.events.map((event) => ({ ...event })),
  measurements: session.measurements.map((measurement) => ({ ...measurement })),
  activeIntervals: session.activeIntervals.map((interval) => ({ ...interval })),
});

const hydrateSession = (value: unknown): WorkSessionProjection => {
  if (typeof value !== "object" || value === null) throw new Error("Completed job idempotency record has no response");
  const source = value as Record<string, unknown>;
  const events = (source.events as readonly Record<string, unknown>[]).map((event) => ({
    ...event,
    effectiveAt: asDate(event.effectiveAt, "event effectiveAt"),
    receivedAt: asDate(event.receivedAt, "event receivedAt"),
    ...(event.deviceObservedAt === undefined ? {} : { deviceObservedAt: asDate(event.deviceObservedAt, "event deviceObservedAt") }),
  })) as unknown as readonly WorkEventProjection[];
  const measurements = (source.measurements as readonly Record<string, unknown>[]).map((measurement) => ({
    ...measurement,
    createdAt: asDate(measurement.createdAt, "measurement createdAt"),
  })) as unknown as readonly WorkMeasurementProjection[];
  const activeIntervals = (source.activeIntervals as readonly Record<string, unknown>[]).map((interval) => ({
    ...interval,
    startedAt: asDate(interval.startedAt, "interval startedAt"),
    endedAt: asDate(interval.endedAt, "interval endedAt"),
  })) as unknown as WorkSessionProjection["activeIntervals"];
  return Object.freeze({
    ...(source as unknown as WorkSessionProjection),
    events: Object.freeze(events),
    measurements: Object.freeze(measurements),
    activeIntervals: Object.freeze(activeIntervals),
    ...(source.openStartedAt === undefined ? {} : { openStartedAt: asDate(source.openStartedAt, "openStartedAt") }),
    ...(source.invoice === undefined || source.invoice === null ? {} : {
      invoice: Object.freeze({
        ...(source.invoice as InvoiceProjection),
        createdAt: asDate((source.invoice as Record<string, unknown>).createdAt, "invoice createdAt"),
      }),
    }),
  });
};

const toRecordedEvent = (row: WorkEventRow): RecordedWorkEvent => ({
  id: row.id,
  eventType: row.event_type,
  effectiveAt: row.effective_at,
  receivedAt: row.received_at,
  ...(row.correction_of_id === null ? {} : { correctionOfId: row.correction_of_id }),
});

const toEventProjection = (row: WorkEventRow): WorkEventProjection => Object.freeze({
  ...toRecordedEvent(row),
  bookingId: row.booking_id,
  actorId: row.actor_id,
  actorChannel: row.actor_channel,
  ...(row.device_observed_at === null ? {} : { deviceObservedAt: row.device_observed_at }),
  ...(row.reason === null ? {} : { reason: row.reason }),
});

const toMeasurementProjection = (row: WorkMeasurementRow): WorkMeasurementProjection => Object.freeze({
  id: row.id,
  bookingId: row.booking_id,
  method: row.method,
  quantity: row.quantity,
  unit: row.unit,
  submittedByUserId: row.submitted_by_user_id,
  ...(row.correction_of_id === null ? {} : { correctionOfId: row.correction_of_id }),
  ...(row.reason === null ? {} : { reason: row.reason }),
  createdAt: row.created_at,
});

const throwSequence = (error: WorkSequenceError): never => {
  throw new InvalidJobSequenceError(error.message, error.currentState, error.validNextActions);
};

export class PostgresJobStore implements JobStore {
  constructor(private readonly pool: SqlPool, private readonly idempotencyTtlMs = IDEMPOTENCY_TTL_MS) {
    if (!Number.isSafeInteger(idempotencyTtlMs) || idempotencyTtlMs <= 0) {
      throw new TypeError("idempotencyTtlMs must be a positive safe integer");
    }
  }

  loadWorkSession(query: WorkSessionQuery, context: JobRequestContext): Promise<WorkSessionProjection> {
    return withTransaction(this.pool, async (sql) => {
      const result = await sql.query<JobBookingRow & { readonly customer_id: string }>(
        `SELECT b.id, b.owner_id, b.customer_id, b.status, b.version, a.method,
           a.id AS agreement_id, a.agreement_version, a.pricing_rule_id, a.pricing_rule_version,
           a.rate_paise, a.currency, a.rounding_policy
         FROM public.bookings b
         JOIN public.booking_agreements a ON a.id = b.current_agreement_id
         WHERE b.id = $1`,
        [query.bookingId],
      );
      const booking = result.rows[0];
      const relatedId = query.viewerRole === "OWNER" ? booking?.owner_id : booking?.customer_id;
      if (booking === undefined || relatedId !== query.viewerId) {
        throw new JobAuthorizationError("The job is unavailable for this account");
      }
      return this.#loadSession(sql, booking);
    }, { isolation: "REPEATABLE READ", readOnly: true, correlationId: context.correlationId });
  }

  recordAction(input: ValidatedJobAction, context: JobRequestContext): Promise<WorkSessionProjection> {
    return this.#run(async (tx) => {
      const replay = await this.#claimIdempotency(tx.sql, input.actorId, input.bookingId,
        input.idempotencyKey, input.requestDigest, input.receivedAt);
      if (replay !== undefined) return replay;

      const booking = await this.#loadOwnedBooking(tx.sql, input.bookingId, input.actorId);
      const rows = await this.#loadEventRows(tx.sql, input.bookingId);
      const candidate: RecordedWorkEvent = {
        id: `candidate:${input.idempotencyKey}`,
        eventType: input.action,
        effectiveAt: input.receivedAt,
        receivedAt: input.receivedAt,
      };
      let before;
      try {
        before = evaluateWorkSequence(rows.map(toRecordedEvent));
        evaluateWorkSequence([...rows.map(toRecordedEvent), candidate]);
      } catch (error) {
        if (error instanceof WorkSequenceError) throwSequence(error);
        throw error;
      }
      this.#assertBookingStatusForAction(booking.status, before.state, input.action, before.validNextActions);
      if (input.action === "COMPLETE") validateCompletionQuantity(booking.method, input.completedQuantity);

      await tx.sql.query<WorkEventRow>(
        `INSERT INTO public.work_events
           (booking_id, event_type, effective_at, received_at, device_observed_at,
            actor_id, actor_channel, idempotency_key)
         VALUES ($1, $2, $3, $3, $4, $5, $6, $7)`,
        [input.bookingId, input.action, input.receivedAt.toISOString(), input.deviceObservedAt?.toISOString() ?? null,
          input.actorId, context.actorChannel, input.idempotencyKey],
      );

      if (input.action === "COMPLETE" && booking.method !== "HOURLY") {
        const unit = booking.method === "PER_ACRE" ? "ACRE" : "TRIP";
        await tx.sql.query(
          `INSERT INTO public.work_measurements
             (booking_id, method, quantity, unit, submitted_by_user_id)
           VALUES ($1, $2, $3, $4, $5)`,
          [input.bookingId, booking.method, input.completedQuantity!, unit, input.actorId],
        );
      }

      const targetStatus = input.action === "START" ? "IN_PROGRESS"
        : input.action === "COMPLETE" ? "WORK_COMPLETED" : booking.status;
      const updated = await tx.sql.query<{ readonly version: number }>(
        `UPDATE public.bookings SET status = $2, version = version + 1, updated_at = $3
         WHERE id = $1 AND version = $4 RETURNING version`,
        [booking.id, targetStatus, input.receivedAt.toISOString(), booking.version],
      );
      const updatedVersion = updated.rows[0]?.version;
      if (updatedVersion === undefined) throw new JobConflictError("The job changed while the command was being processed");

      if (targetStatus !== booking.status) {
        await tx.sql.query(
          `INSERT INTO public.booking_status_history
             (booking_id, from_status, to_status, actor_id, actor_channel, occurred_at)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [booking.id, booking.status, targetStatus, input.actorId, context.actorChannel, input.receivedAt.toISOString()],
        );
      }
      await tx.appendOutbox({
        aggregateType: "Booking",
        aggregateId: booking.id,
        eventType: `Work${input.action[0]}${input.action.slice(1).toLowerCase()}`,
        eventVersion: updatedVersion,
        payload: { bookingId: booking.id, action: input.action, actorId: input.actorId },
      });
      let current: JobBookingRow = { ...booking, status: targetStatus, version: updatedVersion };
      if (input.action === "COMPLETE") {
        current = await this.#generateFinalBill(tx, current, input.receivedAt, input.actorId, context);
      }
      const session = await this.#loadSession(tx.sql, current);
      await this.#completeIdempotency(tx.sql, input.actorId, input.bookingId, input.idempotencyKey, session);
      return session;
    }, context);
  }

  correctWorkEvent(
    input: ValidatedWorkEventCorrection,
    context: JobRequestContext,
  ): Promise<WorkSessionProjection> {
    return this.#run(async (tx) => {
      const replay = await this.#claimIdempotency(tx.sql, input.actorId, input.bookingId,
        input.idempotencyKey, input.requestDigest, input.receivedAt);
      if (replay !== undefined) return replay;
      const booking = await this.#loadOwnedBooking(tx.sql, input.bookingId, input.actorId);
      this.#assertEvidenceCorrectable(booking.status);
      const rows = await this.#loadEventRows(tx.sql, input.bookingId);
      const target = rows.find((row) => row.id === input.eventId && row.event_type !== "CORRECTION");
      if (target === undefined) throw new JobAuthorizationError("The work event is unavailable for this booking");
      const candidate: RecordedWorkEvent = {
        id: `candidate:${input.idempotencyKey}`,
        eventType: "CORRECTION",
        effectiveAt: input.correctedEffectiveAt,
        receivedAt: input.receivedAt,
        correctionOfId: target.id,
      };
      try {
        evaluateWorkSequence([...rows.map(toRecordedEvent), candidate]);
      } catch (error) {
        if (error instanceof WorkSequenceError) throwSequence(error);
        throw error;
      }
      await tx.sql.query(
        `INSERT INTO public.work_events
           (booking_id, event_type, effective_at, received_at, actor_id, actor_channel,
            idempotency_key, correction_of_id, reason)
         VALUES ($1, 'CORRECTION', $2, $3, $4, $5, $6, $7, $8)`,
        [booking.id, input.correctedEffectiveAt.toISOString(), input.receivedAt.toISOString(), input.actorId,
          context.actorChannel, input.idempotencyKey, target.id, input.reason],
      );
      const updatedVersion = await this.#incrementBookingVersion(tx.sql, booking, input.receivedAt);
      await tx.appendAudit({
        actorId: input.actorId,
        actorChannel: context.actorChannel,
        action: "WORK_EVENT_CORRECTED",
        resourceType: "WorkEvent",
        resourceId: target.id,
        outcome: "SUCCEEDED",
        metadata: { bookingId: booking.id, correctionReason: input.reason },
        occurredAt: input.receivedAt,
      });
      await tx.appendOutbox({
        aggregateType: "Booking", aggregateId: booking.id, eventType: "WorkEvidenceCorrected",
        eventVersion: updatedVersion, payload: { bookingId: booking.id, workEventId: target.id },
      });
      let current = { ...booking, version: updatedVersion };
      if (REISSUABLE_BILLED_STATUSES.has(booking.status)) {
        const { totalPaise } = await this.#issueInvoice(tx, current, input.receivedAt, input.actorId, context, "FinalBillReissued");
        // Only an undisputed final bill auto-completes; a DISPUTED booking stays disputed for review.
        if (totalPaise === 0 && current.status === "FINAL_BILL_GENERATED") {
          current = await this.#autoCompleteZeroTotal(tx, current, input.receivedAt, context);
        }
      }
      const session = await this.#loadSession(tx.sql, current);
      await this.#completeIdempotency(tx.sql, input.actorId, input.bookingId, input.idempotencyKey, session);
      return session;
    }, context);
  }

  correctWorkMeasurement(
    input: ValidatedWorkMeasurementCorrection,
    context: JobRequestContext,
  ): Promise<WorkSessionProjection> {
    return this.#run(async (tx) => {
      const replay = await this.#claimIdempotency(tx.sql, input.actorId, input.bookingId,
        input.idempotencyKey, input.requestDigest, input.receivedAt);
      if (replay !== undefined) return replay;
      const booking = await this.#loadOwnedBooking(tx.sql, input.bookingId, input.actorId);
      this.#assertEvidenceCorrectable(booking.status);
      const result = await tx.sql.query<WorkMeasurementRow>(
        `SELECT id, booking_id, method, quantity::text, unit, submitted_by_user_id,
           correction_of_id, reason, created_at
         FROM public.work_measurements WHERE id = $1 AND booking_id = $2 FOR SHARE`,
        [input.measurementId, booking.id],
      );
      const target = result.rows[0];
      if (target === undefined || target.correction_of_id !== null) {
        throw new JobAuthorizationError("The original work measurement is unavailable for this booking");
      }
      validateCompletionQuantity(target.method, input.correctedQuantity);
      await tx.sql.query(
        `INSERT INTO public.work_measurements
           (booking_id, method, quantity, unit, submitted_by_user_id, correction_of_id, reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [booking.id, target.method, input.correctedQuantity, target.unit, input.actorId, target.id, input.reason],
      );
      const updatedVersion = await this.#incrementBookingVersion(tx.sql, booking, input.receivedAt);
      await tx.appendAudit({
        actorId: input.actorId,
        actorChannel: context.actorChannel,
        action: "WORK_MEASUREMENT_CORRECTED",
        resourceType: "WorkMeasurement",
        resourceId: target.id,
        outcome: "SUCCEEDED",
        metadata: { bookingId: booking.id, correctionReason: input.reason },
        occurredAt: input.receivedAt,
      });
      await tx.appendOutbox({
        aggregateType: "Booking", aggregateId: booking.id, eventType: "WorkEvidenceCorrected",
        eventVersion: updatedVersion, payload: { bookingId: booking.id, workMeasurementId: target.id },
      });
      let current = { ...booking, version: updatedVersion };
      if (REISSUABLE_BILLED_STATUSES.has(booking.status)) {
        const { totalPaise } = await this.#issueInvoice(tx, current, input.receivedAt, input.actorId, context, "FinalBillReissued");
        // Only an undisputed final bill auto-completes; a DISPUTED booking stays disputed for review.
        if (totalPaise === 0 && current.status === "FINAL_BILL_GENERATED") {
          current = await this.#autoCompleteZeroTotal(tx, current, input.receivedAt, context);
        }
      }
      const session = await this.#loadSession(tx.sql, current);
      await this.#completeIdempotency(tx.sql, input.actorId, input.bookingId, input.idempotencyKey, session);
      return session;
    }, context);
  }

  async #run(
    work: Parameters<typeof withDomainTransaction<WorkSessionProjection>>[2],
    context: JobRequestContext,
  ): Promise<WorkSessionProjection> {
    try {
      // Each attempt re-claims the idempotency key and re-folds the work events from a fresh snapshot.
      return await retrySerializationFailures(() => withDomainTransaction(this.pool, {
        isolation: "SERIALIZABLE",
        correlationId: context.correlationId,
      }, work));
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
      if (code === "40001") throw new JobConflictError("The job changed concurrently; refresh and retry safely");
      throw error;
    }
  }

  async #claimIdempotency(
    tx: SqlConnection,
    actorId: string,
    bookingId: string,
    key: string,
    requestDigest: string,
    now: Date,
  ): Promise<WorkSessionProjection | undefined> {
    const scope = scopeFor(actorId, bookingId);
    await tx.query(
      `INSERT INTO public.idempotency_records (actor_scope, idempotency_key, request_digest, expires_at)
       VALUES ($1, $2, $3, $4) ON CONFLICT (actor_scope, idempotency_key) DO NOTHING`,
      [scope, key, requestDigest, new Date(now.getTime() + this.idempotencyTtlMs).toISOString()],
    );
    const result = await tx.query<IdempotencyRow>(
      `SELECT request_digest, status, response_body FROM public.idempotency_records
       WHERE actor_scope = $1 AND idempotency_key = $2 FOR UPDATE`,
      [scope, key],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error("Unable to claim job idempotency key");
    if (row.request_digest !== requestDigest) {
      throw new JobConflictError("The idempotency key was already used for a different job command");
    }
    return row.status === "COMPLETED" ? hydrateSession(row.response_body) : undefined;
  }

  async #completeIdempotency(
    tx: SqlConnection,
    actorId: string,
    bookingId: string,
    key: string,
    session: WorkSessionProjection,
  ): Promise<void> {
    await tx.query(
      `UPDATE public.idempotency_records SET status = 'COMPLETED', response_status = 200,
         response_body = $3::jsonb, resource_type = 'Booking', resource_id = $4, updated_at = CURRENT_TIMESTAMP
       WHERE actor_scope = $1 AND idempotency_key = $2`,
      [scopeFor(actorId, bookingId), key, JSON.stringify(serializeSession(session)), bookingId],
    );
  }

  async #loadOwnedBooking(tx: SqlConnection, bookingId: string, actorId: string): Promise<JobBookingRow> {
    const result = await tx.query<JobBookingRow>(
      `SELECT b.id, b.owner_id, b.status, b.version, a.method,
         a.id AS agreement_id, a.agreement_version, a.pricing_rule_id, a.pricing_rule_version,
         a.rate_paise, a.currency, a.rounding_policy
       FROM public.bookings b
       JOIN public.booking_agreements a ON a.id = b.current_agreement_id
       WHERE b.id = $1 FOR UPDATE OF b`,
      [bookingId],
    );
    const booking = result.rows[0];
    if (booking === undefined || booking.owner_id !== actorId) throw new JobAuthorizationError();
    return booking;
  }

  async #loadEventRows(tx: SqlConnection, bookingId: string): Promise<readonly WorkEventRow[]> {
    const result = await tx.query<WorkEventRow>(
      `SELECT id, booking_id, event_type, effective_at, received_at, device_observed_at,
         actor_id, actor_channel, correction_of_id, reason
       FROM public.work_events WHERE booking_id = $1 ORDER BY received_at, id`,
      [bookingId],
    );
    return result.rows;
  }

  async #loadMeasurementRows(tx: SqlConnection, bookingId: string): Promise<readonly WorkMeasurementRow[]> {
    const result = await tx.query<WorkMeasurementRow>(
      `SELECT id, booking_id, method, quantity::text, unit, submitted_by_user_id,
         correction_of_id, reason, created_at
       FROM public.work_measurements WHERE booking_id = $1 ORDER BY created_at, id`,
      [bookingId],
    );
    return result.rows;
  }

  async #loadCurrentInvoice(tx: SqlConnection, bookingId: string): Promise<InvoiceRow | undefined> {
    const result = await tx.query<InvoiceRow>(
      `SELECT i.id, i.booking_id, i.supersedes_invoice_id, i.agreement_id, a.agreement_version,
         i.invoice_version, i.status, a.method, i.rate_paise, i.currency, i.billable_quantity::text,
         i.subtotal_paise, i.adjustments_paise, i.total_paise, i.evidence_references,
         i.calculation_formula, i.rounding_trace, i.created_at
       FROM public.invoices i
       JOIN public.booking_agreements a ON a.id = i.agreement_id
       WHERE i.booking_id = $1
       ORDER BY i.invoice_version DESC
       LIMIT 1`,
      [bookingId],
    );
    return result.rows[0];
  }

  async #loadSession(tx: SqlConnection, booking: JobBookingRow): Promise<WorkSessionProjection> {
    const eventRows = await this.#loadEventRows(tx, booking.id);
    const measurementRows = await this.#loadMeasurementRows(tx, booking.id);
    const invoice = await this.#loadCurrentInvoice(tx, booking.id);
    const folded = foldActiveWorkIntervals(eventRows.map(toRecordedEvent));
    return Object.freeze({
      bookingId: booking.id,
      bookingStatus: booking.status,
      bookingVersion: booking.version,
      pricingMethod: booking.method,
      state: folded.state,
      validNextActions: folded.validNextActions,
      events: Object.freeze(eventRows.map(toEventProjection)),
      measurements: Object.freeze(measurementRows.map(toMeasurementProjection)),
      activeIntervals: folded.intervals,
      activeMilliseconds: folded.activeMilliseconds,
      activeMinutes: folded.activeMinutes,
      ...(folded.openStartedAt === undefined ? {} : { openStartedAt: folded.openStartedAt }),
      ...(invoice === undefined ? {} : { invoice: toInvoiceProjection(invoice) }),
    });
  }

  /** Builds billing evidence from the effective (correction-applied) work record. */
  async #billingEvidence(tx: SqlConnection, booking: JobBookingRow): Promise<BillingWorkEvidence> {
    const eventRows = await this.#loadEventRows(tx, booking.id);
    const folded = foldActiveWorkIntervals(eventRows.map(toRecordedEvent));
    if (folded.state !== "COMPLETED") {
      throw new JobConflictError("A final bill requires completed work");
    }
    const eventReferences = eventRows.map((row) => `work_event:${row.id}`);
    if (booking.method === "HOURLY") {
      return { method: "HOURLY", activeMilliseconds: folded.activeMilliseconds, evidenceReferences: eventReferences };
    }

    const measurements = await this.#loadMeasurementRows(tx, booking.id);
    const original = measurements.find((row) => row.correction_of_id === null);
    if (original === undefined) throw new JobConflictError("A final bill requires a completed work measurement");
    const corrections = measurements.filter((row) => row.correction_of_id === original.id);
    const effective = corrections.at(-1) ?? original;
    const evidenceReferences = [
      ...eventReferences,
      `work_measurement:${original.id}`,
      ...corrections.map((row) => `work_measurement:${row.id}`),
    ];
    return booking.method === "PER_ACRE"
      ? { method: "PER_ACRE", completedAcres: effective.quantity, evidenceReferences }
      : { method: "PER_TRIP", completedTrips: effective.quantity, evidenceReferences };
  }

  /** Appends a new invoice version calculated from the booking's current agreement and work evidence. */
  async #issueInvoice(
    tx: DomainTransaction,
    booking: JobBookingRow,
    occurredAt: Date,
    actorId: string,
    context: JobRequestContext,
    eventType: "FinalBillGenerated" | "FinalBillReissued",
  ): Promise<{ readonly invoiceId: string; readonly totalPaise: number }> {
    const evidence = await this.#billingEvidence(tx.sql, booking);
    const bill = calculateFinalBill(agreementTerms(booking), evidence);
    const previous = await this.#loadCurrentInvoice(tx.sql, booking.id);
    const invoiceVersion = previous === undefined ? 1 : Number(previous.invoice_version) + 1;
    const inserted = await tx.sql.query<{ readonly id: string }>(
      `INSERT INTO public.invoices
         (booking_id, supersedes_invoice_id, agreement_id, invoice_version, status, rate_paise, currency,
          billable_quantity, subtotal_paise, adjustments_paise, total_paise, evidence_references,
          calculation_formula, rounding_trace, created_at)
       VALUES ($1, $2, $3, $4, 'ISSUED', $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13::jsonb, $14)
       RETURNING id`,
      [booking.id, previous?.id ?? null, bill.agreementId, invoiceVersion, bill.ratePaise, bill.currency,
        bill.billableQuantity, bill.subtotalPaise, bill.adjustmentsPaise, bill.totalPaise,
        JSON.stringify(bill.evidenceReferences), bill.formula, JSON.stringify(bill.roundingTrace),
        occurredAt.toISOString()],
    );
    const invoiceId = inserted.rows[0]?.id;
    if (invoiceId === undefined) throw new Error("Invoice was not stored");
    await tx.appendAudit({
      actorId,
      actorChannel: context.actorChannel,
      action: eventType === "FinalBillGenerated" ? "INVOICE_ISSUED" : "INVOICE_REISSUED",
      resourceType: "Invoice",
      resourceId: invoiceId,
      outcome: "SUCCEEDED",
      metadata: {
        bookingId: booking.id,
        invoiceVersion,
        agreementVersion: bill.agreementVersion,
        totalPaise: bill.totalPaise,
        ...(previous === undefined ? {} : { supersedesInvoiceId: previous.id }),
      },
      occurredAt,
    });
    await tx.appendOutbox({
      aggregateType: "Booking",
      aggregateId: booking.id,
      eventType,
      eventVersion: booking.version,
      payload: { bookingId: booking.id, invoiceId, invoiceVersion, totalPaise: bill.totalPaise },
    });
    return { invoiceId, totalPaise: bill.totalPaise };
  }

  /** Bills completed work and records the system WORK_COMPLETED → FINAL_BILL_GENERATED transition. */
  async #generateFinalBill(
    tx: DomainTransaction,
    booking: JobBookingRow,
    occurredAt: Date,
    actorId: string,
    context: JobRequestContext,
  ): Promise<JobBookingRow> {
    const updated = await tx.sql.query<{ readonly version: number }>(
      `UPDATE public.bookings SET status = $2, version = version + 1, updated_at = $3
       WHERE id = $1 AND version = $4 RETURNING version`,
      [booking.id, "FINAL_BILL_GENERATED", occurredAt.toISOString(), booking.version],
    );
    const version = updated.rows[0]?.version;
    if (version === undefined) throw new JobConflictError("The job changed while the final bill was being generated");
    await tx.sql.query(
      `INSERT INTO public.booking_status_history
         (booking_id, from_status, to_status, actor_id, actor_channel, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [booking.id, booking.status, "FINAL_BILL_GENERATED", null, "SYSTEM", occurredAt.toISOString()],
    );
    let billed: JobBookingRow = { ...booking, status: "FINAL_BILL_GENERATED", version };
    const { totalPaise } = await this.#issueInvoice(tx, billed, occurredAt, actorId, context, "FinalBillGenerated");
    if (totalPaise === 0) billed = await this.#autoCompleteZeroTotal(tx, billed, occurredAt, context);
    return billed;
  }

  /**
   * Zero-total auto-completion: a SYSTEM-only FINAL_BILL_GENERATED -> COMPLETED transition from the
   * shared lifecycle table, applied in the same transaction that issued the zero-total bill. No
   * payment can ever be recorded against a 0 paise invoice, so the booking would otherwise never
   * complete. Records status history, an audit event, and a BookingCompleted outbox event, mirroring
   * the payment store's #systemBookingTransition.
   */
  async #autoCompleteZeroTotal(
    tx: DomainTransaction,
    booking: JobBookingRow,
    occurredAt: Date,
    context: JobRequestContext,
  ): Promise<JobBookingRow> {
    const rule = bookingTransitionRule(booking.status, "COMPLETE", "SYSTEM");
    if (rule === undefined) throw new JobConflictError("The booking cannot be auto-completed from its current status");
    const updated = await tx.sql.query<{ readonly version: number }>(
      `UPDATE public.bookings SET status = $2, version = version + 1, updated_at = $3
       WHERE id = $1 AND version = $4 RETURNING version`,
      [booking.id, rule.to, occurredAt.toISOString(), booking.version],
    );
    const version = updated.rows[0]?.version;
    if (version === undefined) throw new JobConflictError("The booking changed while the zero-total bill was being completed");
    await tx.sql.query(
      `INSERT INTO public.booking_status_history
         (booking_id, from_status, to_status, actor_id, actor_channel, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [booking.id, booking.status, rule.to, null, "SYSTEM", occurredAt.toISOString()],
    );
    await tx.appendAudit({
      actorChannel: "SYSTEM",
      action: "BOOKING_AUTO_COMPLETED",
      resourceType: "Booking",
      resourceId: booking.id,
      outcome: "SUCCEEDED",
      metadata: { bookingId: booking.id, fromStatus: booking.status, toStatus: rule.to, reason: "ZERO_TOTAL_INVOICE" },
      occurredAt,
    });
    await tx.appendOutbox({
      aggregateType: "Booking",
      aggregateId: booking.id,
      eventType: bookingTransitionEventType(rule.to),
      eventVersion: Number(version),
      payload: { bookingId: booking.id, fromStatus: booking.status, toStatus: rule.to },
    });
    return { ...booking, status: rule.to, version: Number(version) };
  }
  #assertEvidenceCorrectable(status: BookingStatus): void {
    if (SETTLEMENT_LOCKED_STATUSES.has(status)) {
      throw new JobConflictError("Work evidence cannot be corrected after payment has been recorded");
    }
  }

  #assertBookingStatusForAction(
    bookingStatus: BookingStatus,
    state: string,
    action: WorkAction,
    validNextActions: readonly WorkAction[],
  ): void {
    const statusAllows = action === "START"
      ? bookingStatus === "ACCEPTED" || bookingStatus === "SCHEDULED"
      : bookingStatus === "IN_PROGRESS";
    if (!statusAllows) {
      throw new InvalidJobSequenceError(
        `Cannot ${action.toLowerCase()} work while booking is ${bookingStatus.toLowerCase().replaceAll("_", " ")}`,
        state as "NOT_STARTED" | "ACTIVE" | "PAUSED" | "COMPLETED",
        validNextActions,
      );
    }
  }

  async #incrementBookingVersion(tx: SqlConnection, booking: JobBookingRow, occurredAt: Date): Promise<number> {
    const result = await tx.query<{ readonly version: number }>(
      `UPDATE public.bookings SET version = version + 1, updated_at = $2
       WHERE id = $1 AND version = $3 RETURNING version`,
      [booking.id, occurredAt.toISOString(), booking.version],
    );
    const version = result.rows[0]?.version;
    if (version === undefined) throw new JobConflictError("The job changed while the correction was being recorded");
    return version;
  }
}
