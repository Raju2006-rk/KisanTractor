import type { SqlExecutor } from "./client.js";
import type { JsonObject } from "./json.js";

export type OutboxStatus =
  | "PENDING"
  | "PROCESSING"
  | "PUBLISHED"
  | "FAILED"
  | "DEAD_LETTER";

export interface OutboxEventInput {
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly eventVersion: number;
  readonly payload: JsonObject;
  readonly availableAt?: Date;
  /**
   * Correlation identifier of the request or job that produced the event. When
   * omitted, the transaction-local `app.correlation_id` setting is used, so
   * events written by raw SQL inside a correlated transaction carry it too.
   */
  readonly correlationId?: string;
}

export interface StoredOutboxEvent {
  readonly id: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly eventVersion: number;
  readonly payload: JsonObject;
  readonly status: OutboxStatus;
  readonly availableAt: Date;
  readonly createdAt: Date;
  readonly correlationId?: string;
}

interface OutboxRow extends Record<string, unknown> {
  readonly id: string;
  readonly aggregate_type: string;
  readonly aggregate_id: string;
  readonly event_type: string;
  readonly event_version: number;
  readonly payload: JsonObject;
  readonly status: OutboxStatus;
  readonly available_at: Date;
  readonly created_at: Date;
  readonly correlation_id?: string | null;
}

const correlationOf = (row: OutboxRow): { readonly correlationId?: string } =>
  typeof row.correlation_id === "string" && row.correlation_id.length > 0
    ? { correlationId: row.correlation_id }
    : {};

const requireText = (value: string, field: string): string => {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new TypeError(`${field} must not be empty`);
  }
  return trimmed;
};

export async function storeOutboxEvent(
  executor: SqlExecutor,
  input: OutboxEventInput,
): Promise<StoredOutboxEvent> {
  if (!Number.isSafeInteger(input.eventVersion) || input.eventVersion < 1) {
    throw new TypeError("eventVersion must be a positive safe integer");
  }

  const result = await executor.query<OutboxRow>(
    `INSERT INTO public.outbox_events
      (aggregate_type, aggregate_id, event_type, event_version, payload, available_at, correlation_id)
     VALUES ($1, $2, $3, $4, $5::jsonb, COALESCE($6::timestamptz, CURRENT_TIMESTAMP),
       COALESCE($7::text, NULLIF(current_setting('app.correlation_id', true), '')))
     RETURNING id, aggregate_type, aggregate_id, event_type, event_version,
       payload, status, available_at, created_at, correlation_id`,
    [
      requireText(input.aggregateType, "aggregateType"),
      requireText(input.aggregateId, "aggregateId"),
      requireText(input.eventType, "eventType"),
      input.eventVersion,
      JSON.stringify(input.payload),
      input.availableAt?.toISOString() ?? null,
      input.correlationId?.trim() || null,
    ],
  );
  const row = result.rows[0];
  if (result.rowCount !== 1 || row === undefined) {
    throw new Error("Outbox event was not stored");
  }

  return {
    id: row.id,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    eventVersion: row.event_version,
    payload: row.payload,
    status: row.status,
    availableAt: row.available_at,
    createdAt: row.created_at,
    ...correlationOf(row),
  };
}

/** Identifies one worker's claim on one attempt of an outbox event. */
export interface OutboxLease {
  readonly eventId: string;
  readonly workerId: string;
  readonly attempt: number;
}

export interface ClaimedOutboxEvent extends StoredOutboxEvent {
  /** 1-based attempt number for this claim, including attempts lost to crashes. */
  readonly attemptCount: number;
  readonly lockedAt: Date;
  readonly lockedBy: string;
}

export interface OutboxClaimRequest {
  readonly workerId: string;
  readonly now: Date;
  /** A PROCESSING event whose lease is older than this is reclaimable. */
  readonly leaseMs: number;
  readonly limit: number;
}

export interface DeadLetteredOutboxEvent {
  readonly id: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly attemptCount: number;
  readonly lastErrorCode: string | null;
  readonly deadLetteredAt: Date | null;
}

/** Point-in-time outbox health used for lag and dead-letter monitoring. */
export interface OutboxBacklogSnapshot {
  /** Events due for dispatch (PENDING/FAILED with available_at <= now) or in flight. */
  readonly dueEvents: number;
  /** Age of the oldest due, unpublished event in milliseconds; 0 when none. */
  readonly oldestDueAgeMs: number;
  readonly deadLetterEvents: number;
}

/** Read-only backlog query, kept separate so lease-store test doubles need not implement it. */
export interface OutboxBacklogReader {
  backlog(now: Date): Promise<OutboxBacklogSnapshot>;
}

interface BacklogRow extends Record<string, unknown> {
  readonly due_events: string | number;
  readonly oldest_due_at: Date | null;
  readonly dead_letter_events: string | number;
}

