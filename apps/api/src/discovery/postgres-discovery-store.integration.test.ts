import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

import type { SqlConnection, SqlPool, SqlQueryResult } from "@kisantractor/database";
import { createTestDatabaseFactory, type TestDatabase } from "@kisantractor/test-utils";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { DiscoveryStoreRow, NormalizedDiscoveryQuery } from "./discovery.contracts.js";
import { PostgresDiscoveryStore } from "./postgres-discovery-store.js";

const databaseUrl = process.env.DISCOVERY_INTEGRATION_DATABASE_URL;
const describeDatabase = databaseUrl === undefined ? describe.skip : describe;
const evaluatedAt = new Date("2025-03-01T10:00:00.000Z");
const requestedStart = new Date("2025-03-02T04:00:00.000Z");
const requestedEnd = new Date("2025-03-02T08:00:00.000Z");
const serviceId = "30000000-0000-0000-0000-000000000001";
const equipmentTypeId = "50000000-0000-0000-0000-000000000001";

const uuidFor = (prefix: string, ordinal: number): string => {
  const digest = createHash("md5").update(`${prefix}-${ordinal}`).digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20)}`;
};

class PgConnectionAdapter implements SqlConnection {
  constructor(private readonly client: PoolClient) {}

  async query<Row extends object = Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<SqlQueryResult<Row>> {
    const result = await this.client.query<Row>(text, [...values]);
    return { rows: result.rows, rowCount: result.rowCount ?? 0 };
  }

  release(): void {
    this.client.release();
  }
}

class PgPoolAdapter implements SqlPool {
  readonly discoveryCalls: Array<{ text: string; values: readonly unknown[] }> = [];

  constructor(private readonly pool: Pool) {}

  async query<Row extends object = Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<SqlQueryResult<Row>> {
    if (/^WITH origin AS/u.test(text)) {
      this.discoveryCalls.push({ text, values });
    }
    const result = await this.pool.query<Row>(text, [...values]);
    return { rows: result.rows, rowCount: result.rowCount ?? 0 };
  }

  async connect(): Promise<SqlConnection> {
    return new PgConnectionAdapter(await this.pool.connect());
  }

  async end(): Promise<void> {
    await this.pool.end();
  }
}

const baseQuery = (overrides: Partial<NormalizedDiscoveryQuery> = {}): NormalizedDiscoveryQuery => ({
  serviceLocation: {
    state: "Karnataka",
    district: "Mysuru",
    mandalOrTaluk: "Nanjangud",
    village: "Search origin",
    source: "MANUAL_ADDRESS",
    latitude: 12.1198,
    longitude: 76.6801,
    capturedAt: evaluatedAt,
    collectionPurpose: "SERVICE_LOCATION",
  },
  serviceId,
  equipmentTypeId,
  pricingMethod: "HOURLY",
  requestedInterval: { start: requestedStart, end: requestedEnd },
  radiusKilometers: 80,
  pageSize: 50,
  evaluatedAt,
  staleBefore: new Date("2025-02-28T10:00:00.000Z"),
  ...overrides,
});

/**
 * PostgreSQL's extended protocol accepts one statement per parameterized query, so the seed
 * script runs statement by statement, each bound only to the shared values it references.
 */
const runSeedScript = async (pool: SqlPool, script: string, values: readonly unknown[]): Promise<void> => {
  for (const statement of script.split(/;\s*(?:\n|$)/u).map((text) => text.trim()).filter((text) => text.length > 0)) {
    const used = [...new Set([...statement.matchAll(/\$(\d+)/gu)].map((match) => Number(match[1])))].sort((a, b) => a - b);
    const text = statement.replace(/\$(\d+)/gu, (_, ordinal: string) => `$${used.indexOf(Number(ordinal)) + 1}`);
    await pool.query(text, used.map((ordinal) => values[ordinal - 1]));
  }
};

const seedBroadRuralDataset = async (pool: SqlPool): Promise<void> => {
  await runSeedScript(
    pool,
    `INSERT INTO public.users (id, normalized_phone_ciphertext, phone_lookup_hash)
       VALUES
         ('10000000-0000-0000-0000-000000000001', decode('01', 'hex'), 'owner-phone'),
         ('10000000-0000-0000-0000-000000000002', decode('02', 'hex'), 'farmer-phone');
     INSERT INTO public.locations (
       id, owner_user_id, coordinates, state, district, mandal_or_taluk, village,
       source, captured_at, collection_purpose
     ) VALUES (
       '20000000-0000-0000-0000-000000000001',
       '10000000-0000-0000-0000-000000000001',
       ST_SetSRID(ST_MakePoint(76.6801, 12.1198), 4326)::geography,
       'Karnataka', 'Mysuru', 'Nanjangud', 'Owner village', 'MANUAL_ADDRESS', $1,
       'TRACTOR_OPERATING_LOCATION'
     );
     INSERT INTO public.user_profiles (user_id, full_name, contact_sharing_consent)
       VALUES
         ('10000000-0000-0000-0000-000000000001', 'Integration Owner', true),
         ('10000000-0000-0000-0000-000000000002', 'Integration Farmer', false);
     INSERT INTO public.owner_profiles (user_id, operating_location_id, verification_status)
       VALUES (
         '10000000-0000-0000-0000-000000000001',
         '20000000-0000-0000-0000-000000000001',
         'VERIFIED'
       );
     INSERT INTO public.services (id, stable_code, display_name)
       VALUES ($2, 'TILLING', 'Tilling');
     INSERT INTO public.equipment_types (id, stable_code, display_name)
       VALUES ($3, 'CULTIVATOR', 'Cultivator');

     INSERT INTO public.locations (
       id, owner_user_id, coordinates, state, district, mandal_or_taluk, village,
       source, captured_at, collection_purpose
     )
     SELECT md5('location-' || i)::uuid,
            '10000000-0000-0000-0000-000000000001',
            ST_SetSRID(ST_MakePoint(
              76.6801 + (((i - 1) % 100) - 50) * 0.009,
              12.1198 + floor((i - 1) / 100) * 0.009
            ), 4326)::geography,
            'Karnataka', 'Mysuru', 'Nanjangud', 'Rural village ' || i,
            'MANUAL_ADDRESS', $1, 'TRACTOR_OPERATING_LOCATION'
       FROM generate_series(1, 2000) AS generated(i);

     INSERT INTO public.tractors (
       id, owner_id, brand, model, registration_number_ciphertext,
       registration_lookup_hash, manufacturing_year, horsepower,
       operational_status, eligibility_status, current_location_id, location_updated_at
     )
     SELECT md5('tractor-' || i)::uuid,
            '10000000-0000-0000-0000-000000000001',
            'Mahindra', 'Rural ' || i, decode(lpad(to_hex(i), 8, '0'), 'hex'),
            'registration-' || i, 2020, 45,
            CASE WHEN i % 11 = 0 THEN 'OFFLINE'::operational_status ELSE 'ONLINE'::operational_status END,
            CASE WHEN i % 13 = 0 THEN 'INELIGIBLE'::eligibility_status ELSE 'ELIGIBLE'::eligibility_status END,
            md5('location-' || i)::uuid,
            CASE WHEN i % 17 = 0 THEN $1::timestamptz - interval '3 days' ELSE $1::timestamptz END
       FROM generate_series(1, 2000) AS generated(i);

     INSERT INTO public.tractor_availability (tractor_id, operational_status, effective_at)
     SELECT md5('tractor-' || i)::uuid,
            CASE WHEN i % 19 = 0 THEN 'OFFLINE'::operational_status ELSE 'ONLINE'::operational_status END,
            $1
       FROM generate_series(1, 2000) AS generated(i);

     INSERT INTO public.equipment (
       id, owner_id, tractor_id, equipment_type_id, display_name, availability_status
     )
     SELECT md5('equipment-' || i)::uuid,
            '10000000-0000-0000-0000-000000000001', md5('tractor-' || i)::uuid,
            $3, 'Cultivator ' || i,
            CASE WHEN i % 31 = 0 THEN 'UNAVAILABLE'::equipment_availability_status
                 ELSE 'AVAILABLE'::equipment_availability_status END
       FROM generate_series(1, 2000) AS generated(i);

     INSERT INTO public.service_offerings (id, tractor_id, service_id, equipment_id, enabled)
     SELECT md5('offering-' || i)::uuid, md5('tractor-' || i)::uuid, $2,
            md5('equipment-' || i)::uuid, i % 23 <> 0
       FROM generate_series(1, 2000) AS generated(i);

     INSERT INTO public.pricing_rules (
       id, service_offering_id, method, rate_paise, currency, rounding_policy,
       valid_from, enabled
     )
     SELECT md5('pricing-' || i)::uuid, md5('offering-' || i)::uuid,
            'HOURLY', 80000 + i, 'INR', 'PROPORTIONAL_MINUTE',
            $1::timestamptz - interval '30 days', i % 29 <> 0
       FROM generate_series(1, 2000) AS generated(i);

     INSERT INTO public.bookings (
       id, public_reference, customer_id, owner_id, tractor_id, service_offering_id,
       requested_start_at, requested_end_at, status
     ) VALUES (
       '70000000-0000-0000-0000-000000000001', 'BLOCKED-RURAL-1',
       '10000000-0000-0000-0000-000000000002',
       '10000000-0000-0000-0000-000000000001', md5('tractor-1')::uuid,
       md5('offering-1')::uuid, $4, $5, 'ACCEPTED'
     );
     ANALYZE public.locations;
     ANALYZE public.tractors;
     ANALYZE public.tractor_availability;
     ANALYZE public.service_offerings;
     ANALYZE public.pricing_rules;
     ANALYZE public.bookings;`,
    [evaluatedAt.toISOString(), serviceId, equipmentTypeId, requestedStart.toISOString(), requestedEnd.toISOString()],
  );
};

const collectPages = async (
  store: PostgresDiscoveryStore,
  query: NormalizedDiscoveryQuery,
): Promise<readonly DiscoveryStoreRow[]> => {
  const rows: DiscoveryStoreRow[] = [];
  let cursor = query.cursor;
  for (;;) {
    const page = await store.search({ ...query, ...(cursor === undefined ? {} : { cursor }) });
    const visible = page.slice(0, query.pageSize);
    rows.push(...visible);
    if (page.length <= query.pageSize) return rows;
    const last = visible.at(-1)!;
    cursor = {
      availabilityRank: last.availabilityRank,
      distanceMeters: last.distanceMeters,
      tractorId: last.tractorId,
    };
  }
};

/** Validates: Requirements 7.4, 7.5, 7.8, 18.3, 18.4 */
describeDatabase("PostgresDiscoveryStore database integration and performance", () => {
  let database: TestDatabase;
  let pool: PgPoolAdapter;
  let store: PostgresDiscoveryStore;

  beforeAll(async () => {
    pool = new PgPoolAdapter(new Pool({ connectionString: databaseUrl, max: 4 }));
    database = await createTestDatabaseFactory({
      databaseUrl: databaseUrl!,
      createPool: async () => pool,
    })();
    await seedBroadRuralDataset(pool);
    store = new PostgresDiscoveryStore(pool);
  }, 120_000);

  afterAll(async () => {
    await database?.dispose();
  });

  it("uses the spatial GiST index and keeps broad rural search p95 below the read latency target", async () => {
    await store.search(baseQuery({ radiusKilometers: 5 }));
    const call = pool.discoveryCalls.at(-1)!;
    const plan = await pool.query<Record<string, unknown>>(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${call.text}`,
      call.values,
    );
    const planDocument = Object.values(plan.rows[0] ?? {})[0];
    expect(JSON.stringify(planDocument)).toContain("locations_coordinates_gist_idx");

    const durations: number[] = [];
    for (let run = 0; run < 20; run += 1) {
      const startedAt = performance.now();
      const rows = await store.search(baseQuery());
      durations.push(performance.now() - startedAt);
      expect(rows.length).toBeLessThanOrEqual(51);
    }
    durations.sort((left, right) => left - right);
    const p95 = durations[Math.ceil(durations.length * 0.95) - 1]!;
    expect(p95).toBeLessThan(500);
  }, 30_000);

  it("filters every ineligible dimension, blocking intervals, and stale locations in the database", async () => {
    const rows = await collectPages(store, baseQuery());
    const ids = rows.map((row) => row.tractorId);

    expect(ids).toContain(uuidFor("tractor", 2));
    expect(ids).not.toContain(uuidFor("tractor", 1));
    expect(ids).not.toContain(uuidFor("tractor", 11));
    expect(ids).not.toContain(uuidFor("tractor", 13));
    expect(ids).not.toContain(uuidFor("tractor", 17));
    expect(ids).not.toContain(uuidFor("tractor", 19));
    expect(ids).not.toContain(uuidFor("tractor", 23));
    expect(ids).not.toContain(uuidFor("tractor", 29));
    expect(ids).not.toContain(uuidFor("tractor", 31));

    const violations = await pool.query<{ readonly count: string }>(
      `SELECT count(*)::text AS count
         FROM unnest($1::uuid[]) result(tractor_id)
         JOIN public.tractors t ON t.id = result.tractor_id
         JOIN public.tractor_availability ta ON ta.tractor_id = t.id
         JOIN public.service_offerings so ON so.tractor_id = t.id
         JOIN public.equipment e ON e.id = so.equipment_id
         JOIN public.pricing_rules pr ON pr.service_offering_id = so.id
        WHERE t.operational_status <> 'ONLINE'
           OR ta.operational_status <> 'ONLINE'
           OR t.eligibility_status <> 'ELIGIBLE'
           OR t.location_updated_at < $2
           OR t.location_updated_at > $3
           OR so.enabled = false
           OR e.availability_status <> 'AVAILABLE'
           OR pr.enabled = false`,
      [ids, baseQuery().staleBefore.toISOString(), evaluatedAt.toISOString()],
    );
    expect(violations.rows[0]?.count).toBe("0");
  }, 30_000);

  it("returns stable, duplicate-free keyset pagination across repeated broad searches", async () => {
    const pagedQuery = baseQuery({ pageSize: 37 });
    const firstTraversal = await collectPages(store, pagedQuery);
    const secondTraversal = await collectPages(store, pagedQuery);
    const firstIds = firstTraversal.map((row) => row.tractorId);

    expect(firstIds.length).toBeGreaterThan(500);
    expect(new Set(firstIds).size).toBe(firstIds.length);
    expect(secondTraversal.map((row) => row.tractorId)).toEqual(firstIds);
    expect(firstTraversal).toEqual(
      [...firstTraversal].sort((left, right) =>
        left.availabilityRank - right.availabilityRank ||
        left.distanceMeters - right.distanceMeters ||
        left.tractorId.localeCompare(right.tractorId)),
    );
  }, 30_000);
});
