import "reflect-metadata";

import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { connect } from "node:net";

import { validateEnvironment, type EnvironmentConfig } from "@kisantractor/config";
import type { SqlConnection, SqlPool, SqlQueryResult } from "@kisantractor/database";
import { createTelemetry, type Telemetry } from "@kisantractor/observability";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { afterEach, describe, expect, it } from "vitest";

import { AppModule } from "../app.module.js";
import { IdentityCrypto } from "../identity/identity-crypto.js";
import { buildCapabilityRegistry, type RuntimeSecrets } from "../runtime-config.js";
import { installApiTelemetry } from "../telemetry.js";
import { CapturingNestLogger, DRIVER_DETAIL_PATTERN, SQL_INJECTION_PAYLOAD, UNKNOWN_ID } from "./security-harness.js";

/**
 * HTTP-level security boundaries of the composed API that need no database: credential
 * handling on every protected route, identifier validation before SQL, parameterized
 * statements, correlation-header hygiene, and production refusal of development OTP codes.
 *
 * Validates: Requirements 2.1, 2.3, 12.1, 12.2
 */

const secrets: RuntimeSecrets = Object.freeze({
  FIELD_ENCRYPTION_KEY: new Uint8Array(32).fill(11),
  LOOKUP_HASH_KEY: new Uint8Array(32).fill(12),
  OTP_HASH_KEY: new Uint8Array(32).fill(13),
  SESSION_HASH_KEY: new Uint8Array(32).fill(14),
  PHONE_ENCRYPTION_KEY: new Uint8Array(32).fill(15),
  DISCOVERY_CURSOR_SIGNING_KEY: new Uint8Array(32).fill(16),
});

/** The only access credential the fake session table recognizes; it holds both roles. */
const VALID_ACCESS_CREDENTIAL = "valid-dual-role-access-credential";
const validAccessHash = new IdentityCrypto({
  otpHashKey: secrets.OTP_HASH_KEY,
  lookupHashKey: secrets.LOOKUP_HASH_KEY,
  sessionHashKey: secrets.SESSION_HASH_KEY,
  phoneEncryptionKey: secrets.PHONE_ENCRYPTION_KEY,
}).sessionTokenHash(VALID_ACCESS_CREDENTIAL);

interface RecordedStatement {
  readonly text: string;
  readonly values: readonly unknown[];
}

/**
 * Answers the session lookup for one known credential and returns no rows for anything else,
 * recording every statement and its bound values (pool and transaction connections alike).
 */
class RecordingSessionPool implements SqlPool {
  readonly statements: RecordedStatement[] = [];

  async query<Row extends object = Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<SqlQueryResult<Row>> {
    this.statements.push({ text, values });
    if (text.includes("FROM public.auth_sessions s") && text.includes("access_token_hash = $1")) {
      return values[0] === validAccessHash
        ? { rowCount: 1, rows: [{
            id: "50000000-0000-4000-8000-000000000001", user_id: "10000000-0000-4000-8000-000000000001",
            refresh_expires_at: new Date(Date.now() + 3_600_000), revoked_at: null, status: "ACTIVE",
          }] as unknown as Row[] }
        : { rowCount: 0, rows: [] };
    }
    if (text.includes("FROM public.user_role_memberships")) {
      return { rowCount: 2, rows: [{ role_code: "FARMER" }, { role_code: "OWNER" }] as unknown as Row[] };
    }
    if (text.includes("INSERT INTO public.audit_events")) {
      return { rowCount: 1, rows: [{
        id: "a1000000-0000-4000-8000-000000000001", correlation_id: values[7],
        pii_safe_metadata: JSON.parse(String(values[8])), occurred_at: new Date(),
      }] as unknown as Row[] };
    }
    return { rowCount: 0, rows: [] };
  }

  async connect(): Promise<SqlConnection> {
    return { query: (text: string, values?: readonly unknown[]) => this.query(text, values), release: () => undefined } as SqlConnection;
  }
}

const testConfig = (overrides: Record<string, string> = {}): Readonly<EnvironmentConfig> => validateEnvironment({
  APP_ENV: "test",
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://unused:unused@127.0.0.1:5432/unused_test",
  LOG_LEVEL: "debug",
  ...overrides,
});

