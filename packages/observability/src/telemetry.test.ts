import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";

import {
  CORRELATION_ID_HEADER,
  currentCorrelationId,
  normalizeCorrelationId,
  parseTraceparent,
  resolveCorrelationId,
} from "./context.js";
import { createHttpTelemetryMiddleware, type HttpRequestLike } from "./http.js";
import { OperationalIndicators } from "./indicators.js";
import {
  createTransactionTelemetryObserver,
  createTranslationMissRecorder,
  instrumentProviderCallback,
} from "./instrumentation.js";
import { createStructuredLogger } from "./logger.js";
import { InMemoryMetrics, normalizeMetricLabels } from "./metrics.js";
import { createTelemetry } from "./telemetry.js";
import { InMemorySpanExporter, Tracer } from "./tracing.js";
import { parseWebVitalReport, webRouteGroup } from "./web-vitals.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

const harness = () => {
  const lines: string[] = [];
  const metrics = new InMemoryMetrics();
  const spans = new InMemorySpanExporter();
  const telemetry = {
    logger: createStructuredLogger({ service: "test", level: "debug", sink: (line) => lines.push(line) }),
    tracer: new Tracer(spans),
    indicators: new OperationalIndicators(metrics),
  };
  const logs = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { telemetry, metrics, spans, logs };
};

class FakeResponse extends EventEmitter {
  statusCode = 200;
  readonly headers: Record<string, string> = {};
  setHeader(name: string, value: string): void {
    this.headers[name] = value;
  }
}

