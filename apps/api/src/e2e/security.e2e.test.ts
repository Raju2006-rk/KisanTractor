import "reflect-metadata";

import { randomUUID } from "node:crypto";

import { createTelemetry } from "@kisantractor/observability";
import { createTestDatabaseFactory, type TestDatabase } from "@kisantractor/test-utils";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../app.module.js";
import type { DocumentMalwareScanner, DocumentMalwareScanResult } from "../catalog/index.js";
import { CapturingNestLogger, DRIVER_DETAIL_PATTERN } from "../security/security-harness.js";
import { PgPoolAdapter } from "../sql-pool.js";
import { installApiTelemetry } from "../telemetry.js";
import {
  ApiClient,
  DomainClock,
  ephemeralSecrets,
  listeningBaseUrl,
  SandboxObjectStorage,
  verticalSliceConfig,
  type HttpResult,
} from "./vertical-slice-harness.js";

/**
 * Phase 1 security suite over real HTTP against the composed Nest application and a real
 * PostgreSQL/PostGIS database: OTP abuse, sessions, cross-role/object access, uploads, signed
 * grants, injection, location/contact exposure, booking races, invoice tampering, encryption
 * at rest, and PII-safe logs. Gated like the other database suites; see src/e2e/README.md.
 *
 * Validates: Requirements 2.1, 2.3, 4.5, 4.6, 8.6, 12.1, 12.2, 12.3, 12.6
 */
const databaseUrl = process.env.SECURITY_E2E_DATABASE_URL;
const describeDatabase = databaseUrl === undefined ? describe.skip : describe;

type Json = Record<string, any>;

const SERVICE_PLOUGHING = "30000000-0000-4000-8000-000000000001";
const UNKNOWN = "8b3f2c1e-1111-4111-8111-111111111111";
/** Plaintext personal data used in this suite; none of it may appear at rest, in logs, or to strangers. */
const PHONES = {
  ownerA: "9848022338", ownerB: "9848022339", farmerA: "9876543210", farmerB: "9000000001", recipient: "9123456780",
} as const;
const REGISTRATIONS = { a1: "TS03AB1234", a2: "TS03AB5678", b1: "TS02CD9012" } as const;
const FARM = { latitude: 17.991234, longitude: 79.541234 } as const;
const TRACTOR_A1 = { latitude: 17.978412, longitude: 79.530123 } as const;
const TRACTOR_A2 = { latitude: 17.979567, longitude: 79.531987 } as const;
const RECIPIENT_NAME = "Lakshmi Devi";
const OWNER_NAME = "Raju Naik";
const SQL_NAME = "Robert'); DROP TABLE public.users; --";

const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n", "ascii");
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 1)]);

/** Labelled sandbox scanner whose verdict each test sets explicitly. */
class ControllableScanner implements DocumentMalwareScanner {
  result: DocumentMalwareScanResult = "CLEAN";
  async scan(): Promise<DocumentMalwareScanResult> {
    return this.result;
  }
}