/** Storage operations an outbox worker needs; every completion is lease-guarded. */
export interface OutboxLeaseStore {
  claim(request: OutboxClaimRequest): Promise<readonly ClaimedOutboxEvent[]>;
  markPublished(lease: OutboxLease, at: Date): Promise<boolean>;
  reschedule(lease: OutboxLease, availableAt: Date, errorCode: string): Promise<boolean>;
  /**
   * Like `reschedule`, but returns the claimed attempt to the budget: used when nothing was
   * attempted because a capability is unavailable. Optional; workers fall back to `reschedule`.
   */
  defer?(lease: OutboxLease, availableAt: Date, errorCode: string): Promise<boolean>;
  deadLetter(lease: OutboxLease, at: Date, errorCode: string): Promise<boolean>;
  listDeadLetters(limit: number): Promise<readonly DeadLetteredOutboxEvent[]>;
  requeueDeadLetter(eventId: string, availableAt: Date): Promise<boolean>;
}

interface ClaimedOutboxRow extends OutboxRow {
  readonly attempt_count: number;
  readonly locked_at: Date;
  readonly locked_by: string;
}

interface DeadLetterRow extends Record<string, unknown> {
  readonly id: string;
  readonly aggregate_type: string;
  readonly aggregate_id: string;
  readonly event_type: string;
  readonly attempt_count: number;
  readonly last_error_code: string | null;
  readonly dead_lettered_at: Date | null;
}

const MAX_CLAIM_LIMIT = 500;
const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/u;

const requireBoundedLimit = (limit: number): number => {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CLAIM_LIMIT) {
    throw new RangeError(`limit must be an integer from 1 to ${MAX_CLAIM_LIMIT}`);
  }
  return limit;
};

const requireSafeCode = (code: string): string => {
  if (!SAFE_CODE.test(code)) {
    throw new TypeError("errorCode must be an upper-case code without free text");
  }
  return code;
};

const requireLease = (lease: OutboxLease): OutboxLease => {
  requireText(lease.eventId, "eventId");
  requireText(lease.workerId, "workerId");
  if (!Number.isSafeInteger(lease.attempt) || lease.attempt < 1) {
    throw new RangeError("lease attempt must be a positive safe integer");
  }
  return lease;
};

/**
 * PostgreSQL outbox lease store. Claims use `FOR UPDATE SKIP LOCKED` inside a
 * single statement, so concurrent workers never claim the same event, and a
 * crashed worker's event becomes claimable again once its lease expires.
 */
export class PostgresOutboxLeaseStore implements OutboxLeaseStore, OutboxBacklogReader {
  constructor(private readonly executor: SqlExecutor) {}

  /** One aggregate query over the indexed dispatch and lease columns. */
  async backlog(now: Date): Promise<OutboxBacklogSnapshot> {
    const result = await this.executor.query<BacklogRow>(
      `SELECT
         count(*) FILTER (WHERE status IN ('PENDING', 'FAILED', 'PROCESSING') AND available_at <= $1::timestamptz)
           AS due_events,
         min(available_at) FILTER (WHERE status IN ('PENDING', 'FAILED', 'PROCESSING') AND available_at <= $1::timestamptz)
           AS oldest_due_at,
         count(*) FILTER (WHERE status = 'DEAD_LETTER') AS dead_letter_events
       FROM public.outbox_events
       WHERE status IN ('PENDING', 'FAILED', 'PROCESSING', 'DEAD_LETTER')`,
      [now.toISOString()],
    );
    const row = result.rows[0];
    const oldest = row?.oldest_due_at ?? null;
    return Object.freeze({
      dueEvents: Number(row?.due_events ?? 0),
      oldestDueAgeMs: oldest === null ? 0 : Math.max(0, now.getTime() - new Date(oldest).getTime()),
      deadLetterEvents: Number(row?.dead_letter_events ?? 0),
    });
  }

  async claim(request: OutboxClaimRequest): Promise<readonly ClaimedOutboxEvent[]> {
    const workerId = requireText(request.workerId, "workerId");
    if (!Number.isSafeInteger(request.leaseMs) || request.leaseMs < 1) {
      throw new RangeError("leaseMs must be a positive safe integer");
    }
    const limit = requireBoundedLimit(request.limit);
    const now = request.now.toISOString();
    const leaseExpiredBefore = new Date(request.now.getTime() - request.leaseMs).toISOString();

    const result = await this.executor.query<ClaimedOutboxRow>(
      `WITH candidates AS (
         SELECT id FROM public.outbox_events
         WHERE (status IN ('PENDING', 'FAILED') AND available_at <= $1::timestamptz)
            OR (status = 'PROCESSING' AND locked_at <= $2::timestamptz)
         ORDER BY available_at, id
         FOR UPDATE SKIP LOCKED
         LIMIT $3
       )
       UPDATE public.outbox_events e
          SET status = 'PROCESSING', locked_at = $1::timestamptz, locked_by = $4,
              attempt_count = e.attempt_count + 1, version = e.version + 1
         FROM candidates c
        WHERE e.id = c.id
       RETURNING e.id, e.aggregate_type, e.aggregate_id, e.event_type, e.event_version,
         e.payload, e.status, e.available_at, e.created_at, e.attempt_count, e.locked_at, e.locked_by,
         e.correlation_id`,
      [now, leaseExpiredBefore, limit, workerId],
    );

    return Object.freeze(
      [...result.rows]
        .sort((left, right) =>
          left.available_at.getTime() - right.available_at.getTime() || left.id.localeCompare(right.id))
        .map((row) => Object.freeze({
          id: row.id,
          aggregateType: row.aggregate_type,
          aggregateId: row.aggregate_id,
          eventType: row.event_type,
          eventVersion: row.event_version,
          payload: row.payload,
          status: row.status,
          availableAt: row.available_at,
          createdAt: row.created_at,
          attemptCount: row.attempt_count,
          lockedAt: row.locked_at,
          lockedBy: row.locked_by,
          ...correlationOf(row),
        })),
    );
  }

