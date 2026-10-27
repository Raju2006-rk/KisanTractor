import type { LoggerService } from "@nestjs/common";

/**
 * Captures everything Nest's own logger would print (bootstrap, route mapping, and the
 * unhandled-exception handler's stack traces) so security suites can assert it stays PII-free.
 */
export class CapturingNestLogger implements LoggerService {
  readonly lines: string[] = [];

  #push(level: string, values: readonly unknown[]): void {
    this.lines.push(`${level} ${values.map((value) =>
      value instanceof Error ? `${value.name}: ${value.message}\n${value.stack ?? ""}` : String(value)).join(" ")}`);
  }

  log(...values: unknown[]): void { this.#push("log", values); }
  error(...values: unknown[]): void { this.#push("error", values); }
  warn(...values: unknown[]): void { this.#push("warn", values); }
  debug(...values: unknown[]): void { this.#push("debug", values); }
  verbose(...values: unknown[]): void { this.#push("verbose", values); }
  fatal(...values: unknown[]): void { this.#push("fatal", values); }
}

/** A marker that is easy to find anywhere it might leak: SQL text, bound values, logs, or bodies. */
export const SQL_INJECTION_PAYLOAD = "x' OR '1'='1'; DROP TABLE public.users; --";

/** Response bodies must never carry driver or SQL details. */
export const DRIVER_DETAIL_PATTERN = /syntax|invalid input|postgres|\bpg_|SELECT |INSERT |UPDATE |\bstack\b|DROP TABLE|at .+\.(?:js|ts):\d+/iu;

/** Valid but unknown identifier used where a route needs a well-formed ID. */
export const UNKNOWN_ID = "8b3f2c1e-1111-4111-8111-111111111111";
