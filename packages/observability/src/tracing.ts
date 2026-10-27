import { randomUUID } from "node:crypto";

import {
  currentTelemetryContext,
  newSpanId,
  newTraceId,
  runWithTelemetryContext,
  type TelemetryContext,
} from "./context.js";
import { redactError, redactLogFields, type LogFields } from "./redaction.js";

export type SpanKind = "SERVER" | "INTERNAL" | "CONSUMER" | "CLIENT";
export type SpanStatus = "OK" | "ERROR";

/** A finished span. Attributes are already PII-redacted. */
export interface SpanRecord {
  readonly name: string;
  readonly kind: SpanKind;
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly correlationId: string;
  readonly startTime: string;
  readonly durationMs: number;
  readonly status: SpanStatus;
  readonly errorCode?: string;
  readonly attributes: LogFields;
}

export interface SpanExporter {
  export(span: SpanRecord): void;
}

export const noopSpanExporter: SpanExporter = Object.freeze({ export: () => undefined });

/** Keeps finished spans in memory; for tests and local inspection. */
export class InMemorySpanExporter implements SpanExporter {
  readonly spans: SpanRecord[] = [];
  export(span: SpanRecord): void {
    this.spans.push(span);
  }
}

export interface SpanOptions {
  readonly kind?: SpanKind;
  readonly attributes?: Readonly<Record<string, unknown>>;
  /** Overrides the inherited correlation identifier (e.g. an outbox event's stored id). */
  readonly correlationId?: string;
  /** Continues an upstream trace (W3C traceparent) when there is no active span. */
  readonly remoteParent?: Readonly<{ traceId: string; parentSpanId: string }>;
}

export interface SpanEnd {
  readonly status?: SpanStatus;
  readonly error?: unknown;
}

export interface ActiveSpan {
  readonly context: TelemetryContext & { readonly spanId: string };
  setAttribute(key: string, value: unknown): void;
  end(result?: SpanEnd): void;
}

const SPAN_NAME = /^[a-z][a-z0-9_.]{0,79}$/u;

/**
 * Vendor-neutral tracer. It always creates trace and span identifiers so logs
 * can be joined, but only hands finished spans to the configured exporter;
 * with the no-op exporter nothing leaves the process.
 */
export class Tracer {
  constructor(
    private readonly exporter: SpanExporter = noopSpanExporter,
    private readonly clock: () => number = () => performance.now(),
    private readonly wallClock: () => Date = () => new Date(),
  ) {}

  startSpan(name: string, options: SpanOptions = {}): ActiveSpan {
    if (!SPAN_NAME.test(name)) throw new TypeError("Span names must be lower-case dotted identifiers");
    const parent = currentTelemetryContext();
    const traceId = parent?.traceId ?? options.remoteParent?.traceId ?? newTraceId();
    const parentSpanId = parent?.spanId ?? options.remoteParent?.parentSpanId;
    const correlationId = options.correlationId ?? parent?.correlationId ?? randomUUID();
    const context = Object.freeze({ correlationId, traceId, spanId: newSpanId() });
    const attributes: Record<string, unknown> = { ...options.attributes };
    const startedAt = this.clock();
    const startTime = this.wallClock().toISOString();
    let ended = false;

    return {
      context,
      setAttribute: (key, value) => {
        attributes[key] = value;
      },
      end: (result = {}) => {
        if (ended) return;
        ended = true;
        const status: SpanStatus = result.status ?? (result.error === undefined ? "OK" : "ERROR");
        const errorCode = result.error === undefined ? undefined : redactError(result.error).errorCode;
        try {
          this.exporter.export(Object.freeze({
            name,
            kind: options.kind ?? "INTERNAL",
            traceId,
            spanId: context.spanId,
            ...(parentSpanId === undefined ? {} : { parentSpanId }),
            correlationId,
            startTime,
            durationMs: Math.max(0, Math.round((this.clock() - startedAt) * 1_000) / 1_000),
            status,
            ...(typeof errorCode === "string" ? { errorCode } : {}),
            attributes: redactLogFields(attributes),
          }));
        } catch {
          // Telemetry export must never change the outcome of the traced work.
        }
      },
    };
  }

  /** Runs `work` as the active span; nested spans, logs, and transactions inherit its context. */
  async withSpan<Result>(
    name: string,
    options: SpanOptions,
    work: (span: ActiveSpan) => Promise<Result> | Result,
  ): Promise<Result> {
    const span = this.startSpan(name, options);
    try {
      const result = await runWithTelemetryContext(span.context, () => work(span));
      span.end();
      return result;
    } catch (error) {
      span.end({ error });
      throw error;
    }
  }
}
