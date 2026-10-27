import "reflect-metadata";
import type { AddressInfo } from "node:net";

import {
  withDomainTransaction,
  type SqlConnection,
  type SqlPool,
  type SqlQueryResult,
} from "@kisantractor/database";
import { createLocalization } from "@kisantractor/i18n";
import {
  CORRELATION_ID_HEADER,
  InMemorySpanExporter,
  createStructuredLogger,
  createTelemetry,
  type Telemetry,
} from "@kisantractor/observability";
import { InMemoryOutboxLeaseStore } from "@kisantractor/test-utils";
import { Controller, Headers, HttpCode, Module, Post, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { afterEach, describe, expect, it } from "vitest";

import { AppModule, type AppModuleOverrides } from "./app.module.js";
import { NotificationTemplateRenderer } from "./notification/notification-templates.js";
import { OutboxWorker } from "./outbox/outbox-worker.js";
import type { RuntimeSecrets } from "./runtime-config.js";
import { installApiTelemetry } from "./telemetry.js";

interface RecordedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

/** Records every statement of a domain transaction and answers audit/outbox inserts like PostgreSQL. */
class RecordingPool implements SqlPool {
  readonly queries: RecordedQuery[] = [];

  async query<Row extends object = Record<string, unknown>>(): Promise<SqlQueryResult<Row>> {
    return { rows: [], rowCount: 0 };
  }

  async connect(): Promise<SqlConnection> {
    const queries = this.queries;
    return {
      release: () => undefined,
      async query<Row extends object = Record<string, unknown>>(text: string, values: readonly unknown[] = []) {
        queries.push({ text, values });
        if (text.includes("INSERT INTO public.audit_events")) {
          return { rowCount: 1, rows: [{
            id: "audit-1", correlation_id: values[7], pii_safe_metadata: JSON.parse(String(values[8])),
            occurred_at: new Date("2026-05-12T04:00:00.000Z"),
          }] as unknown as Row[] };
        }
        if (text.includes("INSERT INTO public.outbox_events")) {
          return { rowCount: 1, rows: [{
            id: "70000000-0000-4000-8000-000000000001", aggregate_type: values[0], aggregate_id: values[1],
            event_type: values[2], event_version: values[3], payload: JSON.parse(String(values[4])),
            status: "PENDING", available_at: new Date("2026-05-12T04:00:00.000Z"),
            created_at: new Date("2026-05-12T04:00:00.000Z"), correlation_id: values[6],
          }] as unknown as Row[] };
        }
        return { rows: [] as Row[], rowCount: 0 };
      },
    } as SqlConnection;
  }
}

let probePool = new RecordingPool();

/**
 * A minimal command endpoint that writes an audit row and an outbox event in
 * one domain transaction. Decorators are applied as functions because test
 * files are not compiled with legacy decorator syntax.
 */
class ProbeController {
  async run(correlationId: string) {
    const event = await withDomainTransaction(probePool, { correlationId, isolation: "SERIALIZABLE" }, async (tx) => {
      await tx.appendAudit({
        actorChannel: "WEB", action: "booking.accept", resourceType: "Booking", outcome: "SUCCESS",
        metadata: { recipientPhone: "+919876543210" },
      });
      return tx.appendOutbox({
        aggregateType: "Booking", aggregateId: "booking-1", eventType: "BookingAccepted", eventVersion: 2,
        payload: { bookingId: "booking-1", notificationRecipients: ["farmer-1"] },
      });
    });
    return { outboxEventId: event.id };
  }
}
const runDescriptor = Object.getOwnPropertyDescriptor(ProbeController.prototype, "run")!;
Headers(CORRELATION_ID_HEADER)(ProbeController.prototype, "run", 0);
Post()(ProbeController.prototype, "run", runDescriptor);
HttpCode(202)(ProbeController.prototype, "run", runDescriptor);
Controller("probe")(ProbeController);
class ProbeModule {}
Module({ controllers: [ProbeController] })(ProbeModule);

const capture = () => {
  const lines: string[] = [];
  const spans = new InMemorySpanExporter();
  const telemetry = createTelemetry({ service: "api", logLevel: "debug", sink: (line) => lines.push(line), spanExporter: spans });
  const logs = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { telemetry, spans, logs, lines };
};

const listen = async (app: INestApplication): Promise<string> => {
  await app.listen(0, "127.0.0.1");
  const { port } = app.getHttpServer().address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
};

let app: INestApplication | undefined;
let removeTelemetry: (() => void) | undefined;

afterEach(async () => {
  removeTelemetry?.();
  removeTelemetry = undefined;
  await app?.close();
  app = undefined;
});

/** Validates: Requirements 18.1 */
describe("correlation ID propagation end to end", () => {
  it("carries one correlation ID from the request through the transaction, audit, outbox row, and worker log", async () => {
    const { telemetry, spans, logs, lines } = capture();
    const pool = new RecordingPool();
    probePool = pool;

    app = await NestFactory.create(ProbeModule, { logger: false });
    removeTelemetry = installApiTelemetry(app, telemetry);
    const base = await listen(app);

    const correlationId = "web:req-abcdefgh-0001";
    const response = await fetch(`${base}/probe`, { method: "POST", headers: { [CORRELATION_ID_HEADER]: correlationId } });
    expect(response.status).toBe(202);
    expect(response.headers.get(CORRELATION_ID_HEADER)).toBe(correlationId);

    // Transaction: correlation set transaction-locally, then written to audit and outbox rows.
    const setConfig = pool.queries.find((query) => query.text.includes("set_config('app.correlation_id'"));
    const audit = pool.queries.find((query) => query.text.includes("INSERT INTO public.audit_events"));
    const outbox = pool.queries.find((query) => query.text.includes("INSERT INTO public.outbox_events"));
    expect(setConfig?.values).toEqual([correlationId]);
    expect(audit?.values[7]).toBe(correlationId);
    expect(outbox?.values[6]).toBe(correlationId);
    expect(outbox?.text).toContain("current_setting('app.correlation_id', true)");

    // Worker: the stored correlation ID drives the consumer span and the worker log line.
    const store = new InMemoryOutboxLeaseStore();
    store.append({
      aggregateId: String(outbox?.values[1]), eventType: String(outbox?.values[2]), payload: {},
      availableAt: new Date("2026-05-12T04:00:00.000Z"), correlationId: String(outbox?.values[6]),
    });
    const workerLogger = createStructuredLogger({ service: "outbox-worker", sink: (line) => lines.push(line) });
    const worker = new OutboxWorker(store, {
      workerId: "worker-e2e",
      handlers: [],
      now: () => new Date("2026-05-12T04:00:01.000Z"),
      tracer: telemetry.tracer,
      indicators: telemetry.indicators,
      logger: ({ event, ...fields }) => workerLogger.info(event, fields),
    });
    await worker.runOnce();

    const spanNames = spans.spans.map((span) => [span.name, span.correlationId]);
    expect(spanNames).toEqual(expect.arrayContaining([
      ["db.transaction", correlationId],
      ["http.server.request", correlationId],
      ["outbox.event.process", correlationId],
    ]));
    const request = spans.spans.find((span) => span.name === "http.server.request");
    const transaction = spans.spans.find((span) => span.name === "db.transaction");
    expect(transaction).toMatchObject({ traceId: request?.traceId, parentSpanId: request?.spanId });

    const entries = logs();
    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ service: "api", event: "http.request.completed", correlationId, route: "/probe", statusCode: 202 }),
      expect.objectContaining({ service: "outbox-worker", event: "outbox.event.published", correlationId }),
    ]));
    // Audit metadata and logs stay free of the recipient phone.
    expect(String(audit?.values[8])).not.toContain("9876543210");
    expect(lines.join("\n")).not.toContain("9876543210");
    expect(telemetry.metrics.value("kt_domain_transactions_total", { isolation: "SERIALIZABLE", outcome: "COMMITTED" })).toBe(1);
    expect(telemetry.metrics.value("kt_http_server_requests_total", { method: "POST", route: "/probe", status_class: "2xx" })).toBe(1);
  });
});

