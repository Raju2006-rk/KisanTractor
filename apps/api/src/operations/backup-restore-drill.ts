import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyPendingMigrations,
  captureSchemaSnapshot,
  columnsByTable,
  comparableSchema,
  tableChecksums,
  verifyDatabaseIntegrity,
  type IntegrityReport,
  type SchemaSnapshot,
  type SqlMigration,
  type SqlPool,
} from "@kisantractor/database";

import { connectionParts, dumpDatabase, restoreDatabase, type PgToolsOptions } from "./pg-tools.js";

/**
 * Backup-restore drill (Requirements 12.7, 18.5; ops/runbooks/backup-restore.md): take a logical
 * backup of the source, restore it into an isolated empty target, roll the target forward with the
 * release's migrations, then prove integrity and that every row of every source table survived.
 *
 * Read-only for the source. The target is emptied first, so its database name must contain
 * `drill` or `test` and must differ from the source.
 */
export interface BackupRestoreDrillOptions {
  readonly sourceUrl: string;
  readonly targetUrl: string;
  readonly openPool: (databaseUrl: string) => SqlPool;
  readonly migrations: readonly SqlMigration[];
  readonly tools?: PgToolsOptions;
  /** Where the dump is written; defaults to the OS temp directory. The file is always deleted. */
  readonly workDirectory?: string;
  /** Empty a non-empty target's application schema before restoring. */
  readonly resetTarget?: boolean;
}

export interface BackupRestoreDrillReport {
  readonly ok: boolean;
  readonly dumpBytes: number;
  readonly dumpDurationMs: number;
  readonly restoreDurationMs: number;
  readonly rollForwardDurationMs: number;
  readonly totalDurationMs: number;
  /** Migrations the restored backup lacked and the drill applied. */
  readonly rolledForward: readonly string[];
  /** True when the restored schema (before roll-forward) matched the source (see `restoreComparable`). */
  readonly schemaMatchesSource: boolean;
  readonly schemaDifferences: readonly string[];
  readonly tablesCompared: number;
  readonly rowsCompared: number;
  readonly checksumMismatches: readonly string[];
  readonly integrity: IntegrityReport;
}

export class DrillTargetRefusedError extends Error {
  readonly code = "DRILL_TARGET_REFUSED";

  constructor(reason: string) {
    super(`Refusing to use the drill target: ${reason}`);
    this.name = "DrillTargetRefusedError";
  }
}

const DISPOSABLE_TARGET = /drill|test/iu;

/**
 * pg_dump writes CHECK expressions as PostgreSQL deparsed them and the restore parses them again,
 * which can regroup the parentheses of AND chains (`((a AND b) AND c)` becomes `(a AND b AND c)`).
 * The restored constraint is the same predicate, so constraint definitions are compared without
 * grouping parentheses; every other catalog detail is compared exactly. Restored constraints are
 * also exercised directly by the drill test.
 */
function restoreComparable(snapshot: SchemaSnapshot): Record<string, Record<string, unknown>> {
  const { constraints, ...rest } = comparableSchema(snapshot);
  return {
    ...(rest as unknown as Record<string, Record<string, unknown>>),
    constraints: Object.fromEntries(Object.entries(constraints).map(([name, constraint]) =>
      [name, { ...constraint, definition: constraint.definition.replace(/[()\s]/gu, "") }])),
  };
}

/** Catalog keys that differ between two schemas, for the drill report. */
function schemaDifferences(expected: SchemaSnapshot, actual: SchemaSnapshot): string[] {
  const left = restoreComparable(expected);
  const right = restoreComparable(actual);
  const differences: string[] = [];
  for (const section of Object.keys(left)) {
    const l = left[section] ?? {};
    const r = right[section] ?? {};
    for (const key of new Set([...Object.keys(l), ...Object.keys(r)])) {
      if (JSON.stringify(l[key]) !== JSON.stringify(r[key])) differences.push(`SCHEMA_DIFFERS:${section}.${key}`);
    }
  }
  return differences.sort();
}

async function prepareTarget(pool: SqlPool, resetTarget: boolean): Promise<void> {
  const tables = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')`);
  if (Number(tables.rows[0]?.count ?? 0) === 0) return;
  if (!resetTarget) throw new DrillTargetRefusedError("the target database is not empty (set resetTarget to empty it)");
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await pool.query("CREATE SCHEMA public");
  for (const extension of ["postgis", "btree_gist", "pgcrypto"]) await pool.query(`DROP EXTENSION IF EXISTS ${extension} CASCADE`);
}

export async function runBackupRestoreDrill(options: BackupRestoreDrillOptions): Promise<BackupRestoreDrillReport> {
  const source = connectionParts(options.sourceUrl);
  const target = connectionParts(options.targetUrl);
  if (source.host === target.host && source.port === target.port && source.database === target.database) {
    throw new DrillTargetRefusedError("the target is the source database");
  }
  if (!DISPOSABLE_TARGET.test(target.database)) throw new DrillTargetRefusedError("the target database name must contain 'drill' or 'test'");

  const started = performance.now();
  const dumpFile = join(options.workDirectory ?? tmpdir(), `kisantractor-drill-${randomUUID()}.dump`);
  const sourcePool = options.openPool(options.sourceUrl);
  const targetPool = options.openPool(options.targetUrl);
  try {
    const sourceSchema = await captureSchemaSnapshot(sourcePool);
    const sourceColumns = columnsByTable(sourceSchema);
    await prepareTarget(targetPool, options.resetTarget ?? false);

    // Checksums are read before the dump, so a busy source shows as a mismatch instead of passing
    // silently. Drills run against a quiesced copy or a snapshot.
    const expected = await tableChecksums(sourcePool, sourceColumns);
    const dump = await dumpDatabase(options.sourceUrl, dumpFile, options.tools);
    const restore = await restoreDatabase(options.targetUrl, dumpFile, options.tools);

    const schemaDifferencesFound = schemaDifferences(sourceSchema, await captureSchemaSnapshot(targetPool));
    const schemaMatchesSource = schemaDifferencesFound.length === 0;

    const rollForwardStarted = performance.now();
    const rolledForward = (await applyPendingMigrations(targetPool, options.migrations)).applied;
    const rollForwardDurationMs = Math.round(performance.now() - rollForwardStarted);

    const actual = await tableChecksums(targetPool, sourceColumns);
    const checksumMismatches = Object.keys(expected)
      .filter((table) => JSON.stringify(actual[table]) !== JSON.stringify(expected[table]))
      .map((table) => `TABLE_CHECKSUM_MISMATCH:${table}`);
    const integrity = await verifyDatabaseIntegrity(targetPool, options.migrations);

    return Object.freeze({
      ok: schemaMatchesSource && checksumMismatches.length === 0 && integrity.ok,
      dumpBytes: dump.bytes,
      dumpDurationMs: dump.durationMs,
      restoreDurationMs: restore.durationMs,
      rollForwardDurationMs,
      totalDurationMs: Math.round(performance.now() - started),
      rolledForward,
      schemaMatchesSource,
      schemaDifferences: Object.freeze(schemaDifferencesFound),
      tablesCompared: Object.keys(expected).length,
      rowsCompared: Object.values(expected).reduce((sum, { rows }) => sum + rows, 0),
      checksumMismatches: Object.freeze(checksumMismatches),
      integrity,
    });
  } finally {
    // The dump holds personal data; it never outlives the drill.
    await rm(dumpFile, { force: true });
    await sourcePool.end?.();
    await targetPool.end?.();
  }
}
