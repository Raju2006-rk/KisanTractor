import { currentTelemetryContext } from "./context.js";
import { redactLogFields } from "./redaction.js";

export const logLevels = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof logLevels)[number];

/** Receives one serialized JSON log line. */
export type LogSink = (line: string) => void;

export interface StructuredLogger {
  debug(event: string, fields?: Readonly<Record<string, unknown>>): void;
  info(event: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(event: string, fields?: Readonly<Record<string, unknown>>): void;
  error(event: string, fields?: Readonly<Record<string, unknown>>): void;
  /** Returns a logger that adds `bindings` to every entry. */
  child(bindings: Readonly<Record<string, unknown>>): StructuredLogger;
}

export interface StructuredLoggerOptions {
  readonly service: string;
  readonly level?: LogLevel;
  readonly sink?: LogSink;
  readonly now?: () => Date;
  readonly bindings?: Readonly<Record<string, unknown>>;
}

const EVENT_NAME = /^[a-z][a-z0-9_.]{0,119}$/u;
const RESERVED_FIELDS = new Set(["timestamp", "level", "service", "event"]);

export const stdoutSink: LogSink = (line) => {
  process.stdout.write(`${line}\n`);
};

/**
 * JSON-lines logger. Every entry carries the active correlation, trace, and span
 * identifiers and passes through the central PII redaction before it is written.
 */
export function createStructuredLogger(options: StructuredLoggerOptions): StructuredLogger {
  const threshold = logLevels.indexOf(options.level ?? "info");
  const sink = options.sink ?? stdoutSink;
  const now = options.now ?? (() => new Date());
  const bindings = options.bindings ?? {};

  const write = (level: LogLevel, event: string, fields: Readonly<Record<string, unknown>> = {}): void => {
    if (logLevels.indexOf(level) < threshold) return;
    const context = currentTelemetryContext();
    const merged: Record<string, unknown> = {
      ...(context === undefined ? {} : {
        correlationId: context.correlationId,
        traceId: context.traceId,
        ...(context.spanId === undefined ? {} : { spanId: context.spanId }),
      }),
    };
    for (const [key, value] of Object.entries({ ...bindings, ...fields })) {
      if (!RESERVED_FIELDS.has(key)) merged[key] = value;
    }
    try {
      sink(JSON.stringify({
        timestamp: now().toISOString(),
        level,
        service: options.service,
        event: EVENT_NAME.test(event) ? event : "log.invalid_event_name",
        ...redactLogFields(merged),
      }));
    } catch {
      // Logging must never fail the work being logged.
    }
  };

  const logger: StructuredLogger = {
    debug: (event, fields) => write("debug", event, fields),
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields),
    child: (extra) => createStructuredLogger({ ...options, bindings: { ...bindings, ...extra } }),
  };
  return Object.freeze(logger);
}
