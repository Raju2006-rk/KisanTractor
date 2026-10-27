import "reflect-metadata";

import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

import type { SqlConnection, SqlPool, SqlQueryResult } from "@kisantractor/database";
import type { PricingMethod } from "@kisantractor/domain";
import { createTestDatabaseFactory, type TestDatabase } from "@kisantractor/test-utils";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { findBrowserExecutable, HeadlessBrowser } from "../../../web/quality/cdp.js";
import { allDeviceProfiles } from "../../../web/quality/profiles.js";
import { startProductionServer, type ProductionServer } from "../../../web/quality/production-server.js";
import { PostgresBookingQueryStore } from "../booking/postgres-booking-query-store.js";
import { PostgresCatalogStore } from "../catalog/postgres-catalog-store.js";
import type { NormalizedDiscoveryQuery } from "../discovery/discovery.contracts.js";
import { PostgresDiscoveryStore } from "../discovery/postgres-discovery-store.js";
import { ApiClient } from "../e2e/vertical-slice-harness.js";
import { PostgresJobStore } from "../job/postgres-job-store.js";
import { PostgresPaymentStore } from "../payment/postgres-payment-store.js";
import { PgPoolAdapter } from "../sql-pool.js";
import { startLoadApi, summarizeServerLatency, type LoadApiProcess } from "./load-api-process.js";
import {
  activePrincipals,
  assertLoadProfileConsistent,
  dataVolume,
  discoveryRadiusMix,
  latencyBudgets,
  launchDistricts,
  requestMix,
  trafficProfile,
  type LoadOperationKind,
  type LoadOperationName,
} from "./load-profile.js";
import {
  createRandom,
  formatStepReport,
  LatencyRecorder,
  percentile,
  pick,
  pickWeighted,
  randomInt,
  runOpenLoop,
  summarizeLatencies,
  type OperationOutcome,
  type ScheduledOperation,
  type StepReport,
} from "./load-runner.js";
import { loadServices, scatter, seedLoadDataset, type SeededDataset, type SeededJob, type SeededTractor } from "./load-seed.js";

/**
 * Initial-load performance suite (Requirements 16.6, 17.1, 18.3, 18.4). It seeds the documented
 * data volume into its own database, runs the composed API in a child process over real HTTP,
 * and drives it with an open-loop request mix from OTP-sandbox principals.
 *
 * Skipped unless LOAD_TEST_DATABASE_URL names a local database containing "test" (it is
 * migrated and truncated). LOAD_TEST_BROWSER=1 adds the responsive Farmer/Owner screen audit
 * against the existing apps/web production build. LOAD_TEST_RESULTS_PATH writes a JSON report.
 * LOAD_TEST_STEP_SECONDS shortens the measured steps for a quick local pass.
 * See ops/performance/initial-load-profile.md.
 */
const databaseUrl = process.env.LOAD_TEST_DATABASE_URL;
const describeLoad = databaseUrl === undefined ? describe.skip : describe;
const browserPath = findBrowserExecutable();
const itBrowser = process.env.LOAD_TEST_BROWSER === "1" && browserPath !== undefined ? it : it.skip;
const stepSeconds = Number(process.env.LOAD_TEST_STEP_SECONDS ?? trafficProfile.stepSeconds);
const poolMax = process.env.LOAD_TEST_API_POOL_MAX === undefined ? undefined : Number(process.env.LOAD_TEST_API_POOL_MAX);

type Json = Record<string, any>;

interface Principal {
  client: ApiClient;
  refreshCredential: string;
  readonly userId: string;
  readonly userAgent: string;
}

/** Records every SQL statement a store issues so the suite can EXPLAIN the production queries. */
class CapturingPool implements SqlPool {
  readonly statements: Array<{ text: string; values: readonly unknown[] }> = [];

  constructor(private readonly inner: PgPoolAdapter) {}

  #capture(text: string, values: readonly unknown[]): void {
    if (/^\s*(BEGIN|COMMIT|ROLLBACK|SELECT set_config)/iu.test(text)) return;
    this.statements.push({ text, values });
  }

  async query<Row extends object = Record<string, unknown>>(text: string, values: readonly unknown[] = []): Promise<SqlQueryResult<Row>> {
    this.#capture(text, values);
    return this.inner.query<Row>(text, values);
  }

  async connect(): Promise<SqlConnection> {
    const connection = await this.inner.connect();
    return {
      query: async <Row extends object = Record<string, unknown>>(text: string, values: readonly unknown[] = []) => {
        this.#capture(text, values);
        return connection.query<Row>(text, values);
      },
      release: () => connection.release(),
    };
  }

  take(): Array<{ text: string; values: readonly unknown[] }> {
    return this.statements.splice(0);
  }
}

interface PlanNode {
  readonly "Node Type": string;
  readonly "Relation Name"?: string;
  readonly "Index Name"?: string;
  readonly "Actual Rows"?: number;
  readonly "Actual Loops"?: number;
  readonly Plans?: readonly PlanNode[];
}

interface PlanSummary {
  readonly executionMs: number;
  readonly planningMs: number;
  readonly seqScans: readonly string[];
  readonly indexes: readonly string[];
  readonly topNode: string;
  readonly sharedHitBlocks: number;
  readonly sharedReadBlocks: number;
}

/** Tables large enough at launch volume that a sequential scan on a hot path is a finding. */
const LARGE_TABLES = new Set([
  "bookings", "booking_agreements", "booking_status_history", "booking_recipients", "invoices", "payments",
  "payment_events", "work_events", "work_measurements", "tractors", "locations", "service_offerings", "pricing_rules",
  "equipment", "users", "user_profiles", "tractor_availability", "idempotency_records", "auth_sessions",
]);

const walk = (node: PlanNode, visit: (node: PlanNode) => void): void => {
  visit(node);
  for (const child of node.Plans ?? []) walk(child, visit);
};

