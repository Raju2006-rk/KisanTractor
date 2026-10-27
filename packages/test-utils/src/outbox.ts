import type {
  ClaimedOutboxEvent,
  DeadLetteredOutboxEvent,
  JsonObject,
  OutboxBacklogReader,
  OutboxBacklogSnapshot,
  OutboxClaimRequest,
  OutboxLease,
  OutboxLeaseStore,
  OutboxStatus,
} from "@kisantractor/database";

export interface InMemoryOutboxRow {
  id: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  eventVersion: number;
  payload: JsonObject;
  status: OutboxStatus;
  attemptCount: number;
  availableAt: Date;
  createdAt: Date;
  lockedAt: Date | null;
  lockedBy: string | null;
  publishedAt: Date | null;
  deadLetteredAt: Date | null;
  lastErrorCode: string | null;
  correlationId: string | null;
}

/**
 * Test double with the same claim semantics as `PostgresOutboxLeaseStore`:
 * a claim is atomic, skips events held by another unexpired lease, and every
 * completion is guarded by worker id and attempt number.
 */
export class InMemoryOutboxLeaseStore implements OutboxLeaseStore, OutboxBacklogReader {
  readonly rows = new Map<string, InMemoryOutboxRow>();
  #sequence = 0;

  append(input: {
    readonly aggregateType?: string;
    readonly aggregateId: string;
    readonly eventType: string;
    readonly payload: JsonObject;
    readonly availableAt: Date;
    readonly id?: string;
    readonly correlationId?: string;
  }): InMemoryOutboxRow {
    this.#sequence += 1;
    const id = input.id ?? `00000000-0000-4000-8000-${String(this.#sequence).padStart(12, "0")}`;
    const row: InMemoryOutboxRow = {
      id,
      aggregateType: input.aggregateType ?? "Booking",
      aggregateId: input.aggregateId,
      eventType: input.eventType,
      eventVersion: 1,
      payload: input.payload,
      status: "PENDING",
      attemptCount: 0,
      availableAt: input.availableAt,
      createdAt: input.availableAt,
      lockedAt: null,
      lockedBy: null,
      publishedAt: null,
      deadLetteredAt: null,
      lastErrorCode: null,
      correlationId: input.correlationId ?? null,
    };
    this.rows.set(id, row);
    return row;
  }

  async claim(request: OutboxClaimRequest): Promise<readonly ClaimedOutboxEvent[]> {
    const now = request.now.getTime();
    const candidates = [...this.rows.values()]
      .filter((row) =>
        ((row.status === "PENDING" || row.status === "FAILED") && row.availableAt.getTime() <= now)
        || (row.status === "PROCESSING" && row.lockedAt !== null && row.lockedAt.getTime() <= now - request.leaseMs))
      .sort((left, right) =>
        left.availableAt.getTime() - right.availableAt.getTime() || left.id.localeCompare(right.id))
      .slice(0, request.limit);
    return candidates.map((row) => {
      row.status = "PROCESSING";
      row.lockedAt = new Date(now);
      row.lockedBy = request.workerId;
      row.attemptCount += 1;
      return Object.freeze({
        id: row.id,
        aggregateType: row.aggregateType,
        aggregateId: row.aggregateId,
        eventType: row.eventType,
        eventVersion: row.eventVersion,
        payload: row.payload,
        status: row.status,
        availableAt: row.availableAt,
        createdAt: row.createdAt,
        attemptCount: row.attemptCount,
        lockedAt: row.lockedAt,
        lockedBy: request.workerId,
        ...(row.correlationId === null ? {} : { correlationId: row.correlationId }),
      });
    });
  }

  async backlog(now: Date): Promise<OutboxBacklogSnapshot> {
    const due = [...this.rows.values()].filter((row) =>
      (row.status === "PENDING" || row.status === "FAILED" || row.status === "PROCESSING")
      && row.availableAt.getTime() <= now.getTime());
    const oldest = due.reduce<number | undefined>((min, row) =>
      min === undefined ? row.availableAt.getTime() : Math.min(min, row.availableAt.getTime()), undefined);
    return {
      dueEvents: due.length,
      oldestDueAgeMs: oldest === undefined ? 0 : now.getTime() - oldest,
      deadLetterEvents: [...this.rows.values()].filter((row) => row.status === "DEAD_LETTER").length,
    };
  }

  #held(lease: OutboxLease): InMemoryOutboxRow | undefined {
    const row = this.rows.get(lease.eventId);
    return row !== undefined && row.status === "PROCESSING" && row.lockedBy === lease.workerId
      && row.attemptCount === lease.attempt
      ? row
      : undefined;
  }

  async markPublished(lease: OutboxLease, at: Date): Promise<boolean> {
    const row = this.#held(lease);
    if (row === undefined) return false;
    Object.assign(row, { status: "PUBLISHED", publishedAt: at, lastErrorCode: null, lockedAt: null, lockedBy: null });
    return true;
  }

  async reschedule(lease: OutboxLease, availableAt: Date, errorCode: string): Promise<boolean> {
    const row = this.#held(lease);
    if (row === undefined) return false;
    Object.assign(row, { status: "FAILED", availableAt, lastErrorCode: errorCode, lockedAt: null, lockedBy: null });
    return true;
  }

  async defer(lease: OutboxLease, availableAt: Date, errorCode: string): Promise<boolean> {
    const row = this.#held(lease);
    if (row === undefined) return false;
    Object.assign(row, {
      status: "FAILED", availableAt, lastErrorCode: errorCode, lockedAt: null, lockedBy: null,
      attemptCount: Math.max(row.attemptCount - 1, 0),
    });
    return true;
  }

  async deadLetter(lease: OutboxLease, at: Date, errorCode: string): Promise<boolean> {
    const row = this.#held(lease);
    if (row === undefined) return false;
    Object.assign(row, { status: "DEAD_LETTER", deadLetteredAt: at, lastErrorCode: errorCode, lockedAt: null, lockedBy: null });
    return true;
  }

  async listDeadLetters(limit: number): Promise<readonly DeadLetteredOutboxEvent[]> {
    return [...this.rows.values()]
      .filter((row) => row.status === "DEAD_LETTER")
      .slice(0, limit)
      .map((row) => ({
        id: row.id,
        aggregateType: row.aggregateType,
        aggregateId: row.aggregateId,
        eventType: row.eventType,
        attemptCount: row.attemptCount,
        lastErrorCode: row.lastErrorCode,
        deadLetteredAt: row.deadLetteredAt,
      }));
  }

  async requeueDeadLetter(eventId: string, availableAt: Date): Promise<boolean> {
    const row = this.rows.get(eventId);
    if (row === undefined || row.status !== "DEAD_LETTER") return false;
    Object.assign(row, { status: "PENDING", attemptCount: 0, availableAt, deadLetteredAt: null });
    return true;
  }
}
