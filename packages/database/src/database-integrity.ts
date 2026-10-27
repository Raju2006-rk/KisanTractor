import type { SqlExecutor } from "./client.js";
import type { SqlMigration } from "./migrations.js";
import { readMigrationStatus } from "./schema-migrations.js";

/**
 * Read-only integrity checks for a restored (or any) database, run by the backup-restore drill and
 * after a production restore (ops/runbooks/backup-restore.md, Requirements 12.7, 18.5). Each
 * finding is a stable `CODE:object` string naming a table, constraint, or row id, never row
 * contents, so reports are safe to attach to an incident log.
 */
export interface IntegrityReport {
  readonly ok: boolean;
  readonly findings: readonly string[];
  /** Row counts of the history tables an operator compares with the dashboard at the recovery time. */
  readonly rowCounts: Readonly<Record<string, number>>;
  readonly appliedMigrations: number;
}

/** Append-only history and the trigger guarding it (Requirement 12.4). */
export const APPEND_ONLY_TRIGGERS: ReadonlyArray<readonly [table: string, trigger: string]> = Object.freeze([
  ["tractor_availability_history", "tractor_availability_history_append_only"],
  ["booking_recipients", "booking_recipients_append_only"],
  ["booking_agreements", "booking_agreements_append_only"],
  ["booking_status_history", "booking_status_history_append_only"],
  ["work_events", "work_events_append_only"],
  ["work_measurements", "work_measurements_append_only"],
  ["invoices", "invoices_append_only"],
  ["payment_events", "payment_events_append_only"],
  ["provider_events", "provider_events_append_only"],
  ["notification_delivery_events", "notification_delivery_events_append_only"],
  ["audit_events", "audit_events_append_only"],
] as const);

const REQUIRED_EXTENSIONS = ["pgcrypto", "postgis", "btree_gist"] as const;

const COUNTED_TABLES = [
  "users", "bookings", "booking_agreements", "booking_status_history", "invoices", "payments",
  "payment_events", "audit_events", "outbox_events",
] as const;

/** Domain invariants that constraints alone do not express; each query returns offending ids. */
const INVARIANTS: ReadonlyArray<readonly [code: string, sql: string]> = [
  ["OVERLAPPING_BLOCKING_BOOKINGS", `
    SELECT a.id::text AS id FROM public.bookings a JOIN public.bookings b
      ON a.tractor_id = b.tractor_id AND a.id < b.id
     AND tstzrange(a.requested_start_at, a.requested_end_at, '[)') && tstzrange(b.requested_start_at, b.requested_end_at, '[)')
    WHERE a.status IN ('ACCEPTED', 'SCHEDULED', 'IN_PROGRESS') AND b.status IN ('ACCEPTED', 'SCHEDULED', 'IN_PROGRESS')
    LIMIT 20`],
  ["INVOICE_OVERPAID", `
    SELECT i.id::text AS id FROM public.invoices i JOIN public.payments p ON p.invoice_id = i.id
    WHERE p.status IN ('PAID_CASH', 'PAID_ONLINE')
    GROUP BY i.id, i.total_paise HAVING sum(p.amount_paise) > i.total_paise
    LIMIT 20`],
  ["CASH_PAYMENT_MARKED_ONLINE", `
    SELECT id::text AS id FROM public.payments WHERE method = 'CASH' AND status = 'PAID_ONLINE' LIMIT 20`],
  ["AGREEMENT_FROM_OTHER_BOOKING", `
    SELECT b.id::text AS id FROM public.bookings b JOIN public.booking_agreements a ON a.id = b.current_agreement_id
    WHERE a.booking_id <> b.id LIMIT 20`],
  ["BOOKING_WITHOUT_STATUS_HISTORY", `
    SELECT b.id::text AS id FROM public.bookings b
    WHERE NOT EXISTS (SELECT 1 FROM public.booking_status_history h WHERE h.booking_id = b.id) LIMIT 20`],
];

export async function verifyDatabaseIntegrity(
  executor: SqlExecutor,
  registered: readonly SqlMigration[],
): Promise<IntegrityReport> {
  const findings: string[] = [];

  const status = await readMigrationStatus(executor, registered);
  for (const id of status.pending) findings.push(`MIGRATION_PENDING:${id}`);
  for (const id of status.unknown) findings.push(`MIGRATION_UNKNOWN:${id}`);

  const extensions = new Set((await executor.query<{ name: string }>("SELECT extname AS name FROM pg_extension")).rows.map(({ name }) => name));
  for (const extension of REQUIRED_EXTENSIONS) if (!extensions.has(extension)) findings.push(`EXTENSION_MISSING:${extension}`);

  const triggers = await executor.query<{ table_name: string; name: string; enabled: string }>(
    `SELECT c.relname AS table_name, t.tgname AS name, t.tgenabled::text AS enabled
     FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND NOT t.tgisinternal`);
  for (const [table, trigger] of APPEND_ONLY_TRIGGERS) {
    const found = triggers.rows.find((row) => row.table_name === table && row.name === trigger);
    if (found === undefined) findings.push(`APPEND_ONLY_TRIGGER_MISSING:${table}`);
    else if (found.enabled === "D") findings.push(`APPEND_ONLY_TRIGGER_DISABLED:${table}`);
  }

  const constraints = await executor.query<{ table_name: string; name: string; type: string; validated: boolean }>(
    `SELECT c.relname AS table_name, k.conname AS name, k.contype::text AS type, k.convalidated AS validated
     FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'`);
  if (!constraints.rows.some((row) => row.table_name === "bookings" && row.name === "bookings_no_overlapping_blocking_intervals" && row.type === "x")) {
    findings.push("EXCLUSION_CONSTRAINT_MISSING:bookings.bookings_no_overlapping_blocking_intervals");
  }
  for (const row of constraints.rows.filter(({ validated }) => !validated)) {
    findings.push(`CONSTRAINT_NOT_VALIDATED:${row.table_name}.${row.name}`);
  }

  const tables = new Set((await executor.query<{ name: string }>(
    `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')`)).rows.map(({ name }) => name));
  const rowCounts: Record<string, number> = {};
  for (const table of COUNTED_TABLES) {
    if (!tables.has(table)) {
      findings.push(`TABLE_MISSING:${table}`);
      continue;
    }
    rowCounts[table] = Number((await executor.query<{ count: string }>(`SELECT count(*)::text AS count FROM public.${table}`)).rows[0]?.count ?? 0);
  }
  if (tables.has("bookings") && tables.has("invoices") && tables.has("payments") && tables.has("booking_agreements")) {
    for (const [code, sql] of INVARIANTS) {
      for (const { id } of (await executor.query<{ id: string }>(sql)).rows) findings.push(`${code}:${id}`);
    }
  }

  return Object.freeze({
    ok: findings.length === 0,
    findings: Object.freeze(findings),
    rowCounts: Object.freeze(rowCounts),
    appliedMigrations: status.applied.length,
  });
}
