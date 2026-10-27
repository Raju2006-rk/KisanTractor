import type { ClaimedOutboxEvent } from "@kisantractor/database";
import {
  InMemoryMetrics,
  InMemorySpanExporter,
  OperationalIndicators,
  Tracer,
  currentCorrelationId,
} from "@kisantractor/observability";
import { InMemoryOutboxLeaseStore } from "@kisantractor/test-utils";
import { describe, expect, it } from "vitest";

import {
  NonRetryableOutboxError,
  OutboxWorker,
  type OutboxEventHandler,
  type OutboxHandlerContext,
  type OutboxWorkerLogEvent,
} from "./outbox-worker.js";

const start = new Date("2026-05-12T04:00:00.000Z");
const policy = { maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 60_000, jitterRatio: 0.5 };

class Clock {
  constructor(public value: Date) {}
  now = (): Date => this.value;
  advance(ms: number): void {
    this.value = new Date(this.value.getTime() + ms);
  }
}

class ScriptedHandler implements OutboxEventHandler {
  readonly name = "scripted";
  readonly calls: Array<{ eventId: string; context: OutboxHandlerContext }> = [];

  constructor(private readonly behavior: (attempt: number) => void | Promise<void>) {}

  handles(eventType: string): boolean {
    return eventType === "BookingAccepted";
  }

  async handle(event: ClaimedOutboxEvent, context: OutboxHandlerContext): Promise<void> {
    this.calls.push({ eventId: event.id, context });
    await this.behavior(context.attempt);
  }
}

const setup = (behavior: (attempt: number) => void | Promise<void>, random = () => 0) => {
  const store = new InMemoryOutboxLeaseStore();
  const clock = new Clock(start);
  const handler = new ScriptedHandler(behavior);
  const logs: OutboxWorkerLogEvent[] = [];
  const worker = new OutboxWorker(store, {
    workerId: "worker-a",
    handlers: [handler],
    retryPolicy: policy,
    leaseMs: 30_000,
    now: clock.now,
    random,
    logger: (entry) => logs.push(entry),
  });
  const event = store.append({
    aggregateId: "70000000-0000-4000-8000-000000000001",
    eventType: "BookingAccepted",
    payload: { bookingId: "70000000-0000-4000-8000-000000000001" },
    availableAt: start,
  });
  return { store, clock, handler, logs, worker, event };
};

