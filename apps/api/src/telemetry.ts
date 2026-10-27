import type { EnvironmentConfig } from "@kisantractor/config";
import { registerTransactionObserver } from "@kisantractor/database";
import { subscribeToTranslationMisses } from "@kisantractor/i18n";
import {
  createHttpTelemetryMiddleware,
  createTelemetry,
  createTransactionTelemetryObserver,
  createTranslationMissRecorder,
  isTelemetryExporter,
  type LogSink,
  type Telemetry,
  type TranslationSurface,
} from "@kisantractor/observability";

/** Builds the process telemetry bundle from validated configuration. */
export function createProcessTelemetry(
  config: Readonly<EnvironmentConfig>,
  service: "api" | "outbox-worker",
  sink?: LogSink,
): Telemetry {
  // Hand-built test configs may omit the field; fall back to in-process telemetry.
  const exporter: unknown = config.TELEMETRY_EXPORTER;
  return createTelemetry({
    service,
    exporter: isTelemetryExporter(exporter) ? exporter : "none",
    logLevel: config.LOG_LEVEL,
    ...(sink === undefined ? {} : { sink }),
  });
}

/**
 * Registers the process-wide hooks that do not belong to a single request:
 * domain-transaction spans/metrics and translation-miss telemetry. Returns a
 * function that removes them (used on shutdown and in tests).
 */
export function registerProcessTelemetry(telemetry: Telemetry, surface: TranslationSurface): () => void {
  const removeTransactionObserver = registerTransactionObserver(createTransactionTelemetryObserver(telemetry));
  const removeTranslationListener = subscribeToTranslationMisses(createTranslationMissRecorder(telemetry, surface));
  return () => {
    removeTransactionObserver();
    removeTranslationListener();
  };
}

interface MiddlewareHost {
  use(...handlers: unknown[]): unknown;
}

/**
 * Installs request telemetry on an HTTP application: correlation-ID
 * validation/generation and echo, the request span, request metrics, and one
 * redacted log line per request. Must run before routing so controllers see
 * the normalized `x-correlation-id` header.
 */
export function installApiTelemetry(app: MiddlewareHost, telemetry: Telemetry): () => void {
  app.use(createHttpTelemetryMiddleware(telemetry));
  return registerProcessTelemetry(telemetry, "API");
}
