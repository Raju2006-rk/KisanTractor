import { appliedPaymentStatuses, reservedPaymentStatuses } from "@kisantractor/domain";
import {
  withDomainTransaction,
  withTransaction,
  writeAuditEvent,
  type AuditEventInput,
  type DomainTransaction,
  type SqlConnection,
  type SqlPool,
} from "@kisantractor/database";

import { bookingTransitionEventType, bookingTransitionRule } from "../booking/booking-lifecycle.js";
import type { BookingStatus } from "../booking/booking.contracts.js";
import { retrySerializationFailures } from "../serialization-retry.js";
import {
  decideResolution,
  SUPPORT_RESOLUTION_RULES_VERSION,
  SupportConflictError,
  SupportNotFoundError,
  SupportRuleError,
  type DisputePartyRole,
  type RefundablePayment,
  type ResolutionFacts,
  type SupportAuthorRole,
  type SupportCaseEntryProjection,
  type SupportCaseProjection,
  type SupportCaseStatus,
  type SupportCaseSummary,
  type SupportEntryType,
  type SupportEvidenceKind,
  type SupportEvidenceReference,
  type SupportGrantScope,
  type SupportRequestContext,
  type SupportResolutionOutcome,
} from "./support.contracts.js";

/** Who is reading a case: support sees every statement; a party sees its own statement text only. */
export type SupportCaseViewer =
  | { readonly kind: "SUPPORT"; readonly grantExpiresAt?: Date }
  | { readonly kind: "PARTY"; readonly userId: string };

export interface SupportCaseAccessRecord {
  readonly id: string;
  readonly bookingId: string;
  readonly customerId: string;
  readonly ownerId: string;
  readonly status: SupportCaseStatus;
}

export interface AppendSupportEntryInput {
  readonly caseId: string;
  readonly expectedVersion: number;
  readonly entryType: Extract<SupportEntryType, "PARTY_STATEMENT" | "SUPPORT_NOTE">;
  readonly authorRole: Exclude<SupportAuthorRole, "SYSTEM">;
  readonly authorUserId: string;
  readonly statementCode: string;
  readonly statementText?: string;
  readonly evidence?: SupportEvidenceReference;
  readonly idempotencyKey: string;
  readonly requestDigest: string;
  readonly occurredAt: Date;
}

export interface ResolveSupportCaseInput {
  readonly caseId: string;
  readonly expectedVersion: number;
  /** Required except for REFUND, whose booking version the refund itself advanced. */
  readonly expectedBookingVersion?: number;
  readonly outcome: SupportResolutionOutcome;
  readonly reasonCode: string;
  readonly actorId: string;
  /** REFUND only: the refund PaymentRefundService recorded for this resolution. */
  readonly paymentRefundId?: string;
  readonly idempotencyKey: string;
  readonly requestDigest: string;
  readonly occurredAt: Date;
}

export interface SupportCaseStore {
  findCaseAccess(caseId: string): Promise<SupportCaseAccessRecord | undefined>;
  /** The latest case of a booking, only when the viewer is its Farmer or Owner. */
  findPartyCase(bookingId: string, partyRole: DisputePartyRole, userId: string): Promise<SupportCaseAccessRecord | undefined>;
  listOperatorCases(operatorId: string, now: Date): Promise<readonly SupportCaseSummary[]>;
  operatorGrantExpiry(operatorId: string, caseId: string, now: Date): Promise<Date | undefined>;
  readCase(caseId: string, viewer: SupportCaseViewer): Promise<SupportCaseProjection>;
  readResolutionFacts(caseId: string): Promise<ResolutionFacts>;
  appendEntry(input: AppendSupportEntryInput, context: SupportRequestContext): Promise<void>;
  resolveCase(input: ResolveSupportCaseInput, context: SupportRequestContext): Promise<void>;
  audit(event: Omit<AuditEventInput, "correlationId">, context: SupportRequestContext): Promise<void>;
}