const productionLike = (appEnv: "production" | "staging", overrides: Record<string, string> = {}) => validateEnvironment({
  APP_ENV: appEnv,
  NODE_ENV: "production",
  API_HOST: "0.0.0.0",
  API_PORT: "4000",
  PUBLIC_WEB_ORIGIN: "https://kisantractor.example",
  PUBLIC_API_ORIGIN: "https://api.kisantractor.example",
  DATABASE_URL: "postgresql://USER:PASSWORD@db.invalid:5432/kisantractor",
  OTP_CAPABILITY_STATE: "SANDBOX",
  ...overrides,
});

interface Started {
  readonly app: INestApplication;
  readonly baseUrl: string;
  readonly pool: RecordingSessionPool;
  readonly telemetryLines: string[];
  readonly nestLogger: CapturingNestLogger;
}

let started: Started | undefined;
let removeTelemetry: (() => void) | undefined;

const start = async (config: Readonly<EnvironmentConfig> = testConfig()): Promise<Started> => {
  const pool = new RecordingSessionPool();
  const telemetryLines: string[] = [];
  const telemetry: Telemetry = createTelemetry({ service: "api", logLevel: "debug", sink: (line) => telemetryLines.push(line) });
  const nestLogger = new CapturingNestLogger();
  const app = await NestFactory.create(AppModule.register({ config, sqlPool: pool, secrets, telemetry }), { logger: nestLogger });
  removeTelemetry = installApiTelemetry(app, telemetry);
  await app.listen(0, "127.0.0.1");
  const { port } = app.getHttpServer().address() as AddressInfo;
  started = { app, baseUrl: `http://127.0.0.1:${port}`, pool, telemetryLines, nestLogger };
  return started;
};

afterEach(async () => {
  removeTelemetry?.();
  removeTelemetry = undefined;
  await started?.app.close();
  started = undefined;
});

type Method = "GET" | "POST" | "PUT";

const send = async (baseUrl: string, method: Method, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, text, body: text.length === 0 ? undefined : JSON.parse(text) as Record<string, unknown>, headers: response.headers };
};

/** Every authenticated route with a well-formed identifier wherever the path needs one. */
const PROTECTED_ROUTES: ReadonlyArray<readonly [Method, string, unknown?]> = [
  ["GET", "/identity/session"],
  ["POST", "/identity/session/revoke", {}],
  ["POST", "/account/deletion", { confirmation: "DELETE_MY_ACCOUNT" }],
  ["GET", "/owner/profile"],
  ["PUT", "/owner/profile", {}],
  ["GET", "/owner/tractors"],
  ["POST", "/owner/tractors", {}],
  ["GET", `/owner/tractors/${UNKNOWN_ID}`],
  ["PUT", `/owner/tractors/${UNKNOWN_ID}`, {}],
  ["GET", `/owner/tractors/${UNKNOWN_ID}/availability`],
  ["PUT", `/owner/tractors/${UNKNOWN_ID}/availability`, { status: "ONLINE" }],
  ["GET", "/owner/equipment"],
  ["POST", "/owner/equipment", {}],
  ["PUT", `/owner/equipment/${UNKNOWN_ID}`, {}],
  ["PUT", `/owner/equipment/${UNKNOWN_ID}/assignment`, {}],
  ["GET", `/owner/tractors/${UNKNOWN_ID}/service-offerings`],
  ["PUT", `/owner/tractors/${UNKNOWN_ID}/service-offerings`, {}],
  ["GET", `/owner/service-offerings/${UNKNOWN_ID}/pricing-rules`],
  ["PUT", `/owner/service-offerings/${UNKNOWN_ID}/pricing-rules`, {}],
  ["POST", `/owner/tractors/${UNKNOWN_ID}/eligibility/evaluate`, {}],
  ["GET", `/farmer/service-offerings/${UNKNOWN_ID}/pricing-rules`],
  ["POST", `/farmer/service-offerings/${UNKNOWN_ID}/quote-snapshots`, {}],
  ["GET", "/owner/documents"],
  ["POST", "/owner/documents/upload-grants", {}],
  ["POST", `/owner/documents/${UNKNOWN_ID}/complete`, {}],
  ["GET", `/owner/documents/${UNKNOWN_ID}/download-grant`],
  ["POST", "/farmer/discovery/search", {}],
  ["POST", "/farmer/bookings", {}],
  ["GET", "/farmer/bookings"],
  ["GET", `/farmer/bookings/${UNKNOWN_ID}`],
  ["GET", "/owner/bookings"],
  ["GET", `/owner/bookings/${UNKNOWN_ID}`],
  ["POST", `/owner/bookings/${UNKNOWN_ID}/accept`, {}],
  ["POST", `/owner/bookings/${UNKNOWN_ID}/reject`, {}],
  ["GET", `/owner/bookings/${UNKNOWN_ID}/job`],
  ["POST", `/owner/bookings/${UNKNOWN_ID}/job/start`, {}],
  ["GET", `/farmer/bookings/${UNKNOWN_ID}/job`],
  ["POST", `/farmer/bookings/${UNKNOWN_ID}/dispute`, {}],
  ["GET", `/farmer/bookings/${UNKNOWN_ID}/payments`],
  ["GET", `/owner/bookings/${UNKNOWN_ID}/payments`],
  ["GET", `/farmer/payments/${UNKNOWN_ID}/receipt`],
  ["GET", `/owner/payments/${UNKNOWN_ID}/receipt`],
  ["POST", `/owner/bookings/${UNKNOWN_ID}/payments/cash`, {}],
  ["POST", `/farmer/bookings/${UNKNOWN_ID}/payments/online`, {}],
  ["POST", `/farmer/payments/${UNKNOWN_ID}/checkout-return`, {}],
  ["GET", "/farmer/payments"],
  ["GET", "/owner/payments"],
  ["GET", `/farmer/payments/${UNKNOWN_ID}/checkout`],
  ["POST", `/farmer/payments/${UNKNOWN_ID}/status-check`, {}],
  ["POST", `/farmer/payments/${UNKNOWN_ID}/cancel`, {}],
  ["POST", `/support/payments/${UNKNOWN_ID}/refunds`, {}],
];

