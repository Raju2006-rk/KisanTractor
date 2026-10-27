import { validateEnvironment } from "@kisantractor/config";
import {
  applyPendingMigrations,
  migrations,
  readMigrationStatus,
  seedReferenceData,
  verifyDatabaseIntegrity,
  withTransaction,
} from "@kisantractor/database";
import { Pool } from "pg";

import { runBackupRestoreDrill } from "./operations/backup-restore-drill.js";
import { PgPoolAdapter } from "./sql-pool.js";

/**
 * Database operations for deploys, restores, and drills (ops/runbooks/backup-restore.md).
 *
 *   migrate               apply pending migrations (roll forward) to DATABASE_URL
 *   status                list applied, pending, and unknown migrations
 *   seed-reference-data   write canonical Services and Equipment Types with stable identifiers
 *   verify                run the read-only integrity checks
 *   drill                 backup DRILL_SOURCE_DATABASE_URL, restore into DRILL_TARGET_DATABASE_URL,
 *                         roll forward, and verify (DRILL_PG_CONTAINER, DRILL_PG_BIN_DIR,
 *                         DRILL_RESET_TARGET=true are optional)
 *
 * Output is JSON with ids, counts, and codes only. Connection URLs are never printed.
 */
const commands = ["migrate", "status", "seed-reference-data", "verify", "drill"] as const;
type Command = (typeof commands)[number];

const openPool = (databaseUrl: string) => new PgPoolAdapter(new Pool({ connectionString: databaseUrl, max: 2 }));

const requiredEnv = (name: string): string => {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
};

async function main(command: Command): Promise<boolean> {
  if (command === "drill") {
    const report = await runBackupRestoreDrill({
      sourceUrl: requiredEnv("DRILL_SOURCE_DATABASE_URL"),
      targetUrl: requiredEnv("DRILL_TARGET_DATABASE_URL"),
      openPool,
      migrations,
      tools: {
        ...(process.env.DRILL_PG_CONTAINER ? { container: process.env.DRILL_PG_CONTAINER } : {}),
        ...(process.env.DRILL_PG_BIN_DIR ? { binDirectory: process.env.DRILL_PG_BIN_DIR } : {}),
      },
      resetTarget: process.env.DRILL_RESET_TARGET === "true",
    });
    console.log(JSON.stringify(report, null, 2));
    return report.ok;
  }

  const pool = openPool(validateEnvironment(process.env).DATABASE_URL);
  try {
    switch (command) {
      case "migrate": {
        console.log(JSON.stringify(await applyPendingMigrations(pool, migrations)));
        return true;
      }
      case "status": {
        const status = await readMigrationStatus(pool, migrations);
        console.log(JSON.stringify({
          applied: status.applied.map(({ id, checksum }) => ({ id, checksumRecorded: checksum !== null })),
          pending: status.pending,
          unknown: status.unknown,
        }));
        return status.unknown.length === 0;
      }
      case "seed-reference-data": {
        console.log(JSON.stringify(await withTransaction(pool, (sql) => seedReferenceData(sql))));
        return true;
      }
      case "verify": {
        const report = await verifyDatabaseIntegrity(pool, migrations);
        console.log(JSON.stringify(report));
        return report.ok;
      }
    }
  } finally {
    await pool.end();
  }
}

const command = process.argv[2];
if (!commands.some((known) => known === command)) {
  console.error(`Usage: database-cli <${commands.join("|")}>`);
  process.exitCode = 2;
} else {
  main(command as Command).then((ok) => {
    if (!ok) process.exitCode = 1;
  }, (error: unknown) => {
    // Errors are reported by class and code; messages from this codebase carry no secrets.
    const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "UNCLASSIFIED";
    console.error(JSON.stringify({ error: error instanceof Error ? error.name : "Error", code, message: error instanceof Error ? error.message : "" }));
    process.exitCode = 1;
  });
}
