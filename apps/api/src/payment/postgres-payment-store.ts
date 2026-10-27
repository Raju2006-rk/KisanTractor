import { randomUUID } from "node:crypto";

import {
  appliedPaymentStatuses,
  evaluatePaymentApplication,
  evaluateProviderPaymentEvent,
  evaluateProviderRefundEvent,
  evaluateRefundRequest,
  isRefundEventKind,
  lateConfirmationCapacity,
  planPaymentTransition,
  projectPaymentRecord,
  summarizeInvoiceSettlement,
  type InvoiceRecordStatus,
  type PaymentApplicationDecision,
  type PaymentMethod,
  type PaymentRecordProjection,
  type PaymentRecordSource,
  type PaymentRecordStatus,
  type PaymentRefundStatus,
} from "@kisantractor/domain";
import {
  type DomainTransaction,
  type SqlConnection,
  type SqlPool,
  withDomainTransaction,
  withTransaction,
} from "@kisantractor/database";

import { bookingTransitionEventType, bookingTransitionRule } from "../booking/booking-lifecycle.js";
import type { BookingLifecycleAction, BookingLifecycleActorRole, BookingStatus } from "../booking/booking.contracts.js";
import { retrySerializationFailures } from "../serialization-retry.js";
import type {
  BookingPaymentsSource,
  BookingSettlementProjection,
  OnlineIntentRecord,
  OnlineIntentReference,
  PaymentApplicationPreview,
  PaymentApplicationResult,
  PaymentBookingRecord,
  PaymentHistoryQuery,
  PaymentHistoryRow,
  PaymentHistoryStore,
  PaymentInvoiceRecord,
  PaymentReceiptRecordSource,
  PaymentRecoveryStore,
  PaymentRefundProjection,
  PaymentRefundStore,
  PaymentRequestContext,
  PaymentStore,
  PaymentTransitionResult,
  ProviderEventOutcome,
  RefundRequestResult,
  RefundSubmissionSource,
  RefundSubmissionUpdate,
  ReleasePendingIntentInput,
  ReleasePendingIntentResult,
  ValidatedPaymentApplication,
  ValidatedPaymentTransition,
  ValidatedRefundRequest,
  VerifiedProviderEventRecord,
} from "./payment.contracts.js";
import {
  PAYABLE_BOOKING_STATUSES,
  PaymentCapabilityUnavailableError,
  PaymentConflictError,
  PaymentNotFoundError,
  PaymentValidationError,
  toLedgerEntry,
  toPayableInvoice,
  toSettlementProjection,
} from "./payment.service.js";

interface BookingRow extends Record<string, unknown> {
  readonly id: string;
  readonly public_reference: string;
  readonly customer_id: string;
  readonly owner_id: string;
  readonly status: BookingStatus;
  readonly version: number;
}

interface InvoiceRow extends Record<string, unknown> {
  readonly id: string;
  readonly booking_id: string;
  readonly invoice_version: number;
  readonly status: InvoiceRecordStatus;
  /** bigint columns arrive as strings from node-postgres. */
  readonly total_paise: string | number;
  readonly currency: string;
}

interface PaymentRow extends Record<string, unknown> {
  readonly id: string;
  readonly invoice_id: string;
  readonly method: PaymentMethod;
  readonly status: PaymentRecordStatus;
  readonly amount_paise: string | number;
  readonly currency: string;
  readonly recorded_by_user_id: string | null;
  readonly received_at: Date | null;
  readonly verified_at: Date | null;
  readonly created_at: Date;
  readonly version: number;
  readonly provider?: string | null;
  readonly provider_reference?: string | null;
  readonly provider_payment_id?: string | null;
  readonly provider_mode?: string | null;
}

interface RefundRow extends Record<string, unknown> {
  readonly id: string;
  readonly payment_id: string;
  readonly provider: string;
  readonly provider_payment_id: string;
  readonly provider_refund_id: string | null;
  readonly refund_key: string;
  readonly amount_paise: string | number;
  readonly currency: string;
  readonly status: PaymentRefundStatus;
  readonly reason_code: string;
  readonly submit_attempts: number;
  readonly requested_at: Date;
  readonly resolved_at: Date | null;
  readonly version: number;
  readonly booking_id?: string;
}

interface IdempotencyRow extends Record<string, unknown> {
  readonly request_digest: string;
  readonly status: "IN_PROGRESS" | "COMPLETED" | "FAILED";
  readonly response_body: unknown | null;
}

const BOOKING_COLUMNS = "id, public_reference, customer_id, owner_id, status, version";
const INVOICE_COLUMNS = "id, booking_id, invoice_version, status, total_paise, currency";
const PAYMENT_COLUMNS = `id, invoice_id, method, status, amount_paise, currency, recorded_by_user_id,
  received_at, verified_at, created_at, version, provider, provider_reference, provider_payment_id, provider_mode`;
const REFUND_COLUMNS = `r.id, r.payment_id, r.provider, r.provider_payment_id, r.provider_refund_id, r.refund_key, r.amount_paise,
  r.currency, r.status, r.reason_code, r.submit_attempts, r.requested_at, r.resolved_at, r.version`;
