import { readFile } from "node:fs/promises";

import type { SqlExecutor, SqlMigration } from "@kisantractor/database";

import { assertSafeTestDatabaseUrl } from "./database.js";

/** Runs one migration file as a single simple-protocol script (each file wraps itself in BEGIN/COMMIT). */
export async function runMigrationFile(
  executor: SqlExecutor,
  migration: SqlMigration,
  direction: "up" | "down",
): Promise<void> {
  await executor.query(await readFile(direction === "up" ? migration.up : migration.down, "utf8"));
}

/**
 * Empties a disposable local test database: drops the `public` schema with every application
 * object and extension in it, then recreates it. Refuses non-local databases and database names
 * without `test`.
 */
export async function dropApplicationSchema(executor: SqlExecutor, databaseUrl: string): Promise<void> {
  assertSafeTestDatabaseUrl(databaseUrl);
  await executor.query("DROP SCHEMA IF EXISTS public CASCADE");
  await executor.query("CREATE SCHEMA public");
  await executor.query("GRANT ALL ON SCHEMA public TO public");
  // Extensions installed into public are dropped with it; any left elsewhere are dropped too so the
  // database starts from the same state as a freshly created one.
  for (const extension of ["postgis", "btree_gist", "pgcrypto"]) {
    await executor.query(`DROP EXTENSION IF EXISTS ${extension} CASCADE`);
  }
}
