import {
  applyPendingMigrations,
  captureSchemaSnapshot,
  columnsByTable,
  comparableSchema,
  migrations,
  readMigrationStatus,
  tableChecksums,
  verifyDatabaseIntegrity,
} from "@kisantractor/database";
import { REPRESENTATIVE_TABLES, dropApplicationSchema, seedRepresentativeDataset } from "@kisantractor/test-utils";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CLOSED_BOOKING_STATUSES } from "../account/account-deletion.service.js";
import { PostgresAccountDeletionStore } from "../account/postgres-account-deletion-store.js";
import { DrillTargetRefusedError, runBackupRestoreDrill, type BackupRestoreDrillReport } from "../operations/backup-restore-drill.js";
import type { PgToolsOptions } from "../operations/pg-tools.js";
import { PgPoolAdapter } from "../sql-pool.js";

/**
 * Backup, restore, and roll-forward drill against PostgreSQL/PostGIS with the real pg_dump and
 * pg_restore (Requirements 12.7, 18.5). Skipped unless BACKUP_RESTORE_SOURCE_DATABASE_URL and
 * BACKUP_RESTORE_TARGET_DATABASE_URL name two local databases whose names contain `test`; both are
 * emptied. Set BACKUP_RESTORE_PG_CONTAINER to run the client tools inside a Docker container
 * (for example `kisan-e2e-pg`) when they are not installed on the host.
 *
 * Validates: Requirements 12.7, 18.5
 */
const sourceUrl = process.env.BACKUP_RESTORE_SOURCE_DATABASE_URL;
const targetUrl = process.env.BACKUP_RESTORE_TARGET_DATABASE_URL;
const container = process.env.BACKUP_RESTORE_PG_CONTAINER;
const describeDatabase = sourceUrl === undefined || targetUrl === undefined ? describe.skip : describe;
const tools: PgToolsOptions = container === undefined ? {} : { container };

/** The release that the roll-forward drill restores from. */
const OLDER_RELEASE = "0008_versioned_pricing_rules";