describeLoad("initial load profile over HTTP against PostgreSQL/PostGIS", () => {
  const random = createRandom(20_250_315);
  const report: Record<string, unknown> = { startedAt: new Date().toISOString(), poolMax: poolMax ?? "default (pg 10)" };
  let pool: PgPoolAdapter;
  let database: TestDatabase;
  let api: LoadApiProcess;
  let seeded: SeededDataset;
  const farmers: Principal[] = [];
  const fleetOwners: Principal[] = [];
  const owners: Principal[] = [];
  const ownerById = new Map<string, Principal>();
  const farmerSamples = new Map<string, string[]>();
  const farmerCompleted = new Map<string, string[]>();
  const ownerSamples = new Map<string, string[]>();
  const deepCursors = new Map<string, string[]>();
  const pendingQueue = new Map<string, SeededJob[]>();
  const acceptedQueue = new Map<string, SeededJob[]>();
  const startedQueue = new Map<string, SeededJob[]>();
  const billedQueue = new Map<string, { bookingId: string; invoiceId: string; totalPaise: number }[]>();
  const issuedChallenges: { phone: string; userAgent: string; challengeId: string; code: string }[] = [];
  const steps: StepReport[] = [];
  let substitutions = 0;
  let signUps = 0;

  const allOwners = () => [...fleetOwners, ...owners];

  const phone = (prefix: string, index: number) => `${prefix}${String(index).padStart(4, "0")}`;

  const signIn = async (phone: string, purpose: "REGISTER_FARMER" | "REGISTER_OWNER", userAgent: string): Promise<Principal> => {
    const client = new ApiClient(api.baseUrl, userAgent);
    const challenge = await client.post("/identity/otp/challenges", { phone, purpose });
    if (challenge.status !== 201) throw new Error(`OTP challenge failed: ${challenge.status} ${JSON.stringify(challenge.body)}`);
    const verified = await client.post("/identity/otp/verify", {
      challengeId: challenge.body.challengeId, phone, purpose, code: challenge.body.developmentCode,
    });
    if (verified.status !== 200) {
      throw new Error(`OTP verify failed: ${verified.status} ${JSON.stringify(verified.body)} (challenge issued a code: ${typeof challenge.body.developmentCode === "string"})`);
    }
    return {
      client: client.withCredential(verified.body.accessCredential),
      refreshCredential: verified.body.refreshCredential,
      userId: verified.body.principal.userId,
      userAgent,
    };
  };

  /** Access credentials live 15 minutes; rotate every session before each long phase. */
  const refreshAll = async () => {
    for (const principal of [...farmers, ...allOwners()]) {
      const anonymous = new ApiClient(api.baseUrl, principal.userAgent);
      const refreshed = await anonymous.post("/identity/session/refresh", { refreshCredential: principal.refreshCredential });
      if (refreshed.status !== 200) throw new Error(`session refresh failed: ${refreshed.status}`);
      principal.client = anonymous.withCredential(refreshed.body.accessCredential);
      principal.refreshCredential = refreshed.body.refreshCredential;
    }
  };

  const inBatches = async <T, R>(items: readonly T[], size: number, work: (item: T, index: number) => Promise<R>): Promise<R[]> => {
    const results: R[] = [];
    for (let offset = 0; offset < items.length; offset += size) {
      results.push(...await Promise.all(items.slice(offset, offset + size).map((item, index) => work(item, offset + index))));
    }
    return results;
  };

  beforeAll(async () => {
    assertLoadProfileConsistent();
    pool = new PgPoolAdapter(new Pool({ connectionString: databaseUrl, max: 6 }));
    database = await createTestDatabaseFactory({ databaseUrl: databaseUrl!, createPool: async () => pool })();
    api = await startLoadApi({ databaseUrl: databaseUrl!, ...(poolMax === undefined ? {} : { poolMax }) });

    // Sequential on purpose: concurrent first-time registration is measured separately below.
    farmers.push(...await inBatches(Array.from({ length: activePrincipals.farmers }), 1, (_, index) =>
      signIn(phone("970000", index), "REGISTER_FARMER", `kt-load-farmer-${index}`)));
    fleetOwners.push(...await inBatches(Array.from({ length: activePrincipals.fleetOwners }), 1, (_, index) =>
      signIn(phone("980001", index), "REGISTER_OWNER", `kt-load-fleet-owner-${index}`)));
    owners.push(...await inBatches(Array.from({ length: activePrincipals.owners }), 1, (_, index) =>
      signIn(phone("980002", index), "REGISTER_OWNER", `kt-load-owner-${index}`)));
    for (const owner of allOwners()) ownerById.set(owner.userId, owner);

    // The seed runs on one dedicated connection (it sets session-level synchronous_commit).
    const seedPool = new Pool({ connectionString: databaseUrl, max: 1 });
    const client = await seedPool.connect();
    try {
      seeded = await seedLoadDataset(client, {
        now: new Date(),
        seed: 7,
        activeFarmerIds: farmers.map((farmer) => farmer.userId),
        activeFleetOwnerIds: fleetOwners.map((owner) => owner.userId),
        activeOwnerIds: owners.map((owner) => owner.userId),
        fieldEncryptionKey: api.secrets.FIELD_ENCRYPTION_KEY,
        lookupHashKey: api.secrets.LOOKUP_HASH_KEY,
      });
    } finally {
      client.release();
      await seedPool.end();
    }
    report.seed = { seconds: seeded.seedSeconds, counts: seeded.counts };
    console.info(`[load] seeded in ${seeded.seedSeconds} s: ${JSON.stringify(seeded.counts)}`);

    for (const [ownerId, jobs] of seeded.pending) pendingQueue.set(ownerId, [...jobs]);
    for (const [ownerId, jobs] of seeded.accepted) acceptedQueue.set(ownerId, [...jobs]);
    for (const farmer of farmers) {
      const rows = await pool.query<{ id: string; status: string }>(
        "SELECT id, status FROM public.bookings WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 60", [farmer.userId]);
      farmerSamples.set(farmer.userId, rows.rows.map((row) => row.id));
      farmerCompleted.set(farmer.userId, rows.rows.filter((row) => row.status === "COMPLETED").map((row) => row.id));
    }
    for (const owner of allOwners()) {
      ownerSamples.set(owner.userId, [...(seeded.ownerBookingSamples.get(owner.userId) ?? [])]);
    }
    // Page-boundary cursors exactly as the API encodes them (microsecond createdAt, id).
    const encode = (row: { id: string; created_at: string }) =>
      Buffer.from(JSON.stringify({ c: row.created_at, i: row.id }), "utf8").toString("base64url");
    for (const principal of [...fleetOwners, ...farmers.slice(0, activePrincipals.heavyFarmers)]) {
      const column = fleetOwners.includes(principal) ? "owner_id" : "customer_id";
      const rows = await pool.query<{ id: string; created_at: string }>(
        `SELECT id, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at FROM public.bookings
         WHERE ${column} = $1 ORDER BY bookings.created_at DESC, id DESC`, [principal.userId]);
      deepCursors.set(principal.userId, rows.rows.filter((_, index) => (index + 1) % 20 === 0).map(encode));
    }
  }, 600_000);

  afterAll(async () => {
    report.finishedAt = new Date().toISOString();
    report.steps = steps;
    report.substitutions = substitutions;
    if (process.env.LOAD_TEST_RESULTS_PATH) writeFileSync(process.env.LOAD_TEST_RESULTS_PATH, JSON.stringify(report, null, 2));
    await api?.stop();
    await database?.dispose();
  }, 60_000);

  it("seeds the documented launch volume", () => {
    expect(seeded.counts.tractors).toBe(dataVolume.tractors);
    expect(seeded.counts.bookings).toBe(dataVolume.historicalBookings
      + allOwners().length * (activePrincipals.pendingPerOwner + activePrincipals.acceptedPerOwner)
      + trafficProfile.raceTractors * (trafficProfile.raceOverlappingPerTractor + trafficProfile.raceAdjacentPerTractor));
    expect(seeded.counts.users).toBe(dataVolume.owners + dataVolume.farmers);
    expect(seeded.counts.booking_status_history).toBeGreaterThan(600_000);
  });

  // Stress probe beyond the profile (20 verifications in the same instant); reported, not budgeted.
  it("reports how a burst of simultaneous new registrations fares at launch volume", async () => {
    const burst = 20;
    const results = await Promise.all(Array.from({ length: burst }, async (_, index) => {
      const started = performance.now();
      try {
        await signIn(phone("960000", index), "REGISTER_FARMER", `kt-load-burst-${index}`);
        return { ok: true, latencyMs: performance.now() - started };
      } catch {
        return { ok: false, latencyMs: performance.now() - started };
      }
    }));
    const rejected = results.filter((result) => !result.ok).length;
    report.registrationBurst = { burst, rejected, latency: summarizeLatencies(results.map((result) => result.latencyMs)) };
    console.info(`[load] concurrent registration burst: ${JSON.stringify(report.registrationBurst)}`);
    // The identity store fails closed when its serialization retries run out: no 5xx, no session.
    expect(results).toHaveLength(burst);
  }, 120_000);

  // ---- Query plans ------------------------------------------------------------------------------

  const explain = async (statement: { text: string; values: readonly unknown[] }): Promise<PlanSummary> => {
    const result = await pool.query<Record<string, unknown>>(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement.text}`, statement.values);
    const document = (Object.values(result.rows[0] ?? {})[0] as Array<{ Plan: PlanNode & Json; "Execution Time": number; "Planning Time": number }>)[0]!;
    const seqScans: string[] = [];
    const indexes: string[] = [];
    walk(document.Plan, (node) => {
      if (node["Node Type"] === "Seq Scan" && node["Relation Name"]) seqScans.push(node["Relation Name"]);
      if (node["Index Name"]) indexes.push(node["Index Name"]);
    });
    return {
      executionMs: Math.round(document["Execution Time"] * 100) / 100,
      planningMs: Math.round(document["Planning Time"] * 100) / 100,
      seqScans: [...new Set(seqScans)],
      indexes: [...new Set(indexes)],
      topNode: document.Plan["Node Type"],
      sharedHitBlocks: Number(document.Plan["Shared Hit Blocks"] ?? 0),
      sharedReadBlocks: Number(document.Plan["Shared Read Blocks"] ?? 0),
    };
  };

  const plans: Record<string, PlanSummary[]> = {};
  report.plans = plans;
  const recordPlans = async (name: string, capturing: CapturingPool) => {
    const summaries: PlanSummary[] = [];
    for (const statement of capturing.take()) summaries.push(await explain(statement));
    plans[name] = summaries;
    console.info(`[load] plan ${name}: ${JSON.stringify(summaries)}`);
    return summaries;
  };
  const hotSeqScans = (summaries: readonly PlanSummary[]) => summaries.flatMap((summary) => summary.seqScans.filter((table) => LARGE_TABLES.has(table)));

  it("finds discovery candidates through the spatial and filter indexes at launch volume", async () => {
    const capturing = new CapturingPool(pool);
    const store = new PostgresDiscoveryStore(capturing);
    const evaluatedAt = new Date();
    const warangal = launchDistricts[0]!;
    const start = new Date(Math.ceil(Date.now() / 3_600_000) * 3_600_000 + 5 * 86_400_000);
    const summaries: PlanSummary[] = [];
    for (const radiusKilometers of [5, 25, 100]) {
      const query: NormalizedDiscoveryQuery = {
        serviceLocation: {
          state: warangal.state, district: warangal.district, mandalOrTaluk: warangal.district, village: "Search origin",
          source: "MANUAL_ADDRESS", latitude: warangal.latitude, longitude: warangal.longitude, capturedAt: evaluatedAt,
          collectionPurpose: "SERVICE_LOCATION",
        },
        serviceId: loadServices[0].id,
        requestedInterval: { start, end: new Date(start.getTime() + 3 * 3_600_000) },
        radiusKilometers,
        pageSize: 20,
        evaluatedAt,
        staleBefore: new Date(evaluatedAt.getTime() - 86_400_000),
      };
      const rows = await store.search(query);
      expect(rows.length).toBeLessThanOrEqual(21);
      summaries.push(...await recordPlans(`discovery.${radiusKilometers}km`, capturing));
    }
    for (const summary of summaries) {
      expect(summary.indexes).toContain("locations_coordinates_gist_idx");
      expect(summary.indexes).toEqual(expect.arrayContaining(["service_offerings_discovery_idx", "pricing_rules_active_lookup_idx"]));
      expect(summary.topNode).toBe("Limit");
      expect(summary.executionMs).toBeLessThan(50);
    }
    // The default and widened radii must reach Tractors through the spatial candidates, not a
    // scan of every Tractor. At 100 km a large share of a district's fleet is in range, and a
    // hash join over the Tractor table is the cheaper plan, so that radius is reported only.
    expect(hotSeqScans(summaries.slice(0, 2))).toEqual([]);
  }, 60_000);

  it("keeps booking, dashboard, payment, and job reads on bounded index scans", async () => {
    const capturing = new CapturingPool(pool);
    const context = { correlationId: randomUUID(), actorChannel: "WEB" as const };
    const fleetOwner = fleetOwners[0]!;
    const heavyFarmer = farmers[0]!;
    const bookingQueries = new PostgresBookingQueryStore(capturing);

    await bookingQueries.listBookings({ viewerId: fleetOwner.userId, viewerRole: "OWNER", limit: 21 }, context);
    const deep = await pool.query<{ id: string; created_at: string }>(
      `SELECT id, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at FROM public.bookings
       WHERE owner_id = $1 ORDER BY bookings.created_at DESC, id DESC OFFSET 2500 LIMIT 1`, [fleetOwner.userId]);
    await bookingQueries.listBookings({
      viewerId: fleetOwner.userId, viewerRole: "OWNER", limit: 21, after: { createdAt: deep.rows[0]!.created_at, id: deep.rows[0]!.id },
    }, context);
    await bookingQueries.listBookings({ viewerId: heavyFarmer.userId, viewerRole: "FARMER", limit: 51 }, context);
    const lists = await recordPlans("bookings.list", capturing);
    for (const summary of lists) {
      expect(summary.topNode).toBe("Limit");
      expect(summary.indexes.some((index) => /bookings_(owner|customer)_history_cursor_idx/u.test(index))).toBe(true);
    }

    const completed = farmerCompleted.get(heavyFarmer.userId)![0]!;
    await bookingQueries.loadBookingDetail({ viewerId: heavyFarmer.userId, viewerRole: "FARMER", bookingId: completed }, context);
    const detail = await recordPlans("booking.detail", capturing);

    await new PostgresPaymentStore(capturing).loadBookingPayments(completed, context);
    const payments = await recordPlans("booking.payments", capturing);

    const catalog = new PostgresCatalogStore(capturing, {
      fieldEncryptionKey: api.secrets.FIELD_ENCRYPTION_KEY, lookupHashKey: api.secrets.LOOKUP_HASH_KEY,
    });
    const tractors = await catalog.listOwnerTractors(fleetOwner.userId);
    expect(tractors).toHaveLength(dataVolume.fleetSize);
    await catalog.listOwnerEquipment(fleetOwner.userId);
    const inventory = await recordPlans("owner.inventory", capturing);

    const accepted = seeded.accepted.get(fleetOwner.userId)![0]!;
    await new PostgresJobStore(capturing).loadWorkSession({ bookingId: accepted.bookingId, viewerId: fleetOwner.userId, viewerRole: "OWNER" }, context);
    const job = await recordPlans("job.session", capturing);

    const findings = Object.fromEntries(Object.entries({ lists, detail, payments, inventory, job })
      .map(([name, summaries]) => [name, hotSeqScans(summaries)]));
    report.seqScanFindings = findings;
    for (const summary of [...lists, ...detail, ...payments, ...inventory, ...job]) {
      expect(summary.executionMs).toBeLessThan(50);
    }
    expect(findings).toEqual({ lists: [], detail: [], payments: [], inventory: [], job: [] });
  }, 60_000);

  // ---- Pagination over HTTP ---------------------------------------------------------------------

  const traverse = async (client: ApiClient, path: string, limit: number) => {
    const ids: string[] = [];
    const latencies: number[] = [];
    let cursor: string | undefined;
    for (;;) {
      const started = performance.now();
      const page = await client.get(`${path}?limit=${limit}${cursor === undefined ? "" : `&cursor=${encodeURIComponent(cursor)}`}`);
      latencies.push(performance.now() - started);
      expect(page.status, JSON.stringify(page.body)).toBe(200);
      expect(page.body.items.length).toBeLessThanOrEqual(limit);
      ids.push(...page.body.items.map((item: Json) => item.id));
      cursor = page.body.nextCursor;
      if (cursor === undefined) return { ids, latencies };
    }
  };

  it("pages fleet-Owner dashboards and long Farmer histories to the end with flat latency and no gaps", async () => {
    await refreshAll();
    const results: Json[] = [];
    for (const [principal, path, column] of [
      [fleetOwners[0]!, "/owner/bookings", "owner_id"],
      [fleetOwners[1]!, "/owner/bookings", "owner_id"],
      [farmers[0]!, "/farmer/bookings", "customer_id"],
    ] as const) {
      const expected = await pool.query<{ id: string }>(
        `SELECT id FROM public.bookings WHERE ${column} = $1 ORDER BY created_at DESC, id DESC`, [principal.userId]);
      for (const limit of [20, 50]) {
        const { ids, latencies } = await traverse(principal.client, path, limit);
        const first = latencies.slice(0, 10);
        const last = latencies.slice(-10);
        const result = {
          path, limit, rows: expected.rowCount, pages: latencies.length, returned: ids.length, unique: new Set(ids).size,
          missing: expected.rows.filter((row) => !ids.includes(row.id)).length,
          all: summarizeLatencies(latencies), firstTenMedianMs: Math.round(percentile(first, 0.5) * 10) / 10,
          lastTenMedianMs: Math.round(percentile(last, 0.5) * 10) / 10,
        };
        results.push(result);
        console.info(`[load] traversal ${JSON.stringify(result)}`);
        expect(result.unique).toBe(ids.length);
        expect(ids).toEqual(expected.rows.map((row) => row.id));
        expect(result.all.p95Ms).toBeLessThan(latencyBudgets.readP95Ms);
        // Keyset pages cost the same at page 150 as at page 1 (no OFFSET scan).
        expect(result.lastTenMedianMs).toBeLessThan(Math.max(2 * result.firstTenMedianMs, result.firstTenMedianMs + 15));
      }
    }
    report.traversals = results;
    for (const limit of [0, 51]) {
      expect((await fleetOwners[0]!.client.get(`/owner/bookings?limit=${limit}`)).status).toBe(422);
    }
    const tooBig = await farmers[0]!.client.post("/farmer/discovery/search", {
      serviceLocation: { state: "Telangana", district: "Warangal", mandalOrTaluk: "Warangal", village: "Origin", source: "MANUAL_ADDRESS",
        latitude: 17.98, longitude: 79.59, capturedAt: new Date().toISOString() },
      serviceId: loadServices[0].id,
      requestedInterval: { start: new Date(Date.now() + 2 * 86_400_000).toISOString(), end: new Date(Date.now() + 2 * 86_400_000 + 3_600_000).toISOString() },
      pageSize: 51,
    });
    expect(tooBig.status).toBe(422);
  }, 300_000);

  // ---- Mixed load -----------------------------------------------------------------------------

  /**
   * 409s that come from a SERIALIZABLE abort (40001/23P01) rather than from a real domain
   * conflict are labelled CONTENTION: the user's action was refused only because another
   * transaction ran at the same time.
   */
  const isContention = (body?: Json): boolean =>
    body?.reason === "CONCURRENT_RESERVATION" || body?.code === "PAYMENT_CONFLICT"
    || (body?.code === "JOB_CONFLICT" && /concurrent/iu.test(String(body?.message ?? "")));
  const outcome = (status: number, expectedStatuses: readonly number[], body?: Json): OperationOutcome => {
    const code = status === 409 && isContention(body) ? "CONTENTION"
      : status >= 400 && typeof body?.reason === "string" ? body.reason
        : status >= 400 && typeof body?.code === "string" ? body.code : undefined;
    return { status, expected: expectedStatuses.includes(status), ...(code === undefined ? {} : { code }) };
  };
  const contentionCount = (step: StepReport): number => step.byOperation
    .flatMap((row) => Object.entries(row.statuses).filter(([key]) => key.endsWith(":CONTENTION")).map(([, count]) => count))
    .reduce((sum, count) => sum + count, 0);

  const popRandom = <T>(queues: Map<string, T[]>, predicate: (ownerId: string) => boolean = () => true): [string, T] | undefined => {
    const candidates = [...queues.entries()].filter(([ownerId, items]) => items.length > 0 && predicate(ownerId));
    if (candidates.length === 0) return undefined;
    const [ownerId, items] = pick(random, candidates);
    const item = items.splice(Math.floor(random() * items.length), 1)[0]!;
    return [ownerId, item];
  };
  const push = <T>(queues: Map<string, T[]>, ownerId: string, item: T) => {
    queues.set(ownerId, [...(queues.get(ownerId) ?? []), item]);
  };

  const serviceLocationNear = (latitude: number, longitude: number, kilometers: number, district: { state: string; district: string }) => {
    const [lat, lon] = scatter(random, latitude, longitude, kilometers);
    return {
      state: district.state, district: district.district, mandalOrTaluk: district.district, village: `Load farm ${randomInt(random, 1, 999)}`,
      source: "MANUAL_ADDRESS", latitude: lat, longitude: lon, capturedAt: new Date().toISOString(),
    };
  };
  const futureInterval = (minDay: number, maxDay: number) => {
    const day = Math.floor(Date.now() / 86_400_000) * 86_400_000 + randomInt(random, minDay, maxDay) * 86_400_000;
    const start = day + randomInt(random, 1, 11) * 3_600_000;
    return { start: new Date(start).toISOString(), end: new Date(start + randomInt(random, 3, 4) * 3_600_000).toISOString() };
  };
  const quantityFor = (method: PricingMethod) => (method === "HOURLY" ? "3" : method === "PER_TRIP" ? "2" : "2.5");

  const operations: Record<LoadOperationName, () => (() => Promise<OperationOutcome>) | undefined> = {
    "discovery.search": () => {
      const farmer = pick(random, farmers);
      const district = pick(random, launchDistricts);
      const radius = pickWeighted(random, discoveryRadiusMix).radiusKilometers;
      const pricingMethod = random() < 0.3 ? pick(random, ["HOURLY", "PER_ACRE"] as const) : undefined;
      const service = random() < 0.5 ? loadServices[0] : pick(random, loadServices);
      return async () => {
        const response = await farmer.client.post("/farmer/discovery/search", {
          serviceLocation: serviceLocationNear(district.latitude, district.longitude, 20, district),
          serviceId: service.id,
          requestedInterval: futureInterval(1, 30),
          ...(radius === undefined ? {} : { radiusKilometers: radius }),
          ...(pricingMethod === undefined ? {} : { pricingMethod }),
        });
        return outcome(response.status, [201], response.body);
      };
    },
    "farmer.bookings.list": () => {
      const farmer = pick(random, farmers);
      return async () => outcome((await farmer.client.get("/farmer/bookings")).status, [200]);
    },
    "farmer.bookings.deepPage": () => {
      const farmer = pick(random, farmers.slice(0, activePrincipals.heavyFarmers));
      const cursor = pick(random, deepCursors.get(farmer.userId)!);
      return async () => outcome((await farmer.client.get(`/farmer/bookings?limit=20&cursor=${encodeURIComponent(cursor)}`)).status, [200]);
    },
    "farmer.booking.detail": () => {
      const farmer = pick(random, farmers);
      const id = pick(random, farmerSamples.get(farmer.userId)!);
      return async () => outcome((await farmer.client.get(`/farmer/bookings/${id}`)).status, [200]);
    },
    "farmer.booking.settlement": () => {
      const farmer = pick(random, farmers.filter((candidate) => (farmerCompleted.get(candidate.userId)?.length ?? 0) > 0));
      const id = pick(random, farmerCompleted.get(farmer.userId)!);
      return async () => outcome((await farmer.client.get(`/farmer/bookings/${id}/payments`)).status, [200]);
    },
    "owner.bookings.list": () => {
      const owner = pick(random, allOwners());
      return async () => outcome((await owner.client.get("/owner/bookings")).status, [200]);
    },
    "owner.bookings.deepPage": () => {
      const owner = pick(random, fleetOwners);
      const cursor = pick(random, deepCursors.get(owner.userId)!);
      return async () => outcome((await owner.client.get(`/owner/bookings?limit=20&cursor=${encodeURIComponent(cursor)}`)).status, [200]);
    },
    "owner.booking.detail": () => {
      const owner = pick(random, allOwners());
      const id = pick(random, ownerSamples.get(owner.userId)!);
      return async () => outcome((await owner.client.get(`/owner/bookings/${id}`)).status, [200]);
    },
    "owner.tractors.list": () => {
      const owner = pick(random, allOwners());
      return async () => outcome((await owner.client.get("/owner/tractors")).status, [200]);
    },
    "owner.tractor.availability": () => {
      const tractor = pick(random, seeded.activeTractors);
      const owner = ownerById.get(tractor.ownerId)!;
      return async () => outcome((await owner.client.get(`/owner/tractors/${tractor.id}/availability`)).status, [200]);
    },
    "owner.job.session": () => {
      const candidates = [...acceptedQueue.entries(), ...startedQueue.entries()].filter(([, jobs]) => jobs.length > 0);
      if (candidates.length === 0) return undefined;
      const [ownerId, jobs] = pick(random, candidates);
      const job = pick(random, jobs);
      return async () => outcome((await ownerById.get(ownerId)!.client.get(`/owner/bookings/${job.bookingId}/job`)).status, [200]);
    },
    "identity.session": () => {
      const principal = pick(random, [...farmers, ...allOwners()]);
      return async () => outcome((await principal.client.get("/identity/session")).status, [200]);
    },
    "farmer.booking.create": () => {
      const farmer = pick(random, farmers);
      const tractor: SeededTractor = pick(random, seeded.activeTractors);
      const offering = pick(random, tractor.offerings);
      const rule = pick(random, offering.rules);
      const someoneElse = random() < dataVolume.someoneElseShare;
      return async () => {
        const response = await farmer.client.post("/farmer/bookings", {
          bookingTarget: someoneElse ? "SOMEONE_ELSE" : "MYSELF",
          tractorId: tractor.id, serviceOfferingId: offering.id, pricingRuleId: rule.id, pricingMethod: rule.method,
          expectedQuantity: quantityFor(rule.method),
          requestedInterval: futureInterval(3, seeded.raceDayOffset - 10),
          serviceLocation: serviceLocationNear(tractor.latitude, tractor.longitude, 5, tractor.district),
          ...(someoneElse ? { recipient: { name: "Lakshmi Devi", coordinationPhone: "9123456780", coordinationConsent: true, landmarkOrDirections: "Behind the temple" } } : {}),
        }, { "idempotency-key": randomUUID() });
        if (response.status === 201) {
          push(pendingQueue, tractor.ownerId, { bookingId: response.body.id, ownerId: tractor.ownerId, method: rule.method, quantity: quantityFor(rule.method) });
        }
        return outcome(response.status, [201, 409], response.body);
      };
    },
    "owner.booking.accept": () => {
      const taken = popRandom(pendingQueue);
      if (taken === undefined) return undefined;
      const [ownerId, job] = taken;
      return async () => {
        const response = await ownerById.get(ownerId)!.client.post(`/owner/bookings/${job.bookingId}/accept`, { expectedVersion: 1 });
        if (response.status === 201 && job.method !== "HOURLY") push(acceptedQueue, ownerId, job);
        return outcome(response.status, [201, 409], response.body);
      };
    },
    "owner.booking.reject": () => {
      const taken = popRandom(pendingQueue);
      if (taken === undefined) return undefined;
      const [ownerId, job] = taken;
      return async () => {
        const response = await ownerById.get(ownerId)!.client.post(`/owner/bookings/${job.bookingId}/reject`, {
          expectedVersion: 1, reason: "Tractor is under maintenance that day",
        });
        return outcome(response.status, [201, 409], response.body);
      };
    },
    "owner.job.start": () => {
      const taken = popRandom(acceptedQueue);
      if (taken === undefined) return undefined;
      const [ownerId, job] = taken;
      return async () => {
        const response = await ownerById.get(ownerId)!.client.post(`/owner/bookings/${job.bookingId}/job/start`, { idempotencyKey: randomUUID() });
        if (response.status === 201) push(startedQueue, ownerId, job);
        return outcome(response.status, [201, 409], response.body);
      };
    },
    "owner.job.complete": () => {
      const taken = popRandom(startedQueue);
      if (taken === undefined) return undefined;
      const [ownerId, job] = taken;
      return async () => {
        const response = await ownerById.get(ownerId)!.client.post(`/owner/bookings/${job.bookingId}/job/complete`, {
          idempotencyKey: randomUUID(), completedQuantity: job.quantity,
        });
        if (response.status === 201 && response.body.invoice?.totalPaise > 0) {
          push(billedQueue, ownerId, { bookingId: job.bookingId, invoiceId: response.body.invoice.id, totalPaise: response.body.invoice.totalPaise });
        }
        return outcome(response.status, [201, 409], response.body);
      };
    },
    "identity.otp.request": () => {
      const ordinal = signUps;
      signUps += 1;
      const signUp = { phone: `95${String(ordinal).padStart(8, "0")}`, userAgent: `kt-load-signup-${ordinal}` };
      return async () => {
        const client = new ApiClient(api.baseUrl, signUp.userAgent);
        const response = await client.post("/identity/otp/challenges", { phone: signUp.phone, purpose: "REGISTER_FARMER" });
        if (response.status === 201 && typeof response.body.developmentCode === "string") {
          issuedChallenges.push({ ...signUp, challengeId: response.body.challengeId, code: response.body.developmentCode });
        }
        return outcome(response.status, [201], response.body);
      };
    },
    "identity.otp.verify": () => {
      const challenge = issuedChallenges.shift();
      if (challenge === undefined) return undefined;
      return async () => {
        const response = await new ApiClient(api.baseUrl, challenge.userAgent).post("/identity/otp/verify", {
          challengeId: challenge.challengeId, phone: challenge.phone, purpose: "REGISTER_FARMER", code: challenge.code,
        });
        return outcome(response.status, [200], response.body);
      };
    },
    "owner.payment.cash": () => {
      const taken = popRandom(billedQueue);
      if (taken === undefined) return undefined;
      const [ownerId, bill] = taken;
      return async () => {
        const response = await ownerById.get(ownerId)!.client.post(`/owner/bookings/${bill.bookingId}/payments/cash`, {
          invoiceId: bill.invoiceId, amountPaise: bill.totalPaise, idempotencyKey: randomUUID(),
        });
        return outcome(response.status, [201, 409], response.body);
      };
    },
  };

  /** Picks from the mix; a write whose work queue is empty is replaced by a booking request. */
  const nextOperation = (): ScheduledOperation => {
    const entry = pickWeighted(random, requestMix);
    let name: LoadOperationName = entry.operation;
    let run = operations[name]();
    if (run === undefined) {
      substitutions += 1;
      name = entry.kind === "write" ? "farmer.booking.create" : "owner.booking.detail";
      run = operations[name]()!;
    }
    const kind: LoadOperationKind = requestMix.find((candidate) => candidate.operation === name)!.kind;
    return { operation: name, kind, run };
  };

  const runStep = async (label: string, requestsPerSecond: number, durationSeconds: number, recorder?: LatencyRecorder) => {
    await api.resetMetrics();
    const step = await runOpenLoop({ label, requestsPerSecond, durationSeconds, next: nextOperation, random, ...(recorder ? { recorder } : {}) });
    const server = summarizeServerLatency(await api.metrics());
    console.info(`${formatStepReport(step)}\n[load] server-side p95 bucket bounds: ${JSON.stringify(server)}`);
    return { step, server };
  };

  it(`meets p95 read < ${latencyBudgets.readP95Ms} ms and write < ${latencyBudgets.writeP95Ms} ms at the design load`, async () => {
    await refreshAll();
    // Prime the job pipeline so start, complete, and cash have work from the first second.
    const primed = [...acceptedQueue.entries()].flatMap(([ownerId, jobs]) => jobs.splice(0, 4).map((job) => [ownerId, job] as const));
    await inBatches(primed, 1, async ([ownerId, job], index) => {
      const owner = ownerById.get(ownerId)!;
      const started = await owner.client.post(`/owner/bookings/${job.bookingId}/job/start`, { idempotencyKey: randomUUID() });
      expect(started.status, JSON.stringify(started.body)).toBe(201);
      if (index % 2 === 0) {
        push(startedQueue, ownerId, job);
        return;
      }
      const completed = await owner.client.post(`/owner/bookings/${job.bookingId}/job/complete`, { idempotencyKey: randomUUID(), completedQuantity: job.quantity });
      expect(completed.status, JSON.stringify(completed.body)).toBe(201);
      push(billedQueue, ownerId, { bookingId: job.bookingId, invoiceId: completed.body.invoice.id, totalPaise: completed.body.invoice.totalPaise });
    });
    await runStep("warm-up (not measured)", trafficProfile.designRequestsPerSecond, trafficProfile.warmUpSeconds);
    substitutions = 0;
    const { step, server } = await runStep("design load", trafficProfile.designRequestsPerSecond, stepSeconds);
    steps.push(step);
    report.designServer = server;
    report.designSubstitutions = substitutions;
    const [reads, writes] = step.byKind;
    const contention = contentionCount(step);
    report.designContention = { refusedWrites: contention, writes: writes!.count };
    console.info(`[load] design-load contention refusals: ${contention} of ${writes!.count} writes; substitutions ${substitutions}`);
    expect(reads!.serverErrors + writes!.serverErrors, JSON.stringify(step.byOperation)).toBe(0);
    expect(reads!.unexpected + writes!.unexpected, JSON.stringify(step.byOperation)).toBe(0);
    // Refusing a valid action only because another transaction ran concurrently must be rare.
    expect(contention).toBeLessThanOrEqual(Math.floor(writes!.count * 0.005));
    expect(step.achievedRequestsPerSecond).toBeGreaterThan(trafficProfile.designRequestsPerSecond * 0.85);
    expect(reads!.p95Ms).toBeLessThan(latencyBudgets.readP95Ms);
    expect(writes!.p95Ms).toBeLessThan(latencyBudgets.writeP95Ms);
  }, 600_000);

  it("accepts exactly one of each set of overlapping requests per Tractor during concurrent load", async () => {
    await refreshAll();
    const recorder = new LatencyRecorder();
    const background = runStep("design load during acceptance race", trafficProfile.designRequestsPerSecond, 25, recorder);
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const accept = async (group: (typeof seeded.raceGroups)[number], id: string, overlapping: boolean, stress: boolean) => {
      const started = performance.now();
      const response = await ownerById.get(group.ownerId)!.client.post(`/owner/bookings/${id}/accept`, { expectedVersion: 1 });
      return { group, id, overlapping, stress, status: response.status, reason: response.body?.reason as string | undefined, latencyMs: performance.now() - started };
    };
    // All of one Tractor's requests are accepted at the same instant, in shuffled order.
    const fireGroup = (group: (typeof seeded.raceGroups)[number], stress: boolean) => Promise.all([
      ...group.overlapping.map((id) => ({ id, overlapping: true })),
      ...group.adjacent.map((id) => ({ id, overlapping: false })),
    ].sort(() => random() - 0.5).map(({ id, overlapping }) => accept(group, id, overlapping, stress)));
    const staggered = seeded.raceGroups.slice(0, seeded.raceGroups.length - trafficProfile.raceSimultaneousTractors);
    const simultaneous = seeded.raceGroups.slice(staggered.length);
    const pending: Promise<Awaited<ReturnType<typeof fireGroup>>>[] = [];
    for (const group of staggered) {
      pending.push(fireGroup(group, false));
      await new Promise((resolve) => setTimeout(resolve, trafficProfile.raceStaggerMs));
    }
    // Stress case: several Tractors' races at the same instant.
    pending.push(...simultaneous.map((group) => fireGroup(group, true)));
    const results = (await Promise.all(pending)).flat();
    const { step } = await background;
    steps.push(step);

    const describeResults = (subset: typeof results) => {
      const statuses: Record<string, number> = {};
      for (const result of subset) {
        const key = result.reason === undefined ? String(result.status) : `${result.status}:${result.reason}`;
        statuses[key] = (statuses[key] ?? 0) + 1;
      }
      return { attempts: subset.length, statuses, latency: summarizeLatencies(subset.map((result) => result.latencyMs)) };
    };
    const staggeredResults = describeResults(results.filter((result) => !result.stress));
    const stressResults = describeResults(results.filter((result) => result.stress));
    const latency = staggeredResults.latency;
    report.race = { staggered: staggeredResults, simultaneous: stressResults, backgroundContention: contentionCount(step) };
    console.info(`[load] acceptance race: ${JSON.stringify(report.race)}`);

    expect(results.filter((result) => result.status >= 500)).toEqual([]);
    expect(results.every((result) => result.status === 201 || result.status === 409)).toBe(true);
    for (const group of seeded.raceGroups) {
      const mine = results.filter((result) => result.group === group);
      expect(mine.filter((result) => result.overlapping && result.status === 201)).toHaveLength(1);
      expect(mine.filter((result) => !result.overlapping).every((result) => result.status === 201)).toBe(true);
    }
    const stored = await pool.query<{ tractor_id: string; accepted: number }>(
      `SELECT tractor_id, count(*) FILTER (WHERE status = 'ACCEPTED')::int AS accepted FROM public.bookings
       WHERE tractor_id = ANY($1::uuid[]) AND requested_start_at >= now() + interval '95 days' GROUP BY tractor_id`,
      [seeded.raceGroups.map((group) => group.tractorId)]);
    expect(stored.rows.every((row) => row.accepted === 1 + trafficProfile.raceAdjacentPerTractor)).toBe(true);
    const overlaps = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM public.bookings a JOIN public.bookings b ON a.tractor_id = b.tractor_id AND a.id < b.id
       WHERE a.status IN ('ACCEPTED', 'SCHEDULED', 'IN_PROGRESS') AND b.status IN ('ACCEPTED', 'SCHEDULED', 'IN_PROGRESS')
         AND tstzrange(a.requested_start_at, a.requested_end_at, '[)') && tstzrange(b.requested_start_at, b.requested_end_at, '[)')`);
    expect(overlaps.rows[0]!.n).toBe(0);
    expect(latency.p95Ms).toBeLessThan(latencyBudgets.writeP95Ms);
    expect(step.byKind.every((kind) => kind.serverErrors === 0)).toBe(true);
  }, 300_000);

  it("serves twice the design load without server errors (headroom, reported)", async () => {
    await refreshAll();
    substitutions = 0;
    const { step, server } = await runStep("headroom (2× design)", trafficProfile.headroomRequestsPerSecond, stepSeconds);
    steps.push(step);
    report.headroomServer = server;
    report.headroomSubstitutions = substitutions;
    expect(step.byKind.every((kind) => kind.serverErrors === 0), JSON.stringify(step.byOperation)).toBe(true);
  }, 600_000);

  // ---- Responsive Farmer and Owner screens ------------------------------------------------------

  itBrowser("lays out Farmer and Owner key screens without horizontal overflow on every device profile", async () => {
    await refreshAll();
    const previousApiOrigin = process.env.PUBLIC_API_ORIGIN;
    process.env.PUBLIC_API_ORIGIN = api.baseUrl;
    let web: ProductionServer | undefined;
    let browser: HeadlessBrowser | undefined;
    const findings: Json[] = [];
    try {
      web = await startProductionServer();
      browser = await HeadlessBrowser.launch(browserPath!);
      const farmer = farmers[0]!;
      const owner = fleetOwners[0]!;
      const farmerBooking = farmerCompleted.get(farmer.userId)![0]!;
      const ownerBooking = ownerSamples.get(owner.userId)![0]!;
      const district = launchDistricts[0]!;
      const start = new Date(Math.ceil(Date.now() / 3_600_000) * 3_600_000 + 6 * 86_400_000);
      const search = new URLSearchParams({
        search: "1", state: district.state, district: district.district, mandalOrTaluk: district.district, village: "Hanamkonda",
        latitude: String(district.latitude), longitude: String(district.longitude), serviceId: loadServices[0].id,
        start: start.toISOString(), end: new Date(start.getTime() + 3 * 3_600_000).toISOString(), radius: "25",
      });
      const screens = [
        { role: "farmer", principal: farmer, path: "/farmer" },
        { role: "farmer", principal: farmer, path: `/farmer/search?${search}` },
        { role: "farmer", principal: farmer, path: "/farmer/bookings" },
        { role: "farmer", principal: farmer, path: `/farmer/bookings/${farmerBooking}` },
        { role: "owner", principal: owner, path: "/owner" },
        { role: "owner", principal: owner, path: "/owner/bookings" },
        { role: "owner", principal: owner, path: `/owner/bookings/${ownerBooking}` },
        { role: "owner", principal: owner, path: "/owner/tractors" },
      ];
      for (const profile of allDeviceProfiles) {
        for (const screen of screens) {
          const page = await browser.newPage();
          try {
            await page.send("Emulation.setDeviceMetricsOverride", {
              width: profile.width, height: profile.height, deviceScaleFactor: profile.deviceScaleFactor, mobile: profile.mobile,
            });
            await page.send("Emulation.setTouchEmulationEnabled", { enabled: profile.touch, maxTouchPoints: profile.touch ? 5 : 1 });
            await page.send("Network.setCookie", { name: "kt_access_token", value: screen.principal.client.accessCredential!, url: web.origin });
            await page.send("Network.setCookie", { name: "kt_locale", value: "en", url: web.origin });
            await page.navigate(`${web.origin}${screen.path}`);
            const audit = await page.evaluate<Json>(`(() => {
              const root = document.documentElement;
              const width = root.clientWidth;
              const overflowing = [...document.querySelectorAll("body *")]
                .filter((element) => { const box = element.getBoundingClientRect(); return box.width > 0 && box.right > width + 1; })
                .slice(0, 5).map((element) => element.tagName.toLowerCase() + (element.className ? "." + String(element.className).split(" ")[0] : ""));
              const images = [...document.images].map((image) => ({
                src: image.currentSrc.split("/").pop(), rendered: Math.round(image.getBoundingClientRect().width),
                natural: image.naturalWidth, sized: image.hasAttribute("width") && image.hasAttribute("height"),
              }));
              const resources = performance.getEntriesByType("resource");
              const bytes = (pattern) => resources.filter((entry) => pattern.test(entry.name)).reduce((sum, entry) => sum + entry.transferSize, 0);
              // innerWidth is the layout viewport; clientWidth excludes a desktop scrollbar.
              return {
                viewport: innerWidth, clientWidth: width, scrollWidth: root.scrollWidth, overflowPx: Math.max(0, root.scrollWidth - width), overflowing, images,
                path: location.pathname, title: document.querySelector("h1")?.textContent?.trim() ?? null,
                jsBytes: bytes(/\\.js(\\?|$)/), cssBytes: bytes(/\\.css(\\?|$)/), imageBytes: bytes(/\\.(avif|webp|png|jpe?g|svg)(\\?|$)/),
              };
            })()`);
            const finding = { profile: profile.id, screen: screen.path.split("?")[0], ...audit };
            findings.push(finding);
            expect(audit.path, `${profile.id} ${screen.path} redirected`).not.toBe("/login");
            expect(audit.viewport, `${profile.id} ${screen.path}`).toBe(profile.width);
            expect(audit.overflowPx, `${profile.id} ${screen.path}: ${audit.overflowing.join(", ")}`).toBe(0);
            for (const image of audit.images as Json[]) {
              expect(image.rendered, `${profile.id} ${screen.path} ${image.src}`).toBeLessThanOrEqual(profile.width);
            }
          } finally {
            await page.close();
          }
        }
      }
    } finally {
      report.responsive = findings;
      console.info(`[load] responsive audit: ${JSON.stringify(findings.map(({ profile, screen, overflowPx, jsBytes, cssBytes, imageBytes, images }) =>
        ({ profile, screen, overflowPx, jsBytes, cssBytes, imageBytes, images: images.length })))}`);
      await browser?.close();
      await web?.stop();
      if (previousApiOrigin === undefined) delete process.env.PUBLIC_API_ORIGIN;
      else process.env.PUBLIC_API_ORIGIN = previousApiOrigin;
    }
  }, 600_000);
});