interface CaseRow extends Record<string, unknown> {
  readonly id: string;
  readonly booking_id: string;
  readonly disputed_invoice_id: string;
  readonly status: SupportCaseStatus;
  readonly opened_at: Date;
  readonly resolution_outcome: SupportResolutionOutcome | null;
  readonly resolution_rules_version: number | null;
  readonly resolution_reason_code: string | null;
  readonly resolved_invoice_id: string | null;
  readonly payment_refund_id: string | null;
  readonly resolved_at: Date | null;
  readonly version: number;
  readonly public_reference: string;
  readonly booking_status: BookingStatus;
  readonly booking_version: number;
  readonly customer_id: string;
  readonly owner_id: string;
  readonly disputed_invoice_version: number;
}

interface InvoiceRow extends Record<string, unknown> {
  readonly id: string;
  readonly invoice_version: number;
  readonly total_paise: string | number;
}

interface PaymentRow extends Record<string, unknown> {
  readonly id: string;
  readonly invoice_id: string;
  readonly method: "CASH" | "ONLINE";
  readonly status: string;
  readonly amount_paise: string | number;
}

interface EntryRow extends Record<string, unknown> {
  readonly id: string;
  readonly entry_type: SupportEntryType;
  readonly author_role: SupportAuthorRole;
  readonly author_user_id: string | null;
  readonly statement_code: string;
  readonly statement_text: string | null;
  readonly statement_redacted_at: Date | null;
  readonly evidence_kind: SupportEvidenceKind | null;
  readonly evidence_id: string | null;
  readonly occurred_at: Date;
}

interface IdempotencyRow extends Record<string, unknown> {
  readonly request_digest: string;
  readonly status: string;
}

const CASE_SELECT = `SELECT c.id, c.booking_id, c.disputed_invoice_id, c.status, c.opened_at, c.resolution_outcome,
    c.resolution_rules_version, c.resolution_reason_code, c.resolved_invoice_id, c.payment_refund_id, c.resolved_at,
    c.version, b.public_reference, b.status AS booking_status, b.version AS booking_version, b.customer_id, b.owner_id,
    di.invoice_version AS disputed_invoice_version
  FROM public.support_cases c
  JOIN public.bookings b ON b.id = c.booking_id
  JOIN public.invoices di ON di.id = c.disputed_invoice_id`;

const EVIDENCE_QUERIES: Readonly<Record<SupportEvidenceKind, string>> = Object.freeze({
  INVOICE: "SELECT 1 FROM public.invoices WHERE id = $1::uuid AND booking_id = $2::uuid",
  WORK_EVENT: "SELECT 1 FROM public.work_events WHERE id = $1::uuid AND booking_id = $2::uuid",
  WORK_MEASUREMENT: "SELECT 1 FROM public.work_measurements WHERE id = $1::uuid AND booking_id = $2::uuid",
  PAYMENT: `SELECT 1 FROM public.payments p JOIN public.invoices i ON i.id = p.invoice_id
            WHERE p.id = $1::uuid AND i.booking_id = $2::uuid`,
});

const toAccess = (row: CaseRow): SupportCaseAccessRecord => Object.freeze({
  id: row.id, bookingId: row.booking_id, customerId: row.customer_id, ownerId: row.owner_id, status: row.status,
});

const isApplied = (status: string): boolean => (appliedPaymentStatuses as readonly string[]).includes(status);
const isReserved = (status: string): boolean => (reservedPaymentStatuses as readonly string[]).includes(status);

const scopeFor = (actorId: string, caseId: string, operation: "entry" | "resolve"): string =>
  `support-case:${actorId}:${caseId}:${operation}`;

/**
 * Support cases, their timelines, and resolutions (task 16.5). Every write runs in one
 * SERIALIZABLE transaction with an idempotency claim, an optimistic case version, a PII-free audit
 * event, and outbox events for notifications. Statement text never enters audit or outbox payloads.
 */
export class PostgresSupportCaseStore implements SupportCaseStore {
  constructor(
    private readonly pool: SqlPool,
    private readonly idempotencyTtlMs = 24 * 60 * 60 * 1_000,
  ) {}

  async findCaseAccess(caseId: string): Promise<SupportCaseAccessRecord | undefined> {
    const row = (await this.pool.query<CaseRow>(`${CASE_SELECT} WHERE c.id = $1::uuid`, [caseId])).rows[0];
    return row === undefined ? undefined : toAccess(row);
  }