const bad = encodeURIComponent(SQL_INJECTION_PAYLOAD);
const serviceLocation = {
  state: "Telangana", district: "Warangal", mandalOrTaluk: "Hanamkonda", village: "Kazipet",
  source: "MANUAL_ADDRESS", latitude: 17.99, longitude: 79.54, capturedAt: new Date().toISOString(),
};
const interval = { start: new Date(Date.now() + 86_400_000).toISOString(), end: new Date(Date.now() + 90_000_000).toISOString() };

/** Attacker-controlled identifiers in paths, bodies, and query strings, with the expected refusal. */
const INJECTION_CASES: ReadonlyArray<readonly [Method, string, unknown, readonly number[]]> = [
  ["GET", `/owner/tractors/${bad}`, undefined, [404]],
  ["GET", `/owner/tractors/${bad}/availability`, undefined, [404]],
  ["PUT", `/owner/tractors/${bad}/availability`, { status: "OFFLINE", expectedVersion: 1 }, [404]],
  ["GET", `/owner/tractors/${bad}/service-offerings`, undefined, [404]],
  ["PUT", `/owner/tractors/${bad}/service-offerings`, { serviceId: UNKNOWN_ID, enabled: true }, [404]],
  ["POST", `/owner/tractors/${bad}/eligibility/evaluate`, {}, [404]],
  ["PUT", `/owner/equipment/${bad}`, { displayName: "Cultivator", expectedVersion: 1 }, [404]],
  ["PUT", `/owner/equipment/${bad}/assignment`, { tractorId: UNKNOWN_ID, expectedVersion: 1 }, [404]],
  ["GET", `/owner/service-offerings/${bad}/pricing-rules`, undefined, [404]],
  ["PUT", `/owner/service-offerings/${bad}/pricing-rules`, { method: "PER_TRIP", ratePaise: 1000, enabled: true }, [404]],
  ["GET", `/farmer/service-offerings/${bad}/pricing-rules`, undefined, [404]],
  ["POST", `/farmer/service-offerings/${bad}/quote-snapshots`, { pricingRuleId: UNKNOWN_ID, estimatedQuantity: "1" }, [404]],
  ["POST", `/owner/documents/${bad}/complete`, {}, [404]],
  ["GET", `/owner/documents/${bad}/download-grant`, undefined, [404]],
  ["GET", `/farmer/bookings/${bad}`, undefined, [404]],
  ["GET", `/owner/bookings/${bad}`, undefined, [404]],
  ["POST", `/owner/bookings/${bad}/accept`, { expectedVersion: 1 }, [404]],
  ["GET", `/owner/bookings/${bad}/job`, undefined, [404]],
  ["POST", `/owner/bookings/${bad}/job/start`, { idempotencyKey: "k-1" }, [404]],
  ["GET", `/farmer/bookings/${bad}/job`, undefined, [404]],
  ["POST", `/farmer/bookings/${bad}/dispute`, { expectedVersion: 1, reason: "Wrong acreage" }, [404]],
  ["GET", `/farmer/bookings/${bad}/payments`, undefined, [404]],
  ["GET", `/owner/bookings/${bad}/payments`, undefined, [404]],
  ["GET", `/farmer/payments/${bad}/receipt`, undefined, [404]],
  ["GET", `/owner/payments/${bad}/receipt`, undefined, [404]],
  ["POST", `/owner/bookings/${bad}/payments/cash`, { invoiceId: UNKNOWN_ID, amountPaise: 100, idempotencyKey: "k-2" }, [404]],
  ["POST", `/farmer/bookings/${bad}/payments/online`, { invoiceId: UNKNOWN_ID, amountPaise: 100, idempotencyKey: "k-5" }, [404]],
  ["POST", `/farmer/payments/${bad}/checkout-return`, {}, [404]],
  ["GET", `/farmer/payments/${bad}/checkout`, undefined, [404]],
  ["POST", `/farmer/payments/${bad}/status-check`, {}, [404]],
  ["POST", `/farmer/payments/${bad}/cancel`, {}, [404]],
  ["GET", `/farmer/payments?cursor=${bad}`, undefined, [422]],
  ["GET", `/owner/payments?limit=${bad}`, undefined, [422]],
  // The unauthenticated webhook route refuses a malformed provider name before any work.
  ["POST", `/payments/webhooks/${bad}`, {}, [404]],
  // Identifiers carried in bodies are validation failures.
  ["POST", `/owner/bookings/${UNKNOWN_ID}/payments/cash`, { invoiceId: SQL_INJECTION_PAYLOAD, amountPaise: 100, idempotencyKey: "k-3" }, [422]],
  ["POST", `/farmer/bookings/${UNKNOWN_ID}/payments/online`, { invoiceId: SQL_INJECTION_PAYLOAD, amountPaise: 100, idempotencyKey: "k-6" }, [422]],
  ["POST", "/owner/documents/upload-grants", {
    tractorId: SQL_INJECTION_PAYLOAD, documentKind: "INSURANCE", fileName: "insurance.pdf", declaredMimeType: "application/pdf", sizeBytes: 100,
  }, [422]],
  ["POST", "/owner/equipment", { equipmentTypeId: SQL_INJECTION_PAYLOAD, displayName: "Cultivator" }, [422]],
  ["PUT", `/owner/equipment/${UNKNOWN_ID}/assignment`, { tractorId: SQL_INJECTION_PAYLOAD, expectedVersion: 1 }, [422]],
  ["PUT", `/owner/tractors/${UNKNOWN_ID}/service-offerings`, { serviceId: SQL_INJECTION_PAYLOAD, enabled: true }, [422]],
  ["POST", `/farmer/service-offerings/${UNKNOWN_ID}/quote-snapshots`, { pricingRuleId: SQL_INJECTION_PAYLOAD, estimatedQuantity: "1" }, [422]],
  ["POST", "/farmer/discovery/search", { serviceLocation, serviceId: SQL_INJECTION_PAYLOAD, requestedInterval: interval }, [422]],
  ["POST", "/farmer/discovery/search", {
    serviceLocation, serviceId: UNKNOWN_ID, equipmentTypeId: SQL_INJECTION_PAYLOAD, requestedInterval: interval,
  }, [422]],
  ["POST", "/farmer/bookings", {
    bookingTarget: "MYSELF", tractorId: SQL_INJECTION_PAYLOAD, serviceOfferingId: UNKNOWN_ID, pricingRuleId: UNKNOWN_ID,
    pricingMethod: "HOURLY", expectedQuantity: "1", requestedInterval: interval, serviceLocation, idempotencyKey: "k-4",
  }, [422]],
  // Query strings.
  ["GET", `/farmer/bookings?limit=${bad}`, undefined, [422]],
  ["GET", `/owner/bookings?cursor=${bad}`, undefined, [422]],
  ["GET", `/farmer/bookings?limit=1&cursor=${bad}`, undefined, [422]],
];