describeDatabase("Phase 1 security over HTTP and PostgreSQL", () => {
  const clock = new DomainClock();
  const storage = new SandboxObjectStorage();
  const scanner = new ControllableScanner();
  const telemetryLines: string[] = [];
  const nestLogger = new CapturingNestLogger();
  /** Every OTP code and credential the API ever returned, for the log and at-rest scans. */
  const issuedCodes: string[] = [];
  const issuedCredentials: string[] = [];
  let database: TestDatabase;
  let pool: PgPoolAdapter;
  let app: INestApplication;
  let removeTelemetry: () => void;
  let baseUrl: string;
  let ownerA: ApiClient;
  let ownerB: ApiClient;
  let farmerA: ApiClient;
  let farmerB: ApiClient;
  const ids: Record<string, string> = {};
  let agentSequence = 0;

  const anonymous = (label = `kisan-security-${++agentSequence}`) => new ApiClient(baseUrl, label);
  const day = new Date(Math.ceil(clock.now().getTime() / 3_600_000) * 3_600_000 + 24 * 3_600_000);
  const at = (hours: number) => new Date(day.getTime() + hours * 3_600_000).toISOString();
  const interval = (from: number, to: number) => ({ start: at(from), end: at(to) });
  const location = (village: string, point: { latitude: number; longitude: number }, extra: Json = {}) => ({
    state: "Telangana", district: "Warangal", mandalOrTaluk: "Hanamkonda", village, source: "MANUAL_ADDRESS",
    latitude: point.latitude, longitude: point.longitude, capturedAt: clock.now().toISOString(), ...extra,
  });

  const requestOtp = async (client: ApiClient, phone: string, purpose: string) => {
    const response = await client.post("/identity/otp/challenges", { phone, purpose });
    if (typeof response.body?.developmentCode === "string") issuedCodes.push(response.body.developmentCode);
    return response;
  };

  const verifyOtp = async (client: ApiClient, body: Json) => {
    const response = await client.post("/identity/otp/verify", body);
    for (const key of ["accessCredential", "refreshCredential"]) {
      if (typeof response.body?.[key] === "string") issuedCredentials.push(response.body[key]);
    }
    return response;
  };

  const wrongCode = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, "0");

  const signIn = async (phone: string, purpose: "REGISTER_FARMER" | "REGISTER_OWNER") => {
    const client = anonymous();
    const challenge = await requestOtp(client, phone, purpose);
    expect(challenge.status, JSON.stringify(challenge.body)).toBe(201);
    const verified = await verifyOtp(client, { challengeId: challenge.body.challengeId, phone, purpose, code: challenge.body.developmentCode });
    expect(verified.status, JSON.stringify(verified.body)).toBe(200);
    return { client: client.withCredential(verified.body.accessCredential), session: verified.body as Json };
  };

  /** Authoritative state that a denied command must leave untouched (Requirement 2.3). */
  const mutableState = async (): Promise<string> => {
    const result = await pool.query<{ state: string }>(`SELECT json_build_object(
      'bookings', (SELECT json_agg(json_build_array(id, status, version) ORDER BY id) FROM public.bookings),
      'tractors', (SELECT json_agg(json_build_array(id, version, operational_status, eligibility_status) ORDER BY id) FROM public.tractors),
      'documents', (SELECT json_agg(json_build_array(id, version, scan_status) ORDER BY id) FROM public.documents),
      'offerings', (SELECT json_agg(json_build_array(id, version, enabled) ORDER BY id) FROM public.service_offerings),
      'pricing', (SELECT json_agg(json_build_array(id, version, enabled, rate_paise) ORDER BY id) FROM public.pricing_rules),
      'equipment', (SELECT json_agg(json_build_array(id, version, tractor_id) ORDER BY id) FROM public.equipment),
      'counts', json_build_array(
        (SELECT count(*) FROM public.work_events), (SELECT count(*) FROM public.work_measurements),
        (SELECT count(*) FROM public.invoices), (SELECT count(*) FROM public.payments),
        (SELECT count(*) FROM public.booking_status_history), (SELECT count(*) FROM public.booking_agreements),
        (SELECT count(*) FROM public.outbox_events))
    )::text AS state`);
    return result.rows[0]!.state;
  };

  const expectDenied = (response: HttpResult, label: string, statuses: readonly number[] = [404]) => {
    expect(statuses, `${label}: ${response.status} ${JSON.stringify(response.body)}`).toContain(response.status);
    expect(JSON.stringify(response.body ?? "")).not.toMatch(DRIVER_DETAIL_PATTERN);
  };

  const upload = async (client: ApiClient, tractorId: string, documentKind: string, bytes: Buffer, options: {
    declaredMimeType?: string; storedContentType?: string; declaredSize?: number; expiresAt?: string; fileName?: string;
  } = {}) => {
    const declaredMimeType = options.declaredMimeType ?? "application/pdf";
    const grant = await client.post("/owner/documents/upload-grants", {
      tractorId, documentKind, fileName: options.fileName ?? `${documentKind.toLowerCase()}.pdf`, declaredMimeType,
      sizeBytes: options.declaredSize ?? bytes.length, ...(options.expiresAt === undefined ? {} : { expiresAt: options.expiresAt }),
    });
    expect(grant.status, JSON.stringify(grant.body)).toBe(201);
    storage.upload(grant.body.grant.url, bytes, options.storedContentType ?? declaredMimeType);
    return { grant: grant.body as Json, complete: () => client.post(`/owner/documents/${grant.body.document.id}/complete`) };
  };

  beforeAll(async () => {
    pool = new PgPoolAdapter(new Pool({ connectionString: databaseUrl, max: 12 }));
    database = await createTestDatabaseFactory({ databaseUrl: databaseUrl!, createPool: async () => pool })();
    await pool.query(`INSERT INTO public.services (id, stable_code, display_name) VALUES ($1, 'PLOUGHING', 'Ploughing')`, [SERVICE_PLOUGHING]);
    const telemetry = createTelemetry({ service: "api", logLevel: "debug", sink: (line) => telemetryLines.push(line) });
    app = await NestFactory.create(AppModule.register({
      config: verticalSliceConfig(databaseUrl!),
      sqlPool: pool,
      secrets: ephemeralSecrets(),
      telemetry,
      sandboxProviders: { OBJECT_STORAGE: storage },
      documentScanner: scanner,
      domainClock: clock.now,
    }), { logger: nestLogger });
    removeTelemetry = installApiTelemetry(app, telemetry);
    await app.listen(0, "127.0.0.1");
    baseUrl = listeningBaseUrl(app);
  }, 120_000);

  afterAll(async () => {
    removeTelemetry?.();
    await app?.close();
    await database?.dispose();
  });

  describe("OTP abuse resistance", () => {
    it("signs in two Owners and two Farmers with explicit roles", async () => {
      const signed = await Promise.all([
        signIn(PHONES.ownerA, "REGISTER_OWNER"), signIn(PHONES.ownerB, "REGISTER_OWNER"),
        signIn(PHONES.farmerA, "REGISTER_FARMER"), signIn(PHONES.farmerB, "REGISTER_FARMER"),
      ]);
      [ownerA, ownerB, farmerA, farmerB] = signed.map((entry) => entry.client) as [ApiClient, ApiClient, ApiClient, ApiClient];
      [ids.ownerA, ids.ownerB, ids.farmerA, ids.farmerB] = signed.map((entry) => entry.session.principal.userId as string);
      expect(signed.map((entry) => entry.session.principal.roles)).toEqual([["OWNER"], ["OWNER"], ["FARMER"], ["FARMER"]]);
    });

    it("throttles requests per phone without issuing more codes, in the same generic shape", async () => {
      const phone = "9111111111";
      const issued = [];
      for (let index = 0; index < 3; index += 1) issued.push(await requestOtp(anonymous(), phone, "SIGN_IN"));
      expect(issued.every((response) => response.status === 201 && /^\d{6}$/u.test(response.body.developmentCode))).toBe(true);

      const throttled = await requestOtp(anonymous(), phone, "REGISTER_FARMER");
      const invalidPhone = await requestOtp(anonymous(), "12345", "SIGN_IN");
      for (const response of [throttled, invalidPhone]) {
        expect(response.status).toBe(201);
        expect(Object.keys(response.body).sort()).toEqual(["accepted", "challengeId", "expiresAt", "message"]);
        expect(response.body.message).toBe(throttled.body.message);
      }
      // The throttled challenge was never stored, so nothing can verify against it.
      const stored = await pool.query("SELECT 1 FROM public.otp_challenges WHERE id = $1", [throttled.body.challengeId]);
      expect(stored.rowCount).toBe(0);
      const verify = await verifyOtp(anonymous(), { challengeId: throttled.body.challengeId, phone, purpose: "REGISTER_FARMER", code: "000000" });
      expect(verify.status).toBe(401);
      const audits = await pool.query("SELECT count(*)::int AS n FROM public.audit_events WHERE action = 'otp.request' AND reason_code = 'RATE_LIMITED'");
      expect(audits.rows[0]).toEqual({ n: 1 });
    });

    it("throttles a single requester across many phones", async () => {
      const flood = anonymous("kisan-security-flood");
      const responses = [];
      for (let index = 0; index < 6; index += 1) responses.push(await requestOtp(flood, `92000000${10 + index}`, "SIGN_IN"));
      expect(responses.map((response) => typeof response.body.developmentCode === "string"))
        .toEqual([true, true, true, true, true, false]);
    });

    it("holds the phone throttle under concurrent requests without errors", async () => {
      const responses = await Promise.all(Array.from({ length: 6 }, () => requestOtp(anonymous(), "9333333333", "SIGN_IN")));
      expect(responses.map((response) => response.status)).toEqual(Array(6).fill(201));
      expect(responses.filter((response) => typeof response.body.developmentCode === "string").length).toBeLessThanOrEqual(3);
    });

    it("does not reveal whether a phone has an account", async () => {
      const existing = await requestOtp(anonymous(), PHONES.farmerA, "SIGN_IN");
      const unknown = await requestOtp(anonymous(), "9444444444", "SIGN_IN");
      expect(existing.status).toBe(unknown.status);
      expect(Object.keys(existing.body).sort()).toEqual(Object.keys(unknown.body).sort());
      expect(existing.body.message).toBe(unknown.body.message);

      // SIGN_IN for a phone with no account fails exactly like a wrong code, even with the right code.
      const noAccount = await verifyOtp(anonymous(), { challengeId: unknown.body.challengeId, phone: "9444444444", purpose: "SIGN_IN", code: unknown.body.developmentCode });
      const wrong = await verifyOtp(anonymous(), { challengeId: existing.body.challengeId, phone: PHONES.farmerA, purpose: "SIGN_IN", code: wrongCode(existing.body.developmentCode) });
      expect(noAccount.status).toBe(401);
      expect(noAccount.body).toEqual(wrong.body);
      expect((await pool.query("SELECT count(*)::int AS n FROM public.users")).rows[0]).toEqual({ n: 4 });
    });

    it("binds a challenge to its phone and purpose and counts mismatches as attempts", async () => {
      const phone = "9555555555";
      const challenge = await requestOtp(anonymous(), phone, "REGISTER_FARMER");
      const code = challenge.body.developmentCode;
      const otherPhone = await verifyOtp(anonymous(), { challengeId: challenge.body.challengeId, phone: "9555555556", purpose: "REGISTER_FARMER", code });
      const otherPurpose = await verifyOtp(anonymous(), { challengeId: challenge.body.challengeId, phone, purpose: "REGISTER_OWNER", code });
      expect([otherPhone.status, otherPurpose.status]).toEqual([401, 401]);
      const row = await pool.query("SELECT attempt_count FROM public.otp_challenges WHERE id = $1", [challenge.body.challengeId]);
      expect(row.rows[0]).toEqual({ attempt_count: 2 });
      // Formatting variants normalize to the same bound phone.
      const verified = await verifyOtp(anonymous(), { challengeId: challenge.body.challengeId, phone: "+91 95555 55555", purpose: "REGISTER_FARMER", code });
      expect(verified.status).toBe(200);
      expect(verified.body.principal.roles).toEqual(["FARMER"]);
    });

    it("caps verification attempts and invalidates the challenge", async () => {
      const phone = "9666666666";
      const challenge = await requestOtp(anonymous(), phone, "REGISTER_FARMER");
      const body = { challengeId: challenge.body.challengeId, phone, purpose: "REGISTER_FARMER" };
      for (let index = 0; index < 3; index += 1) {
        expect((await verifyOtp(anonymous(), { ...body, code: wrongCode(challenge.body.developmentCode) })).status).toBe(401);
      }
      expect((await verifyOtp(anonymous(), { ...body, code: challenge.body.developmentCode })).status).toBe(401);
      const row = await pool.query("SELECT invalidation_reason, consumed_at FROM public.otp_challenges WHERE id = $1", [challenge.body.challengeId]);
      expect(row.rows[0]).toEqual({ invalidation_reason: "ATTEMPTS_EXHAUSTED", consumed_at: null });
    });

    it("expires challenges and refuses replay of a consumed code", async () => {
      const phone = "9777777777";
      const expiring = await requestOtp(anonymous(), phone, "REGISTER_FARMER");
      await pool.query(`UPDATE public.otp_challenges SET created_at = now() - interval '10 minutes', expires_at = now() - interval '5 minutes'
        WHERE id = $1`, [expiring.body.challengeId]);
      const late = await verifyOtp(anonymous(), { challengeId: expiring.body.challengeId, phone, purpose: "REGISTER_FARMER", code: expiring.body.developmentCode });
      expect(late.status).toBe(401);
      expect((await pool.query("SELECT invalidation_reason FROM public.otp_challenges WHERE id = $1", [expiring.body.challengeId])).rows[0])
        .toEqual({ invalidation_reason: "EXPIRED" });

      const fresh = await requestOtp(anonymous(), phone, "REGISTER_FARMER");
      const body = { challengeId: fresh.body.challengeId, phone, purpose: "REGISTER_FARMER", code: fresh.body.developmentCode };
      expect((await verifyOtp(anonymous(), body)).status).toBe(200);
      const sessions = (await pool.query("SELECT count(*)::int AS n FROM public.auth_sessions")).rows[0];
      expect((await verifyOtp(anonymous(), body)).status).toBe(401);
      expect((await pool.query("SELECT count(*)::int AS n FROM public.auth_sessions")).rows[0]).toEqual(sessions);
    });

    it("issues exactly one session when the same code is verified concurrently", async () => {
      const phone = "9888888888";
      const challenge = await requestOtp(anonymous(), phone, "REGISTER_OWNER");
      const body = { challengeId: challenge.body.challengeId, phone, purpose: "REGISTER_OWNER", code: challenge.body.developmentCode };
      const responses = await Promise.all(Array.from({ length: 5 }, () => verifyOtp(anonymous(), body)));
      expect(responses.map((response) => response.status).sort()).toEqual([200, 401, 401, 401, 401]);
    });

    it("creates one account when two challenges for a new phone verify concurrently", async () => {
      const phone = "9898989898";
      const first = await requestOtp(anonymous(), phone, "REGISTER_FARMER");
      const second = await requestOtp(anonymous(), phone, "REGISTER_OWNER");
      const responses = await Promise.all([
        verifyOtp(anonymous(), { challengeId: first.body.challengeId, phone, purpose: "REGISTER_FARMER", code: first.body.developmentCode }),
        verifyOtp(anonymous(), { challengeId: second.body.challengeId, phone, purpose: "REGISTER_OWNER", code: second.body.developmentCode }),
      ]);
      expect(responses.map((response) => response.status)).toEqual([200, 200]);
      expect(responses[0]!.body.principal.userId).toBe(responses[1]!.body.principal.userId);
      const users = await pool.query("SELECT count(*)::int AS n FROM public.users WHERE id = $1", [responses[0]!.body.principal.userId]);
      expect(users.rows[0]).toEqual({ n: 1 });
    });
  });

  describe("sessions", () => {
    it("rotates refresh credentials, retires the old pair, and refuses reuse", async () => {
      const { client, session } = await signIn("9123412345", "REGISTER_FARMER");
      const refresh = (credential: string) => anonymous().post("/identity/session/refresh", { refreshCredential: credential });
      const rotated = await refresh(session.refreshCredential);
      expect(rotated.status).toBe(200);
      issuedCredentials.push(rotated.body.accessCredential, rotated.body.refreshCredential);
      expect(rotated.body.principal.userId).toBe(session.principal.userId);
      expect(rotated.body.principal.sessionId).not.toBe(session.principal.sessionId);
      expect((await client.get("/identity/session")).status).toBe(401);
      expect((await refresh(session.refreshCredential)).status).toBe(401);

      const current = client.withCredential(rotated.body.accessCredential);
      expect((await current.get("/identity/session")).status).toBe(200);
      const tampered = `${rotated.body.accessCredential.slice(0, -1)}${rotated.body.accessCredential.endsWith("A") ? "B" : "A"}`;
      expect((await client.withCredential(tampered).get("/farmer/bookings")).status).toBe(401);
      expect((await refresh("not-a-real-refresh-credential")).status).toBe(401);

      // Exactly one of several concurrent refreshes with the same credential succeeds.
      const racing = await Promise.all(Array.from({ length: 5 }, () => refresh(rotated.body.refreshCredential)));
      expect(racing.map((response) => response.status).sort()).toEqual([200, 401, 401, 401, 401]);
      const winner = racing.find((response) => response.status === 200)!;
      issuedCredentials.push(winner.body.accessCredential, winner.body.refreshCredential);

      // Revocation ends both the access and refresh credentials immediately.
      const latest = client.withCredential(winner.body.accessCredential);
      expect((await latest.post("/identity/session/revoke")).status).toBe(204);
      expect((await latest.get("/farmer/bookings")).status).toBe(401);
      expect((await refresh(winner.body.refreshCredential)).status).toBe(401);
      expect((await latest.post("/identity/session/revoke")).status).toBe(401);
    });

    it("refuses expired access and refresh credentials", async () => {
      const { client, session } = await signIn("9123498765", "REGISTER_FARMER");
      await pool.query(`UPDATE public.auth_sessions SET access_expires_at = created_at + interval '1 millisecond',
        refresh_expires_at = created_at + interval '2 milliseconds' WHERE id = $1`, [session.principal.sessionId]);
      expect((await client.get("/identity/session")).status).toBe(401);
      expect((await anonymous().post("/identity/session/refresh", { refreshCredential: session.refreshCredential })).status).toBe(401);
    });

    it("stores only hashes of OTP codes and session credentials", async () => {
      const sessions = await pool.query<{ text: string }>("SELECT row_to_json(s)::text AS text FROM public.auth_sessions s");
      const challenges = await pool.query<{ code_hash: string }>("SELECT code_hash FROM public.otp_challenges");
      const serialized = sessions.rows.map((row) => row.text).join("\n");
      for (const credential of issuedCredentials) expect(serialized).not.toContain(credential);
      expect(challenges.rows.length).toBeGreaterThan(10);
      for (const row of challenges.rows) {
        expect(row.code_hash).toMatch(/^[0-9a-f]{64}$/u);
        expect(issuedCodes).not.toContain(row.code_hash);
      }
    });
  });

  describe("catalog, uploads, and signed grants", () => {
    it("onboards Owner A with two discoverable Tractors and Owner B with one private Tractor", async () => {
      // Owner A records a GPS operating location with explicit consent (Requirement 12.6).
      const gps = location("Hanamkonda", TRACTOR_A1, {
        source: "DEVICE_GPS", accuracyMeters: 12, consentedAt: new Date(clock.now().getTime() - 60_000).toISOString(),
      });
      const withoutConsent = await ownerA.put("/owner/profile", {
        fullName: OWNER_NAME, preferredLocale: "te", contactSharingConsent: false, operatingLocation: { ...gps, consentedAt: undefined },
      });
      expect(withoutConsent.status).toBe(422);
      expect(withoutConsent.body).toMatchObject({ code: "CATALOG_VALIDATION_FAILED", field: "consentedAt" });
      expect((await ownerA.put("/owner/profile", {
        fullName: OWNER_NAME, preferredLocale: "te", contactSharingConsent: false, operatingLocation: gps,
      })).status).toBe(200);
      // A SQL-shaped name is data: stored verbatim, executed never.
      expect((await ownerB.put("/owner/profile", {
        fullName: SQL_NAME, preferredLocale: "en", contactSharingConsent: false,
        operatingLocation: location("Karimnagar", { latitude: 18.438612, longitude: 79.128834 }),
      })).status).toBe(200);

      const tractor = async (client: ApiClient, registrationNumber: string, point: { latitude: number; longitude: number }) => {
        const response = await client.post("/owner/tractors", {
          brand: "Mahindra", model: "575 DI", registrationNumber, manufacturingYear: 2021, horsepower: 47,
          operatingLocation: location("Hanamkonda", point),
        });
        expect(response.status, JSON.stringify(response.body)).toBe(201);
        return response.body.id as string;
      };
      const stored = await pool.query("SELECT full_name FROM public.user_profiles WHERE user_id = $1", [ids.ownerB]);
      expect(stored.rows[0]).toEqual({ full_name: SQL_NAME });
      expect((await pool.query("SELECT count(*)::int AS n FROM public.users")).rows[0].n).toBeGreaterThan(4);
      expect((await ownerB.get("/owner/profile")).body.fullName).toBe(SQL_NAME);

      ids.a1 = await tractor(ownerA, REGISTRATIONS.a1, TRACTOR_A1);
      ids.a2 = await tractor(ownerA, REGISTRATIONS.a2, TRACTOR_A2);
      ids.b1 = await tractor(ownerB, REGISTRATIONS.b1, { latitude: 18.438612, longitude: 79.128834 });

      // A registration identity is unique across Owners and the conflict reveals no one else's data.
      const duplicate = await ownerB.post("/owner/tractors", {
        brand: "Swaraj", model: "744 FE", registrationNumber: "ts 03 ab 1234", manufacturingYear: 2020,
        operatingLocation: location("Karimnagar", { latitude: 18.43, longitude: 79.12 }),
      });
      expect(duplicate.status, JSON.stringify(duplicate.body)).toBe(409);
      expect(duplicate.body).toMatchObject({ code: "CATALOG_CONFLICT" });
      expect(JSON.stringify(duplicate.body)).not.toMatch(new RegExp(`${ids.a1}|${ids.ownerA}|${OWNER_NAME}`, "u"));

      const offering = async (tractorId: string) => {
        const response = await ownerA.put(`/owner/tractors/${tractorId}/service-offerings`, { serviceId: SERVICE_PLOUGHING, enabled: true });
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        return response.body.id as string;
      };
      ids.offeringA1 = await offering(ids.a1);
      ids.offeringA2 = await offering(ids.a2);
      const price = async (offeringId: string, rule: Json) => {
        const response = await ownerA.put(`/owner/service-offerings/${offeringId}/pricing-rules`, { enabled: true, ...rule });
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        return response.body.id as string;
      };
      ids.hourlyA1 = await price(ids.offeringA1, { method: "HOURLY", ratePaise: 80_000, roundingPolicy: "PROPORTIONAL_MINUTE" });
      ids.perAcreA1 = await price(ids.offeringA1, { method: "PER_ACRE", ratePaise: 120_000 });
      ids.hourlyA2 = await price(ids.offeringA2, { method: "HOURLY", ratePaise: 70_000, roundingPolicy: "PROPORTIONAL_MINUTE" });

      // Going online while ineligible is refused with reasons, not a server error.
      const availability = await ownerA.get(`/owner/tractors/${ids.a1}/availability`);
      const early = await ownerA.put(`/owner/tractors/${ids.a1}/availability`, { status: "ONLINE", expectedVersion: availability.body.version });
      expect(early.status, JSON.stringify(early.body)).toBe(409);
      expect(early.body).toMatchObject({ code: "TRACTOR_AVAILABILITY_REJECTED" });
      expect(early.body.reasonCodes).toContain("REQUIRED_DOCUMENTS_MISSING");

      for (const tractorId of [ids.a1, ids.a2]) {
        for (const kind of ["REGISTRATION_CERTIFICATE", "INSURANCE"]) {
          const accepted = await (await upload(ownerA, tractorId, kind, PDF)).complete();
          expect(accepted.body, JSON.stringify(accepted.body)).toMatchObject({ scanStatus: "ACCEPTED" });
          ids[`doc-${tractorId}-${kind}`] = accepted.body.id;
        }
        expect((await ownerA.post(`/owner/tractors/${tractorId}/eligibility/evaluate`)).body).toMatchObject({ status: "ELIGIBLE" });
        const current = await ownerA.get(`/owner/tractors/${tractorId}/availability`);
        const online = await ownerA.put(`/owner/tractors/${tractorId}/availability`, { status: "ONLINE", expectedVersion: current.body.version });
        expect(online.status, JSON.stringify(online.body)).toBe(200);
      }
      ids.docA = ids[`doc-${ids.a1}-INSURANCE`]!;
      const bDoc = await (await upload(ownerB, ids.b1, "INSURANCE", PDF)).complete();
      ids.docB = bDoc.body.id;
    });

    it("validates declared type, content signature, size, and file name before accepting an upload", async () => {
      const grant = (body: Json) => ownerA.post("/owner/documents/upload-grants", {
        tractorId: ids.a1, documentKind: "PERMIT", fileName: "permit.pdf", declaredMimeType: "application/pdf", sizeBytes: 100, ...body,
      });
      const refusals: ReadonlyArray<readonly [Json, string]> = [
        [{ declaredMimeType: "text/html", fileName: "permit.html" }, "UNSUPPORTED_MIME_TYPE"],
        [{ declaredMimeType: "image/svg+xml", fileName: "permit.svg" }, "UNSUPPORTED_MIME_TYPE"],
        [{ fileName: "permit.exe" }, "EXTENSION_MIME_MISMATCH"],
        [{ fileName: "permit.pdf.exe" }, "EXTENSION_MIME_MISMATCH"],
        [{ fileName: "../../etc/passwd.pdf" }, "INVALID_FILE_NAME"],
        [{ fileName: "..\\..\\boot.pdf" }, "INVALID_FILE_NAME"],
        [{ fileName: "permit\u0000.pdf" }, "INVALID_FILE_NAME"],
        [{ fileName: `${"a".repeat(180)}.pdf` }, "INVALID_FILE_NAME"],
        [{ sizeBytes: 10 * 1024 * 1024 + 1 }, "INVALID_SIZE"],
        [{ sizeBytes: 0 }, "INVALID_SIZE"],
        [{ sizeBytes: 1.5 }, "INVALID_SIZE"],
        [{ sizeBytes: "100" }, "INVALID_SIZE"],
        [{ documentKind: "PERMIT'; DROP TABLE documents; --" }, "INVALID_DOCUMENT_KIND"],
        [{ expiresAt: "not-a-date" }, "INVALID_EXPIRY"],
        [{ tractorId: ids.b1 }, "INVALID_RESOURCE_SCOPE"],
        [{ tractorId: "../tractors/other" }, "INVALID_RESOURCE_ID"],
      ];
      const before = await pool.query("SELECT count(*)::int AS n FROM public.documents");
      for (const [body, reasonCode] of refusals) {
        const response = await grant(body);
        expect(response.status, `${JSON.stringify(body)} -> ${JSON.stringify(response.body)}`).toBe(422);
        expect(response.body).toMatchObject({ code: "DOCUMENT_VALIDATION_FAILED", reasonCode });
      }
      expect((await pool.query("SELECT count(*)::int AS n FROM public.documents")).rows[0]).toEqual(before.rows[0]);

      // The private object key is server-generated: client file names never shape it.
      const named = await upload(ownerA, ids.a1, "PERMIT", PDF, { fileName: "Permit scan (front) %2e%2e%2f copy.pdf" });
      expect(decodeURIComponent(named.grant.grant.url)).toMatch(/\/private\/documents\/[0-9a-f-]{36}$/u);
      expect(JSON.stringify(named.grant.document)).not.toMatch(/objectKey/iu);

      // Stored bytes are inspected: signature, stored content type, and size must all match the claim.
      const signature = await (await upload(ownerA, ids.a1, "PERMIT", PNG)).complete();
      const contentType = await (await upload(ownerA, ids.a1, "PERMIT", PDF, { storedContentType: "image/png" })).complete();
      const size = await (await upload(ownerA, ids.a1, "PERMIT", PDF, { declaredSize: PDF.length - 1 })).complete();
      expect(signature.body).toMatchObject({ scanStatus: "REJECTED", rejectionCode: "MIME_SIGNATURE_MISMATCH" });
      expect(contentType.body).toMatchObject({ scanStatus: "REJECTED", rejectionCode: "MIME_SIGNATURE_MISMATCH" });
      expect(size.body).toMatchObject({ scanStatus: "REJECTED", rejectionCode: "SIZE_MISMATCH" });

      // A rejected upload cannot be completed again or downloaded.
      expect((await ownerA.post(`/owner/documents/${signature.body.id}/complete`)).status).toBe(409);
      expect((await ownerA.get(`/owner/documents/${signature.body.id}/download-grant`)).status).toBe(409);
    });

    it("accepts a document only after a clean scan and keeps it pending while scanning is unavailable", async () => {
      scanner.result = "INFECTED";
      const infected = await (await upload(ownerA, ids.a1, "PERMIT", PDF)).complete();
      expect(infected.body).toMatchObject({ scanStatus: "REJECTED", rejectionCode: "MALWARE_DETECTED" });

      scanner.result = "UNAVAILABLE";
      const pending = await upload(ownerA, ids.a1, "PERMIT", PDF);
      const unavailable = await pending.complete();
      expect(unavailable.status).toBe(503);
      expect(unavailable.body).toMatchObject({ code: "DOCUMENT_SCAN_UNAVAILABLE", retryable: true });
      const listed = await ownerA.get("/owner/documents");
      expect(listed.status).toBe(200);
      expect(listed.body.items.find((item: Json) => item.id === pending.grant.document.id)).toMatchObject({ scanStatus: "PENDING_SCAN" });
      expect((await ownerA.get(`/owner/documents/${pending.grant.document.id}/download-grant`)).status).toBe(409);

      scanner.result = "CLEAN";
      expect((await pending.complete()).body).toMatchObject({ scanStatus: "ACCEPTED" });
    });

    it("lists only the Owner's own document metadata", async () => {
      const [mine, theirs] = await Promise.all([ownerA.get("/owner/documents"), ownerB.get("/owner/documents")]);
      expect(mine.status).toBe(200);
      expect(mine.body.items.length).toBeGreaterThan(5);
      expect(mine.body.items.every((item: Json) => item.ownerId === ids.ownerA)).toBe(true);
      expect(theirs.body.items.map((item: Json) => item.id)).toEqual([ids.docB]);
      expect(JSON.stringify(mine.body)).not.toMatch(/objectKey|private\/documents|"url"/iu);
      expect((await farmerA.get("/owner/documents")).status).toBe(404);
    });

    it("issues short-lived download grants only to the document's Owner", async () => {
      const granted = await ownerA.get(`/owner/documents/${ids.docA}/download-grant`);
      expect(granted.status).toBe(200);
      const lifetime = new Date(granted.body.grant.expiresAt).getTime() - clock.now().getTime();
      expect(lifetime).toBeGreaterThan(0);
      expect(lifetime).toBeLessThanOrEqual(2 * 60_000);
      expect(granted.body.grant.url).toMatch(/^https:\/\//u);

      const before = await mutableState();
      for (const [client, label] of [[ownerB, "other Owner"], [farmerA, "Farmer"]] as const) {
        expectDenied(await client.get(`/owner/documents/${ids.docA}/download-grant`), `${label} download`);
        expectDenied(await client.post(`/owner/documents/${ids.docA}/complete`), `${label} complete`);
      }
      expectDenied(await ownerA.get(`/owner/documents/${UNKNOWN}/download-grant`), "unknown document");
      expect(await mutableState()).toBe(before);
      const audits = await pool.query("SELECT count(*)::int AS n FROM public.audit_events WHERE action = 'document.download.grant'");
      expect(audits.rows[0]).toEqual({ n: 1 });
    });
  });

  describe("discovery exposure and signed cursors", () => {
    it("shows approximate distance without coordinates, registrations, phones, or Owner identity", async () => {
      const search = await farmerA.post("/farmer/discovery/search", {
        serviceLocation: location("Kazipet", FARM), serviceId: SERVICE_PLOUGHING, requestedInterval: interval(10, 12), pageSize: 1,
      });
      expect(search.status, JSON.stringify(search.body)).toBe(201);
      expect(search.body.items).toHaveLength(1);
      expect(typeof search.body.nextCursor).toBe("string");
      const serialized = JSON.stringify(search.body);
      expect(serialized).not.toMatch(/latitude|longitude|registration|phone|ownerId|userId/iu);
      for (const value of [TRACTOR_A1.latitude, TRACTOR_A1.longitude, TRACTOR_A2.latitude, TRACTOR_A2.longitude, ...Object.values(REGISTRATIONS)]) {
        expect(serialized).not.toContain(String(value));
      }
      expect(serialized).not.toContain(ids.ownerA);
      expect(serialized).not.toContain(OWNER_NAME);
      ids.cursor = search.body.nextCursor;
    });

    it("refuses tampered cursors and cursors from a different search", async () => {
      const body = { serviceLocation: location("Kazipet", FARM), serviceId: SERVICE_PLOUGHING, requestedInterval: interval(10, 12), pageSize: 1 };
      const next = await farmerA.post("/farmer/discovery/search", { ...body, cursor: ids.cursor });
      expect(next.status).toBe(201);
      expect(next.body.items).toHaveLength(1);

      const [payload, signature] = ids.cursor!.split(".") as [string, string];
      const forgedPayload = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString("utf8")), d: 0 })).toString("base64url");
      // Change the first character: the last base64url character of a 32-byte signature carries
      // padding bits, so swapping it between "A" and "B" can decode to the same bytes.
      const flipped = `${signature.startsWith("A") ? "B" : "A"}${signature.slice(1)}`;
      for (const cursor of [`${forgedPayload}.${signature}`, `${payload}.${flipped}`, "garbage", `${payload}.`, "' OR '1'='1"]) {
        const response = await farmerA.post("/farmer/discovery/search", { ...body, cursor });
        expect(response.status, cursor).toBe(422);
        expect(response.body).toMatchObject({ code: "DISCOVERY_VALIDATION_FAILED", field: "cursor" });
      }
      const otherSearch = await farmerA.post("/farmer/discovery/search", { ...body, requestedInterval: interval(13, 15), cursor: ids.cursor });
      expect(otherSearch.status).toBe(422);
    });
  });

  describe("bookings: tampering, cross-object access, and races", () => {
    it("ignores client-supplied prices, totals, statuses, and parties when creating a booking", async () => {
      const created = await farmerA.post("/farmer/bookings", {
        bookingTarget: "MYSELF", tractorId: ids.a1, serviceOfferingId: ids.offeringA1, pricingRuleId: ids.hourlyA1,
        pricingMethod: "HOURLY", expectedQuantity: "1.5", requestedInterval: interval(0, 3), serviceLocation: location("Kazipet", FARM),
        // Tampering attempts: none of these fields are accepted from the client.
        ratePaise: 1, estimatedTotalPaise: 1, status: "ACCEPTED", customerId: ids.farmerB, ownerId: ids.ownerB,
        quoteSnapshot: { ratePaise: 1, estimatedTotalPaise: 1, method: "PER_TRIP" },
      }, { "idempotency-key": "security-self-1" });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      expect(created.body).toMatchObject({
        status: "PENDING_OWNER_RESPONSE", version: 1,
        quoteSnapshot: { method: "HOURLY", ratePaise: 80_000, estimatedQuantity: "1.5", estimatedTotalPaise: 120_000 },
      });
      ids.self = created.body.id;
      const stored = await pool.query("SELECT customer_id, owner_id FROM public.bookings WHERE id = $1", [ids.self]);
      expect(stored.rows[0]).toEqual({ customer_id: ids.farmerA, owner_id: ids.ownerA });
    });

    it("requires consent before storing a Recipient's coordination phone and stores it encrypted", async () => {
      const body = {
        bookingTarget: "SOMEONE_ELSE", tractorId: ids.a1, serviceOfferingId: ids.offeringA1, pricingRuleId: ids.perAcreA1,
        pricingMethod: "PER_ACRE", expectedQuantity: "3", requestedInterval: interval(4, 7),
        serviceLocation: location("Rekurthi", FARM, { landmark: "Behind the temple" }),
        recipient: { name: RECIPIENT_NAME, coordinationPhone: PHONES.recipient, landmarkOrDirections: "Behind the temple" },
      };
      const refused = await farmerA.post("/farmer/bookings", body, { "idempotency-key": "security-other-0" });
      expect(refused.status).toBe(422);
      expect(refused.body).toMatchObject({ field: "recipient.coordinationConsent" });
      const created = await farmerA.post("/farmer/bookings", { ...body, recipient: { ...body.recipient, coordinationConsent: true } },
        { "idempotency-key": "security-other-1" });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      expect(JSON.stringify(created.body)).not.toContain(PHONES.recipient);
      ids.other = created.body.id;
      const recipient = await pool.query<{ coordination_consent: boolean; text: string }>(
        "SELECT coordination_consent, row_to_json(r)::text AS text FROM public.booking_recipients r WHERE booking_id = $1", [ids.other]);
      expect(recipient.rows[0]!.coordination_consent).toBe(true);
      expect(recipient.rows[0]!.text).not.toContain(PHONES.recipient);
      expect(recipient.rows[0]!.text).not.toContain(Buffer.from(PHONES.recipient).toString("hex"));
    });

    it("denies unrelated Farmers, unrelated Owners, and wrong roles without changing anything", async () => {
      const farmerBooking = await farmerB.post("/farmer/bookings", {
        bookingTarget: "MYSELF", tractorId: ids.a2, serviceOfferingId: ids.offeringA2, pricingRuleId: ids.hourlyA2,
        pricingMethod: "HOURLY", expectedQuantity: "2", requestedInterval: interval(4, 6), serviceLocation: location("Kazipet", FARM),
      }, { "idempotency-key": "security-farmer-b-1" });
      expect(farmerBooking.status).toBe(201);
      ids.farmerBBooking = farmerBooking.body.id;

      const before = await mutableState();
      const b = ids.self!;
      const denials: ReadonlyArray<readonly [string, Promise<HttpResult>]> = [
        // Another Farmer.
        ["farmerB read", farmerB.get(`/farmer/bookings/${b}`)],
        ["farmerB job", farmerB.get(`/farmer/bookings/${b}/job`)],
        ["farmerB settlement", farmerB.get(`/farmer/bookings/${b}/payments`)],
        ["farmerB dispute", farmerB.post(`/farmer/bookings/${b}/dispute`, { expectedVersion: 1, reason: "Not my booking" })],
        ["farmerA reads farmerB", farmerA.get(`/farmer/bookings/${ids.farmerBBooking}`)],
        // A Farmer on Owner routes.
        ["farmer owner read", farmerA.get(`/owner/bookings/${b}`)],
        ["farmer accept", farmerA.post(`/owner/bookings/${b}/accept`, { expectedVersion: 1 })],
        ["farmer job start", farmerA.post(`/owner/bookings/${b}/job/start`, { idempotencyKey: "deny-1" })],
        ["farmer cash", farmerA.post(`/owner/bookings/${b}/payments/cash`, { invoiceId: UNKNOWN, amountPaise: 100, idempotencyKey: "deny-2" })],
        ["farmer tractor list", farmerA.get("/owner/tractors")],
        ["farmer tractor read", farmerA.get(`/owner/tractors/${ids.a1}`)],
        ["farmer availability", farmerA.put(`/owner/tractors/${ids.a1}/availability`, { status: "OFFLINE", expectedVersion: 1 })],
        // Another Owner.
        ["ownerB read", ownerB.get(`/owner/bookings/${b}`)],
        ["ownerB accept", ownerB.post(`/owner/bookings/${b}/accept`, { expectedVersion: 1 })],
        ["ownerB reject", ownerB.post(`/owner/bookings/${b}/reject`, { expectedVersion: 1, reason: "Not mine" })],
        ["ownerB job", ownerB.get(`/owner/bookings/${b}/job`)],
        ["ownerB job start", ownerB.post(`/owner/bookings/${b}/job/start`, { idempotencyKey: "deny-3" })],
        ["ownerB settlement", ownerB.get(`/owner/bookings/${b}/payments`)],
        ["ownerB cash", ownerB.post(`/owner/bookings/${b}/payments/cash`, { invoiceId: UNKNOWN, amountPaise: 100, idempotencyKey: "deny-4" })],
        ["ownerB tractor", ownerB.get(`/owner/tractors/${ids.a1}`)],
        ["ownerB tractor update", ownerB.put(`/owner/tractors/${ids.a1}`, {
          brand: "Hijack", model: "X", registrationNumber: "TS09ZZ0001", manufacturingYear: 2020, expectedVersion: 1,
          operatingLocation: location("Elsewhere", FARM),
        })],
        ["ownerB availability read", ownerB.get(`/owner/tractors/${ids.a1}/availability`)],
        ["ownerB availability", ownerB.put(`/owner/tractors/${ids.a1}/availability`, { status: "OFFLINE", expectedVersion: 1 })],
        ["ownerB offerings", ownerB.get(`/owner/tractors/${ids.a1}/service-offerings`)],
        ["ownerB offering", ownerB.put(`/owner/tractors/${ids.a1}/service-offerings`, { serviceId: SERVICE_PLOUGHING, enabled: false })],
        ["ownerB pricing read", ownerB.get(`/owner/service-offerings/${ids.offeringA1}/pricing-rules`)],
        ["ownerB pricing", ownerB.put(`/owner/service-offerings/${ids.offeringA1}/pricing-rules`, { method: "PER_TRIP", ratePaise: 1, enabled: true })],
        ["ownerB eligibility", ownerB.post(`/owner/tractors/${ids.a1}/eligibility/evaluate`)],
        ["ownerB upload to A1", ownerB.post("/owner/documents/upload-grants", {
          tractorId: ids.a1, documentKind: "PERMIT", fileName: "permit.pdf", declaredMimeType: "application/pdf", sizeBytes: 10,
        })],
        ["owner farmer read", ownerA.get(`/farmer/bookings/${b}`)],
      ];
      for (const [label, pending] of denials) {
        const response = await pending;
        expectDenied(response, label, label === "ownerB upload to A1" ? [422] : [404]);
      }
      expect((await farmerB.get("/farmer/bookings")).body.items.map((item: Json) => item.id)).toEqual([ids.farmerBBooking]);
      expect((await ownerB.get("/owner/bookings")).body.items).toEqual([]);

      // A forged list cursor moves the page boundary but never widens the scope.
      const forged = Buffer.from(JSON.stringify({ c: new Date(Date.now() + 86_400_000).toISOString(), i: "ffffffff-ffff-4fff-bfff-ffffffffffff" })).toString("base64url");
      const forgedPage = await farmerB.get(`/farmer/bookings?cursor=${forged}`);
      expect(forgedPage.status).toBe(200);
      expect(forgedPage.body.items.map((item: Json) => item.id)).toEqual([ids.farmerBBooking]);

      expect(await mutableState()).toBe(before);
    });

    it("lets exactly one of many concurrent acceptances win, with no partial state", async () => {
      const pending = await ownerA.get(`/owner/bookings/${ids.farmerBBooking}`);
      const racers = await Promise.all(Array.from({ length: 8 }, () =>
        ownerA.post(`/owner/bookings/${ids.farmerBBooking}/accept`, { expectedVersion: pending.body.version })));
      const statuses = racers.map((response) => response.status);
      expect(statuses.filter((status) => status === 201)).toHaveLength(1);
      expect(statuses.filter((status) => status === 409)).toHaveLength(7);
      const history = await pool.query(`SELECT
          (SELECT count(*)::int FROM public.booking_status_history WHERE booking_id = $1 AND to_status = 'ACCEPTED') AS accepted,
          (SELECT count(*)::int FROM public.booking_agreements WHERE booking_id = $1) AS agreements,
          (SELECT count(*)::int FROM public.outbox_events WHERE aggregate_id = $1 AND event_type = 'BookingAccepted') AS events,
          (SELECT version FROM public.bookings WHERE id = $1) AS version`, [ids.farmerBBooking]);
      expect(history.rows[0]).toEqual({ accepted: 1, agreements: 1, events: 1, version: pending.body.version + 1 });
    });

    it("atomically refuses a second overlapping Blocking Booking under concurrent acceptance", async () => {
      const create = (client: ApiClient, key: string, from: number, to: number) => client.post("/farmer/bookings", {
        bookingTarget: "MYSELF", tractorId: ids.a2, serviceOfferingId: ids.offeringA2, pricingRuleId: ids.hourlyA2,
        pricingMethod: "HOURLY", expectedQuantity: "1", requestedInterval: interval(from, to), serviceLocation: location("Kazipet", FARM),
      }, { "idempotency-key": key });
      const first = await create(farmerA, "security-race-x", 8, 10);
      const second = await create(farmerB, "security-race-y", 9, 11);
      expect([first.status, second.status]).toEqual([201, 201]);
      const before = await pool.query("SELECT count(*)::int AS n FROM public.booking_agreements");
      const attempts = await Promise.all([first, second, first, second].map((booking) =>
        ownerA.post(`/owner/bookings/${booking.body.id}/accept`, { expectedVersion: booking.body.version })));
      expect(attempts.filter((response) => response.status === 201)).toHaveLength(1);
      expect(attempts.every((response) => response.status === 201 || response.status === 409)).toBe(true);
      const states = await pool.query<{ status: string }>("SELECT status::text AS status FROM public.bookings WHERE id = ANY($1::uuid[])",
        [[first.body.id, second.body.id]]);
      expect(states.rows.map((row) => row.status).sort()).toEqual(["ACCEPTED", "PENDING_OWNER_RESPONSE"]);
      const after = await pool.query("SELECT count(*)::int AS n FROM public.booking_agreements");
      expect(after.rows[0].n - before.rows[0].n).toBeLessThanOrEqual(1);
    });
  });

  describe("work, invoices, and payments", () => {
    it("bills from the agreed Quote Snapshot regardless of client-supplied totals", async () => {
      for (const bookingId of [ids.self, ids.other]) {
        const view = await ownerA.get(`/owner/bookings/${bookingId}`);
        expect((await ownerA.post(`/owner/bookings/${bookingId}/accept`, { expectedVersion: view.body.version })).status).toBe(201);
      }
      const act = (bookingId: string, action: string, extra: Json = {}) =>
        ownerA.post(`/owner/bookings/${bookingId}/job/${action}`, { idempotencyKey: `security-${action}-${randomUUID()}`, ...extra });
      expect((await act(ids.self!, "start")).status).toBe(201);
      clock.advanceMinutes(90);
      const hourly = await act(ids.self!, "complete", { totalPaise: 1, ratePaise: 1, invoice: { totalPaise: 1 } });
      expect(hourly.status, JSON.stringify(hourly.body)).toBe(201);
      expect(hourly.body.invoice).toMatchObject({ method: "HOURLY", ratePaise: 80_000, totalPaise: 120_000 });
      ids.selfInvoice = hourly.body.invoice.id;

      expect((await act(ids.other!, "start")).status).toBe(201);
      clock.advanceMinutes(60);
      const negative = await act(ids.other!, "complete", { completedQuantity: "-3" });
      expect(negative.status).toBe(422);
      const perAcre = await act(ids.other!, "complete", { completedQuantity: "3", ratePaise: 1 });
      expect(perAcre.body.invoice).toMatchObject({ method: "PER_ACRE", ratePaise: 120_000, totalPaise: 360_000 });
      ids.otherInvoice = perAcre.body.invoice.id;
    });

    it("never shows the Farmer the Owner's account identifiers in work views", async () => {
      for (const bookingId of [ids.self, ids.other]) {
        const view = await farmerA.get(`/farmer/bookings/${bookingId}/job`);
        expect(view.status).toBe(200);
        expect(view.body.events.length).toBeGreaterThan(0);
        expect(JSON.stringify(view.body)).not.toContain(ids.ownerA);
        const ownerView = await ownerA.get(`/owner/bookings/${bookingId}/job`);
        expect(JSON.stringify(ownerView.body)).not.toContain(ids.farmerA);
      }
    });

    it("rejects tampered cash records: cross-booking invoices, malformed and excessive amounts, wrong parties", async () => {
      const cash = (client: ApiClient, bookingId: string, body: Json) =>
        client.post(`/owner/bookings/${bookingId}/payments/cash`, { idempotencyKey: `security-cash-${randomUUID()}`, ...body });
      const before = await pool.query("SELECT count(*)::int AS n FROM public.payments");

      const crossBooking = await cash(ownerA, ids.self!, { invoiceId: ids.otherInvoice, amountPaise: 120_000 });
      expect(crossBooking.status).toBe(409);
      expect(crossBooking.body).toMatchObject({ code: "PAYMENT_INVOICE_NOT_PAYABLE" });
      for (const amountPaise of [0, -100, 12.5, "1e3", "120000.00", 1e20, null, "12' OR '1'='1"]) {
        const response = await cash(ownerA, ids.self!, { invoiceId: ids.selfInvoice, amountPaise });
        expect(response.status, `${String(amountPaise)} -> ${JSON.stringify(response.body)}`).toBe(422);
      }
      const over = await cash(ownerA, ids.self!, { invoiceId: ids.selfInvoice, amountPaise: 120_001 });
      expect(over.status).toBe(409);
      expect(over.body.code).toBe("PAYMENT_OVERPAYMENT");
      expectDenied(await cash(ownerB, ids.self!, { invoiceId: ids.selfInvoice, amountPaise: 120_000 }), "ownerB cash");
      expectDenied(await farmerA.post(`/owner/bookings/${ids.self}/payments/cash`, {
        invoiceId: ids.selfInvoice, amountPaise: 120_000, idempotencyKey: "farmer-cash",
      }), "farmer cash");
      expect((await pool.query("SELECT count(*)::int AS n FROM public.payments")).rows[0]).toEqual(before.rows[0]);

      // A settled record carries only server-derived values, and the key cannot be reused for another amount.
      const paid = await ownerA.post(`/owner/bookings/${ids.self}/payments/cash`, {
        invoiceId: ids.selfInvoice, amountPaise: 120_000, idempotencyKey: "security-cash-final",
        currency: "USD", method: "UPI", status: "REFUNDED", confirmedBy: "FARMER",
      });
      expect(paid.status, JSON.stringify(paid.body)).toBe(201);
      expect(paid.body.payment).toMatchObject({ method: "CASH", status: "PAID_CASH", currency: "INR", amountPaise: 120_000, confirmedBy: "OWNER" });
      const reused = await ownerA.post(`/owner/bookings/${ids.self}/payments/cash`, {
        invoiceId: ids.selfInvoice, amountPaise: 1, idempotencyKey: "security-cash-final",
      });
      expect(reused.status).toBe(409);
      ids.payment = paid.body.payment.id;
    });

    it("shows receipts only to the booking's two parties", async () => {
      const [farmerReceipt, ownerReceipt] = await Promise.all([
        farmerA.get(`/farmer/payments/${ids.payment}/receipt`), ownerA.get(`/owner/payments/${ids.payment}/receipt`),
      ]);
      expect([farmerReceipt.status, ownerReceipt.status]).toEqual([200, 200]);
      expect(farmerReceipt.body).toEqual(ownerReceipt.body);
      for (const [client, path] of [
        [farmerB, `/farmer/payments/${ids.payment}/receipt`], [ownerB, `/owner/payments/${ids.payment}/receipt`],
        [ownerA, `/farmer/payments/${ids.payment}/receipt`], [farmerA, `/owner/payments/${ids.payment}/receipt`],
      ] as const) {
        expectDenied(await client.get(path), path);
      }
      const serialized = JSON.stringify(farmerReceipt.body);
      expect(serialized).not.toContain(ids.ownerA);
      expect(serialized).not.toContain(ids.farmerA);
    });

    it("keeps the counterparty's phone, registration, and exact Tractor location out of booking views", async () => {
      const views = await Promise.all([
        farmerA.get(`/farmer/bookings/${ids.self}`), farmerA.get(`/farmer/bookings/${ids.other}`),
        ownerA.get(`/owner/bookings/${ids.self}`), ownerA.get(`/owner/bookings/${ids.other}`),
        farmerA.get(`/farmer/bookings/${ids.self}/payments`), ownerA.get(`/owner/bookings/${ids.other}/payments`),
      ]);
      for (const view of views) {
        expect(view.status).toBe(200);
        const serialized = JSON.stringify(view.body);
        for (const phone of Object.values(PHONES)) expect(serialized).not.toContain(phone);
        for (const registration of Object.values(REGISTRATIONS)) expect(serialized).not.toContain(registration);
        for (const value of [TRACTOR_A1.latitude, TRACTOR_A1.longitude]) expect(serialized).not.toContain(String(value));
        expect(serialized).not.toMatch(/customerId|ownerId|Ciphertext|LookupHash|phone/iu);
      }
      // The Owner withheld consent, so the Farmer sees a generic name and no contact.
      expect(views[0]!.body.owner).toEqual({ displayName: "Tractor Owner" });
      expect(views[0]!.body.ownerContact).toEqual({ sharingPermitted: false });
      expect(views[3]!.body.recipient).toMatchObject({ name: RECIPIENT_NAME });
    });

    it("refuses an expired document's download grant", async () => {
      const expiring = await upload(ownerA, ids.a2, "PERMIT", PDF, { expiresAt: new Date(clock.now().getTime() + 86_400_000).toISOString() });
      const accepted = await expiring.complete();
      expect(accepted.body).toMatchObject({ scanStatus: "ACCEPTED" });
      expect((await ownerA.get(`/owner/documents/${accepted.body.id}/download-grant`)).status).toBe(200);
      clock.advanceMinutes(2 * 24 * 60);
      const expired = await ownerA.get(`/owner/documents/${accepted.body.id}/download-grant`);
      expect(expired.status).toBe(409);
      expect(expired.body).toMatchObject({ code: "DOCUMENT_STATE_INVALID" });
    });
  });

  describe("data at rest and logs", () => {
    it("stores phones, registrations, and object keys only as ciphertext or keyed hashes", async () => {
      const tables = await pool.query<{ table_name: string }>(
        // spatial_ref_sys is PostGIS reference data (EPSG definitions), not application data.
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
           AND table_name <> 'spatial_ref_sys'`);
      const forbidden = [
        ...Object.values(PHONES), ...Object.values(PHONES).map((phone) => `+91${phone}`),
        ...Object.values(PHONES).map((phone) => Buffer.from(`+91${phone}`).toString("hex")),
        ...Object.values(REGISTRATIONS), ...Object.values(REGISTRATIONS).map((value) => Buffer.from(value).toString("hex")),
        "private/documents/", Buffer.from("private/documents/").toString("hex"),
        ...issuedCredentials,
      ];
      const findings: string[] = [];
      for (const { table_name: table } of tables.rows) {
        const rows = await pool.query<{ text: string }>(`SELECT row_to_json(t)::text AS text FROM public.${table} t`);
        for (const { text } of rows.rows) {
          for (const value of forbidden) if (text.includes(value)) findings.push(`${table}: ${value}`);
        }
      }
      expect(findings).toEqual([]);

      const users = await pool.query<{ ciphertext: Buffer; lookup: string }>(
        "SELECT normalized_phone_ciphertext AS ciphertext, phone_lookup_hash AS lookup FROM public.users");
      for (const user of users.rows) {
        expect(user.ciphertext[0]).toBe(1);
        expect(user.ciphertext.length).toBe(1 + 12 + 16 + "+919876543210".length);
        expect(user.lookup).toMatch(/^[0-9a-f]{64}$/u);
      }
      // Every stored location names its disclosed purpose; device GPS also carries consent time.
      const locations = await pool.query("SELECT count(*)::int AS n FROM public.locations WHERE collection_purpose IS NULL OR (source = 'DEVICE_GPS' AND location_consent_at IS NULL)");
      expect(locations.rows[0]).toEqual({ n: 0 });
      expect((await pool.query("SELECT count(*)::int AS n FROM public.locations WHERE source = 'DEVICE_GPS'")).rows[0].n).toBeGreaterThan(0);
    });

    it("emitted no server errors and no phones, OTP codes, credentials, coordinates, names, or registrations in logs", async () => {
      expect(telemetryLines.length).toBeGreaterThan(100);
      const requests = telemetryLines.map((line) => JSON.parse(line) as Json).filter((line) => line.event === "http.request.completed");
      expect(requests.some((line) => line.statusCode === 401)).toBe(true);
      // The only 5xx is the deliberate, retryable "scan unavailable" answer; nothing returned a 500.
      expect(requests.filter((line) => line.statusCode >= 500).map((line) => `${line.statusCode} ${line.route}`))
        .toEqual(["503 /owner/documents/:documentId/complete"]);
      expect(nestLogger.lines.filter((line) => line.startsWith("error") || line.startsWith("fatal"))).toEqual([]);

      const logs = [...telemetryLines, ...nestLogger.lines].join("\n");
      const findings: string[] = [];
      const literal = [
        ...Object.values(PHONES), ...Object.values(REGISTRATIONS), ...issuedCredentials, RECIPIENT_NAME, OWNER_NAME, SQL_NAME,
        ...[FARM, TRACTOR_A1, TRACTOR_A2].flatMap((point) => [String(point.latitude), String(point.longitude)]),
      ];
      for (const value of literal) if (logs.includes(value)) findings.push(value);
      expect(issuedCodes.length).toBeGreaterThan(10);
      for (const code of new Set(issuedCodes)) {
        if (new RegExp(`(?<![0-9A-Za-z])${code}(?![0-9A-Za-z])`, "u").test(logs)) findings.push(`otp ${code}`);
      }
      expect(findings).toEqual([]);
    });
  });
});
