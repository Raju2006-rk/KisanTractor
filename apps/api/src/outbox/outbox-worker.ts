import type {
  ClaimedOutboxEvent,
  OutboxBacklogReader,
  OutboxLease,
  OutboxLeaseStore,
} from "@kisantractor/database";
import type { OutboxRetryPlan, OutboxRetryPolicy } from "@kisantractor/domain";
import {
  defaultOutboxRetryPolicy,
  planOutboxRetry,
  safeDeliveryErrorCode,
  validateOutboxRetryPolicy,
} from "@kisantractor/domain";
import {
  noopIndicators,
  Tracer,
  type OperationalIndicators,
  type OutboxResolution,
} from "@kisantractor/observability";

/** Context passed to a handler for one claimed attempt. */
export interface OutboxHandlerContext {
  readonly attempt: number;
  readonly now: Date;
  /** What the worker will do if this attempt fails; decided before the attempt runs. */
  readonly retryPlan: OutboxRetryPlan;
  readonly signal?: AbortSignal;
  /** Correlation identifier of the transaction that wrote the event, when recorded. */
  readonly correlationId?: string;
  /** When the event becomes available again if the handler throws `OutboxDeferredError`. */
  readonly deferredUntil?: Date;
}

/**
 * An outbox subscriber. Handlers run after the domain transaction committed and
 * must be idempotent, because an event can be retried or reclaimed after a crash.
 * Throwing schedules a retry; throwing `NonRetryableOutboxError` dead-letters.
 */
export interface OutboxEventHandler {
  readonly name: string;
  handles(eventType: string): boolean;
  handle(event: ClaimedOutboxEvent, context: OutboxHandlerContext): Promise<void>;
}

export class NonRetryableOutboxError extends Error {
  readonly retryable = false;

  constructor(readonly code: string) {
    super(`Outbox event cannot be processed: ${code}`);
    this.name = "NonRetryableOutboxError";
  }
}

/**
 * Thrown when nothing was attempted because a capability is unavailable (for example MESSAGING is
 * DEGRADED): the event waits `deferralDelayMs` and the attempt is not counted against its retry
 * budget, so a long provider outage cannot exhaust retries and dead-letter work that never ran.
 */
export class OutboxDeferredError extends Error {
  readonly retryable = true;
  readonly deferred = true;

  constructor(readonly code: string) {
    super(`Outbox event deferred: ${code}`);
    this.name = "OutboxDeferredError";
  }
}

export type OutboxWorkerLogEvent = Readonly<{
  event:
    | "outbox.event.published"
    | "outbox.event.retry_scheduled"
    | "outbox.event.deferred"
    | "outbox.event.dead_lettered"
    | "outbox.event.lease_lost"
    | "outbox.poll.failed"
    | "outbox.backlog.sample_failed";
  workerId: string;
  outboxEventId?: string;
  eventType?: string;
  attempt?: number;
  errorCode?: string;
  nextAttemptAt?: string;
  /** Correlation identifier carried from the originating request or job. */
  correlationId?: string;
  /** Milliseconds between the event becoming available and this claim. */
  lagMs?: number;
}>;

/** Receives only identifiers, counters, and codes; never payloads or messages. */
export type OutboxWorkerLogger = (entry: OutboxWorkerLogEvent) => void;

export interface OutboxWorkerOptions {
  readonly workerId: string;
  readonly handlers: readonly OutboxEventHandler[];
  readonly retryPolicy?: OutboxRetryPolicy;
  readonly leaseMs?: number;
  readonly batchSize?: number;
  readonly pollIntervalMs?: number;
  readonly now?: () => Date;
  readonly random?: () => number;
  readonly logger?: OutboxWorkerLogger;
  /** Records outbox lag, resolutions, backlog, and committed booking-funnel events. */
  readonly indicators?: OperationalIndicators;
  /** Traces each attempt as a consumer span joined to the event's correlation identifier. */
  readonly tracer?: Tracer;
  /** Samples backlog depth, oldest due age, and dead letters for lag alerts. */
  readonly backlog?: OutboxBacklogReader;
  readonly backlogSampleIntervalMs?: number;
  /** Wait before a deferred event (see `OutboxDeferredError`) is offered again. */
  readonly deferralDelayMs?: number;
}