const fakeSecrets: RuntimeSecrets = Object.freeze({
  FIELD_ENCRYPTION_KEY: new Uint8Array(32).fill(1),
  LOOKUP_HASH_KEY: new Uint8Array(32).fill(2),
  OTP_HASH_KEY: new Uint8Array(32).fill(3),
  SESSION_HASH_KEY: new Uint8Array(32).fill(4),
  PHONE_ENCRYPTION_KEY: new Uint8Array(32).fill(5),
  DISCOVERY_CURSOR_SIGNING_KEY: new Uint8Array(32).fill(6),
});

const overrides = (telemetry: Telemetry): AppModuleOverrides => ({
  sqlPool: new RecordingPool(),
  secrets: fakeSecrets,
  telemetry,
  config: {
    CONFIG_VERSION: "1", APP_ENV: "test", NODE_ENV: "test", API_HOST: "127.0.0.1", API_PORT: 4100,
    PUBLIC_WEB_ORIGIN: "http://localhost:3100", PUBLIC_API_ORIGIN: "http://localhost:4100",
    DATABASE_URL: "postgresql://unused:unused@localhost:5432/unused", LOG_LEVEL: "warn",
    TELEMETRY_EXPORTER: "none", ENABLE_PWA: false,
    OTP_CAPABILITY_STATE: "UNCONFIGURED", MAPS_CAPABILITY_STATE: "UNCONFIGURED",
    PAYMENT_CAPABILITY_STATE: "UNCONFIGURED", MESSAGING_CAPABILITY_STATE: "UNCONFIGURED",
    STORAGE_CAPABILITY_STATE: "UNCONFIGURED", TELEPHONY_CAPABILITY_STATE: "UNCONFIGURED",
    ALLOW_LOCAL_OTP_CODES: false, ALLOW_UNSIGNED_PROVIDER_CALLBACKS: false,
    ALLOW_FAKE_PHONE_NUMBERS: false, ALLOW_TEST_PAYMENT_SUCCESS: false,
  } as NonNullable<AppModuleOverrides["config"]>,
});