/** Retried in a fresh transaction: a concurrent delivery inserted the same provider event first. */
const PROVIDER_EVENT_RETRY_CODES: ReadonlySet<string> = new Set(["23505"]);
const CURRENCY_CODE = /^[A-Z]{3}$/u;
const ERROR_CODE = /^[A-Z0-9_]{1,64}$/u;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1_000;
const CURSOR_INSTANT_SQL = `to_char(p.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const scopeFor = (actorId: string, invoiceId: string): string => `payment:${actorId}:invoice:${invoiceId}:apply`;
const refundScopeFor = (actorId: string, paymentId: string): string => `refund:${actorId}:payment:${paymentId}:request`;
/** The provider idempotency key and receipt for one refund request: `ktrf` + 32 hex digits. */
const refundKeyFor = (refundId: string): string => `ktrf${refundId.replaceAll("-", "").toLowerCase()}`;

const safePaise = (value: string | number, field: string): number => {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`Stored ${field} is not a safe whole number of paise`);
  return parsed;
};

const toBooking = (row: BookingRow): PaymentBookingRecord => Object.freeze({
  id: row.id,
  reference: row.public_reference,
  customerId: row.customer_id,
  ownerId: row.owner_id,
  status: row.status,
  version: Number(row.version),
});

const toInvoice = (row: InvoiceRow): PaymentInvoiceRecord => Object.freeze({
  id: row.id,
  bookingId: row.booking_id,
  invoiceVersion: Number(row.invoice_version),
  status: row.status,
  totalPaise: safePaise(row.total_paise, "invoice total"),
  currency: row.currency.trim(),
});

const toPayment = (row: PaymentRow): PaymentRecordSource => Object.freeze({
  id: row.id,
  invoiceId: row.invoice_id,
  method: row.method,
  status: row.status,
  amountPaise: safePaise(row.amount_paise, "payment amount"),
  currency: row.currency.trim(),
  ...(row.recorded_by_user_id === null ? {} : { recordedByUserId: row.recorded_by_user_id }),
  ...(row.received_at === null ? {} : { receivedAt: new Date(row.received_at) }),
  ...(row.verified_at === null ? {} : { verifiedAt: new Date(row.verified_at) }),
  createdAt: new Date(row.created_at),
  ...(row.provider_mode === "SANDBOX" || row.provider_mode === "LIVE" ? { providerMode: row.provider_mode } : {}),
});

const toRefundSource = (row: RefundRow, bookingId: string): RefundSubmissionSource => Object.freeze({
  refundId: row.id,
  paymentId: row.payment_id,
  bookingId,
  provider: row.provider,
  providerPaymentId: row.provider_payment_id,
  ...(row.provider_refund_id === null ? {} : { providerRefundId: row.provider_refund_id }),
  refundKey: row.refund_key,
  amountPaise: safePaise(row.amount_paise, "refund amount"),
  currency: row.currency.trim(),
  status: row.status,
  requestedAt: new Date(row.requested_at),
  submitAttempts: Number(row.submit_attempts),
});

const toRefundProjection = (row: RefundRow, bookingId: string): PaymentRefundProjection => Object.freeze({
  id: row.id,
  paymentId: row.payment_id,
  bookingId,
  status: row.status,
  amountPaise: safePaise(row.amount_paise, "refund amount"),
  currency: "INR",
  reasonCode: row.reason_code,
  requestedAt: new Date(row.requested_at),
  ...(row.resolved_at === null ? {} : { resolvedAt: new Date(row.resolved_at) }),
});

const asDate = (value: unknown, field: string): Date => {
  const result = new Date(String(value));
  if (Number.isNaN(result.getTime())) throw new Error(`Stored payment response has invalid ${field}`);
  return result;
};

const hydrateRecord = (value: Record<string, unknown>): PaymentRecordProjection => Object.freeze({
  ...(value as unknown as PaymentRecordProjection),
  recordedAt: asDate(value.recordedAt, "recordedAt"),
  ...(value.paidAt === undefined ? {} : { paidAt: asDate(value.paidAt, "paidAt") }),
});

const hydrateIntent = (value: unknown): OnlineIntentReference | undefined => {
  const source = typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
  return typeof source?.provider === "string" && typeof source.providerReference === "string"
    ? Object.freeze({ provider: source.provider, providerReference: source.providerReference })
    : undefined;
};

const hydrateResult = (value: unknown): PaymentApplicationResult => {
  if (typeof value !== "object" || value === null) throw new Error("Completed payment idempotency record has no response");
  const source = value as { payment: Record<string, unknown>; settlement: Record<string, unknown>; onlineIntent?: unknown };
  const settlement = source.settlement as unknown as BookingSettlementProjection;
  const onlineIntent = hydrateIntent(source.onlineIntent);
  return Object.freeze({
    payment: hydrateRecord(source.payment),
    settlement: Object.freeze({
      ...settlement,
      payments: Object.freeze((settlement.payments as unknown as Record<string, unknown>[]).map(hydrateRecord)),
    }),
    ...(onlineIntent === undefined ? {} : { onlineIntent }),
  });
};

const hydrateRefundResult = (value: unknown): RefundRequestResult => {
  if (typeof value !== "object" || value === null) throw new Error("Completed refund idempotency record has no response");
  const source = value as { refund: Record<string, unknown>; payment: Record<string, unknown>; bookingStatus: BookingStatus };
  return Object.freeze({
    refund: Object.freeze({
      ...(source.refund as unknown as PaymentRefundProjection),
      requestedAt: asDate(source.refund.requestedAt, "requestedAt"),
      ...(source.refund.resolvedAt === undefined ? {} : { resolvedAt: asDate(source.refund.resolvedAt, "resolvedAt") }),
    }),
    payment: hydrateRecord(source.payment),
    bookingStatus: source.bookingStatus,
  });
};

/** Everything applyPayment and its preview derive from the ledger before writing. */
interface EvaluatedApplication {
  readonly booking: PaymentBookingRecord;
  readonly invoice: PaymentInvoiceRecord;
  readonly existing: readonly PaymentRecordSource[];
  readonly decision: PaymentApplicationDecision;
}

/** A booking, one of its invoices, and that invoice's payments, locked booking first. */
interface LockedLedger {
  readonly booking: PaymentBookingRecord;
  readonly invoice: PaymentInvoiceRecord;
  readonly rows: readonly PaymentRow[];
}

const validateApplicationShape = (input: ValidatedPaymentApplication, requireProviderReference: boolean): void => {
  if (!Number.isSafeInteger(input.amountPaise) || input.amountPaise <= 0) {
    throw new PaymentValidationError("amountPaise", "Payment amount must be a positive whole number of paise");
  }
  if (input.method === "CASH") {
    if (input.provider !== undefined || input.providerReference !== undefined || input.providerMode !== undefined) {
      throw new PaymentValidationError("provider", "A cash payment cannot carry provider details");
    }
    if (input.receivedAt !== undefined
      && (Number.isNaN(input.receivedAt.getTime()) || input.receivedAt.getTime() > input.occurredAt.getTime())) {
      throw new PaymentValidationError("receivedAt", "Cash receipt time must be a valid instant that is not in the future");
    }
    return;
  }
  if (input.receivedAt !== undefined) {
    throw new PaymentValidationError("receivedAt", "Online payments are received only through a verified provider event");
  }
  if (input.provider === undefined || input.provider.trim().length === 0) {
    throw new PaymentValidationError("provider", "An online payment intent must name its configured provider");
  }
  if (requireProviderReference && (input.providerReference === undefined || input.providerReference.trim().length === 0)) {
    throw new PaymentValidationError("providerReference", "An online payment must be linked to its server-created provider intent");
  }
};

const outboxEventType = (eventType: string): string =>
  `Payment${eventType.toLowerCase().split("_").map((part) => part[0]!.toUpperCase() + part.slice(1)).join("")}`;

export class PostgresPaymentStore implements PaymentStore, PaymentRefundStore, PaymentRecoveryStore, PaymentHistoryStore {
  constructor(private readonly pool: SqlPool, private readonly idempotencyTtlMs = IDEMPOTENCY_TTL_MS) {
    if (!Number.isSafeInteger(idempotencyTtlMs) || idempotencyTtlMs <= 0) {
      throw new TypeError("idempotencyTtlMs must be a positive safe integer");
    }
  }

  loadBookingPayments(bookingId: string, context: PaymentRequestContext): Promise<BookingPaymentsSource | undefined> {
    return withTransaction(this.pool, async (sql) => {
      const booking = await this.#loadBooking(sql, bookingId, false);
      if (booking === undefined) return undefined;
      const invoice = await this.#loadCurrentInvoice(sql, booking.id);
      const payments = invoice === undefined ? [] : await this.#loadPayments(sql, invoice.id, false);
      return Object.freeze({
        booking,
        ...(invoice === undefined ? {} : { invoice }),
        payments: Object.freeze(payments.map(toPayment)),
      });
    }, { isolation: "REPEATABLE READ", readOnly: true, correlationId: context.correlationId });
  }

  loadReceiptSource(paymentId: string, context: PaymentRequestContext): Promise<PaymentReceiptRecordSource | undefined> {
    return withTransaction(this.pool, async (sql) => {
      const paymentResult = await sql.query<PaymentRow>(
        `SELECT ${PAYMENT_COLUMNS} FROM public.payments WHERE id = $1`,
        [paymentId],
      );
      const paymentRow = paymentResult.rows[0];
      if (paymentRow === undefined) return undefined;
      const invoiceResult = await sql.query<InvoiceRow>(
        `SELECT ${INVOICE_COLUMNS} FROM public.invoices WHERE id = $1`,
        [paymentRow.invoice_id],
      );
      const invoiceRow = invoiceResult.rows[0];
      if (invoiceRow === undefined) return undefined;
      const booking = await this.#loadBooking(sql, invoiceRow.booking_id, false);
      if (booking === undefined) return undefined;
      const current = await this.#loadCurrentInvoice(sql, booking.id);
      const siblings = await this.#loadPayments(sql, invoiceRow.id, false);
      return Object.freeze({
        booking,
        invoice: toInvoice(invoiceRow),
        invoiceSuperseded: current?.id !== invoiceRow.id,
        payment: toPayment(paymentRow),
        invoicePayments: Object.freeze(siblings.map(toPayment)),
      });
    }, { isolation: "REPEATABLE READ", readOnly: true, correlationId: context.correlationId });
  }

  previewPaymentApplication(input: ValidatedPaymentApplication, context: PaymentRequestContext): Promise<PaymentApplicationPreview> {
    validateApplicationShape(input, false);
    return withTransaction(this.pool, async (sql) => {
      const recorded = await sql.query<IdempotencyRow>(
        `SELECT request_digest, status, response_body FROM public.idempotency_records
         WHERE actor_scope = $1 AND idempotency_key = $2`,
        [scopeFor(input.actorId, input.invoiceId), input.idempotencyKey],
      );
      const row = recorded.rows[0];
      if (row !== undefined && row.request_digest !== input.requestDigest) {
        throw new PaymentConflictError("IDEMPOTENCY_KEY_REUSED", "The idempotency key was already used for a different payment");
      }
      if (row?.status === "COMPLETED") return Object.freeze({ kind: "REPLAY", result: hydrateResult(row.response_body) });
      await this.#evaluateApplication(sql, input, false);
      return Object.freeze({ kind: "PROCEED" });
    }, { isolation: "REPEATABLE READ", readOnly: true, correlationId: context.correlationId });
  }

  async applyPayment(input: ValidatedPaymentApplication, context: PaymentRequestContext): Promise<PaymentApplicationResult> {
    validateApplicationShape(input, true);
    return this.#run(context, async (tx) => {
      const scope = scopeFor(input.actorId, input.invoiceId);
      const replay = await this.#claimIdempotency(tx.sql, scope, input.idempotencyKey, input.requestDigest, input.occurredAt,
        "The idempotency key was already used for a different payment");
      if (replay !== undefined) return hydrateResult(replay);

      const { booking, invoice: payable, existing, decision } = await this.#evaluateApplication(tx.sql, input, true);
      const occurredAt = input.occurredAt.toISOString();
      const isCash = input.method === "CASH";
      const inserted = await tx.sql.query<PaymentRow>(
        `INSERT INTO public.payments
           (invoice_id, method, status, amount_paise, currency, provider, provider_reference,
            recorded_by_user_id, received_at, created_at, updated_at, provider_mode)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10, $11)
         RETURNING ${PAYMENT_COLUMNS}`,
        [payable.id, input.method, decision.initialStatus, input.amountPaise, input.currency,
          isCash ? null : input.provider!.trim(), isCash ? null : input.providerReference!.trim(),
          isCash ? input.actorId : null, isCash ? (input.receivedAt ?? input.occurredAt).toISOString() : null,
          occurredAt, isCash ? null : input.providerMode ?? null],
      );
      const paymentRow = inserted.rows[0];
      if (paymentRow === undefined) throw new Error("Payment was not stored");
      const payment = toPayment(paymentRow);
      await tx.sql.query(
        `INSERT INTO public.payment_events
           (payment_id, event_type, from_status, to_status, amount_paise, actor_id, actor_channel, occurred_at)
         VALUES ($1, $2, NULL, $3, $4, $5, $6, $7)`,
        [payment.id, decision.eventType, payment.status, payment.amountPaise, input.actorId,
          context.actorChannel, occurredAt],
      );

      let current = booking;
      if (appliedPaymentStatuses.includes(payment.status)) {
        if (current.status === "FINAL_BILL_GENERATED") {
          current = await this.#bookingTransition(tx, current, "RECORD_PAYMENT", "SYSTEM", input.occurredAt);
        }
        // The booking completes in the same transaction as the payment that settles its bill.
        if (decision.settlementAfter.settled && current.status === "PAYMENT_RECORDED") {
          current = await this.#bookingTransition(tx, current, "COMPLETE", "SYSTEM", input.occurredAt);
        }
      }
      await tx.appendAudit({
        actorId: input.actorId,
        actorChannel: context.actorChannel,
        action: decision.eventType,
        resourceType: "Payment",
        resourceId: payment.id,
        outcome: "SUCCEEDED",
        metadata: {
          bookingId: booking.id,
          invoiceId: payable.id,
          method: payment.method,
          status: payment.status,
          amountPaise: payment.amountPaise,
          settled: decision.settlementAfter.settled,
          outstandingPaise: decision.settlementAfter.outstandingPaise,
          bookingStatusBefore: booking.status,
          bookingStatusAfter: current.status,
          ...(payment.receivedAt === undefined ? {} : { receivedAt: payment.receivedAt.toISOString() }),
        },
        occurredAt: input.occurredAt,
      });
      await tx.appendOutbox({
        aggregateType: "Payment",
        aggregateId: payment.id,
        eventType: isCash ? "CashPaymentRecorded" : "OnlinePaymentInitiated",
        eventVersion: Number(paymentRow.version),
        payload: {
          paymentId: payment.id,
          bookingId: booking.id,
          invoiceId: payable.id,
          method: payment.method,
          status: payment.status,
          amountPaise: payment.amountPaise,
          settled: decision.settlementAfter.settled,
        },
      });

      const result: PaymentApplicationResult = Object.freeze({
        payment: projectPaymentRecord(payment, booking),
        settlement: toSettlementProjection({ booking: current, invoice: payable, payments: [...existing, payment] }),
        ...(isCash ? {} : {
          onlineIntent: Object.freeze({ provider: input.provider!.trim(), providerReference: input.providerReference!.trim() }),
        }),
      });
      await this.#completeIdempotency(tx.sql, scope, input.idempotencyKey, result, "Payment", payment.id);
      return result;
    });
  }

  transitionPayment(input: ValidatedPaymentTransition, context: PaymentRequestContext): Promise<PaymentTransitionResult> {
    return this.#run(context, async (tx) => {
      const located = await tx.sql.query<{ readonly booking_id: string }>(
        `SELECT i.booking_id FROM public.payments p JOIN public.invoices i ON i.id = p.invoice_id WHERE p.id = $1`,
        [input.paymentId],
      );
      const bookingId = located.rows[0]?.booking_id;
      if (bookingId === undefined) throw new PaymentNotFoundError();
      const booking = await this.#loadBooking(tx.sql, bookingId, true);
      if (booking === undefined) throw new PaymentNotFoundError();
      const locked = await tx.sql.query<PaymentRow>(
        `SELECT ${PAYMENT_COLUMNS} FROM public.payments WHERE id = $1 FOR UPDATE`,
        [input.paymentId],
      );
      const row = locked.rows[0];
      if (row === undefined) throw new PaymentNotFoundError();
      if (Number(row.version) !== input.expectedVersion) {
        throw new PaymentConflictError("PAYMENT_CONFLICT", "The payment changed; refresh and retry");
      }
      const before = toPayment(row);
      const rule = planPaymentTransition(before, input.toStatus, input.actorRole, {
        ...(input.reason === undefined ? {} : { reason: input.reason }),
        ...(input.evidence === undefined ? {} : { evidence: input.evidence }),
      });
      if (rule.evidence === "VERIFIED_PROVIDER_EVENT") {
        // Evidence named by a caller is not verification. Provider-confirmed changes happen only in
        // recordProviderEvent, after the adapter has verified the provider's signature.
        throw new PaymentCapabilityUnavailableError(
          "Provider-confirmed payment changes are applied only from a verified provider event");
      }
      const occurredAt = input.occurredAt.toISOString();
      const updated = await tx.sql.query<PaymentRow>(
        `UPDATE public.payments SET status = $2, version = version + 1, updated_at = $3
         WHERE id = $1 AND version = $4
         RETURNING ${PAYMENT_COLUMNS}`,
        [before.id, rule.to, occurredAt, input.expectedVersion],
      );
      const afterRow = updated.rows[0];
      if (afterRow === undefined) throw new PaymentConflictError("PAYMENT_CONFLICT", "The payment changed; refresh and retry");
      const after = toPayment(afterRow);
      const reason = input.reason?.trim();
      await tx.sql.query(
        `INSERT INTO public.payment_events
           (payment_id, event_type, from_status, to_status, amount_paise, actor_id, actor_channel, reason, occurred_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [after.id, rule.eventType, before.status, after.status, after.amountPaise, input.actorId ?? null,
          context.actorChannel, reason === undefined || reason.length === 0 ? null : reason, occurredAt],
      );
      await tx.appendAudit({
        ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
        actorChannel: context.actorChannel,
        action: rule.eventType,
        resourceType: "Payment",
        resourceId: after.id,
        outcome: "SUCCEEDED",
        metadata: { bookingId: booking.id, invoiceId: after.invoiceId, fromStatus: before.status, toStatus: after.status },
        occurredAt: input.occurredAt,
      });
      await tx.appendOutbox({
        aggregateType: "Payment",
        aggregateId: after.id,
        eventType: outboxEventType(rule.eventType),
        eventVersion: Number(afterRow.version),
        payload: { paymentId: after.id, bookingId: booking.id, fromStatus: before.status, toStatus: after.status },
      });
      return Object.freeze({ payment: projectPaymentRecord(after, booking), version: Number(afterRow.version) });
    });
  }

  /**
   * Records verified provider evidence (Requirements 11.5, 11.6). One SERIALIZABLE transaction:
   * deduplicate by event id or digest, lock the booking and its invoice ledger (the same lock
   * order as applyPayment), let the domain decide, append the immutable provider event, and apply
   * the financial effect with its payment event, booking transitions, audit, and outbox records.
   * A concurrent duplicate loses on the unique index and is retried into DUPLICATE. Payment and
   * refund evidence from webhooks and from provider API reads take this same path, so the same
   * fact observed twice has one financial effect.
   */
  recordProviderEvent(input: VerifiedProviderEventRecord, context: PaymentRequestContext): Promise<ProviderEventOutcome> {
    return this.#run(context, async (tx) => {
      const seen = await tx.sql.query<{ readonly provider_event_id: string }>(
        `SELECT provider_event_id FROM public.provider_events
         WHERE provider = $1 AND (provider_event_id = $2 OR payload_digest = $3)
         ORDER BY received_at LIMIT 1`,
        [input.provider, input.providerEventId, input.payloadDigest],
      );
      const duplicate = seen.rows[0];
      if (duplicate !== undefined) {
        return Object.freeze({
          disposition: "DUPLICATE",
          ...(duplicate.provider_event_id === input.providerEventId ? {} : { replayedUnderNewEventId: true }),
        });
      }
      const refundEvidence = isRefundEventKind(input.kind) || input.providerRefundId !== undefined
        || input.paymentRefundId !== undefined || input.eventType.startsWith("refund.");
      return refundEvidence ? this.#recordRefundEvidence(tx, input) : this.#recordPaymentEvidence(tx, input);
    }, PROVIDER_EVENT_RETRY_CODES);
  }

  // ---- Refunds (task 16.2) ----

  requestRefund(input: ValidatedRefundRequest, context: PaymentRequestContext): Promise<RefundRequestResult> {
    return this.#run(context, async (tx) => {
      const scope = refundScopeFor(input.actorId, input.paymentId);
      const replay = await this.#claimIdempotency(tx.sql, scope, input.idempotencyKey, input.requestDigest, input.occurredAt,
        "The idempotency key was already used for a different refund");
      if (replay !== undefined) return hydrateRefundResult(replay);

      const ledger = await this.#lockLedgerForPayment(tx.sql, input.paymentId);
      if (ledger === undefined) throw new PaymentNotFoundError();
      const row = ledger.rows.find((candidate) => candidate.id === input.paymentId);
      if (row === undefined) throw new PaymentNotFoundError();
      const payment = toPayment(row);
      const decision = evaluateRefundRequest({
        payment,
        ...(row.provider_payment_id ? { providerPaymentId: row.provider_payment_id } : {}),
        bookingStatus: ledger.booking.status,
        actorRole: input.actorRole,
        reasonCode: input.reasonCode,
        ...(input.amountPaise === undefined ? {} : { amountPaise: input.amountPaise }),
      });
      if (row.provider !== input.provider) {
        throw new PaymentCapabilityUnavailableError("This payment was made with a provider that is no longer configured");
      }

      const occurredAt = input.occurredAt.toISOString();
      const refundId = randomUUID();
      const inserted = await tx.sql.query<RefundRow>(
        `INSERT INTO public.payment_refunds AS r
           (id, payment_id, provider, provider_payment_id, refund_key, amount_paise, currency, status, reason_code,
            requested_by_user_id, requested_by_role, requested_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'REQUESTED', $8, $9, $10, $11, $11, $11)
         RETURNING ${REFUND_COLUMNS}`,
        [refundId, payment.id, row.provider, row.provider_payment_id, refundKeyFor(refundId), decision.refundPaise,
          decision.currency, decision.reasonCode, input.actorId, input.actorRole, occurredAt],
      );
      const refundRow = inserted.rows[0];
      if (refundRow === undefined) throw new Error("Refund was not stored");
      const updated = await tx.sql.query<PaymentRow>(
        `UPDATE public.payments SET status = $2, version = version + 1, updated_at = $3
         WHERE id = $1 AND version = $4 AND status = $5
         RETURNING ${PAYMENT_COLUMNS}`,
        [payment.id, decision.rule.to, occurredAt, Number(row.version), decision.rule.from],
      );
      const afterRow = updated.rows[0];
      if (afterRow === undefined) throw new PaymentConflictError("PAYMENT_CONFLICT", "The payment changed; refresh and retry");
      const after = toPayment(afterRow);
      await tx.sql.query(
        `INSERT INTO public.payment_events
           (payment_id, event_type, from_status, to_status, amount_paise, actor_id, actor_channel, reason, occurred_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [after.id, decision.rule.eventType, payment.status, after.status, after.amountPaise, input.actorId,
          context.actorChannel, decision.reason, occurredAt],
      );
      let booking = ledger.booking;
      if (decision.bookingRefundRequested) {
        booking = await this.#bookingTransition(tx, booking, "REQUEST_REFUND", input.actorRole, input.occurredAt,
          input.actorId, decision.reason);
      }
      await tx.appendAudit({
        actorId: input.actorId,
        actorChannel: context.actorChannel,
        action: decision.rule.eventType,
        resourceType: "Payment",
        resourceId: after.id,
        outcome: "SUCCEEDED",
        metadata: {
          bookingId: booking.id,
          invoiceId: after.invoiceId,
          refundId,
          amountPaise: decision.refundPaise,
          reasonCode: decision.reasonCode,
          requestedByRole: input.actorRole,
          bookingStatusBefore: ledger.booking.status,
          bookingStatusAfter: booking.status,
        },
        occurredAt: input.occurredAt,
      });
      await tx.appendOutbox({
        aggregateType: "Payment",
        aggregateId: after.id,
        eventType: "PaymentRefundRequested",
        eventVersion: Number(afterRow.version),
        payload: { paymentId: after.id, bookingId: booking.id, refundId, amountPaise: decision.refundPaise, status: after.status },
      });
      const result: RefundRequestResult = Object.freeze({
        refund: toRefundProjection(refundRow, booking.id),
        payment: projectPaymentRecord(after, booking),
        bookingStatus: booking.status,
      });
      await this.#completeIdempotency(tx.sql, scope, input.idempotencyKey, result, "PaymentRefund", refundId);
      return result;
    });
  }

  loadRefundSubmission(refundId: string, context: PaymentRequestContext): Promise<RefundSubmissionSource | undefined> {
    return withTransaction(this.pool, async (sql) => {
      const result = await sql.query<RefundRow>(
        `SELECT ${REFUND_COLUMNS}, i.booking_id FROM public.payment_refunds r
         JOIN public.payments p ON p.id = r.payment_id JOIN public.invoices i ON i.id = p.invoice_id
         WHERE r.id = $1`,
        [refundId],
      );
      const row = result.rows[0];
      return row === undefined ? undefined : toRefundSource(row, String(row.booking_id));
    }, { isolation: "READ COMMITTED", readOnly: true, correlationId: context.correlationId });
  }

  recordRefundSubmission(input: RefundSubmissionUpdate, context: PaymentRequestContext): Promise<void> {
    const errorCode = input.errorCode === undefined ? null : ERROR_CODE.test(input.errorCode) ? input.errorCode : "OTHER";
    return this.#run(context, async (tx) => {
      const updated = await tx.sql.query<RefundRow>(
        `UPDATE public.payment_refunds AS r SET
           provider_refund_id = COALESCE(r.provider_refund_id, $2::text),
           status = CASE WHEN $2::text IS NOT NULL AND r.status = 'REQUESTED' THEN 'SUBMITTED'::payment_refund_status ELSE r.status END,
           submitted_at = CASE WHEN $2::text IS NOT NULL THEN COALESCE(r.submitted_at, $4::timestamptz) ELSE r.submitted_at END,
           submit_attempts = r.submit_attempts + 1,
           last_error_code = $3::text,
           checked_at = $4::timestamptz,
           updated_at = $4::timestamptz,
           version = r.version + 1
         WHERE r.id = $1 AND r.status IN ('REQUESTED', 'SUBMITTED')
         RETURNING ${REFUND_COLUMNS}`,
        [input.refundId, input.providerRefundId ?? null, errorCode, input.occurredAt.toISOString()],
      );
      const row = updated.rows[0];
      if (row === undefined) return;
      await tx.appendAudit({
        actorChannel: "SYSTEM",
        action: input.providerRefundId === undefined ? "REFUND_SUBMISSION_FAILED" : "REFUND_SUBMITTED",
        resourceType: "PaymentRefund",
        resourceId: row.id,
        outcome: input.providerRefundId === undefined ? "FAILED" : "SUCCEEDED",
        ...(errorCode === null ? {} : { reasonCode: errorCode }),
        metadata: { paymentId: row.payment_id, status: row.status, attempts: Number(row.submit_attempts) },
        occurredAt: input.occurredAt,
      });
    });
  }

  // ---- Pending-intent recovery and reconciliation (task 16.2) ----

  loadOnlineIntent(paymentId: string, context: PaymentRequestContext): Promise<OnlineIntentRecord | undefined> {
    return withTransaction(this.pool, async (sql) => {
      const result = await sql.query<PaymentRow & { readonly booking_id: string }>(
        `SELECT ${PAYMENT_COLUMNS.split(",").map((column) => `p.${column.trim()}`).join(", ")}, i.booking_id
         FROM public.payments p JOIN public.invoices i ON i.id = p.invoice_id
         WHERE p.id = $1 AND p.method = 'ONLINE'`,
        [paymentId],
      );
      const row = result.rows[0];
      if (row === undefined) return undefined;
      const booking = await this.#loadBooking(sql, row.booking_id, false);
      return booking === undefined ? undefined : this.#toIntent(row, booking);
    }, { isolation: "REPEATABLE READ", readOnly: true, correlationId: context.correlationId });
  }

  listPendingIntentsForRecovery(
    input: Readonly<{ createdBefore: Date; limit: number }>,
    context: PaymentRequestContext,
  ): Promise<readonly OnlineIntentRecord[]> {
    return withTransaction(this.pool, async (sql) => {
      const result = await sql.query<PaymentRow & { readonly booking_id: string }>(
        `SELECT ${PAYMENT_COLUMNS.split(",").map((column) => `p.${column.trim()}`).join(", ")}, i.booking_id
         FROM public.payments p JOIN public.invoices i ON i.id = p.invoice_id
         WHERE p.method = 'ONLINE' AND p.status = 'PENDING' AND p.created_at < $1
         ORDER BY p.reconciled_at NULLS FIRST, p.created_at, p.id
         LIMIT $2`,
        [input.createdBefore.toISOString(), input.limit],
      );
      if (result.rows.length === 0) return [];
      const bookings = await sql.query<BookingRow>(
        `SELECT ${BOOKING_COLUMNS} FROM public.bookings WHERE id = ANY($1::uuid[])`,
        [[...new Set(result.rows.map((row) => row.booking_id))]],
      );
      const byId = new Map(bookings.rows.map((row) => [row.id, toBooking(row)]));
      return Object.freeze(result.rows.flatMap((row) => {
        const booking = byId.get(row.booking_id);
        const intent = booking === undefined ? undefined : this.#toIntent(row, booking);
        return intent === undefined ? [] : [intent];
      }));
    }, { isolation: "REPEATABLE READ", readOnly: true, correlationId: context.correlationId });
  }

  markIntentChecked(paymentId: string, checkedAt: Date, context: PaymentRequestContext): Promise<void> {
    return withTransaction(this.pool, async (sql) => {
      await sql.query(
        `UPDATE public.payments SET reconciled_at = $2 WHERE id = $1 AND method = 'ONLINE' AND status = 'PENDING'`,
        [paymentId, checkedAt.toISOString()],
      );
    }, { isolation: "READ COMMITTED", correlationId: context.correlationId });
  }

  /**
   * Closes a pending intent the provider showed no successful payment for, releasing its bill
   * reservation. Re-checks under lock that the intent is still pending: a confirmation that
   * committed first wins, and a capture that arrives later is a late confirmation.
   */
  releasePendingIntent(input: ReleasePendingIntentInput, context: PaymentRequestContext): Promise<ReleasePendingIntentResult> {
    return this.#run(context, async (tx) => {
      const ledger = await this.#lockLedgerForPayment(tx.sql, input.paymentId);
      const row = ledger?.rows.find((candidate) => candidate.id === input.paymentId);
      if (ledger === undefined || row === undefined || row.method !== "ONLINE") throw new PaymentNotFoundError();
      const before = toPayment(row);
      if (before.status !== "PENDING" || row.provider !== input.provider) {
        return Object.freeze({ released: false, status: before.status, payment: projectPaymentRecord(before, ledger.booking) });
      }
      const reason = input.reason === "CANCELLED"
        ? "The Farmer cancelled the online payment and the provider reported no successful payment"
        : "The online payment was not completed in time and the provider reported no successful payment";
      const rule = planPaymentTransition(before, "PAYMENT_FAILED", "SYSTEM", { reason });
      const occurredAt = input.occurredAt.toISOString();
      const updated = await tx.sql.query<PaymentRow>(
        `UPDATE public.payments SET status = $2, version = version + 1, updated_at = $3, reconciled_at = $3
         WHERE id = $1 AND version = $4 AND status = 'PENDING'
         RETURNING ${PAYMENT_COLUMNS}`,
        [before.id, rule.to, occurredAt, Number(row.version)],
      );
      const afterRow = updated.rows[0];
      if (afterRow === undefined) throw new PaymentConflictError("PAYMENT_CONFLICT", "The payment changed; refresh and retry");
      const after = toPayment(afterRow);
      // The provider read that justified the release is kept as immutable evidence.
      await tx.sql.query(
        `INSERT INTO public.provider_events
           (payment_id, provider, provider_event_id, provider_reference, event_type, status, signature_verified,
            amount_paise, currency, payload_digest, received_at, applied_at, evidence_source)
         VALUES ($1, $2, $3, $4, 'api.intent.unpaid', 'APPLIED', false, $5, $6, $7, $8, $8, 'PROVIDER_API')`,
        [after.id, input.provider, `api:intent.released:${after.id}`, row.provider_reference ?? null, after.amountPaise,
          after.currency, input.providerEvidenceDigest, occurredAt],
      );
      await tx.sql.query(
        `INSERT INTO public.payment_events
           (payment_id, event_type, from_status, to_status, amount_paise, actor_id, actor_channel, reason, occurred_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [after.id, rule.eventType, before.status, after.status, after.amountPaise, input.actorId ?? null,
          context.actorChannel, reason, occurredAt],
      );
      await tx.appendAudit({
        ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
        actorChannel: context.actorChannel,
        action: "ONLINE_PAYMENT_RELEASED",
        resourceType: "Payment",
        resourceId: after.id,
        outcome: "SUCCEEDED",
        reasonCode: input.reason,
        metadata: { bookingId: ledger.booking.id, invoiceId: after.invoiceId, amountPaise: after.amountPaise, provider: input.provider },
        occurredAt: input.occurredAt,
      });
      await tx.appendOutbox({
        aggregateType: "Payment",
        aggregateId: after.id,
        eventType: "OnlinePaymentReleased",
        eventVersion: Number(afterRow.version),
        payload: { paymentId: after.id, bookingId: ledger.booking.id, invoiceId: after.invoiceId, reason: input.reason, status: after.status },
      });
      return Object.freeze({ released: true, status: after.status, payment: projectPaymentRecord(after, ledger.booking) });
    }, PROVIDER_EVENT_RETRY_CODES);
  }

  listRefundsForReconciliation(
    input: Readonly<{ requestedBefore: Date; limit: number }>,
    context: PaymentRequestContext,
  ): Promise<readonly RefundSubmissionSource[]> {
    return withTransaction(this.pool, async (sql) => {
      const result = await sql.query<RefundRow>(
        `SELECT ${REFUND_COLUMNS}, i.booking_id FROM public.payment_refunds r
         JOIN public.payments p ON p.id = r.payment_id JOIN public.invoices i ON i.id = p.invoice_id
         WHERE r.status IN ('REQUESTED', 'SUBMITTED') AND r.requested_at < $1
         ORDER BY r.checked_at NULLS FIRST, r.requested_at, r.id
         LIMIT $2`,
        [input.requestedBefore.toISOString(), input.limit],
      );
      return Object.freeze(result.rows.map((row) => toRefundSource(row, String(row.booking_id))));
    }, { isolation: "REPEATABLE READ", readOnly: true, correlationId: context.correlationId });
  }

  markRefundChecked(refundId: string, checkedAt: Date, context: PaymentRequestContext): Promise<void> {
    return withTransaction(this.pool, async (sql) => {
      await sql.query(
        `UPDATE public.payment_refunds SET checked_at = $2 WHERE id = $1 AND status IN ('REQUESTED', 'SUBMITTED')`,
        [refundId, checkedAt.toISOString()],
      );
    }, { isolation: "READ COMMITTED", correlationId: context.correlationId });
  }

  // ---- Party-scoped payment history (task 16.2) ----

  listPaymentHistory(query: PaymentHistoryQuery, context: PaymentRequestContext): Promise<readonly PaymentHistoryRow[]> {
    const partyColumn = query.partyRole === "FARMER" ? "b.customer_id" : "b.owner_id";
    return withTransaction(this.pool, async (sql) => {
      const result = await sql.query<PaymentRow & {
        readonly created_at_cursor: string;
        readonly booking_id: string; readonly public_reference: string; readonly booking_status: BookingStatus;
        readonly customer_id: string; readonly owner_id: string; readonly booking_version: number;
        readonly invoice_version: number; readonly invoice_total_paise: string | number;
        readonly invoice_applied_paise: string | number;
      }>(
        `SELECT ${PAYMENT_COLUMNS.split(",").map((column) => `p.${column.trim()}`).join(", ")},
           ${CURSOR_INSTANT_SQL} AS created_at_cursor,
           b.id AS booking_id, b.public_reference, b.status AS booking_status, b.customer_id, b.owner_id,
           b.version AS booking_version, i.invoice_version, i.total_paise AS invoice_total_paise,
           (SELECT COALESCE(sum(q.amount_paise), 0) FROM public.payments q
             WHERE q.invoice_id = p.invoice_id AND q.status IN ('PAID_CASH', 'PAID_ONLINE', 'REFUND_PENDING')) AS invoice_applied_paise
         FROM public.payments p
         JOIN public.invoices i ON i.id = p.invoice_id
         JOIN public.bookings b ON b.id = i.booking_id
         WHERE ${partyColumn} = $1
           AND ($2::timestamptz IS NULL OR (p.created_at, p.id) < ($2::timestamptz, $3::uuid))
         ORDER BY p.created_at DESC, p.id DESC
         LIMIT $4`,
        [query.partyId, query.after?.createdAt ?? null, query.after?.id ?? null, query.limit],
      );
      return Object.freeze(result.rows.map((row): PaymentHistoryRow => Object.freeze({
        payment: toPayment(row),
        booking: Object.freeze({
          id: row.booking_id, reference: row.public_reference, customerId: row.customer_id, ownerId: row.owner_id,
          status: row.booking_status, version: Number(row.booking_version),
        }),
        invoiceVersion: Number(row.invoice_version),
        invoiceTotalPaise: safePaise(row.invoice_total_paise, "invoice total"),
        invoiceAppliedPaise: safePaise(row.invoice_applied_paise, "applied amount"),
        cursorCreatedAt: row.created_at_cursor,
      })));
    }, { isolation: "REPEATABLE READ", readOnly: true, correlationId: context.correlationId });
  }

  // ---- Provider evidence ----

  async #recordPaymentEvidence(tx: DomainTransaction, input: VerifiedProviderEventRecord): Promise<ProviderEventOutcome> {
    const located = input.providerReference === undefined ? undefined : (await tx.sql.query<{ readonly id: string }>(
      `SELECT p.id FROM public.payments p WHERE p.provider = $1 AND p.provider_reference = $2`,
      [input.provider, input.providerReference],
    )).rows[0];
    const ledger = located === undefined ? undefined : await this.#lockLedgerForPayment(tx.sql, located.id);
    const target = ledger?.rows.find((row) => row.id === located?.id);
    const payment = target === undefined ? undefined : toPayment(target);
    const booking = ledger?.booking;
    const invoice = ledger?.invoice;

    let lateConfirmationCapacityPaise: number | undefined;
    if (payment?.status === "PAYMENT_FAILED" && input.kind === "PAYMENT_CONFIRMED" && ledger !== undefined) {
      const current = await this.#loadCurrentInvoice(tx.sql, ledger.booking.id);
      const currentInvoice = current?.id === ledger.invoice.id;
      lateConfirmationCapacityPaise = lateConfirmationCapacity(
        toPayableInvoice(ledger.invoice, !currentInvoice),
        ledger.rows.map((row) => toLedgerEntry(toPayment(row))),
        payment.id,
        {
          currentInvoice,
          bookingPayable: PAYABLE_BOOKING_STATUSES.has(ledger.booking.status),
          disputed: ledger.booking.status === "DISPUTED",
        },
      );
    }
    const decision = evaluateProviderPaymentEvent(payment === undefined ? undefined : {
      method: payment.method,
      status: payment.status,
      amountPaise: payment.amountPaise,
      currency: payment.currency,
      ...(target?.provider_reference ? { providerReference: target.provider_reference } : {}),
      ...(target?.provider_payment_id ? { providerPaymentId: target.provider_payment_id } : {}),
    }, input, lateConfirmationCapacityPaise === undefined ? {} : { lateConfirmationCapacityPaise });

    const receivedAt = input.receivedAt.toISOString();
    const providerEventRecordId = await this.#insertProviderEvent(tx.sql, input, {
      paymentId: payment?.id,
      status: decision.outcome === "APPLY" ? "APPLIED" : decision.outcome === "REJECT" ? "REJECTED" : "VERIFIED",
    });

    if (decision.outcome === "REJECT") {
      await tx.appendAudit({
        actorChannel: "PROVIDER",
        action: "PROVIDER_PAYMENT_EVENT_REJECTED",
        resourceType: "ProviderEvent",
        resourceId: providerEventRecordId,
        outcome: "REJECTED",
        reasonCode: decision.code,
        metadata: {
          provider: input.provider,
          providerEventType: input.eventType,
          kind: input.kind,
          evidenceSource: input.evidenceSource ?? "WEBHOOK",
          ...(payment === undefined ? {} : { paymentId: payment.id, paymentStatus: payment.status }),
          ...(booking === undefined ? {} : { bookingId: booking.id }),
        },
        occurredAt: input.receivedAt,
      });
      return Object.freeze({
        disposition: "REJECTED",
        rejectionCode: decision.code,
        ...(payment === undefined ? {} : { paymentId: payment.id, paymentStatus: payment.status }),
      });
    }
    if (decision.outcome === "RECORD_ONLY" || payment === undefined || booking === undefined || invoice === undefined
      || ledger === undefined || target === undefined) {
      return Object.freeze({
        disposition: "RECORDED",
        ...(payment === undefined ? {} : { paymentId: payment.id, paymentStatus: payment.status }),
      });
    }

    const confirmed = decision.toStatus === "PAID_ONLINE";
    const updated = await tx.sql.query<PaymentRow>(
      `UPDATE public.payments SET status = $2, verified_at = COALESCE($3::timestamptz, verified_at),
         provider_payment_id = COALESCE(provider_payment_id, $6::text),
         version = version + 1, updated_at = $4
       WHERE id = $1 AND version = $5 AND status = $7
       RETURNING ${PAYMENT_COLUMNS}`,
      [payment.id, decision.toStatus, confirmed ? receivedAt : null, receivedAt, Number(target.version),
        confirmed ? input.providerPaymentId ?? null : null, payment.status],
    );
    const afterRow = updated.rows[0];
    if (afterRow === undefined) throw new PaymentConflictError("PAYMENT_CONFLICT", "The payment changed; the provider event will be retried");
    const after = toPayment(afterRow);
    await tx.sql.query(
      `INSERT INTO public.payment_events
         (payment_id, event_type, from_status, to_status, amount_paise, actor_id, actor_channel, reason, occurred_at)
       VALUES ($1, $2, $3, $4, $5, NULL, 'PROVIDER', $6, $7)`,
      [after.id, decision.eventType, payment.status, after.status, after.amountPaise, decision.reason ?? null, receivedAt],
    );

    const ledgerAfter = ledger.rows.map((row) => row.id === after.id ? after : toPayment(row));
    const current = await this.#loadCurrentInvoice(tx.sql, booking.id);
    const superseded = current?.id !== invoice.id;
    const disputed = booking.status === "DISPUTED";
    const settlement = summarizeInvoiceSettlement(toPayableInvoice(invoice, superseded),
      ledgerAfter.map(toLedgerEntry), { disputed });
    let bookingAfter = booking;
    // Settlement moves the booking only for its current, undisputed bill, exactly as cash does.
    if (confirmed && !superseded && !disputed) {
      if (bookingAfter.status === "FINAL_BILL_GENERATED") {
        bookingAfter = await this.#bookingTransition(tx, bookingAfter, "RECORD_PAYMENT", "SYSTEM", input.receivedAt);
      }
      if (settlement.settled && bookingAfter.status === "PAYMENT_RECORDED") {
        bookingAfter = await this.#bookingTransition(tx, bookingAfter, "COMPLETE", "SYSTEM", input.receivedAt);
      }
    }
    await tx.appendAudit({
      actorChannel: "PROVIDER",
      action: decision.eventType,
      resourceType: "Payment",
      resourceId: after.id,
      outcome: "SUCCEEDED",
      metadata: {
        bookingId: booking.id,
        invoiceId: invoice.id,
        provider: input.provider,
        providerEventRecordId,
        evidenceSource: input.evidenceSource ?? "WEBHOOK",
        fromStatus: payment.status,
        toStatus: after.status,
        amountPaise: after.amountPaise,
        settled: settlement.settled,
        bookingStatusBefore: booking.status,
        bookingStatusAfter: bookingAfter.status,
      },
      occurredAt: input.receivedAt,
    });
    await tx.appendOutbox({
      aggregateType: "Payment",
      aggregateId: after.id,
      eventType: confirmed ? "OnlinePaymentConfirmed" : "OnlinePaymentFailed",
      eventVersion: Number(afterRow.version),
      payload: {
        paymentId: after.id,
        bookingId: booking.id,
        invoiceId: invoice.id,
        method: after.method,
        status: after.status,
        amountPaise: after.amountPaise,
        settled: settlement.settled,
        lateConfirmation: payment.status === "PAYMENT_FAILED",
      },
    });
    return Object.freeze({ disposition: "APPLIED", paymentId: after.id, paymentStatus: after.status });
  }

  /**
   * Refund evidence: finds the platform's refund request (by its id, the provider refund id, or the
   * refund key the provider echoes back), locks booking, ledger, and refund in that order, and lets
   * the domain decide. A processed refund moves the payment to refunded and, once nothing applied
   * remains on the current bill, the booking from refund-pending to refunded.
   */
  async #recordRefundEvidence(tx: DomainTransaction, input: VerifiedProviderEventRecord): Promise<ProviderEventOutcome> {
    const findRefund = async (clause: string, values: readonly unknown[]): Promise<RefundRow | undefined> =>
      (await tx.sql.query<RefundRow>(`SELECT ${REFUND_COLUMNS} FROM public.payment_refunds r WHERE ${clause}`, values)).rows[0];
    let refundRow = input.paymentRefundId !== undefined
      ? await findRefund("r.id = $1 AND r.provider = $2", [input.paymentRefundId, input.provider]) : undefined;
    if (refundRow === undefined && input.providerRefundId !== undefined) {
      refundRow = await findRefund("r.provider = $1 AND r.provider_refund_id = $2", [input.provider, input.providerRefundId]);
    }
    if (refundRow === undefined && input.refundKey !== undefined) {
      refundRow = await findRefund("r.provider = $1 AND r.refund_key = $2", [input.provider, input.refundKey]);
    }
    const paymentId = refundRow?.payment_id ?? (input.providerPaymentId === undefined ? undefined : (await tx.sql.query<{ readonly id: string }>(
      `SELECT id FROM public.payments WHERE provider = $1 AND provider_payment_id = $2`,
      [input.provider, input.providerPaymentId],
    )).rows[0]?.id);
    const ledger = paymentId === undefined ? undefined : await this.#lockLedgerForPayment(tx.sql, paymentId);
    const target = ledger?.rows.find((row) => row.id === paymentId);
    if (refundRow !== undefined) {
      refundRow = await findRefund("r.id = $1 FOR UPDATE", [refundRow.id]);
    }
    const payment = target === undefined ? undefined : toPayment(target);
    const decision = evaluateProviderRefundEvent(refundRow === undefined || payment === undefined ? undefined : {
      status: refundRow.status,
      amountPaise: safePaise(refundRow.amount_paise, "refund amount"),
      currency: refundRow.currency.trim(),
      providerPaymentId: refundRow.provider_payment_id,
      ...(refundRow.provider_refund_id === null ? {} : { providerRefundId: refundRow.provider_refund_id }),
      payment: { method: payment.method, status: payment.status },
    }, input);

    const informational = !isRefundEventKind(input.kind);
    const providerEventRecordId = await this.#insertProviderEvent(tx.sql, input, {
      paymentId: payment?.id,
      refundId: refundRow?.id,
      status: decision.outcome === "APPLY" ? "APPLIED" : decision.outcome === "REJECT" && !informational ? "REJECTED" : "VERIFIED",
    });
    const receivedAt = input.receivedAt.toISOString();

    if (decision.outcome === "REJECT" && !informational) {
      await tx.appendAudit({
        actorChannel: "PROVIDER",
        action: "PROVIDER_REFUND_EVENT_REJECTED",
        resourceType: "ProviderEvent",
        resourceId: providerEventRecordId,
        outcome: "REJECTED",
        reasonCode: decision.code,
        metadata: {
          provider: input.provider,
          providerEventType: input.eventType,
          kind: input.kind,
          evidenceSource: input.evidenceSource ?? "WEBHOOK",
          ...(refundRow === undefined ? {} : { refundId: refundRow.id, refundStatus: refundRow.status }),
          ...(payment === undefined ? {} : { paymentId: payment.id, paymentStatus: payment.status }),
          ...(ledger === undefined ? {} : { bookingId: ledger.booking.id }),
        },
        occurredAt: input.receivedAt,
      });
      return Object.freeze({
        disposition: "REJECTED",
        rejectionCode: decision.code,
        ...(payment === undefined ? {} : { paymentId: payment.id, paymentStatus: payment.status }),
        ...(refundRow === undefined ? {} : { refundId: refundRow.id, refundStatus: refundRow.status }),
      });
    }
    if (decision.outcome !== "APPLY" || refundRow === undefined || payment === undefined || ledger === undefined || target === undefined) {
      // Link a requested refund to the provider's refund id the first time the provider names it.
      if (refundRow !== undefined && refundRow.provider_refund_id === null && input.providerRefundId !== undefined
        && (refundRow.status === "REQUESTED" || refundRow.status === "SUBMITTED")
        && input.providerPaymentId === refundRow.provider_payment_id) {
        await tx.sql.query(
          `UPDATE public.payment_refunds SET provider_refund_id = $2, status = 'SUBMITTED',
             submitted_at = COALESCE(submitted_at, $3), updated_at = $3, version = version + 1
           WHERE id = $1 AND provider_refund_id IS NULL`,
          [refundRow.id, input.providerRefundId, receivedAt],
        );
      }
      return Object.freeze({
        disposition: "RECORDED",
        ...(payment === undefined ? {} : { paymentId: payment.id, paymentStatus: payment.status }),
        ...(refundRow === undefined ? {} : { refundId: refundRow.id, refundStatus: refundRow.status }),
      });
    }

    const refundUpdated = await tx.sql.query<RefundRow>(
      `UPDATE public.payment_refunds AS r SET status = $2, provider_refund_id = COALESCE(r.provider_refund_id, $3::text),
         resolved_at = $4, updated_at = $4, version = r.version + 1
       WHERE r.id = $1 AND r.status IN ('REQUESTED', 'SUBMITTED')
       RETURNING ${REFUND_COLUMNS}`,
      [refundRow.id, decision.refundStatus, input.providerRefundId ?? null, receivedAt],
    );
    if (refundUpdated.rows[0] === undefined) {
      throw new PaymentConflictError("PAYMENT_CONFLICT", "The refund changed; the provider event will be retried");
    }
    const updated = await tx.sql.query<PaymentRow>(
      `UPDATE public.payments SET status = $2, version = version + 1, updated_at = $3
       WHERE id = $1 AND version = $4 AND status = 'REFUND_PENDING'
       RETURNING ${PAYMENT_COLUMNS}`,
      [payment.id, decision.paymentStatus, receivedAt, Number(target.version)],
    );
    const afterRow = updated.rows[0];
    if (afterRow === undefined) throw new PaymentConflictError("PAYMENT_CONFLICT", "The payment changed; the provider event will be retried");
    const after = toPayment(afterRow);
    await tx.sql.query(
      `INSERT INTO public.payment_events
         (payment_id, event_type, from_status, to_status, amount_paise, actor_id, actor_channel, reason, occurred_at)
       VALUES ($1, $2, $3, $4, $5, NULL, 'PROVIDER', $6, $7)`,
      [after.id, decision.eventType, payment.status, after.status, after.amountPaise,
        decision.refundStatus === "FAILED" ? "The payment provider could not process the refund" : null, receivedAt],
    );

    const processed = decision.refundStatus === "PROCESSED";
    let bookingAfter = ledger.booking;
    const current = await this.#loadCurrentInvoice(tx.sql, ledger.booking.id);
    if (processed && current?.id === ledger.invoice.id && bookingAfter.status === "REFUND_PENDING") {
      const ledgerAfter = ledger.rows.map((row) => row.id === after.id ? after : toPayment(row));
      const settlement = summarizeInvoiceSettlement(toPayableInvoice(ledger.invoice, false), ledgerAfter.map(toLedgerEntry),
        { disputed: false });
      // The booking is refunded once no applied money and no refund in progress remains on its bill.
      if (settlement.status === "REFUNDED") {
        bookingAfter = await this.#bookingTransition(tx, bookingAfter, "REFUND", "SYSTEM", input.receivedAt);
      }
    }
    await tx.appendAudit({
      actorChannel: "PROVIDER",
      action: decision.eventType,
      resourceType: "Payment",
      resourceId: after.id,
      outcome: processed ? "SUCCEEDED" : "FAILED",
      metadata: {
        bookingId: ledger.booking.id,
        invoiceId: ledger.invoice.id,
        refundId: refundRow.id,
        provider: input.provider,
        providerEventRecordId,
        evidenceSource: input.evidenceSource ?? "WEBHOOK",
        fromStatus: payment.status,
        toStatus: after.status,
        amountPaise: safePaise(refundRow.amount_paise, "refund amount"),
        bookingStatusBefore: ledger.booking.status,
        bookingStatusAfter: bookingAfter.status,
      },
      occurredAt: input.receivedAt,
    });
    await tx.appendOutbox({
      aggregateType: "Payment",
      aggregateId: after.id,
      eventType: processed ? "PaymentRefundProcessed" : "PaymentRefundFailed",
      eventVersion: Number(afterRow.version),
      payload: {
        paymentId: after.id,
        bookingId: ledger.booking.id,
        refundId: refundRow.id,
        amountPaise: safePaise(refundRow.amount_paise, "refund amount"),
        status: after.status,
      },
    });
    return Object.freeze({
      disposition: "APPLIED", paymentId: after.id, paymentStatus: after.status, refundId: refundRow.id,
      refundStatus: decision.refundStatus,
    });
  }

  async #insertProviderEvent(
    sql: SqlConnection,
    input: VerifiedProviderEventRecord,
    link: Readonly<{ paymentId?: string | undefined; refundId?: string | undefined; status: "APPLIED" | "REJECTED" | "VERIFIED" }>,
  ): Promise<string> {
    const receivedAt = input.receivedAt.toISOString();
    const source = input.evidenceSource ?? "WEBHOOK";
    const stored = await sql.query<{ readonly id: string }>(
      `INSERT INTO public.provider_events
         (payment_id, provider, provider_event_id, provider_reference, event_type, status, signature_verified,
          amount_paise, currency, payload_digest, occurred_at, received_at, applied_at, evidence_source, payment_refund_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       RETURNING id`,
      [link.paymentId ?? null, input.provider, input.providerEventId, input.providerReference ?? null, input.eventType,
        link.status, source === "WEBHOOK",
        input.amountPaise !== undefined && Number.isSafeInteger(input.amountPaise) && input.amountPaise >= 0 ? input.amountPaise : null,
        input.currency !== undefined && CURRENCY_CODE.test(input.currency) ? input.currency : null,
        input.payloadDigest, input.occurredAt?.toISOString() ?? null, receivedAt,
        link.status === "APPLIED" ? receivedAt : null, source, link.refundId ?? null],
    );
    const id = stored.rows[0]?.id;
    if (id === undefined) throw new Error("Provider event was not stored");
    return id;
  }

  // ---- Shared helpers ----

  #toIntent(row: PaymentRow, booking: PaymentBookingRecord): OnlineIntentRecord | undefined {
    if (row.method !== "ONLINE" || !row.provider || !row.provider_reference) return undefined;
    const payment = toPayment(row);
    return Object.freeze({
      paymentId: payment.id,
      invoiceId: payment.invoiceId,
      booking,
      provider: row.provider,
      providerReference: row.provider_reference,
      ...(row.provider_payment_id ? { providerPaymentId: row.provider_payment_id } : {}),
      status: payment.status,
      amountPaise: payment.amountPaise,
      currency: payment.currency,
      createdAt: payment.createdAt,
      payment,
    });
  }

  /** Locks the booking, then the payment's invoice ledger, in the order every payment write uses. */
  async #lockLedgerForPayment(sql: SqlConnection, paymentId: string): Promise<LockedLedger | undefined> {
    const located = await sql.query<{ readonly invoice_id: string; readonly booking_id: string }>(
      `SELECT p.invoice_id, i.booking_id FROM public.payments p JOIN public.invoices i ON i.id = p.invoice_id WHERE p.id = $1`,
      [paymentId],
    );
    const position = located.rows[0];
    if (position === undefined) return undefined;
    const booking = await this.#loadBooking(sql, position.booking_id, true);
    const invoiceResult = await sql.query<InvoiceRow>(`SELECT ${INVOICE_COLUMNS} FROM public.invoices WHERE id = $1`, [position.invoice_id]);
    const invoiceRow = invoiceResult.rows[0];
    if (booking === undefined || invoiceRow === undefined) return undefined;
    const rows = await this.#loadPayments(sql, position.invoice_id, true);
    return { booking, invoice: toInvoice(invoiceRow), rows };
  }

  /**
   * Validates a payment application against the current ledger and returns what applyPayment
   * needs. With `lock`, the booking and its invoice's payments are locked (booking first), which
   * serializes every write to one invoice's ledger.
   */
  async #evaluateApplication(
    sql: SqlConnection,
    input: ValidatedPaymentApplication,
    lock: boolean,
  ): Promise<EvaluatedApplication> {
    const booking = await this.#loadBooking(sql, input.bookingId, lock);
    if (booking === undefined) throw new PaymentNotFoundError();
    // Unrelated actors learn nothing about the booking's state, not even why it is not payable.
    const party = input.actorRole === "OWNER" ? booking.ownerId : input.actorRole === "FARMER" ? booking.customerId : undefined;
    if (party !== input.actorId) throw new PaymentNotFoundError();
    const disputed = booking.status === "DISPUTED";
    if (!disputed && !PAYABLE_BOOKING_STATUSES.has(booking.status)) {
      throw new PaymentConflictError("PAYMENT_BOOKING_NOT_PAYABLE",
        `A booking that is ${booking.status.toLowerCase().replaceAll("_", " ")} cannot receive payment`);
    }
    const invoice = await this.#loadCurrentInvoice(sql, booking.id);
    if (invoice !== undefined && invoice.id !== input.invoiceId) {
      throw new PaymentConflictError("PAYMENT_INVOICE_NOT_PAYABLE", "Only the current final bill can receive payment");
    }
    const paymentRows = invoice === undefined ? [] : await this.#loadPayments(sql, invoice.id, lock);
    const existing = paymentRows.map(toPayment);
    const decision = evaluatePaymentApplication(
      invoice === undefined ? undefined : toPayableInvoice(invoice, false),
      existing.map(toLedgerEntry),
      {
        method: input.method,
        amountPaise: input.amountPaise,
        currency: input.currency,
        actorId: input.actorId,
        actorRole: input.actorRole,
      },
      booking,
      { disputed },
    );
    // evaluatePaymentApplication refuses a missing invoice, so one exists here.
    return { booking, invoice: invoice!, existing, decision };
  }

  async #run<Result>(
    context: PaymentRequestContext,
    work: (tx: DomainTransaction) => Promise<Result>,
    alsoRetry?: ReadonlySet<string>,
  ): Promise<Result> {
    try {
      // Each attempt re-claims the idempotency key and re-reads the ledger from a fresh snapshot.
      return await retrySerializationFailures(() =>
        withDomainTransaction(this.pool, { isolation: "SERIALIZABLE", correlationId: context.correlationId }, work),
      alsoRetry === undefined ? {} : { alsoRetry });
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
      if (code === "40001") {
        throw new PaymentConflictError("PAYMENT_CONFLICT", "The bill changed concurrently; refresh and retry safely");
      }
      throw error;
    }
  }

  /** Claims an idempotency key; returns the stored response of a completed request with the same digest. */
  async #claimIdempotency(
    sql: SqlConnection,
    scope: string,
    idempotencyKey: string,
    requestDigest: string,
    occurredAt: Date,
    reusedMessage: string,
  ): Promise<unknown | undefined> {
    await sql.query(
      `INSERT INTO public.idempotency_records (actor_scope, idempotency_key, request_digest, expires_at)
       VALUES ($1, $2, $3, $4) ON CONFLICT (actor_scope, idempotency_key) DO NOTHING`,
      [scope, idempotencyKey, requestDigest, new Date(occurredAt.getTime() + this.idempotencyTtlMs).toISOString()],
    );
    const result = await sql.query<IdempotencyRow>(
      `SELECT request_digest, status, response_body FROM public.idempotency_records
       WHERE actor_scope = $1 AND idempotency_key = $2 FOR UPDATE`,
      [scope, idempotencyKey],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error("Unable to claim payment idempotency key");
    if (row.request_digest !== requestDigest) throw new PaymentConflictError("IDEMPOTENCY_KEY_REUSED", reusedMessage);
    return row.status === "COMPLETED" ? row.response_body : undefined;
  }

  async #completeIdempotency(
    sql: SqlConnection,
    scope: string,
    idempotencyKey: string,
    result: unknown,
    resourceType: string,
    resourceId: string,
  ): Promise<void> {
    await sql.query(
      `UPDATE public.idempotency_records SET status = 'COMPLETED', response_status = 200,
         response_body = $3::jsonb, resource_type = $5, resource_id = $4, updated_at = CURRENT_TIMESTAMP
       WHERE actor_scope = $1 AND idempotency_key = $2`,
      [scope, idempotencyKey, JSON.stringify(result), resourceId, resourceType],
    );
  }

  async #loadBooking(sql: SqlConnection, bookingId: string, forUpdate: boolean): Promise<PaymentBookingRecord | undefined> {
    const result = await sql.query<BookingRow>(
      `SELECT ${BOOKING_COLUMNS} FROM public.bookings WHERE id = $1${forUpdate ? " FOR UPDATE" : ""}`,
      [bookingId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : toBooking(row);
  }

  async #loadCurrentInvoice(sql: SqlConnection, bookingId: string): Promise<PaymentInvoiceRecord | undefined> {
    const result = await sql.query<InvoiceRow>(
      `SELECT ${INVOICE_COLUMNS} FROM public.invoices WHERE booking_id = $1 ORDER BY invoice_version DESC LIMIT 1`,
      [bookingId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : toInvoice(row);
  }

  async #loadPayments(sql: SqlConnection, invoiceId: string, forUpdate: boolean): Promise<readonly PaymentRow[]> {
    const result = await sql.query<PaymentRow>(
      `SELECT ${PAYMENT_COLUMNS} FROM public.payments WHERE invoice_id = $1 ORDER BY created_at, id${forUpdate ? " FOR UPDATE" : ""}`,
      [invoiceId],
    );
    return result.rows;
  }

  /**
   * Applies a booking transition from the shared lifecycle table on behalf of payment records:
   * FINAL_BILL_GENERATED → PAYMENT_RECORDED on the first applied payment, PAYMENT_RECORDED →
   * COMPLETED on settlement, DISPUTED → REFUND_PENDING when support requests a refund, and
   * REFUND_PENDING → REFUNDED once every applied payment on the bill is refunded.
   */
  async #bookingTransition(
    tx: DomainTransaction,
    booking: PaymentBookingRecord,
    action: Extract<BookingLifecycleAction, "RECORD_PAYMENT" | "COMPLETE" | "REQUEST_REFUND" | "REFUND">,
    role: BookingLifecycleActorRole,
    occurredAt: Date,
    actorId?: string,
    reason?: string,
  ): Promise<PaymentBookingRecord> {
    const rule = bookingTransitionRule(booking.status, action, role);
    if (rule === undefined) {
      throw new PaymentConflictError("PAYMENT_BOOKING_NOT_PAYABLE",
        action === "COMPLETE" ? "The booking cannot be completed"
          : action === "RECORD_PAYMENT" ? "The booking cannot record payment" : "The booking cannot move to its refund state");
    }
    const updated = await tx.sql.query<{ readonly version: number }>(
      `UPDATE public.bookings SET status = $2, version = version + 1, updated_at = $3
       WHERE id = $1 AND version = $4 RETURNING version`,
      [booking.id, rule.to, occurredAt.toISOString(), booking.version],
    );
    const version = updated.rows[0]?.version;
    if (version === undefined) throw new PaymentConflictError("PAYMENT_CONFLICT", "The booking changed; refresh and retry");
    if (reason === undefined) {
      await tx.sql.query(
        `INSERT INTO public.booking_status_history
           (booking_id, from_status, to_status, actor_id, actor_channel, occurred_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [booking.id, booking.status, rule.to, actorId ?? null, "SYSTEM", occurredAt.toISOString()],
      );
    } else {
      await tx.sql.query(
        `INSERT INTO public.booking_status_history
           (booking_id, from_status, to_status, actor_id, actor_channel, reason, occurred_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [booking.id, booking.status, rule.to, actorId ?? null, role === "SUPPORT" ? "OPERATOR" : "SYSTEM", reason,
          occurredAt.toISOString()],
      );
    }
    await tx.appendOutbox({
      aggregateType: "Booking",
      aggregateId: booking.id,
      eventType: bookingTransitionEventType(rule.to),
      eventVersion: Number(version),
      payload: { bookingId: booking.id, fromStatus: booking.status, toStatus: rule.to },
    });
    return Object.freeze({ ...booking, status: rule.to, version: Number(version) });
  }
}
