import { CORRELATION_ID_HEADER, resolveCorrelationId } from "./context.js";
import type { ProviderCallbackCapability, ProviderCallbackOutcome, TranslationSurface } from "./indicators.js";
import { redactError } from "./redaction.js";
import type { Telemetry } from "./telemetry.js";

/** Structural match for `TransactionObserver` in `@kisantractor/database`. */
export interface ObservedTransactionStart {
  readonly correlationId?: string;
  readonly isolation: string;
  readonly readOnly: boolean;
}

export interface ObservedTransactionEnd {
  readonly outcome: "COMMITTED" | "ROLLED_BACK";
  readonly durationMs: number;
  readonly error?: unknown;
}

/**
 * Observes domain transactions: one span per transaction (a child of the
 * active request or outbox span), outcome/duration metrics, and a log line
 * for rollbacks carrying only the error code.
 */
export function createTransactionTelemetryObserver(telemetry: Pick<Telemetry, "tracer" | "logger" | "indicators">) {
  return (start: ObservedTransactionStart) => {
    const span = telemetry.tracer.startSpan("db.transaction", {
      kind: "INTERNAL",
      attributes: { isolation: start.isolation, readOnly: start.readOnly },
      ...(start.correlationId === undefined ? {} : { correlationId: start.correlationId }),
    });
    return (end: ObservedTransactionEnd): void => {
      telemetry.indicators.domainTransactionCompleted(start.isolation, end.outcome, end.durationMs);
      span.end(end.outcome === "COMMITTED" ? { status: "OK" } : { status: "ERROR", error: end.error });
      if (end.outcome === "ROLLED_BACK") {
        telemetry.logger.info("db.transaction.rolled_back", {
          correlationId: span.context.correlationId,
          traceId: span.context.traceId,
          spanId: span.context.spanId,
          isolation: start.isolation,
          durationMs: end.durationMs,
          ...redactError(end.error),
        });
      }
    };
  };
}

/** Structural match for `MissingTranslationEvent` in `@kisantractor/i18n`. */
export interface ObservedTranslationMiss {
  readonly resolvedLocale: string;
  readonly key: string;
  readonly reason: string;
}

/**
 * Translation-miss telemetry (Requirement 13.3). The raw requested locale is
 * not recorded because it comes from client input; the message key is
 * code-defined and logged for catalog maintenance but never used as a label.
 */
export function createTranslationMissRecorder(
  telemetry: Pick<Telemetry, "logger" | "indicators">,
  surface: TranslationSurface,
) {
  return (event: ObservedTranslationMiss): void => {
    telemetry.indicators.translationMissed(event.resolvedLocale, event.reason, surface);
    telemetry.logger.debug("i18n.translation.missed", {
      resolvedLocale: event.resolvedLocale,
      translationKey: /^[a-z][a-zA-Z0-9_.-]{0,119}$/u.test(event.key) ? event.key : "INVALID_KEY",
      reasonCode: event.reason,
      surface,
    });
  };
}

export interface ProviderCallbackResult<Result> {
  readonly outcome: ProviderCallbackOutcome;
  readonly result: Result;
}

/**
 * Wraps a provider callback (payment webhook, telephony event) in a
 * correlation context and span, then records its verification outcome.
 * Phase 1 has no provider callback routes; Phase 2/3 routes must use this so
 * callbacks are traced and counted the same way as client requests.
 */
export async function instrumentProviderCallback<Result>(
  telemetry: Pick<Telemetry, "tracer" | "logger" | "indicators">,
  capability: ProviderCallbackCapability,
  headers: Readonly<Record<string, unknown>>,
  handle: (correlationId: string) => Promise<ProviderCallbackResult<Result>>,
): Promise<Result> {
  const { correlationId } = resolveCorrelationId(headers[CORRELATION_ID_HEADER]);
  return telemetry.tracer.withSpan("provider.callback", {
    kind: "SERVER",
    correlationId,
    attributes: { capability },
  }, async (span) => {
    try {
      const { outcome, result } = await handle(correlationId);
      span.setAttribute("outcome", outcome);
      telemetry.indicators.providerCallbackHandled(capability, outcome);
      telemetry.logger.info("provider.callback.handled", { capability, outcome });
      return result;
    } catch (error) {
      telemetry.indicators.providerCallbackHandled(capability, "FAILED");
      telemetry.logger.error("provider.callback.failed", { capability, ...redactError(error) });
      throw error;
    }
  });
}