/** Validates: Requirements 14.6, 17.6 */
describe("OutboxWorker", () => {
  it("publishes an event once its handlers succeed", async () => {
    const { worker, store, event, handler } = setup(() => undefined);
    await expect(worker.runOnce()).resolves.toMatchObject({ claimed: 1, published: 1 });
    expect(store.rows.get(event.id)).toMatchObject({ status: "PUBLISHED", attemptCount: 1, lockedBy: null });
    expect(handler.calls[0]?.context.retryPlan.kind).toBe("RETRY");
    await expect(worker.runOnce()).resolves.toMatchObject({ claimed: 0 });
  });

  it("publishes events that no handler subscribes to", async () => {
    const { worker, store } = setup(() => undefined);
    const other = store.append({ aggregateId: "a", eventType: "TractorAvailabilityChanged", payload: {}, availableAt: start });
    await worker.runOnce();
    expect(store.rows.get(other.id)?.status).toBe("PUBLISHED");
  });

  it("retries with bounded exponential backoff and dead-letters after max attempts", async () => {
    const { worker, store, clock, event, handler, logs } = setup(() => {
      throw Object.assign(new Error("provider down"), { code: "PROVIDER_TIMEOUT" });
    });

    await worker.runOnce();
    expect(store.rows.get(event.id)).toMatchObject({
      status: "FAILED",
      attemptCount: 1,
      lastErrorCode: "PROVIDER_TIMEOUT",
      availableAt: new Date(start.getTime() + 1_000),
    });

    // Not yet due: nothing is claimed before the backoff elapses.
    clock.advance(999);
    await expect(worker.runOnce()).resolves.toMatchObject({ claimed: 0 });

    clock.advance(1);
    await worker.runOnce();
    expect(store.rows.get(event.id)).toMatchObject({
      status: "FAILED",
      attemptCount: 2,
      availableAt: new Date(clock.value.getTime() + 2_000),
    });

    clock.advance(2_000);
    await worker.runOnce();
    expect(store.rows.get(event.id)).toMatchObject({
      status: "DEAD_LETTER",
      attemptCount: 3,
      lastErrorCode: "PROVIDER_TIMEOUT",
      deadLetteredAt: clock.value,
    });
    expect(handler.calls.map((call) => call.context.retryPlan.isFinalAttempt)).toEqual([false, false, true]);
    expect(logs.map((entry) => entry.event)).toEqual([
      "outbox.event.retry_scheduled",
      "outbox.event.retry_scheduled",
      "outbox.event.dead_lettered",
    ]);

    clock.advance(10 * 60_000);
    await expect(worker.runOnce()).resolves.toMatchObject({ claimed: 0 });
    await expect(store.listDeadLetters(10)).resolves.toEqual([
      expect.objectContaining({ id: event.id, attemptCount: 3, lastErrorCode: "PROVIDER_TIMEOUT" }),
    ]);
  });

  it("applies jitter within the policy bounds", async () => {
    const { worker, store, event } = setup(() => {
      throw new Error("boom");
    }, () => 0.5);
    await worker.runOnce();
    // 1000 ms capped delay with 50% jitter ratio and a 0.5 sample removes 25%.
    expect(store.rows.get(event.id)?.availableAt).toEqual(new Date(start.getTime() + 750));
  });

  it("dead-letters immediately on a non-retryable failure", async () => {
    const { worker, store, event } = setup(() => {
      throw new NonRetryableOutboxError("INVALID_NOTIFICATION_PAYLOAD");
    });
    await worker.runOnce();
    expect(store.rows.get(event.id)).toMatchObject({
      status: "DEAD_LETTER",
      attemptCount: 1,
      lastErrorCode: "INVALID_NOTIFICATION_PAYLOAD",
    });
  });

  it("never logs or stores PII from handler error messages", async () => {
    const { worker, store, event, logs } = setup(() => {
      throw new Error("SMS to +91 98765 43210 for Ravi failed");
    });
    await worker.runOnce();
    expect(store.rows.get(event.id)?.lastErrorCode).toBe("HANDLER_ERROR");
    const serialized = JSON.stringify(logs);
    expect(serialized).not.toMatch(/98765|Ravi/u);
    expect(serialized).not.toContain("bookingId");
  });

  it("lets concurrent workers process each event exactly once", async () => {
    const store = new InMemoryOutboxLeaseStore();
    const handled: string[] = [];
    const handler: OutboxEventHandler = {
      name: "count",
      handles: () => true,
      handle: async (event) => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        handled.push(event.id);
      },
    };
    for (let index = 0; index < 20; index += 1) {
      store.append({ aggregateId: `a-${index}`, eventType: "BookingAccepted", payload: {}, availableAt: start });
    }
    const workers = ["a", "b", "c"].map((workerId) => new OutboxWorker(store, {
      workerId,
      handlers: [handler],
      batchSize: 4,
      now: () => start,
    }));

    for (let round = 0; round < 3; round += 1) {
      await Promise.all(workers.map((worker) => worker.runOnce()));
    }

    expect(handled).toHaveLength(20);
    expect(new Set(handled).size).toBe(20);
    expect([...store.rows.values()].every((row) => row.status === "PUBLISHED")).toBe(true);
  });

  it("reclaims an expired lease and does not let the stale worker overwrite the outcome", async () => {
    const store = new InMemoryOutboxLeaseStore();
    const clock = new Clock(start);
    const event = store.append({ aggregateId: "a", eventType: "BookingAccepted", payload: {}, availableAt: start });
    let releaseStale!: () => void;
    const staleHandler: OutboxEventHandler = {
      name: "stale",
      handles: () => true,
      handle: () => new Promise<void>((resolve) => {
        releaseStale = resolve;
      }),
    };
    const stale = new OutboxWorker(store, { workerId: "stale", handlers: [staleHandler], leaseMs: 30_000, now: clock.now });
    const fresh = new OutboxWorker(store, {
      workerId: "fresh",
      handlers: [{ name: "ok", handles: () => true, handle: async () => undefined }],
      leaseMs: 30_000,
      now: clock.now,
    });

    const staleRun = stale.runOnce();
    await new Promise((resolve) => setTimeout(resolve, 0));
    clock.advance(30_000);
    await expect(fresh.runOnce()).resolves.toMatchObject({ claimed: 1, published: 1 });
    releaseStale();
    await expect(staleRun).resolves.toMatchObject({ claimed: 1, leaseLost: 1 });
    expect(store.rows.get(event.id)).toMatchObject({ status: "PUBLISHED", attemptCount: 2 });
  });

  it("dead-letters a reclaimed event that already exhausted its attempts", async () => {
    const { worker, store, event, handler } = setup(() => undefined);
    store.rows.get(event.id)!.attemptCount = policy.maxAttempts;
    await worker.runOnce();
    expect(store.rows.get(event.id)).toMatchObject({ status: "DEAD_LETTER", lastErrorCode: "MAX_ATTEMPTS_EXCEEDED" });
    expect(handler.calls).toEqual([]);
  });

  it("runs a polling loop until stopped", async () => {
    const { store, event } = setup(() => undefined);
    const worker = new OutboxWorker(store, {
      workerId: "loop",
      handlers: [],
      pollIntervalMs: 5,
      now: () => start,
    });
    worker.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await worker.stop();
    expect(store.rows.get(event.id)?.status).toBe("PUBLISHED");
  });
});