  async findPartyCase(bookingId: string, partyRole: DisputePartyRole, userId: string): Promise<SupportCaseAccessRecord | undefined> {
    const column = partyRole === "FARMER" ? "b.customer_id" : "b.owner_id";
    const row = (await this.pool.query<CaseRow>(
      `${CASE_SELECT} WHERE c.booking_id = $1::uuid AND ${column} = $2::uuid
       ORDER BY c.opened_at DESC, c.id DESC LIMIT 1`, [bookingId, userId])).rows[0];
    return row === undefined ? undefined : toAccess(row);
  }

  async listOperatorCases(operatorId: string, now: Date): Promise<readonly SupportCaseSummary[]> {
    const result = await this.pool.query<CaseRow & { readonly scope: SupportGrantScope; readonly expires_at: Date }>(
      `SELECT DISTINCT ON (c.id) c.id, c.booking_id, c.status, c.opened_at, b.public_reference,
         b.status AS booking_status, g.scope, g.expires_at
       FROM public.support_access_grants g
       JOIN public.support_cases c ON c.id = g.case_id
       JOIN public.bookings b ON b.id = c.booking_id
       WHERE g.operator_user_id = $1::uuid AND g.revoked_at IS NULL
         AND g.valid_from <= $2::timestamptz AND g.expires_at > $2::timestamptz
       ORDER BY c.id, g.expires_at DESC
       LIMIT 200`, [operatorId, now.toISOString()]);
    return Object.freeze(result.rows
      .map((row) => Object.freeze({
        id: row.id, bookingId: row.booking_id, bookingReference: row.public_reference, bookingStatus: row.booking_status,
        status: row.status, openedAt: row.opened_at, grantScope: row.scope, grantExpiresAt: row.expires_at,
      }))
      .sort((left, right) => left.openedAt.getTime() - right.openedAt.getTime() || left.id.localeCompare(right.id)));
  }

  async operatorGrantExpiry(operatorId: string, caseId: string, now: Date): Promise<Date | undefined> {
    const result = await this.pool.query<{ readonly expires_at: Date }>(
      `SELECT max(expires_at) AS expires_at FROM public.support_access_grants
       WHERE operator_user_id = $1::uuid AND case_id = $2::uuid AND revoked_at IS NULL
         AND valid_from <= $3::timestamptz AND expires_at > $3::timestamptz`,
      [operatorId, caseId, now.toISOString()]);
    return result.rows[0]?.expires_at ?? undefined;
  }

  readCase(caseId: string, viewer: SupportCaseViewer): Promise<SupportCaseProjection> {
    return withTransaction(this.pool, (sql) => this.#project(sql, caseId, viewer), { isolation: "REPEATABLE READ" });
  }

  readResolutionFacts(caseId: string): Promise<ResolutionFacts> {
    return withTransaction(this.pool, async (sql) => {
      const row = await this.#loadCase(sql, caseId, false);
      return this.#facts(sql, row);
    }, { isolation: "REPEATABLE READ" });
  }

  async audit(event: Omit<AuditEventInput, "correlationId">, context: SupportRequestContext): Promise<void> {
    await writeAuditEvent(this.pool, { ...event, correlationId: context.correlationId });
  }

  appendEntry(input: AppendSupportEntryInput, context: SupportRequestContext): Promise<void> {
    return this.#run(context, async (tx) => {
      const scope = scopeFor(input.authorUserId, input.caseId, "entry");
      if (await this.#claim(tx.sql, scope, input.idempotencyKey, input.requestDigest, input.occurredAt)) return;
      const row = await this.#loadCase(tx.sql, input.caseId, true);
      if (row.status !== "OPEN") throw new SupportConflictError("CASE_CLOSED", "The case is resolved and accepts no more entries");
      if (row.version !== input.expectedVersion) {
        throw new SupportConflictError("VERSION_CONFLICT", `Case version conflict: current version is ${row.version}`);
      }
      if (input.evidence !== undefined) await this.#assertEvidence(tx.sql, input.evidence, row.booking_id);
      const inserted = await tx.sql.query<{ readonly id: string }>(
        `INSERT INTO public.support_case_entries
           (case_id, entry_type, author_role, author_user_id, statement_code, statement_text, evidence_kind, evidence_id, occurred_at)
         VALUES ($1::uuid, $2, $3, $4::uuid, $5, $6::text, $7::text, $8::uuid, $9::timestamptz) RETURNING id`,
        [row.id, input.entryType, input.authorRole, input.authorUserId, input.statementCode, input.statementText ?? null,
          input.evidence?.kind ?? null, input.evidence?.id ?? null, input.occurredAt.toISOString()]);
      await this.#bumpCase(tx.sql, row, input.occurredAt);
      await tx.appendAudit({
        actorId: input.authorUserId,
        actorChannel: context.actorChannel,
        action: input.entryType === "SUPPORT_NOTE" ? "support.case.note" : "dispute.statement",
        resourceType: "SupportCase",
        resourceId: row.id,
        outcome: "SUCCEEDED",
        metadata: {
          bookingId: row.booking_id,
          entryId: inserted.rows[0]?.id ?? null,
          authorRole: input.authorRole,
          statementCode: input.statementCode,
          hasStatementText: input.statementText !== undefined,
          ...(input.evidence === undefined ? {} : { evidenceKind: input.evidence.kind, evidenceId: input.evidence.id }),
        },
        occurredAt: input.occurredAt,
      });
      await this.#complete(tx.sql, scope, input.idempotencyKey, row.id);
    });
  }

