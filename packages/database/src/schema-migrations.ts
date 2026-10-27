import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { SqlConnection, SqlExecutor, SqlPool } from "./client.js";
import type { SqlMigration } from "./migrations.js";

/**
 * Roll-forward migration runner (Requirement 18.5). Applies registered up migrations in order,
 * each in one transaction together with its ledger row, under an advisory lock so two deploys
 * cannot migrate concurrently. A migration that was already applied is never re-run, and a change
 * to an applied migration's file is refused rather than silently ignored.
 *
 * The ledger is `public.kisantractor_schema_migrations` (also used by the test database factory,
 * which predates the checksum column; rows without a checksum are adopted on first run).
 */
export const MIGRATION_LEDGER_TABLE = "kisantractor_schema_migrations";

/** Arbitrary constant key for `pg_advisory_lock`; identifies the KisanTractor migrator. */
const MIGRATION_LOCK_KEY = 7_302_018_005;
const MIGRATION_ID = /^\d{4}_[a-z0-9_]+$/u;

export interface AppliedMigration {
  readonly id: string;
  readonly checksum: string | null;
  readonly appliedAt: Date;
}

export interface MigrationStatus {
  readonly applied: readonly AppliedMigration[];
  readonly pending: readonly string[];
  /** Ledger ids this code does not know: the database is newer than the running release. */
  readonly unknown: readonly string[];
}

export interface MigrationRunResult {
  readonly applied: readonly string[];
  readonly alreadyApplied: number;
  /** Ledger rows written before checksums were recorded, now stamped with the file checksum. */
  readonly adopted: readonly string[];
}

export class MigrationHistoryError extends Error {
  constructor(
    readonly code: "MIGRATION_CHECKSUM_MISMATCH" | "MIGRATION_HISTORY_DIVERGED" | "MIGRATION_FILE_INVALID",
    readonly migrationId: string,
    message: string,
  ) {
    super(message);
    this.name = "MigrationHistoryError";
  }
}

export class MigrationFailedError extends Error {
  readonly code = "MIGRATION_FAILED";

  constructor(readonly migrationId: string, readonly causeCode: string | undefined) {
    super(`Migration ${migrationId} failed${causeCode === undefined ? "" : ` (SQLSTATE ${causeCode})`}; it was rolled back`);
    this.name = "MigrationFailedError";
  }
}

/** sha256 of the file with line endings normalized, so Windows and Linux checkouts agree. */
export function migrationChecksum(sql: string): string {
  return createHash("sha256").update(sql.replace(/\r\n/gu, "\n"), "utf8").digest("hex");
}

/** The file body without its own outer BEGIN/COMMIT, so the runner can add the ledger row. */
export function migrationBody(migrationId: string, sql: string): string {
  const normalized = sql.replace(/\r\n/gu, "\n").trim();
  const begins = /^BEGIN;/u.test(normalized);
  const commits = /COMMIT;$/u.test(normalized);
  if (begins !== commits) {
    throw new MigrationHistoryError("MIGRATION_FILE_INVALID", migrationId,
      `Migration ${migrationId} must either wrap itself in BEGIN;/COMMIT; or contain neither`);
  }
  return begins ? normalized.replace(/^BEGIN;/u, "").replace(/COMMIT;$/u, "").trim() : normalized;
}

const ensureLedger = async (executor: SqlExecutor): Promise<void> => {
  await executor.query(`CREATE TABLE IF NOT EXISTS public.${MIGRATION_LEDGER_TABLE} (
    id text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  await executor.query(`ALTER TABLE public.${MIGRATION_LEDGER_TABLE} ADD COLUMN IF NOT EXISTS checksum text`);
};

const ledgerExists = async (executor: SqlExecutor): Promise<boolean> =>
  (await executor.query<{ exists: boolean }>(
    "SELECT to_regclass($1) IS NOT NULL AS exists", [`public.${MIGRATION_LEDGER_TABLE}`])).rows[0]?.exists === true;

async function readLedger(executor: SqlExecutor): Promise<AppliedMigration[]> {
  if (!(await ledgerExists(executor))) return [];
  const hasChecksum = (await executor.query<{ present: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'checksum') AS present`,
    [MIGRATION_LEDGER_TABLE])).rows[0]?.present === true;
  const rows = await executor.query<{ id: string; checksum: string | null; applied_at: Date }>(
    `SELECT id, ${hasChecksum ? "checksum" : "NULL::text AS checksum"}, applied_at
     FROM public.${MIGRATION_LEDGER_TABLE} ORDER BY id`);
  return rows.rows.map((row) => Object.freeze({ id: row.id, checksum: row.checksum, appliedAt: row.applied_at }));
}

