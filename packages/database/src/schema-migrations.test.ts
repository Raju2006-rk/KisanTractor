import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { SqlConnection, SqlPool, SqlQueryResult } from "./client.js";
import { migrations, type SqlMigration } from "./migrations.js";
import {
  MigrationFailedError,
  MigrationHistoryError,
  applyPendingMigrations,
  migrationBody,
  migrationChecksum,
} from "./schema-migrations.js";

interface LedgerRow { id: string; checksum: string | null; applied_at: Date }

/** A fake connection that keeps the ledger in memory and records every migration script. */
class LedgerPool implements SqlPool {
  readonly scripts: string[] = [];
  readonly statements: string[] = [];
  released = 0;
  constructor(readonly ledger: LedgerRow[] = [], readonly failOn?: string) {}

  async query<Row extends object = Record<string, unknown>>(text: string, values: readonly unknown[] = []): Promise<SqlQueryResult<Row>> {
    this.statements.push(text);
    const result = (rows: object[]): SqlQueryResult<Row> => ({ rows: rows as Row[], rowCount: rows.length });
    if (text.startsWith("BEGIN;")) {
      const id = /VALUES \('([^']+)', '([0-9a-f]+)'\)/u.exec(text);
      if (this.failOn !== undefined && id?.[1] === this.failOn) throw Object.assign(new Error("boom"), { code: "42P07" });
      this.scripts.push(text);
      this.ledger.push({ id: id![1]!, checksum: id![2]!, applied_at: new Date() });
      return result([]);
    }
    if (text.includes("to_regclass")) return result([{ exists: true }]);
    if (text.includes("information_schema.columns")) return result([{ present: true }]);
    if (text.startsWith("SELECT id,")) return result([...this.ledger].sort((a, b) => a.id.localeCompare(b.id)));
    if (text.startsWith("UPDATE public.kisantractor_schema_migrations")) {
      const row = this.ledger.find(({ id }) => id === values[0]);
      if (row !== undefined && row.checksum === null) row.checksum = String(values[1]);
      return result([]);
    }
    return result([]);
  }

  async connect(): Promise<SqlConnection> {
    return { query: (text, values) => this.query(text, values), release: () => { this.released += 1; } };
  }
}

const checksumOf = (migration: SqlMigration): string => migrationChecksum(readFileSync(migration.up, "utf8"));
const appliedRows = (count: number): LedgerRow[] =>
  migrations.slice(0, count).map((migration) => ({ id: migration.id, checksum: checksumOf(migration), applied_at: new Date(0) }));

/** Validates: Requirements 18.5 */
describe("roll-forward migration runner", () => {
  it("checksums content independent of line endings", () => {
    expect(migrationChecksum("BEGIN;\r\nSELECT 1;\r\nCOMMIT;\r\n")).toBe(migrationChecksum("BEGIN;\nSELECT 1;\nCOMMIT;\n"));
    expect(migrationChecksum("SELECT 1;")).not.toBe(migrationChecksum("SELECT 2;"));
  });

  it("unwraps every registered migration so it can commit with its ledger row", () => {
    for (const migration of migrations) {
      const body = migrationBody(migration.id, readFileSync(migration.up, "utf8"));
      expect(body.length, migration.id).toBeGreaterThan(0);
      expect(body, migration.id).not.toMatch(/^BEGIN;|COMMIT;$/u);
    }
    expect(() => migrationBody("0099_bad", "BEGIN;\nSELECT 1;")).toThrow(MigrationHistoryError);
  });

  it("applies pending migrations in order, each atomically with its ledger row, under the lock", async () => {
    const pool = new LedgerPool(appliedRows(8));
    const result = await applyPendingMigrations(pool, migrations);
    expect(result).toEqual({ applied: migrations.slice(8).map(({ id }) => id), alreadyApplied: 8, adopted: [] });
    for (const [index, script] of pool.scripts.entries()) {
      const migration = migrations[8 + index]!;
      expect(script.startsWith("BEGIN;\n")).toBe(true);
      expect(script.endsWith(`VALUES ('${migration.id}', '${checksumOf(migration)}');\nCOMMIT;`)).toBe(true);
      expect(script.match(/\bBEGIN;/gu)).toHaveLength(1);
    }
    expect(pool.statements[0]).toContain("pg_advisory_lock");
    expect(pool.statements.at(-1)).toContain("pg_advisory_unlock");
    expect(pool.released).toBe(1);
    // Running again is a no-op.
    expect(await applyPendingMigrations(pool, migrations)).toEqual({ applied: [], alreadyApplied: migrations.length, adopted: [] });
  });

  it("adopts ledger rows written before checksums were recorded", async () => {
    const pool = new LedgerPool(appliedRows(3).map((row) => ({ ...row, checksum: null })));
    const result = await applyPendingMigrations(pool, migrations.slice(0, 3));
    expect(result.adopted).toEqual(migrations.slice(0, 3).map(({ id }) => id));
    expect(pool.ledger.every(({ checksum }) => checksum !== null)).toBe(true);
  });

  it("refuses a changed applied migration, an unknown applied migration, and a gap", async () => {
    const changed = appliedRows(2);
    changed[1] = { ...changed[1]!, checksum: "0".repeat(64) };
    await expect(applyPendingMigrations(new LedgerPool(changed), migrations))
      .rejects.toMatchObject({ code: "MIGRATION_CHECKSUM_MISMATCH", migrationId: migrations[1]!.id });
    await expect(applyPendingMigrations(new LedgerPool([...appliedRows(2), { id: "9999_from_the_future", checksum: "x", applied_at: new Date() }]), migrations))
      .rejects.toMatchObject({ code: "MIGRATION_HISTORY_DIVERGED", migrationId: "9999_from_the_future" });
    const gap = appliedRows(4).filter((_, index) => index !== 2);
    await expect(applyPendingMigrations(new LedgerPool(gap), migrations))
      .rejects.toMatchObject({ code: "MIGRATION_HISTORY_DIVERGED", migrationId: migrations[3]!.id });
  });

  it("rolls back a failing migration, stops, and reports only its id and SQLSTATE", async () => {
    const pool = new LedgerPool(appliedRows(10), migrations[11]!.id);
    const error = await applyPendingMigrations(pool, migrations).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MigrationFailedError);
    expect(error).toMatchObject({ migrationId: migrations[11]!.id, causeCode: "42P07" });
    expect(pool.ledger.map(({ id }) => id)).toEqual(migrations.slice(0, 11).map(({ id }) => id));
    expect(pool.statements).toContain("ROLLBACK");
    expect(pool.released).toBe(1);
  });
});