describeDatabase("backup, restore, and roll-forward drill", () => {
  let source: PgPoolAdapter;
  let target: PgPoolAdapter;
  const openPool = (url: string) => new PgPoolAdapter(new Pool({ connectionString: url, max: 2 }));
  const drill = () => runBackupRestoreDrill({ sourceUrl: sourceUrl!, targetUrl: targetUrl!, openPool, migrations, tools, resetTarget: true });
  const summary = (label: string, report: BackupRestoreDrillReport) =>
    console.info(`[drill] ${label}: ok=${report.ok} tables=${report.tablesCompared} rows=${report.rowsCompared} dump=${report.dumpBytes}B `
      + `dumpMs=${report.dumpDurationMs} restoreMs=${report.restoreDurationMs} rollForward=${report.rolledForward.length} totalMs=${report.totalDurationMs}`);

  beforeAll(async () => {
    source = openPool(sourceUrl!);
    target = openPool(targetUrl!);
  });

  afterAll(async () => {
    await source?.end();
    await target?.end();
  });

  it("restores a backup of the current release with every row, trigger, and invariant intact", async () => {
    await dropApplicationSchema(source, sourceUrl!);
    // The production roll-forward runner builds the source schema from empty.
    expect((await applyPendingMigrations(source, migrations)).applied).toEqual(migrations.map(({ id }) => id));
    await seedRepresentativeDataset(source, { ordinal: 1 });
    const erased = await seedRepresentativeDataset(source, { ordinal: 2 });
    await seedRepresentativeDataset(source, { ordinal: 3, bookingStatus: "DISPUTED" });
    // An erased account must stay erased after a restore of a later backup.
    expect((await new PostgresAccountDeletionStore(source).eraseAccount({
      userId: erased.customerId, actorChannel: "WEB", correlationId: "drill-erasure", closedBookingStatuses: CLOSED_BOOKING_STATUSES,
    })).status).toBe("ERASED");
    expect(await verifyDatabaseIntegrity(source, migrations)).toMatchObject({ ok: true, findings: [] });

    const report = await drill();
    summary("current release", report);

    expect(report).toMatchObject({ ok: true, schemaMatchesSource: true, schemaDifferences: [], rolledForward: [], checksumMismatches: [] });
    expect(report.integrity.findings).toEqual([]);
    expect(report.integrity.appliedMigrations).toBe(migrations.length);
    expect(report.tablesCompared).toBeGreaterThanOrEqual(REPRESENTATIVE_TABLES.length);
    expect(report.integrity.rowCounts).toMatchObject({ bookings: 3, invoices: 3, payments: 3 });
    expect(report.dumpBytes).toBeGreaterThan(0);

    // The restored database enforces the same rules, not just the same rows.
    const invoice = (await target.query<{ id: string }>("SELECT id::text AS id FROM public.invoices LIMIT 1")).rows[0]!;
    await expect(target.query("UPDATE public.invoices SET total_paise = 1 WHERE id = $1", [invoice.id])).rejects.toMatchObject({ code: "55000" });
    await expect(target.query("DELETE FROM public.audit_events")).rejects.toMatchObject({ code: "55000" });
    await expect(target.query(
      `INSERT INTO public.bookings (public_reference, customer_id, owner_id, tractor_id, service_offering_id, requested_start_at, requested_end_at, status)
       SELECT 'KT-DRILL-OVERLAP-' || n, customer_id, owner_id, tractor_id, service_offering_id, requested_start_at, requested_end_at, 'ACCEPTED'
       FROM public.bookings, generate_series(1, 2) AS n WHERE public_reference = 'KT-FX000001'`))
      .rejects.toMatchObject({ code: "23P01" });
    // CHECK constraints the dump re-parsed (see restoreComparable) still reject what they rejected.
    await expect(target.query(
      `INSERT INTO public.locations (state, district, mandal_or_taluk, village, source, captured_at)
       VALUES ('  Telangana', 'Warangal', 'Hanamkonda', 'Kazipet', 'MANUAL_ADDRESS', CURRENT_TIMESTAMP)`))
      .rejects.toMatchObject({ code: "23514", constraint: "locations_administrative_parts_check" });
    await expect(target.query(
      `INSERT INTO public.locations (state, district, mandal_or_taluk, village, source, captured_at)
       VALUES ('Telangana', 'Warangal', 'Hanamkonda', 'Kazipet', 'DEVICE_GPS', CURRENT_TIMESTAMP)`))
      .rejects.toMatchObject({ code: "23514", constraint: "locations_coordinate_metadata_check" });
    expect((await target.query("SELECT status FROM public.users WHERE id = $1", [erased.customerId])).rows).toEqual([{ status: "DELETED" }]);
    expect((await readMigrationStatus(target, migrations)).pending).toEqual([]);
  }, 180_000);

  it("restores a backup taken by an older release and rolls it forward without changing old data", async () => {
    const checkpoint = migrations.findIndex(({ id }) => id === OLDER_RELEASE);
    await dropApplicationSchema(source, sourceUrl!);
    await applyPendingMigrations(source, migrations.slice(0, checkpoint + 1));
    await seedRepresentativeDataset(source, { ordinal: 1 });
    await seedRepresentativeDataset(source, { ordinal: 2, bookingStatus: "DISPUTED" });

    const report = await drill();
    summary(`backup from ${OLDER_RELEASE}`, report);

    expect(report).toMatchObject({ ok: true, schemaMatchesSource: true, checksumMismatches: [] });
    expect(report.rolledForward).toEqual(migrations.slice(checkpoint + 1).map(({ id }) => id));
    expect(report.integrity.findings).toEqual([]);

    // The rolled-forward restore has exactly the schema of the current release.
    await applyPendingMigrations(source, migrations);
    expect(comparableSchema(await captureSchemaSnapshot(target))).toEqual(comparableSchema(await captureSchemaSnapshot(source)));
    // Columns added after the backup read their defaults on restored rows.
    expect((await target.query("SELECT DISTINCT collection_purpose FROM public.locations ORDER BY 1")).rows)
      .toEqual([{ collection_purpose: "SERVICE_LOCATION" }, { collection_purpose: "TRACTOR_OPERATING_LOCATION" }]);
  }, 180_000);

  it("reports a damaged restore instead of passing it", async () => {
    // The target holds the previous drill's restore.
    const columns = columnsByTable(await captureSchemaSnapshot(source));
    const before = await tableChecksums(target, columns);
    await target.query("DROP TRIGGER audit_events_append_only ON public.audit_events");
    await target.query("DELETE FROM public.outbox_events");
    await target.query(
      `INSERT INTO public.payments (invoice_id, method, status, amount_paise, recorded_by_user_id, received_at)
       SELECT invoice_id, method, status, amount_paise, recorded_by_user_id, received_at FROM public.payments LIMIT 1`);

    const report = await verifyDatabaseIntegrity(target, migrations);
    expect(report.ok).toBe(false);
    expect(report.findings).toContain("APPEND_ONLY_TRIGGER_MISSING:audit_events");
    expect(report.findings.some((finding) => finding.startsWith("INVOICE_OVERPAID:"))).toBe(true);
    const after = await tableChecksums(target, columns);
    expect(Object.keys(before).filter((table) => JSON.stringify(before[table]) !== JSON.stringify(after[table])).sort())
      .toEqual(["outbox_events", "payments"]);
  }, 60_000);

  it("refuses a target that is the source or not disposable, before touching either database", async () => {
    await expect(runBackupRestoreDrill({ sourceUrl: sourceUrl!, targetUrl: sourceUrl!, openPool, migrations, tools }))
      .rejects.toBeInstanceOf(DrillTargetRefusedError);
    const production = new URL(targetUrl!);
    production.pathname = "/kisantractor";
    await expect(runBackupRestoreDrill({ sourceUrl: sourceUrl!, targetUrl: production.toString(), openPool, migrations, tools }))
      .rejects.toMatchObject({ code: "DRILL_TARGET_REFUSED" });
  });

  it("refuses to roll forward over a changed applied migration", async () => {
    await target.query(`UPDATE public.kisantractor_schema_migrations SET checksum = repeat('0', 64) WHERE id = $1`, [migrations[0]!.id]);
    await expect(applyPendingMigrations(target, migrations)).rejects.toMatchObject({ code: "MIGRATION_CHECKSUM_MISMATCH" });
  });
});