/** Compares the ledger with the registered migrations without changing anything. */
export async function readMigrationStatus(
  executor: SqlExecutor,
  registered: readonly SqlMigration[],
): Promise<MigrationStatus> {
  const applied = await readLedger(executor);
  const known = new Set(registered.map(({ id }) => id));
  const appliedIds = new Set(applied.map(({ id }) => id));
  return Object.freeze({
    applied: Object.freeze(applied),
    pending: Object.freeze(registered.filter(({ id }) => !appliedIds.has(id)).map(({ id }) => id)),
    unknown: Object.freeze(applied.filter(({ id }) => !known.has(id)).map(({ id }) => id)),
  });
}

const databaseErrorCode = (error: unknown): string | undefined => {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" ? code : undefined;
};

async function applyOne(connection: SqlConnection, migration: SqlMigration, checksum: string, body: string): Promise<void> {
  // id and checksum are validated constants from the release, never user input.
  const script = `BEGIN;\n${body}\nINSERT INTO public.${MIGRATION_LEDGER_TABLE} (id, checksum) VALUES ('${migration.id}', '${checksum}');\nCOMMIT;`;
  try {
    await connection.query(script);
  } catch (error) {
    await connection.query("ROLLBACK").catch(() => undefined);
    throw new MigrationFailedError(migration.id, databaseErrorCode(error));
  }
}

/**
 * Applies every pending registered migration in order. Refuses to run when the ledger shows a
 * changed applied file, an applied migration this release does not know, or a gap (a later
 * migration applied before an earlier one). Each migration commits or rolls back as a unit.
 */
export async function applyPendingMigrations(
  pool: SqlPool,
  registered: readonly SqlMigration[],
): Promise<MigrationRunResult> {
  const files = await Promise.all(registered.map(async (migration) => {
    if (!MIGRATION_ID.test(migration.id)) {
      throw new MigrationHistoryError("MIGRATION_FILE_INVALID", migration.id, `Invalid migration id ${migration.id}`);
    }
    const sql = await readFile(migration.up, "utf8");
    return { migration, checksum: migrationChecksum(sql), body: migrationBody(migration.id, sql) };
  }));
  const connection = await pool.connect();
  try {
    await connection.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    try {
      await ensureLedger(connection);
      const status = await readMigrationStatus(connection, registered);
      if (status.unknown.length > 0) {
        throw new MigrationHistoryError("MIGRATION_HISTORY_DIVERGED", status.unknown[0]!,
          `The database records migration ${status.unknown[0]} that this release does not know; deploy the newer release instead`);
      }
      const appliedById = new Map(status.applied.map((entry) => [entry.id, entry]));
      const adopted: string[] = [];
      let seenPending = false;
      for (const { migration, checksum } of files) {
        const entry = appliedById.get(migration.id);
        if (entry === undefined) {
          seenPending = true;
          continue;
        }
        if (seenPending) {
          throw new MigrationHistoryError("MIGRATION_HISTORY_DIVERGED", migration.id,
            `Migration ${migration.id} is applied but an earlier migration is not; the history has a gap`);
        }
        if (entry.checksum === null) {
          await connection.query(`UPDATE public.${MIGRATION_LEDGER_TABLE} SET checksum = $2 WHERE id = $1 AND checksum IS NULL`,
            [migration.id, checksum]);
          adopted.push(migration.id);
        } else if (entry.checksum !== checksum) {
          throw new MigrationHistoryError("MIGRATION_CHECKSUM_MISMATCH", migration.id,
            `Applied migration ${migration.id} was changed after it ran; add a new migration instead`);
        }
      }
      const applied: string[] = [];
      for (const { migration, checksum, body } of files) {
        if (appliedById.has(migration.id)) continue;
        await applyOne(connection, migration, checksum, body);
        applied.push(migration.id);
      }
      return Object.freeze({
        applied: Object.freeze(applied),
        alreadyApplied: registered.length - applied.length,
        adopted: Object.freeze(adopted),
      });
    } finally {
      await connection.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]).catch(() => undefined);
    }
  } finally {
    connection.release();
  }
}