describe("credential handling on every protected route", () => {
  it("refuses missing, malformed, and forged credentials with 401 and a stable code", async () => {
    const { baseUrl, telemetryLines, nestLogger } = await start();
    const credentials: ReadonlyArray<Record<string, string>> = [
      {},
      { authorization: "Basic a2lzYW46dHJhY3Rvcg==" },
      { authorization: "Bearer" },
      { authorization: "Bearer forged-access-credential" },
      { authorization: `Bearer ${VALID_ACCESS_CREDENTIAL}x` },
      { authorization: `Bearer ${SQL_INJECTION_PAYLOAD}` },
    ];
    const failures: string[] = [];
    for (const [method, path, body] of PROTECTED_ROUTES) {
      for (const headers of credentials) {
        const response = await send(baseUrl, method, path, body, headers);
        const code = response.body?.code;
        if (response.status !== 401 || (code !== "UNAUTHENTICATED" && code !== "AUTHENTICATION_REJECTED")
          || DRIVER_DETAIL_PATTERN.test(response.text)) {
          failures.push(`${method} ${path} [${headers.authorization ?? "none"}] -> ${response.status} ${response.text}`);
        }
      }
    }
    expect(failures).toEqual([]);
    // Neither the forged credentials nor the injection marker reach any log line.
    const logs = [...telemetryLines, ...nestLogger.lines].join("\n");
    expect(logs).not.toContain("forged-access-credential");
    expect(logs).not.toContain(VALID_ACCESS_CREDENTIAL);
    expect(logs).not.toContain("DROP TABLE");
  }, 60_000);
});

