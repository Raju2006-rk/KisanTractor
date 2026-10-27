import { validateEnvironment } from "@kisantractor/config";
import { createTelemetry, isTelemetryExporter, type Telemetry } from "@kisantractor/observability";

let instance: Telemetry | undefined;

const environmentInput = (): Readonly<Record<string, string | undefined>> => {
  if (process.env.APP_ENV) return process.env;
  const inferred = process.env.NODE_ENV === "test" ? "test" : "local";
  return { ...process.env, APP_ENV: inferred, NODE_ENV: inferred === "test" ? "test" : "development" };
};

/**
 * Server-side telemetry for the web app's route handlers and server rendering.
 * Configuration problems fall back to in-process telemetry rather than failing
 * the request, because observability must never block a user flow.
 */
export function webTelemetry(): Telemetry {
  if (instance !== undefined) return instance;
  let exporter: unknown = "none";
  let logLevel: "debug" | "info" | "warn" | "error" = "info";
  try {
    const config = validateEnvironment(environmentInput());
    exporter = config.TELEMETRY_EXPORTER;
    logLevel = config.LOG_LEVEL;
  } catch {
    // Keep defaults; environment validation errors are reported by env:check.
  }
  instance = createTelemetry({
    service: "web",
    exporter: isTelemetryExporter(exporter) ? exporter : "none",
    logLevel,
  });
  return instance;
}
