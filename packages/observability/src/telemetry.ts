import { OperationalIndicators } from "./indicators.js";
import { createStructuredLogger, stdoutSink, type LogLevel, type LogSink, type StructuredLogger } from "./logger.js";
import { InMemoryMetrics, type MetricSample } from "./metrics.js";
import { noopSpanExporter, Tracer, type SpanExporter, type SpanRecord } from "./tracing.js";

/**
 * Where spans and metric snapshots go. `none` keeps them in process (logs are
 * still written); `stdout` writes them as JSON lines for a log shipper or
 * collector to forward. No exporter requires a live telemetry backend.
 */
export const telemetryExporters = ["none", "stdout"] as const;
export type TelemetryExporter = (typeof telemetryExporters)[number];

export function isTelemetryExporter(value: unknown): value is TelemetryExporter {
  return typeof value === "string" && (telemetryExporters as readonly string[]).includes(value);
}

export interface TelemetryOptions {
  readonly service: string;
  readonly exporter?: TelemetryExporter;
  readonly logLevel?: LogLevel;
  readonly sink?: LogSink;
  /** Interval for stdout metric snapshots; ignored for the `none` exporter. */
  readonly metricExportIntervalMs?: number;
  readonly now?: () => Date;
  /** Replaces the exporter-derived span exporter, e.g. an in-memory exporter in tests. */
  readonly spanExporter?: SpanExporter;
}

export interface Telemetry {
  readonly service: string;
  readonly exporter: TelemetryExporter;
  readonly logger: StructuredLogger;
  readonly metrics: InMemoryMetrics;
  readonly tracer: Tracer;
  readonly indicators: OperationalIndicators;
  /** Writes one metric snapshot through the sink when the stdout exporter is active. */
  flushMetrics(): void;
  /** Stops periodic export and writes a final snapshot. */
  shutdown(): void;
}

const stdoutSpanExporter = (sink: LogSink, service: string): SpanExporter => ({
  export: (span: SpanRecord) => {
    sink(JSON.stringify({ timestamp: span.startTime, level: "info", service, event: "trace.span", ...span }));
  },
});

const serializeSnapshot = (service: string, at: Date, samples: readonly MetricSample[]): string =>
  JSON.stringify({ timestamp: at.toISOString(), level: "info", service, event: "metrics.snapshot", metrics: samples });

export function createTelemetry(options: TelemetryOptions): Telemetry {
  const exporter = options.exporter ?? "none";
  const sink = options.sink ?? stdoutSink;
  const now = options.now ?? (() => new Date());
  const metrics = new InMemoryMetrics();
  const spanExporter = options.spanExporter
    ?? (exporter === "stdout" ? stdoutSpanExporter(sink, options.service) : noopSpanExporter);
  const tracer = new Tracer(spanExporter);
  const logger = createStructuredLogger({
    service: options.service,
    level: options.logLevel ?? "info",
    sink,
    now,
  });

  const flushMetrics = (): void => {
    if (exporter !== "stdout") return;
    const samples = metrics.snapshot();
    if (samples.length === 0) return;
    try {
      sink(serializeSnapshot(options.service, now(), samples));
    } catch {
      // Export failures never affect the instrumented process.
    }
  };

  let timer: ReturnType<typeof setInterval> | undefined;
  if (exporter === "stdout") {
    timer = setInterval(flushMetrics, options.metricExportIntervalMs ?? 60_000);
    timer.unref?.();
  }

  const indicators = new OperationalIndicators(metrics);
  indicators.initializeAlertBaselines();

  return Object.freeze({
    service: options.service,
    exporter,
    logger,
    metrics,
    tracer,
    indicators,
    flushMetrics,
    shutdown: () => {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      flushMetrics();
    },
  });
}