export type OutboxEventResolution = "PUBLISHED" | "RETRY_SCHEDULED" | "DEFERRED" | "DEAD_LETTERED" | "LEASE_LOST";

export interface OutboxBatchResult {
  readonly claimed: number;
  readonly published: number;
  readonly retryScheduled: number;
  readonly deferred: number;
  readonly deadLettered: number;
  readonly leaseLost: number;
}

const DEFAULT_LEASE_MS = 5 * 60_000;
const DEFAULT_DEFERRAL_DELAY_MS = 60_000;

const isDeferred = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "deferred" in error
  && (error as { readonly deferred: unknown }).deferred === true;
const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_BACKLOG_SAMPLE_INTERVAL_MS = 15_000;

const isNonRetryable = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "retryable" in error
  && (error as { readonly retryable: unknown }).retryable === false;

/**
 * Polls the transactional outbox, dispatches each claimed event to its
 * handlers, and resolves it as published, retried with jittered exponential
 * backoff, or dead-lettered. It writes only outbox rows, so a handler failure
 * can never change or roll back committed domain state.
 */
export class OutboxWorker {
  readonly #store: OutboxLeaseStore;
  readonly #workerId: string;
  readonly #handlers: readonly OutboxEventHandler[];
  readonly #policy: OutboxRetryPolicy;
  readonly #leaseMs: number;
  readonly #batchSize: number;
  readonly #pollIntervalMs: number;
  readonly #now: () => Date;
  readonly #random: () => number;
  readonly #log: OutboxWorkerLogger;
  readonly #indicators: OperationalIndicators;
  readonly #tracer: Tracer;
  readonly #backlog: OutboxBacklogReader | undefined;
  readonly #backlogSampleIntervalMs: number;
  readonly #deferralDelayMs: number;
  #lastBacklogSampleAt: number | undefined;
  #loop: Promise<void> | undefined;
  #abort: AbortController | undefined;