  resolveCase(input: ResolveSupportCaseInput, context: SupportRequestContext): Promise<void> {
    return this.#run(context, async (tx) => {
      const scope = scopeFor(input.actorId, input.caseId, "resolve");
      if (await this.#claim(tx.sql, scope, input.idempotencyKey, input.requestDigest, input.occurredAt)) return;
      const row = await this.#loadCase(tx.sql, input.caseId, true);
      if (row.status !== "OPEN") throw new SupportRuleError("CASE_NOT_OPEN", "The case is already resolved");
      if (row.version !== input.expectedVersion) {
        throw new SupportConflictError("VERSION_CONFLICT", `Case version conflict: current version is ${row.version}`);
      }
      const facts = await this.#facts(tx.sql, row);
      let bookingStatusAfter: BookingStatus = row.booking_status;

      if (input.outcome === "REFUND") {
        // PaymentRefundService already recorded the refund (and moved the booking to REFUND_PENDING).
        const refund = await tx.sql.query<{ readonly id: string }>(
          `SELECT r.id FROM public.payment_refunds r
           JOIN public.payments p ON p.id = r.payment_id JOIN public.invoices i ON i.id = p.invoice_id
           WHERE r.id = $1::uuid AND i.booking_id = $2::uuid AND r.status IN ('REQUESTED', 'SUBMITTED', 'PROCESSED')`,
          [input.paymentRefundId ?? null, row.booking_id]);
        if (refund.rows[0] === undefined || !["DISPUTED", "REFUND_PENDING", "REFUNDED"].includes(row.booking_status)) {
          throw new SupportRuleError("REFUND_NOT_AVAILABLE", "No refund of this booking's payment was recorded");
        }
      } else {
        if (input.expectedBookingVersion !== row.booking_version) {
          throw new SupportConflictError("VERSION_CONFLICT", `Booking version conflict: current version is ${row.booking_version}`);
        }
        const decision = decideResolution(input.outcome, facts);
        if (decision.kind !== "BOOKING_TRANSITION") throw new Error("Unexpected refund decision");
        const rule = bookingTransitionRule(row.booking_status, decision.action, "SUPPORT");
        if (rule === undefined || rule.to !== decision.to) {
          throw new SupportRuleError("BOOKING_NOT_DISPUTED", "The booking cannot take this resolution");
        }
        const updated = await tx.sql.query<{ readonly version: number }>(
          `UPDATE public.bookings SET status = $2, version = version + 1, updated_at = $3
           WHERE id = $1 AND version = $4 RETURNING version`,
          [row.booking_id, rule.to, input.occurredAt.toISOString(), row.booking_version]);
        const bookingVersion = updated.rows[0]?.version;
        if (bookingVersion === undefined) throw new SupportConflictError("VERSION_CONFLICT", "The booking changed; refresh and retry");
        await tx.sql.query(
          `INSERT INTO public.booking_status_history
             (booking_id, from_status, to_status, actor_id, actor_channel, reason, occurred_at)
           VALUES ($1, $2, $3, $4, 'OPERATOR', $5, $6)`,
          [row.booking_id, row.booking_status, rule.to, input.actorId, `DISPUTE_${input.outcome}:${input.reasonCode}`,
            input.occurredAt.toISOString()]);
        await tx.appendOutbox({
          aggregateType: "Booking",
          aggregateId: row.booking_id,
          eventType: bookingTransitionEventType(rule.to),
          eventVersion: Number(bookingVersion),
          payload: { bookingId: row.booking_id, fromStatus: row.booking_status, toStatus: rule.to },
        });
        bookingStatusAfter = rule.to;
      }

      const resolvedInvoiceId = input.outcome === "UPHOLD" || input.outcome === "ADJUST" ? facts.currentInvoiceId : null;
      const caseUpdated = await tx.sql.query<{ readonly version: number }>(
        `UPDATE public.support_cases SET status = 'RESOLVED', resolution_outcome = $2, resolution_rules_version = $3,
           resolution_reason_code = $4, resolved_invoice_id = $5::uuid, payment_refund_id = $6::uuid,
           resolved_by_user_id = $7::uuid, resolved_at = $8::timestamptz, version = version + 1, updated_at = $8::timestamptz
         WHERE id = $1::uuid AND version = $9 AND status = 'OPEN' RETURNING version`,
        [row.id, input.outcome, SUPPORT_RESOLUTION_RULES_VERSION, input.reasonCode, resolvedInvoiceId,
          input.outcome === "REFUND" ? input.paymentRefundId ?? null : null, input.actorId, input.occurredAt.toISOString(), row.version]);
      if (caseUpdated.rows[0] === undefined) throw new SupportConflictError("VERSION_CONFLICT", "The case changed; refresh and retry");
      await tx.sql.query(
        `INSERT INTO public.support_case_entries
           (case_id, entry_type, author_role, author_user_id, statement_code, evidence_kind, evidence_id, occurred_at)
         VALUES ($1::uuid, 'RESOLVED', 'SUPPORT', $2::uuid, $3, 'INVOICE', $4::uuid, $5::timestamptz)`,
        [row.id, input.actorId, input.reasonCode, facts.currentInvoiceId, input.occurredAt.toISOString()]);
      await tx.appendAudit({
        actorId: input.actorId,
        actorChannel: "OPERATOR",
        action: "support.case.resolve",
        resourceType: "SupportCase",
        resourceId: row.id,
        outcome: "SUCCEEDED",
        reasonCode: input.reasonCode,
        metadata: {
          bookingId: row.booking_id,
          resolutionOutcome: input.outcome,
          rulesVersion: SUPPORT_RESOLUTION_RULES_VERSION,
          disputedInvoiceId: row.disputed_invoice_id,
          currentInvoiceId: facts.currentInvoiceId,
          ...(input.paymentRefundId === undefined ? {} : { paymentRefundId: input.paymentRefundId }),
          bookingStatusBefore: row.booking_status,
          bookingStatusAfter,
        },
        occurredAt: input.occurredAt,
      });
      await tx.appendOutbox({
        aggregateType: "Booking",
        aggregateId: row.booking_id,
        eventType: "DisputeResolved",
        eventVersion: Number(caseUpdated.rows[0].version),
        payload: { bookingId: row.booking_id, caseId: row.id, outcome: input.outcome, rulesVersion: SUPPORT_RESOLUTION_RULES_VERSION },
      });
      await this.#complete(tx.sql, scope, input.idempotencyKey, row.id);
    });
  }

  async #run(context: SupportRequestContext, work: (tx: DomainTransaction) => Promise<void>): Promise<void> {
    try {
      await retrySerializationFailures(() =>
        withDomainTransaction(this.pool, { isolation: "SERIALIZABLE", correlationId: context.correlationId }, work));
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
      if (code === "40001") throw new SupportConflictError("VERSION_CONFLICT", "The case changed concurrently; refresh and retry");
      throw error;
    }
  }

  /** Claims the key; true when a completed request with the same digest already applied it. */
  async #claim(sql: SqlConnection, scope: string, key: string, digest: string, occurredAt: Date): Promise<boolean> {
    await sql.query(
      `INSERT INTO public.idempotency_records (actor_scope, idempotency_key, request_digest, expires_at)
       VALUES ($1, $2, $3, $4) ON CONFLICT (actor_scope, idempotency_key) DO NOTHING`,
      [scope, key, digest, new Date(occurredAt.getTime() + this.idempotencyTtlMs).toISOString()]);
    const row = (await sql.query<IdempotencyRow>(
      `SELECT request_digest, status FROM public.idempotency_records
       WHERE actor_scope = $1 AND idempotency_key = $2 FOR UPDATE`, [scope, key])).rows[0];
    if (row === undefined) throw new Error("Unable to claim support idempotency key");
    if (row.request_digest !== digest) {
      throw new SupportConflictError("IDEMPOTENCY_KEY_REUSED", "The idempotency key was already used for a different request");
    }
    return row.status === "COMPLETED";
  }

  async #complete(sql: SqlConnection, scope: string, key: string, caseId: string): Promise<void> {
    await sql.query(
      `UPDATE public.idempotency_records SET status = 'COMPLETED', response_status = 200, response_body = $3::jsonb,
         resource_type = 'SupportCase', resource_id = $4, updated_at = CURRENT_TIMESTAMP
       WHERE actor_scope = $1 AND idempotency_key = $2`,
      [scope, key, JSON.stringify({ caseId }), caseId]);
  }

  async #loadCase(sql: SqlConnection, caseId: string, forUpdate: boolean): Promise<CaseRow> {
    const row = (await sql.query<CaseRow>(
      `${CASE_SELECT} WHERE c.id = $1::uuid${forUpdate ? " FOR UPDATE OF c, b" : ""}`, [caseId])).rows[0];
    if (row === undefined) throw new SupportNotFoundError();
    return row;
  }

  async #bumpCase(sql: SqlConnection, row: CaseRow, occurredAt: Date): Promise<void> {
    const updated = await sql.query(
      `UPDATE public.support_cases SET version = version + 1, updated_at = $3::timestamptz
       WHERE id = $1::uuid AND version = $2`, [row.id, row.version, occurredAt.toISOString()]);
    if (updated.rowCount !== 1) throw new SupportConflictError("VERSION_CONFLICT", "The case changed; refresh and retry");
  }

  async #assertEvidence(sql: SqlConnection, evidence: SupportEvidenceReference, bookingId: string): Promise<void> {
    const found = await sql.query(EVIDENCE_QUERIES[evidence.kind], [evidence.id, bookingId]);
    if (found.rowCount === 0) throw new SupportNotFoundError();
  }

  async #currentInvoice(sql: SqlConnection, bookingId: string): Promise<InvoiceRow> {
    const invoice = (await sql.query<InvoiceRow>(
      `SELECT id, invoice_version, total_paise FROM public.invoices WHERE booking_id = $1::uuid
       ORDER BY invoice_version DESC LIMIT 1`, [bookingId])).rows[0];
    if (invoice === undefined) throw new Error("A disputed booking has no invoice");
    return invoice;
  }

  async #payments(sql: SqlConnection, bookingId: string): Promise<readonly PaymentRow[]> {
    return (await sql.query<PaymentRow>(
      `SELECT p.id, p.invoice_id, p.method, p.status, p.amount_paise FROM public.payments p
       JOIN public.invoices i ON i.id = p.invoice_id WHERE i.booking_id = $1::uuid ORDER BY p.created_at, p.id`,
      [bookingId])).rows;
  }

  async #facts(sql: SqlConnection, row: CaseRow): Promise<ResolutionFacts> {
    const invoice = await this.#currentInvoice(sql, row.booking_id);
    const payments = await this.#payments(sql, row.booking_id);
    const sum = (rows: readonly PaymentRow[]) => rows.reduce((total, payment) => total + Number(payment.amount_paise), 0);
    return Object.freeze({
      bookingStatus: row.booking_status,
      disputedInvoiceId: row.disputed_invoice_id,
      currentInvoiceId: invoice.id,
      currentInvoiceTotalPaise: Number(invoice.total_paise),
      appliedOnCurrentPaise: sum(payments.filter((payment) => payment.invoice_id === invoice.id && isApplied(payment.status))),
      appliedOnSupersededPaise: sum(payments.filter((payment) => payment.invoice_id !== invoice.id && isApplied(payment.status))),
      pendingPaise: sum(payments.filter((payment) => isReserved(payment.status))),
      refundablePaymentIds: Object.freeze(payments
        .filter((payment) => payment.method === "ONLINE" && payment.status === "PAID_ONLINE").map((payment) => payment.id)),
    });
  }

  async #project(sql: SqlConnection, caseId: string, viewer: SupportCaseViewer): Promise<SupportCaseProjection> {
    const row = await this.#loadCase(sql, caseId, false);
    const invoice = await this.#currentInvoice(sql, row.booking_id);
    const payments = await this.#payments(sql, row.booking_id);
    const entries = (await sql.query<EntryRow>(
      `SELECT id, entry_type, author_role, author_user_id, statement_code, statement_text, statement_redacted_at,
         evidence_kind, evidence_id, occurred_at
       FROM public.support_case_entries WHERE case_id = $1::uuid ORDER BY occurred_at, id`, [row.id])).rows;
    const showText = (entry: EntryRow): boolean =>
      entry.statement_text !== null && (viewer.kind === "SUPPORT" || entry.author_user_id === viewer.userId);
    const refundable: readonly RefundablePayment[] = payments
      .filter((payment) => payment.method === "ONLINE" && payment.status === "PAID_ONLINE")
      .map((payment) => Object.freeze({ id: payment.id, amountPaise: Number(payment.amount_paise) }));
    const projection: SupportCaseProjection = {
      id: row.id,
      bookingId: row.booking_id,
      bookingReference: row.public_reference,
      bookingStatus: row.booking_status,
      bookingVersion: Number(row.booking_version),
      status: row.status,
      version: Number(row.version),
      openedAt: row.opened_at,
      disputedInvoiceId: row.disputed_invoice_id,
      disputedInvoiceVersion: Number(row.disputed_invoice_version),
      currentInvoiceId: invoice.id,
      currentInvoiceVersion: Number(invoice.invoice_version),
      currentInvoiceTotalPaise: Number(invoice.total_paise),
      appliedPaise: payments.filter((payment) => payment.invoice_id === invoice.id && isApplied(payment.status))
        .reduce((total, payment) => total + Number(payment.amount_paise), 0),
      ...(row.status === "RESOLVED" && row.resolution_outcome !== null && row.resolved_at !== null ? {
        resolution: Object.freeze({
          outcome: row.resolution_outcome,
          rulesVersion: Number(row.resolution_rules_version),
          reasonCode: row.resolution_reason_code ?? "OTHER",
          resolvedAt: row.resolved_at,
          ...(row.resolved_invoice_id === null ? {} : { resolvedInvoiceId: row.resolved_invoice_id }),
          ...(row.payment_refund_id === null ? {} : { paymentRefundId: row.payment_refund_id }),
        }),
      } : {}),
      entries: Object.freeze(entries.map((entry): SupportCaseEntryProjection => Object.freeze({
        id: entry.id,
        entryType: entry.entry_type,
        authorRole: entry.author_role,
        statementCode: entry.statement_code,
        ...(showText(entry) ? { statementText: entry.statement_text! } : {}),
        statementRedacted: entry.statement_redacted_at !== null,
        ...(entry.evidence_kind === null || entry.evidence_id === null ? {} : {
          evidence: Object.freeze({ kind: entry.evidence_kind, id: entry.evidence_id }),
        }),
        occurredAt: entry.occurred_at,
      }))),
      ...(viewer.kind === "SUPPORT" ? {
        refundablePayments: Object.freeze(refundable),
        ...(viewer.grantExpiresAt === undefined ? {} : { grantExpiresAt: viewer.grantExpiresAt }),
      } : {}),
    };
    return Object.freeze(projection);
  }
}
