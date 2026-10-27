import {
  ReferenceDataDriftError,
  canonicalEquipmentTypes,
  canonicalServices,
  seedReferenceData,
  withTransaction,
} from "@kisantractor/database";
import { createTestDatabaseFactory, type TestDatabase } from "@kisantractor/test-utils";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PgPoolAdapter } from "../sql-pool.js";

/**
 * Canonical reference data seeding against PostgreSQL. Skipped unless
 * REFERENCE_DATA_INTEGRATION_DATABASE_URL names a local database whose name contains `test`.
 *
 * Validates: Requirements 18.5
 */
const databaseUrl = process.env.REFERENCE_DATA_INTEGRATION_DATABASE_URL;
const describeDatabase = databaseUrl === undefined ? describe.skip : describe;

interface ReferenceRowRecord extends Record<string, unknown> {
  readonly id: string;
  readonly stable_code: string;
  readonly display_name: string;
  readonly created_at: Date;
}

describeDatabase("canonical reference data seed", () => {
  let database: TestDatabase;
  let pool: PgPoolAdapter;

  const rows = async (table: "services" | "equipment_types") =>
    (await pool.query<ReferenceRowRecord>(
      `SELECT id::text AS id, stable_code, display_name, created_at FROM public.${table} ORDER BY id`,
    )).rows;

  beforeAll(async () => {
    pool = new PgPoolAdapter(new Pool({ connectionString: databaseUrl, max: 4 }));
    database = await createTestDatabaseFactory({ databaseUrl: databaseUrl!, createPool: async () => pool })();
  }, 120_000);

  beforeEach(async () => {
    await database.reset();
  });

  afterAll(async () => {
    await database?.dispose();
  });

  it("writes every canonical row with its fixed UUID and stable code", async () => {
    const result = await seedReferenceData(pool);
    expect(result).toEqual({ version: 1, inserted: canonicalServices.length + canonicalEquipmentTypes.length, renamed: 0, unchanged: 0 });
    for (const [table, canonical] of [["services", canonicalServices], ["equipment_types", canonicalEquipmentTypes]] as const) {
      expect((await rows(table)).map(({ id, stable_code, display_name }) => ({ id, stable_code, display_name })))
        .toEqual(canonical.map(({ id, stableCode, displayName }) => ({ id, stable_code: stableCode, display_name: displayName }))
          .sort((left, right) => left.id.localeCompare(right.id)));
    }
  });

  it("is idempotent: re-running changes no identifier, row, or timestamp", async () => {
    await seedReferenceData(pool);
    const first = { services: await rows("services"), equipment: await rows("equipment_types") };
    for (let run = 0; run < 3; run += 1) {
      expect(await seedReferenceData(pool)).toEqual({
        version: 1, inserted: 0, renamed: 0, unchanged: canonicalServices.length + canonicalEquipmentTypes.length,
      });
    }
    expect({ services: await rows("services"), equipment: await rows("equipment_types") }).toEqual(first);
  });

  it("restores a renamed display name in place without changing the UUID", async () => {
    await seedReferenceData(pool);
    const ploughing = canonicalServices[0]!;
    await pool.query("UPDATE public.services SET display_name = 'Old name' WHERE id = $1", [ploughing.id]);
    expect((await seedReferenceData(pool)).renamed).toBe(1);
    const row = (await rows("services")).find(({ stable_code }) => stable_code === ploughing.stableCode);
    expect(row).toMatchObject({ id: ploughing.id, display_name: ploughing.displayName });
  });

  it("refuses identity drift and leaves the transaction without a partial seed", async () => {
    // An operator inserted ROTAVATION by hand under a random UUID.
    await pool.query("INSERT INTO public.services (stable_code, display_name) VALUES ('ROTAVATION', 'Rotavator')");
    await expect(withTransaction(pool, (sql) => seedReferenceData(sql))).rejects.toBeInstanceOf(ReferenceDataDriftError);
    expect((await rows("services")).map(({ stable_code }) => stable_code)).toEqual(["ROTAVATION"]);
    expect(await rows("equipment_types")).toEqual([]);
  });

  it("enforces one row per stable code in the schema (migration 0016)", async () => {
    await seedReferenceData(pool);
    await expect(pool.query("INSERT INTO public.equipment_types (stable_code, display_name) VALUES ('CULTIVATOR', 'Duplicate')"))
      .rejects.toMatchObject({ code: "23505" });
  });
});