  constructor(store: OutboxLeaseStore, options: OutboxWorkerOptions) {
    const workerId = options.workerId.trim();
    if (workerId.length === 0) throw new TypeError("workerId must not be empty");
    this.#store = store;
    this.#workerId = workerId;
    this.#handlers = Object.freeze([...options.handlers]);
    this.#policy = validateOutboxRetryPolicy(options.retryPolicy ?? defaultOutboxRetryPolicy);
    this.#leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.#batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.#pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.#now = options.now ?? (() => new Date());
    this.#random = options.random ?? Math.random;
    this.#log = options.logger ?? (() => undefined);
    this.#indicators = options.indicators ?? noopIndicators;
    this.#tracer = options.tracer ?? new Tracer();
    this.#backlog = options.backlog;
    this.#backlogSampleIntervalMs = options.backlogSampleIntervalMs ?? DEFAULT_BACKLOG_SAMPLE_INTERVAL_MS;
    this.#deferralDelayMs = options.deferralDelayMs ?? DEFAULT_DEFERRAL_DELAY_MS;
    if (!Number.isSafeInteger(this.#deferralDelayMs) || this.#deferralDelayMs < 1) {
      throw new RangeError("deferralDelayMs must be a positive safe integer");
    }
  }

  /** Claims and resolves one batch. Safe to call from several workers concurrently. */
  async runOnce(signal?: AbortSignal): Promise<OutboxBatchResult> {
    await this.#sampleBacklog();
    const claimed = await this.#store.claim({
      workerId: this.#workerId,
      now: this.#now(),
      leaseMs: this.#leaseMs,
      limit: this.#batchSize,
    });
    const counts = { published: 0, retryScheduled: 0, deferred: 0, deadLettered: 0, leaseLost: 0 };
    for (const event of claimed) {
      if (signal?.aborted === true) break;
      const resolution = await this.processEvent(event, signal);
      if (resolution === "PUBLISHED") counts.published += 1;
      else if (resolution === "RETRY_SCHEDULED") counts.retryScheduled += 1;
      else if (resolution === "DEFERRED") counts.deferred += 1;
      else if (resolution === "DEAD_LETTERED") counts.deadLettered += 1;
      else counts.leaseLost += 1;
    }
    return Object.freeze({ claimed: claimed.length, ...counts });
  }

  /**
   * Resolves one claimed attempt inside a consumer span that carries the
   * event's stored correlation identifier, so handler logs, nested
   * transactions, and worker logs join the request that wrote the event.
   */
  async processEvent(event: ClaimedOutboxEvent, signal?: AbortSignal): Promise<OutboxEventResolution> {
    const startedAt = this.#now();
    const lagMs = Math.max(0, startedAt.getTime() - event.availableAt.getTime());
    this.#indicators.outboxEventClaimed(event.eventType, lagMs);
    const resolution = await this.#tracer.withSpan("outbox.event.process", {
      kind: "CONSUMER",
      ...(event.correlationId === undefined ? {} : { correlationId: event.correlationId }),
      attributes: {
        outboxEventId: event.id,
        eventType: event.eventType,
        attempt: event.attemptCount,
        lagMs,
        workerId: this.#workerId,
      },
    }, async (span) => {
      const outcome = await this.#resolve(event, startedAt, lagMs, signal);
      span.setAttribute("outcome", outcome);
      return outcome;
    });
    this.#indicators.outboxEventResolved(event.eventType, resolution satisfies OutboxResolution);
    return resolution;
  }

  async #resolve(
    event: ClaimedOutboxEvent,
    startedAt: Date,
    lagMs: number,
    signal: AbortSignal | undefined,
  ): Promise<OutboxEventResolution> {
    const lease: OutboxLease = Object.freeze({
      eventId: event.id,
      workerId: this.#workerId,
      attempt: event.attemptCount,
    });
    const retryPlan = planOutboxRetry(event.attemptCount, startedAt, this.#policy, this.#random);

    // A reclaimed event can exceed the budget when a worker crashed mid-attempt.
    if (event.attemptCount > this.#policy.maxAttempts) {
      return this.#deadLetter(event, lease, "MAX_ATTEMPTS_EXCEEDED");
    }

    const deferredUntil = new Date(startedAt.getTime() + this.#deferralDelayMs);
    try {
      for (const handler of this.#handlers) {
        if (!handler.handles(event.eventType)) continue;
        await handler.handle(event, Object.freeze({
          attempt: event.attemptCount,
          now: startedAt,
          retryPlan,
          deferredUntil,
          ...(signal === undefined ? {} : { signal }),
          ...(event.correlationId === undefined ? {} : { correlationId: event.correlationId }),
        }));
      }
    } catch (error) {
      const errorCode = safeDeliveryErrorCode(error);
      if (isDeferred(error) && this.#store.defer !== undefined) {
        const deferred = await this.#store.defer(lease, deferredUntil, errorCode);
        if (!deferred) return this.#leaseLost(event);
        this.#log(Object.freeze({
          event: "outbox.event.deferred",
          workerId: this.#workerId,
          outboxEventId: event.id,
          eventType: event.eventType,
          attempt: event.attemptCount,
          errorCode,
          nextAttemptAt: deferredUntil.toISOString(),
          ...this.#correlation(event),
        }));
        return "DEFERRED";
      }
      if (retryPlan.kind === "DEAD_LETTER" || isNonRetryable(error)) {
        return this.#deadLetter(event, lease, errorCode);
      }
      const rescheduled = await this.#store.reschedule(lease, retryPlan.nextAttemptAt, errorCode);
      if (!rescheduled) return this.#leaseLost(event);
      this.#log(Object.freeze({
        event: "outbox.event.retry_scheduled",
        workerId: this.#workerId,
        outboxEventId: event.id,
        eventType: event.eventType,
        attempt: event.attemptCount,
        errorCode,
        nextAttemptAt: retryPlan.nextAttemptAt.toISOString(),
        ...this.#correlation(event),
      }));
      return "RETRY_SCHEDULED";
    }

    const published = await this.#store.markPublished(lease, this.#now());
    if (!published) return this.#leaseLost(event);
    this.#log(Object.freeze({
      event: "outbox.event.published",
      workerId: this.#workerId,
      outboxEventId: event.id,
      eventType: event.eventType,
      attempt: event.attemptCount,
      lagMs,
      ...this.#correlation(event),
    }));
    return "PUBLISHED";
  }

  /** Starts a polling loop; resolves `stop()` after the in-flight batch finishes. */
  start(): void {
    if (this.#loop !== undefined) return;
    const abort = new AbortController();
    this.#abort = abort;
    this.#loop = (async () => {
      while (!abort.signal.aborted) {
        let claimed = 0;
        try {
          claimed = (await this.runOnce(abort.signal)).claimed;
        } catch (error) {
          this.#indicators.outboxPollFailed();
          this.#log(Object.freeze({
            event: "outbox.poll.failed",
            workerId: this.#workerId,
            errorCode: safeDeliveryErrorCode(error, "POLL_FAILED"),
          }));
        }
        if (claimed < this.#batchSize) await sleep(this.#pollIntervalMs, abort.signal);
      }
    })();
  }

  async stop(): Promise<void> {
    this.#abort?.abort();
    await this.#loop;
    this.#loop = undefined;
    this.#abort = undefined;
  }

  /** Samples outbox backlog at most once per interval; failures never stop dispatch. */
  async #sampleBacklog(): Promise<void> {
    if (this.#backlog === undefined) return;
    const now = this.#now();
    if (this.#lastBacklogSampleAt !== undefined
      && now.getTime() - this.#lastBacklogSampleAt < this.#backlogSampleIntervalMs) return;
    this.#lastBacklogSampleAt = now.getTime();
    try {
      this.#indicators.outboxBacklogSampled(await this.#backlog.backlog(now));
    } catch (error) {
      this.#log(Object.freeze({
        event: "outbox.backlog.sample_failed",
        workerId: this.#workerId,
        errorCode: safeDeliveryErrorCode(error, "BACKLOG_SAMPLE_FAILED"),
      }));
    }
  }

  #correlation(event: ClaimedOutboxEvent): { readonly correlationId?: string } {
    return event.correlationId === undefined ? {} : { correlationId: event.correlationId };
  }

  async #deadLetter(
    event: ClaimedOutboxEvent,
    lease: OutboxLease,
    errorCode: string,
  ): Promise<OutboxEventResolution> {
    const deadLettered = await this.#store.deadLetter(lease, this.#now(), errorCode);
    if (!deadLettered) return this.#leaseLost(event);
    this.#log(Object.freeze({
      event: "outbox.event.dead_lettered",
      workerId: this.#workerId,
      outboxEventId: event.id,
      eventType: event.eventType,
      attempt: event.attemptCount,
      errorCode,
      ...this.#correlation(event),
    }));
    return "DEAD_LETTERED";
  }

  #leaseLost(event: ClaimedOutboxEvent): OutboxEventResolution {
    this.#log(Object.freeze({
      event: "outbox.event.lease_lost",
      workerId: this.#workerId,
      outboxEventId: event.id,
      eventType: event.eventType,
      attempt: event.attemptCount,
      ...this.#correlation(event),
    }));
    return "LEASE_LOST";
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
