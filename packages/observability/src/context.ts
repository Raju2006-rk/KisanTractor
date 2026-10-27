import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes, randomUUID } from "node:crypto";

import { containsSensitiveText } from "./redaction.js";

export const CORRELATION_ID_HEADER = "x-correlation-id";
export const TRACEPARENT_HEADER = "traceparent";

/** Request-scoped identifiers that every log line, span, and transaction can join on. */
export interface TelemetryContext {
  readonly correlationId: string;
  readonly traceId: string;
  readonly spanId?: string;
}

const storage = new AsyncLocalStorage<TelemetryContext>();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const CORRELATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/u;
const ZERO_TRACE = /^0+$/u;

const firstHeaderValue = (value: unknown): string | undefined => {
  const first = Array.isArray(value) ? (value as readonly unknown[])[0] : value;
  return typeof first === "string" ? first.trim() : undefined;
};

/**
 * Accepts an inbound correlation identifier only when it is a bounded, opaque
 * token. Values that look like phone numbers, OTPs, tokens, or other personal
 * data are refused, so a client cannot smuggle PII into every log line.
 */
export function normalizeCorrelationId(value: unknown): string | undefined {
  const candidate = firstHeaderValue(value);
  if (candidate === undefined || !CORRELATION_ID.test(candidate)) return undefined;
  if (UUID.test(candidate)) return candidate.toLowerCase();
  return containsSensitiveText(candidate) ? undefined : candidate;
}

export interface ResolvedCorrelationId {
  readonly correlationId: string;
  readonly source: "INBOUND" | "GENERATED";
}

/** Uses a valid inbound correlation identifier or generates a new UUID. */
export function resolveCorrelationId(
  value: unknown,
  generate: () => string = randomUUID,
): ResolvedCorrelationId {
  const inbound = normalizeCorrelationId(value);
  return inbound === undefined
    ? Object.freeze({ correlationId: generate(), source: "GENERATED" as const })
    : Object.freeze({ correlationId: inbound, source: "INBOUND" as const });
}

/** Parses a W3C `traceparent` header so an upstream trace continues; invalid values start a new trace. */
export function parseTraceparent(value: unknown): Readonly<{ traceId: string; parentSpanId: string }> | undefined {
  const candidate = firstHeaderValue(value)?.toLowerCase();
  const match = candidate === undefined ? null : TRACEPARENT.exec(candidate);
  if (match?.[1] === undefined || match[2] === undefined) return undefined;
  if (ZERO_TRACE.test(match[1]) || ZERO_TRACE.test(match[2])) return undefined;
  return Object.freeze({ traceId: match[1], parentSpanId: match[2] });
}

export const newTraceId = (): string => randomBytes(16).toString("hex");
export const newSpanId = (): string => randomBytes(8).toString("hex");

/** Runs `work` with the given telemetry context visible to every nested async call. */
export function runWithTelemetryContext<Result>(context: TelemetryContext, work: () => Result): Result {
  return storage.run(Object.freeze({ ...context }), work);
}

export function currentTelemetryContext(): TelemetryContext | undefined {
  return storage.getStore();
}

export function currentCorrelationId(): string | undefined {
  return storage.getStore()?.correlationId;
}