  async markPublished(lease: OutboxLease, at: Date): Promise<boolean> {
    requireLease(lease);
    const result = await this.executor.query(
      `UPDATE public.outbox_events
          SET status = 'PUBLISHED', published_at = $4::timestamptz, last_error_code = NULL,
              locked_at = NULL, locked_by = NULL, version = version + 1
        WHERE id = $1 AND status = 'PROCESSING' AND locked_by = $2 AND attempt_count = $3`,
      [lease.eventId, lease.workerId, lease.attempt, at.toISOString()],
    );
    return result.rowCount === 1;
  }

  async reschedule(lease: OutboxLease, availableAt: Date, errorCode: string): Promise<boolean> {
    requireLease(lease);
    const result = await this.executor.query(
      `UPDATE public.outbox_events
          SET status = 'FAILED', available_at = $4::timestamptz, last_error_code = $5,
              locked_at = NULL, locked_by = NULL, version = version + 1
        WHERE id = $1 AND status = 'PROCESSING' AND locked_by = $2 AND attempt_count = $3`,
      [lease.eventId, lease.workerId, lease.attempt, availableAt.toISOString(), requireSafeCode(errorCode)],
    );
    return result.rowCount === 1;
  }

  async defer(lease: OutboxLease, availableAt: Date, errorCode: string): Promise<boolean> {
    requireLease(lease);
    const result = await this.executor.query(
      `UPDATE public.outbox_events
          SET status = 'FAILED', available_at = $4::timestamptz, last_error_code = $5,
              attempt_count = GREATEST(attempt_count - 1, 0),
              locked_at = NULL, locked_by = NULL, version = version + 1
        WHERE id = $1 AND status = 'PROCESSING' AND locked_by = $2 AND attempt_count = $3`,
      [lease.eventId, lease.workerId, lease.attempt, availableAt.toISOString(), requireSafeCode(errorCode)],
    );
    return result.rowCount === 1;
  }

  async deadLetter(lease: OutboxLease, at: Date, errorCode: string): Promise<boolean> {
    requireLease(lease);
    const result = await this.executor.query(
      `UPDATE public.outbox_events
          SET status = 'DEAD_LETTER', dead_lettered_at = $4::timestamptz, last_error_code = $5,
              locked_at = NULL, locked_by = NULL, version = version + 1
        WHERE id = $1 AND status = 'PROCESSING' AND locked_by = $2 AND attempt_count = $3`,
      [lease.eventId, lease.workerId, lease.attempt, at.toISOString(), requireSafeCode(errorCode)],
    );
    return result.rowCount === 1;
  }

  async listDeadLetters(limit: number): Promise<readonly DeadLetteredOutboxEvent[]> {
    const result = await this.executor.query<DeadLetterRow>(
      `SELECT id, aggregate_type, aggregate_id, event_type, attempt_count, last_error_code, dead_lettered_at
         FROM public.outbox_events
        WHERE status = 'DEAD_LETTER'
        ORDER BY dead_lettered_at DESC NULLS LAST, id DESC
        LIMIT $1`,
      [requireBoundedLimit(limit)],
    );
    return Object.freeze(result.rows.map((row) => Object.freeze({
      id: row.id,
      aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id,
      eventType: row.event_type,
      attemptCount: row.attempt_count,
      lastErrorCode: row.last_error_code,
      deadLetteredAt: row.dead_lettered_at,
    })));
  }

  /** Operator action: gives a dead-lettered event a fresh attempt budget. */
  async requeueDeadLetter(eventId: string, availableAt: Date): Promise<boolean> {
    const result = await this.executor.query(
      `UPDATE public.outbox_events
          SET status = 'PENDING', attempt_count = 0, available_at = $2::timestamptz,
              dead_lettered_at = NULL, version = version + 1
        WHERE id = $1 AND status = 'DEAD_LETTER'`,
      [requireText(eventId, "eventId"), availableAt.toISOString()],
    );
    return result.rowCount === 1;
  }
}