describe("identifier validation and parameterized SQL", () => {
  it("refuses attacker-controlled identifiers with 4xx before they reach any SQL statement", async () => {
    const { baseUrl, pool, telemetryLines, nestLogger } = await start();
    const auth = { authorization: `Bearer ${VALID_ACCESS_CREDENTIAL}`, "idempotency-key": "security-key-1" };
    const failures: string[] = [];
    for (const [method, path, body, expected] of INJECTION_CASES) {
      pool.statements.length = 0;
      const response = await send(baseUrl, method, path, body, auth);
      const reached = pool.statements.filter((statement) =>
        statement.text.includes("DROP TABLE") || JSON.stringify(statement.values).includes("DROP TABLE"));
      if (!expected.includes(response.status) || reached.length > 0 || DRIVER_DETAIL_PATTERN.test(response.text)
        || typeof response.body?.code !== "string") {
        failures.push(`${method} ${decodeURIComponent(path)} -> ${response.status} ${response.text} (statements with payload: ${reached.length})`);
      }
    }
    expect(failures).toEqual([]);
    expect([...telemetryLines, ...nestLogger.lines].join("\n")).not.toContain("DROP TABLE");
  }, 60_000);

  it("treats a malformed OTP challenge identifier exactly like a wrong code", async () => {
    const { baseUrl, pool } = await start();
    pool.statements.length = 0;
    const response = await send(baseUrl, "POST", "/identity/otp/verify", {
      challengeId: SQL_INJECTION_PAYLOAD, phone: "9876543210", purpose: "SIGN_IN", code: "123456",
    });
    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ code: "AUTHENTICATION_REJECTED" });
    expect(JSON.stringify(pool.statements)).not.toContain("DROP TABLE");
    const audit = pool.statements.find((statement) => statement.text.includes("INSERT INTO public.audit_events"));
    expect(audit?.values.slice(2, 7)).toEqual(["otp.verify", "OtpChallenge", null, "REJECTED", "MALFORMED_CHALLENGE"]);
  });

  it("binds every value as a parameter: no request text is ever interpolated into SQL", async () => {
    const { baseUrl, pool } = await start();
    const auth = { authorization: `Bearer ${VALID_ACCESS_CREDENTIAL}` };
    const marker = "Robert'); DROP TABLE public.bookings; --";
    pool.statements.length = 0;
    await send(baseUrl, "POST", "/farmer/bookings", {
      bookingTarget: "SOMEONE_ELSE", tractorId: UNKNOWN_ID, serviceOfferingId: UNKNOWN_ID, pricingRuleId: UNKNOWN_ID,
      pricingMethod: "HOURLY", expectedQuantity: "1", requestedInterval: interval,
      serviceLocation: { ...serviceLocation, village: marker, landmark: marker },
      recipient: { name: marker, coordinationConsent: true, landmarkOrDirections: marker },
    }, { ...auth, "idempotency-key": marker });
    await send(baseUrl, "PUT", "/owner/profile", {
      fullName: marker, preferredLocale: "te", contactSharingConsent: false,
      operatingLocation: { ...serviceLocation, village: marker },
    }, auth);
    await send(baseUrl, "POST", `/owner/bookings/${UNKNOWN_ID}/reject`, { expectedVersion: 1, reason: marker }, auth);
    expect(pool.statements.length).toBeGreaterThan(0);
    for (const statement of pool.statements) expect(statement.text).not.toContain("DROP TABLE");
  });
});

