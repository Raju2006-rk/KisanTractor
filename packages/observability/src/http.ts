import {
  CORRELATION_ID_HEADER,
  parseTraceparent,
  resolveCorrelationId,
  runWithTelemetryContext,
} from "./context.js";
import type { Telemetry } from "./telemetry.js";

/** The subset of a Node/Express request the middleware reads. */
export interface HttpRequestLike {
  readonly method?: string;
  headers: Record<string, string | string[] | undefined>;
  readonly baseUrl?: string;
  readonly route?: { readonly path?: unknown };
}

/** The subset of a Node/Express response the middleware writes. */
export interface HttpResponseLike {
  readonly statusCode: number;
  setHeader(name: string, value: string): unknown;
  once(event: "finish" | "close", listener: () => void): unknown;
}

/** Express route template (never the concrete path, which carries identifiers). */
export function routeTemplate(request: HttpRequestLike): string | undefined {
  const path = request.route?.path;
  if (typeof path !== "string") return undefined;
  const base = typeof request.baseUrl === "string" ? request.baseUrl : "";
  return `${base}${path}` || "/";
}

/**
 * Connect-style middleware for client requests. It accepts a valid inbound
 * `x-correlation-id` or generates one, writes the normalized value back onto
 * the request (so controllers reading the header see it) and the response,
 * continues a W3C `traceparent` when present, runs the rest of the request in
 * that telemetry context, and on completion records a server span, request
 * metrics with route-template labels, and one PII-redacted log line.
 */
export function createHttpTelemetryMiddleware(
  telemetry: Pick<Telemetry, "tracer" | "logger" | "indicators">,
  clock: () => number = () => performance.now(),
) {
  return (request: HttpRequestLike, response: HttpResponseLike, next: (error?: unknown) => void): void => {
    const { correlationId, source } = resolveCorrelationId(request.headers[CORRELATION_ID_HEADER]);
    request.headers[CORRELATION_ID_HEADER] = correlationId;
    response.setHeader(CORRELATION_ID_HEADER, correlationId);

    const remoteParent = parseTraceparent(request.headers.traceparent);
    const method = (request.method ?? "GET").toUpperCase();
    const span = telemetry.tracer.startSpan("http.server.request", {
      kind: "SERVER",
      correlationId,
      attributes: { method, correlationSource: source },
      ...(remoteParent === undefined ? {} : { remoteParent }),
    });
    const startedAt = clock();
    let finished = false;
    const complete = (): void => {
      if (finished) return;
      finished = true;
      const durationMs = Math.round((clock() - startedAt) * 1_000) / 1_000;
      const route = routeTemplate(request);
      const statusCode = response.statusCode;
      telemetry.indicators.httpRequestCompleted(method, route, statusCode, durationMs);
      span.setAttribute("route", route ?? "unmatched");
      span.setAttribute("statusCode", statusCode);
      span.end({ status: statusCode >= 500 ? "ERROR" : "OK" });
      runWithTelemetryContext(span.context, () => {
        const fields = { method, route: route ?? "unmatched", statusCode, durationMs };
        if (statusCode >= 500) telemetry.logger.error("http.request.completed", fields);
        else telemetry.logger.info("http.request.completed", fields);
      });
    };
    response.once("finish", complete);
    response.once("close", complete);
    runWithTelemetryContext(span.context, () => next());
  };
}
