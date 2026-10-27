import { additivityExceptions, migrations } from "@kisantractor/database";
import {
  REPRESENTATIVE_TABLES,
  additivityFindings,
  assertSafeTestDatabaseUrl,
  captureSchemaSnapshot,
  columnsByTable,
  comparableSchema,
  dropApplicationSchema,
  findingKey,
  runMigrationFile,
  seedRepresentativeDataset,
  tableChecksums,
  type SchemaSnapshot,
} from "@kisantractor/test-utils";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PgPoolAdapter } from "../sql-pool.js";

/**
 * Additive migrations, reversible round-trips, and roll-forward over existing data, against a
 * real PostGIS database. Skipped unless MIGRATION_INTEGRATION_DATABASE_URL names a local database
 * whose name contains `test`; the suite drops and recreates its `public` schema.
 *
 * Validates: Requirements 18.5
 */
const databaseUrl = process.env.MIGRATION_INTEGRATION_DATABASE_URL;
const describeDatabase = databaseUrl === undefined ? describe.skip : describe;

/** Roll-forward checkpoint: data is written at this version, then every later migration runs. */
const ROLL_FORWARD_FROM = "0008_versioned_pricing_rules";

describeDatabase("database migrations", () => {
  let pool: PgPoolAdapter;
  /** snapshots[i] is the schema after migrations[0..i-1]; snapshots[0] is the empty schema. */
  const snapshots: SchemaSnapshot[] = [];
  const findingsByMigration = new Map<string, string[]>();
  const roundTripFailures: string[] = [];

  beforeAll(async () => {
    assertSafeTestDatabaseUrl(databaseUrl!);
    pool = new PgPoolAdapter(new Pool({ connectionString: databaseUrl, max: 2 }));
    await dropApplicationSchema(pool, databaseUrl!);
    snapshots.push(await captureSchemaSnapshot(pool));
    // One pass from empty: up N, snapshot, then down N and up N again on the same schema.
    for (const [index, migration] of migrations.entries()) {
      const before = snapshots[index]!;
      await runMigrationFile(pool, migration, "up");
      const after = await captureSchemaSnapshot(pool);
      snapshots.push(after);
      findingsByMigration.set(migration.id, additivityFindings(before, after).map(findingKey).sort());

      await runMigrationFile(pool, migration, "down");
      const rolledBack = await captureSchemaSnapshot(pool);
      if (JSON.stringify(comparableSchema(rolledBack)) !== JSON.stringify(comparableSchema(before))) {
        roundTripFailures.push(`${migration.id} down did not restore the previous schema: ${schemaDifference(before, rolledBack)}`);
      }
      await runMigrationFile(pool, migration, "up");
      const reapplied = await captureSchemaSnapshot(pool);
      if (JSON.stringify(comparableSchema(reapplied)) !== JSON.stringify(comparableSchema(after))) {
        roundTripFailures.push(`${migration.id} up after down differs: ${schemaDifference(after, reapplied)}`);
      }
    }
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
  });

  it("applies every registered migration to an empty database", () => {
    const latest = snapshots.at(-1)!;
    expect(snapshots).toHaveLength(migrations.length + 1);
    expect(snapshots[0]!.tables).toEqual([]);
    for (const table of [...REPRESENTATIVE_TABLES, "booking_agreements"]) expect(latest.tables).toContain(table);
  });

  it("round-trips each migration down and up to the identical schema", () => {
    expect(roundTripFailures).toEqual([]);
  });

  it("rolls the whole chain back to an empty application schema", async () => {
    for (const migration of [...migrations].reverse()) await runMigrationFile(pool, migration, "down");
    const empty = await captureSchemaSnapshot(pool);
    expect(comparableSchema(empty)).toEqual(comparableSchema(snapshots[0]!));
    for (const migration of migrations) await runMigrationFile(pool, migration, "up");
    expect(comparableSchema(await captureSchemaSnapshot(pool))).toEqual(comparableSchema(snapshots.at(-1)!));
  }, 120_000);

  it("adds schema without dropping, renaming, retyping, or narrowing it, except for the justified exceptions", () => {
    const actual = Object.fromEntries([...findingsByMigration].filter(([, findings]) => findings.length > 0));
    const declared = Object.fromEntries(additivityExceptions
      .filter(({ catalogFindings }) => catalogFindings.length > 0)
      .map(({ migrationId, catalogFindings }) => [migrationId, [...catalogFindings].sort()]));
    expect(actual).toEqual(declared);
    for (const exception of additivityExceptions) expect(exception.justification.length).toBeGreaterThan(40);
    // Destructive kinds never appear, justified or not.
    const destructive = Object.values(actual).flat().filter((finding) =>
      /^(TABLE_DROPPED|COLUMN_DROPPED|COLUMN_TYPE_CHANGED|ENUM_DROPPED|ENUM_VALUE_REMOVED_OR_REORDERED|FUNCTION_DROPPED):/u.test(finding));
    expect(destructive).toEqual([]);
  });

  it("rolls forward from an earlier version with existing data preserved", async () => {
    const checkpoint = migrations.findIndex(({ id }) => id === ROLL_FORWARD_FROM);
    expect(checkpoint).toBeGreaterThan(0);
    await dropApplicationSchema(pool, databaseUrl!);
    for (const migration of migrations.slice(0, checkpoint + 1)) await runMigrationFile(pool, migration, "up");

    // Data written by the release that shipped ROLL_FORWARD_FROM: two complete histories.
    const first = await seedRepresentativeDataset(pool, { ordinal: 1 });
    await seedRepresentativeDataset(pool, { ordinal: 2, bookingStatus: "DISPUTED" });
    const oldColumns = columnsByTable(await captureSchemaSnapshot(pool));
    const before = await tableChecksums(pool, oldColumns);
    expect(before.bookings!.rows).toBe(2);
    expect(before.invoices!.rows).toBe(2);

    // Roll forward one migration at a time, re-checking the old data after each step.
    const drift: string[] = [];
    for (const migration of migrations.slice(checkpoint + 1)) {
      await runMigrationFile(pool, migration, "up");
      const after = await tableChecksums(pool, oldColumns);
      for (const [table, checksum] of Object.entries(before)) {
        if (JSON.stringify(after[table]) !== JSON.stringify(checksum)) drift.push(`${migration.id} changed ${table}`);
      }
    }
    expect(drift).toEqual([]);
    expect(comparableSchema(await captureSchemaSnapshot(pool))).toEqual(comparableSchema(snapshots.at(-1)!));

    // 0009 backfilled the purpose of locations that existed before it.
    const purposes = await pool.query<{ id: string; collection_purpose: string }>(
      "SELECT id::text AS id, collection_purpose FROM public.locations WHERE id = ANY($1::uuid[]) ORDER BY id",
      [[first.customerLocationId, first.ownerLocationId]],
    );
    expect(Object.fromEntries(purposes.rows.map((row) => [row.id, row.collection_purpose]))).toEqual({
      [first.customerLocationId]: "SERVICE_LOCATION",
      [first.ownerLocationId]: "TRACTOR_OPERATING_LOCATION",
    });
    // Columns added after the checkpoint read their defaults on old rows.
    const outbox = await pool.query<{ correlation_id: string | null; dead_lettered_at: Date | null }>(
      "SELECT correlation_id, dead_lettered_at FROM public.outbox_events LIMIT 1");
    expect(outbox.rows[0]).toEqual({ correlation_id: null, dead_lettered_at: null });
    const notification = await pool.query<{ test_only: boolean; capability_state: string | null }>(
      "SELECT test_only, capability_state FROM public.notifications WHERE id = $1", [first.notificationId]);
    expect(notification.rows[0]).toEqual({ test_only: false, capability_state: null });

    // The append-only history is still enforced on rolled-forward rows.
    await expect(pool.query("UPDATE public.invoices SET total_paise = 1 WHERE id = $1", [first.invoiceId]))
      .rejects.toMatchObject({ code: "55000" });
    await expect(pool.query("DELETE FROM public.booking_status_history WHERE booking_id = $1", [first.bookingId]))
      .rejects.toMatchObject({ code: "55000" });
  }, 180_000);
});

/** First few differing keys between two snapshots, for a readable failure. */
function schemaDifference(expected: SchemaSnapshot, actual: SchemaSnapshot): string {
  const differences: string[] = [];
  for (const section of ["tables", "columns", "enums", "indexes", "constraints", "triggers", "functions"] as const) {
    const left = expected[section] as unknown as Record<string, unknown>;
    const right = actual[section] as unknown as Record<string, unknown>;
    for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
      if (JSON.stringify(left[key]) !== JSON.stringify(right[key])) {
        differences.push(`${section}.${key}: ${JSON.stringify(left[key])} -> ${JSON.stringify(right[key])}`);
      }
    }
  }
  return differences.slice(0, 6).join("; ");
}