/** Validates: Requirements 18.1 */
describe("correlation identifiers", () => {
  it("accepts opaque tokens and UUIDs and refuses PII-shaped or malformed values", () => {
    expect(normalizeCorrelationId("6F1C2D3E-4B5A-4C6D-8E7F-9A0B1C2D3E4F")).toBe("6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f");
    expect(normalizeCorrelationId(["web:req-abcdefgh", "ignored"])).toBe("web:req-abcdefgh");
    for (const unsafe of ["+919876543210", "9876543210ab", "ravi@example.com", "short", "has space here", "x".repeat(200), undefined, 42]) {
      expect(normalizeCorrelationId(unsafe)).toBeUndefined();
    }
    expect(resolveCorrelationId("+919876543210")).toMatchObject({ source: "GENERATED", correlationId: expect.stringMatching(UUID) });
    expect(resolveCorrelationId("web:req-abcdefgh")).toEqual({ source: "INBOUND", correlationId: "web:req-abcdefgh" });
  });

  it("continues valid W3C traceparent headers only", () => {
    expect(parseTraceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"))
      .toEqual({ traceId: "4bf92f3577b34da6a3ce929d0e0e4736", parentSpanId: "00f067aa0ba902b7" });
    expect(parseTraceparent("00-00000000000000000000000000000000-00f067aa0ba902b7-01")).toBeUndefined();
    expect(parseTraceparent("garbage")).toBeUndefined();
  });
});

/** Validates: Requirements 18.1, 18.2 */
describe("HTTP telemetry middleware", () => {
  it("echoes a valid inbound correlation ID, runs the request in its context, and records route-template metrics", async () => {
    const { telemetry, metrics, spans, logs } = harness();
    const middleware = createHttpTelemetryMiddleware(telemetry, () => 0);
    const request: HttpRequestLike & { route?: { path: string } } = {
      method: "post",
      headers: {
        [CORRELATION_ID_HEADER]: "web:req-abcdefgh",
        traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      },
      baseUrl: "",
    };
    const response = new FakeResponse();
    let seenInHandler: string | undefined;
    await new Promise<void>((resolve) => {
      middleware(request, response, () => {
        seenInHandler = currentCorrelationId();
        telemetry.logger.info("handler.ran", { phone: "9876543210" });
        resolve();
      });
    });
    request.route = { path: "/owner/bookings/:bookingId/job/:action" };
    response.statusCode = 409;
    response.emit("finish");
    response.emit("close");

    expect(response.headers[CORRELATION_ID_HEADER]).toBe("web:req-abcdefgh");
    expect(request.headers[CORRELATION_ID_HEADER]).toBe("web:req-abcdefgh");
    expect(seenInHandler).toBe("web:req-abcdefgh");
    expect(spans.spans).toEqual([expect.objectContaining({
      name: "http.server.request",
      kind: "SERVER",
      correlationId: "web:req-abcdefgh",
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      parentSpanId: "00f067aa0ba902b7",
    })]);
    expect(metrics.value("kt_http_server_requests_total", {
      method: "POST", route: "/owner/bookings/:bookingId/job/:action", status_class: "4xx",
    })).toBe(1);
    const entries = logs();
    expect(entries.map((entry) => entry.event)).toEqual(["handler.ran", "http.request.completed"]);
    expect(entries.every((entry) => entry.correlationId === "web:req-abcdefgh")).toBe(true);
    expect(entries[0]).toMatchObject({ phone: "[REDACTED]", traceId: "4bf92f3577b34da6a3ce929d0e0e4736" });
  });

  it("replaces a PII-shaped correlation ID and labels unmatched routes without the concrete path", () => {
    const { telemetry, metrics, logs } = harness();
    const middleware = createHttpTelemetryMiddleware(telemetry, () => 0);
    const request: HttpRequestLike = { method: "GET", headers: { [CORRELATION_ID_HEADER]: "+919876543210" } };
    const response = new FakeResponse();
    middleware(request, response, () => undefined);
    response.statusCode = 404;
    response.emit("finish");

    const generated = response.headers[CORRELATION_ID_HEADER];
    expect(generated).toMatch(UUID);
    expect(request.headers[CORRELATION_ID_HEADER]).toBe(generated);
    expect(metrics.value("kt_http_server_requests_total", { method: "GET", route: "OTHER", status_class: "4xx" })).toBe(1);
    expect(JSON.stringify(logs())).not.toContain("9876543210");
  });
});

describe("metric label normalization", () => {
  it("drops undeclared labels and replaces identifiers and unknown values", () => {
    expect(normalizeMetricLabels("kt_http_server_requests_total", {
      method: "GET",
      route: "/owner/bookings/70000000-0000-4000-8000-000000000001/job",
      status_class: "2xx",
      userId: "user-1",
    })).toEqual({ method: "GET", route: "OTHER", status_class: "2xx" });
    expect(normalizeMetricLabels("kt_invalid_transitions_total", { aggregate: "BOOKING", action: "ACCEPT_12345" }))
      .toEqual({ aggregate: "BOOKING", action: "OTHER" });
    expect(normalizeMetricLabels("kt_otp_requests_total", {})).toEqual({ outcome: "UNKNOWN" });
  });

  it("rejects recording a metric with the wrong kind", () => {
    const metrics = new InMemoryMetrics();
    expect(() => metrics.increment("kt_outbox_backlog_events" as never)).toThrow(TypeError);
  });
});

/** Validates: Requirements 18.1, 18.2 */
describe("transaction, translation, and provider-callback instrumentation", () => {
  it("traces domain transactions under the active request and records rollbacks with codes only", async () => {
    const { telemetry, metrics, spans, logs } = harness();
    const observe = createTransactionTelemetryObserver(telemetry);
    await telemetry.tracer.withSpan("http.server.request", { correlationId: "web:req-abcdefgh" }, () => {
      observe({ isolation: "SERIALIZABLE", readOnly: false })({ outcome: "COMMITTED", durationMs: 4 });
      observe({ isolation: "READ COMMITTED", readOnly: false, correlationId: "web:req-abcdefgh" })({
        outcome: "ROLLED_BACK",
        durationMs: 2,
        error: Object.assign(new Error("duplicate key for 9876543210"), { code: "23505" }),
      });
    });

    const transactionSpans = spans.spans.filter((span) => span.name === "db.transaction");
    const parent = spans.spans.find((span) => span.name === "http.server.request");
    expect(transactionSpans).toHaveLength(2);
    for (const span of transactionSpans) {
      expect(span).toMatchObject({ correlationId: "web:req-abcdefgh", traceId: parent?.traceId, parentSpanId: parent?.spanId });
    }
    expect(metrics.value("kt_domain_transactions_total", { isolation: "SERIALIZABLE", outcome: "COMMITTED" })).toBe(1);
    expect(metrics.value("kt_domain_transactions_total", { isolation: "READ_COMMITTED", outcome: "ROLLED_BACK" })).toBe(1);
    expect(logs()).toEqual([expect.objectContaining({
      event: "db.transaction.rolled_back", correlationId: "web:req-abcdefgh", errorCode: "SQLSTATE_23505",
    })]);
    expect(JSON.stringify(logs())).not.toContain("9876543210");
  });

  it("records translation misses by resolved locale and reason without the raw requested locale", () => {
    const { telemetry, metrics, logs } = harness();
    const record = createTranslationMissRecorder(telemetry, "WEB");
    record({ resolvedLocale: "te", key: "control.retry", reason: "MISSING_LOCALE_ENTRY" });
    record({ resolvedLocale: "en", key: "menu.home", reason: "UNSUPPORTED_LOCALE" });
    expect(metrics.value("kt_translation_misses_total", { locale: "te", reason: "MISSING_LOCALE_ENTRY", surface: "WEB" })).toBe(1);
    expect(metrics.value("kt_translation_misses_total", { locale: "en", reason: "UNSUPPORTED_LOCALE", surface: "WEB" })).toBe(1);
    expect(logs()[0]).toMatchObject({ translationKey: "control.retry", resolvedLocale: "te" });
  });

  it("wraps provider callbacks in a correlated span and counts verification outcomes", async () => {
    const { telemetry, metrics, spans } = harness();
    const seen: string[] = [];
    await instrumentProviderCallback(telemetry, "ONLINE_PAYMENT", { [CORRELATION_ID_HEADER]: "pg:evt-abcdefgh" }, async (correlationId) => {
      seen.push(correlationId, currentCorrelationId() ?? "");
      return { outcome: "REJECTED_SIGNATURE", result: undefined };
    });
    await expect(instrumentProviderCallback(telemetry, "ONLINE_PAYMENT", {}, async () => {
      throw new Error("boom");
    })).rejects.toThrow("boom");
    expect(seen).toEqual(["pg:evt-abcdefgh", "pg:evt-abcdefgh"]);
    expect(metrics.value("kt_provider_callbacks_total", { capability: "ONLINE_PAYMENT", outcome: "REJECTED_SIGNATURE" })).toBe(1);
    expect(metrics.value("kt_provider_callbacks_total", { capability: "ONLINE_PAYMENT", outcome: "FAILED" })).toBe(1);
    expect(spans.spans.map((span) => span.status)).toEqual(["OK", "ERROR"]);
  });
});

/** Validates: Requirements 18.2 */
describe("web vitals", () => {
  it("accepts only the bounded report contract", () => {
    expect(parseWebVitalReport({ vital: "LCP", value: 2_400, rating: "good", routeGroup: "farmer", url: "/x?phone=1" }))
      .toEqual({ vital: "LCP", value: 2_400, rating: "good", routeGroup: "farmer" });
    expect(parseWebVitalReport({ vital: "FID", value: 1, rating: "good", routeGroup: "farmer" })).toBeUndefined();
    expect(parseWebVitalReport({ vital: "CLS", value: 99, rating: "poor", routeGroup: "farmer" })).toBeUndefined();
    expect(parseWebVitalReport({ vital: "INP", value: 100, rating: "good", routeGroup: "/farmer/bookings/1" })).toBeUndefined();
  });

  it("maps paths to coarse route groups and records duration and CLS histograms", () => {
    expect(webRouteGroup("/")).toBe("landing");
    expect(webRouteGroup("/login/verify?challengeId=abc")).toBe("auth");
    expect(webRouteGroup("/farmer/bookings/KT-ABC123")).toBe("farmer");
    expect(webRouteGroup("/unknown/path")).toBe("other");
    const metrics = new InMemoryMetrics();
    const indicators = new OperationalIndicators(metrics);
    indicators.webVitalReported({ vital: "LCP", value: 2_000, rating: "good", routeGroup: "farmer" });
    indicators.webVitalReported({ vital: "CLS", value: 0.3, rating: "poor", routeGroup: "owner" });
    expect(metrics.histogram("kt_web_vital_duration_ms", { vital: "LCP", route_group: "farmer" })).toEqual({ count: 1, sum: 2_000 });
    expect(metrics.histogram("kt_web_vital_cls", { route_group: "owner" })).toEqual({ count: 1, sum: 0.3 });
    expect(metrics.value("kt_web_vitals_reports_total", { vital: "CLS", rating: "poor", route_group: "owner" })).toBe(1);
  });
});

describe("telemetry exporters", () => {
  it("writes spans and metric snapshots as JSON lines only for the stdout exporter", async () => {
    const lines: string[] = [];
    const stdout = createTelemetry({ service: "api", exporter: "stdout", sink: (line) => lines.push(line) });
    await stdout.tracer.withSpan("test.work", {}, () => undefined);
    stdout.indicators.otpRequested("ISSUED");
    stdout.shutdown();
    const events = lines.map((line) => (JSON.parse(line) as { event: string }).event);
    expect(events).toEqual(["trace.span", "metrics.snapshot"]);

    const quiet: string[] = [];
    const none = createTelemetry({ service: "api", exporter: "none", sink: (line) => quiet.push(line) });
    await none.tracer.withSpan("test.work", {}, () => undefined);
    none.indicators.otpRequested("ISSUED");
    none.shutdown();
    expect(quiet).toEqual([]);
    expect(none.metrics.value("kt_otp_requests_total", { outcome: "ISSUED" })).toBe(1);
  });
});