/** Validates: Requirements 18.1 */
describe("API composition telemetry", () => {
  it("returns a correlation ID on real routes and replaces PII-shaped inbound values", async () => {
    const { telemetry, logs } = capture();
    app = await NestFactory.create(AppModule.register(overrides(telemetry)), { logger: false });
    removeTelemetry = installApiTelemetry(app, telemetry);
    const base = await listen(app);

    const valid = await fetch(`${base}/farmer/bookings/booking-1/job`, { headers: { [CORRELATION_ID_HEADER]: "web:req-abcdefgh" } });
    expect(valid.status).toBe(401);
    expect(valid.headers.get(CORRELATION_ID_HEADER)).toBe("web:req-abcdefgh");

    const smuggled = await fetch(`${base}/farmer/bookings/booking-1/job`, { headers: { [CORRELATION_ID_HEADER]: "+919876543210" } });
    expect(smuggled.headers.get(CORRELATION_ID_HEADER)).toMatch(/^[0-9a-f-]{36}$/u);

    expect(telemetry.metrics.value("kt_http_server_requests_total", {
      method: "GET", route: "/farmer/bookings/:bookingId/job", status_class: "4xx",
    })).toBe(2);
    expect(JSON.stringify(logs())).not.toMatch(/9876543210|booking-1/u);
  });
});

/** Validates: Requirements 13.3, 18.2 */
describe("translation-miss telemetry", () => {
  it("records a miss when a notification template falls back to English", () => {
    const misses: unknown[] = [];
    const renderer = new NotificationTemplateRenderer(createLocalization({
      catalogs: { te: {} },
      onMissingTranslation: (event) => misses.push(event),
    }));
    expect(renderer.templateLocale("notification.booking.accepted", "te")).toBe("en");
    expect(renderer.templateLocale("notification.booking.accepted", "en")).toBe("en");
    expect(misses).toEqual([expect.objectContaining({
      resolvedLocale: "te", key: "notification.booking.accepted", reason: "MISSING_LOCALE_ENTRY",
    })]);
  });
});