/** Validates: Requirements 18.1, 18.2 */
describe("OutboxWorker telemetry", () => {
  const correlationId = "6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f";

  const instrumented = (handler: OutboxEventHandler) => {
    const store = new InMemoryOutboxLeaseStore();
    const clock = new Clock(start);
    const metrics = new InMemoryMetrics();
    const spans = new InMemorySpanExporter();
    const logs: OutboxWorkerLogEvent[] = [];
    const worker = new OutboxWorker(store, {
      workerId: "worker-t",
      handlers: [handler],
      retryPolicy: policy,
      now: clock.now,
      random: () => 0,
      logger: (entry) => logs.push(entry),
      indicators: new OperationalIndicators(metrics),
      tracer: new Tracer(spans),
      backlog: store,
    });
    return { store, clock, metrics, spans, logs, worker };
  };

  it("carries the stored correlation ID into the handler, the span, and every log line", async () => {
    const seen: Array<string | undefined> = [];
    const { store, clock, spans, logs, worker } = instrumented({
      name: "probe",
      handles: () => true,
      handle: async (_event, context) => {
        seen.push(context.correlationId, currentCorrelationId());
      },
    });
    store.append({ aggregateId: "a", eventType: "BookingAccepted", payload: {}, availableAt: start, correlationId });
    clock.advance(2_500);
    await worker.runOnce();

    expect(seen).toEqual([correlationId, correlationId]);
    expect(spans.spans).toEqual([expect.objectContaining({
      name: "outbox.event.process", kind: "CONSUMER", correlationId, status: "OK",
    })]);
    expect(logs).toEqual([expect.objectContaining({ event: "outbox.event.published", correlationId, lagMs: 2_500 })]);
  });

  it("records dispatch lag, resolutions, backlog, and committed funnel and dispute events once", async () => {
    let failNext = true;
    const { store, clock, metrics, worker } = instrumented({
      name: "flaky",
      handles: (eventType) => eventType === "BookingRequested",
      handle: async () => {
        if (failNext) {
          failNext = false;
          throw Object.assign(new Error("provider down"), { code: "PROVIDER_TIMEOUT" });
        }
      },
    });
    store.append({ aggregateId: "b-1", eventType: "BookingRequested", payload: {}, availableAt: start });
    store.append({ aggregateId: "b-2", eventType: "BookingDisputed", payload: {}, availableAt: start });
    clock.advance(1_000);

    await worker.runOnce();
    expect(metrics.value("kt_outbox_backlog_events")).toBe(2);
    expect(metrics.value("kt_outbox_oldest_pending_age_ms")).toBe(1_000);
    expect(metrics.histogram("kt_outbox_dispatch_lag_ms", { event_type: "BookingRequested" }))
      .toEqual({ count: 1, sum: 1_000 });
    // The retried request is not yet a committed funnel event; the dispute is.
    expect(metrics.value("kt_outbox_events_resolved_total", { event_type: "BookingRequested", resolution: "RETRY_SCHEDULED" })).toBe(1);
    expect(metrics.value("kt_booking_funnel_events_total", { stage: "REQUESTED" })).toBe(0);
    expect(metrics.value("kt_invoice_disputes_total")).toBe(1);

    clock.advance(1_000);
    await worker.runOnce();
    expect(metrics.value("kt_booking_funnel_events_total", { stage: "REQUESTED" })).toBe(1);
    expect(metrics.total("kt_invoice_disputes_total")).toBe(1);

    clock.advance(60_000);
    await worker.runOnce();
    expect(metrics.value("kt_outbox_backlog_events")).toBe(0);
    expect(metrics.value("kt_outbox_dead_letter_events")).toBe(0);
  });
});