describe("header hygiene", () => {
  it("replaces unsafe correlation identifiers and never reflects injected header lines", async () => {
    const { baseUrl } = await start();
    for (const value of [SQL_INJECTION_PAYLOAD, "<script>alert(1)</script>", "a".repeat(300), "+91 98765 43210"]) {
      const response = await send(baseUrl, "GET", "/identity/session", undefined, { "x-correlation-id": value });
      expect(response.headers.get("x-correlation-id")).toMatch(/^[0-9a-f-]{36}$/u);
    }

    // A raw request smuggles a CRLF into the correlation header; the response must not grow a header.
    const { port } = new URL(baseUrl);
    const raw = await new Promise<string>((resolve, reject) => {
      const socket = connect(Number(port), "127.0.0.1", () => {
        socket.write("GET /identity/session HTTP/1.1\r\nHost: 127.0.0.1\r\n"
          + "x-correlation-id: web:req-abcdefgh\r\nSet-Cookie: injected=1\r\nConnection: close\r\n\r\n");
      });
      let data = "";
      socket.on("data", (chunk) => { data += chunk.toString("utf8"); });
      socket.on("end", () => resolve(data));
      socket.on("error", reject);
    });
    const [head] = raw.split("\r\n\r\n");
    expect(head).toMatch(/^HTTP\/1\.1 401/u);
    expect(head).not.toMatch(/set-cookie/iu);
    expect(head).toMatch(/x-correlation-id: web:req-abcdefgh/iu);

    // Node refuses to send a header value carrying CR/LF at all.
    expect(() => httpRequest(`${baseUrl}/identity/session`, { headers: { "x-correlation-id": "a\r\nSet-Cookie: x=1" } }))
      .toThrow(/Invalid character/iu);
  });
});

describe("production and staging refuse development OTP codes", () => {
  it("rejects ALLOW_LOCAL_OTP_CODES=true in production configuration", () => {
    expect(() => productionLike("production", { ALLOW_LOCAL_OTP_CODES: "true" })).toThrow(/ALLOW_LOCAL_OTP_CODES/u);
  });

  it("never registers the local OTP adapter outside local/test, even with the opt-in", () => {
    for (const config of [productionLike("production"), productionLike("staging", { ALLOW_LOCAL_OTP_CODES: "true" })]) {
      expect(buildCapabilityRegistry(config).getState("OTP")).toBe("DEGRADED");
    }
  });

  it.each(["production", "staging"] as const)("answers an OTP request in %s with an honest 503 and no development code", async (appEnv) => {
    const config = appEnv === "production" ? productionLike("production") : productionLike("staging", { ALLOW_LOCAL_OTP_CODES: "true" });
    const { baseUrl, pool } = await start(config);
    const response = await send(baseUrl, "POST", "/identity/otp/challenges", { phone: "9876543210", purpose: "SIGN_IN" });
    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ capability: "OTP", state: "DEGRADED" });
    expect(response.text).not.toMatch(/developmentCode|testOnly|\d{6}/u);
    expect(pool.statements.filter((statement) => statement.text.includes("otp_challenges"))).toEqual([]);
  });
});
