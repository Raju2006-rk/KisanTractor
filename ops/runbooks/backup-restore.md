# Backup and restore

Status: procedure and tooling defined, and the restore and roll-forward drill passes against a
local PostGIS container (record below). Production backups are **not configured**: no
infrastructure in this repository provisions them, and no restore of a real backup has been run.
Both are blocking gates in `ops/release/readiness.json` (`PRODUCTION_BACKUPS_CONFIGURED`,
`STAGING_RESTORE_DRILL`). Requirements 12.7, 18.5.

## Scope

| Data | Store | Backup method |
|---|---|---|
| Relational state (users, bookings, agreements, work events, invoices, payments, audit, outbox) | PostgreSQL with PostGIS | Continuous WAL archiving plus a daily base backup, giving point-in-time recovery |
| Private documents and photos | S3-compatible private object storage | Bucket versioning plus cross-region replication or scheduled copy |
| Secrets and keys (`FIELD_ENCRYPTION_KEY`, `LOOKUP_HASH_KEY`, `OTP_HASH_KEY`, `SESSION_HASH_KEY`, `PHONE_ENCRYPTION_KEY`, `DISCOVERY_CURSOR_SIGNING_KEY`) | Managed secret store | Secret-store versioning; keys are never in database backups |

Encrypted fields in the database (phones, registrations, object keys) are unreadable without
the matching key versions. A restore needs both the database backup and the keys that were
current when it was taken.

## Proposed targets (to be ratified before launch)

- Recovery point objective: 15 minutes (WAL archive interval).
- Recovery time objective: 4 hours for a full restore to a new instance.
- Retention: 35 days of base backups and WAL; financial and audit records follow the legal
  retention policy (Requirement 12.4). Deleted accounts remain in backups until they age out
  (see `account-deletion.md`).

## Backup requirements

1. Backups are encrypted at rest with keys separate from the database host (Requirement 12.1).
2. Backups are stored in a different account or region from the primary.
3. Backup jobs alert on failure; a missing daily base backup is a warning, a WAL archive gap is critical.
4. Access to backups is restricted to the operations role and audited.
5. Logical dumps made for drills hold personal data. The drill tool deletes its dump when it ends;
   never copy one to a laptop or ticket.

## Tooling

`apps/api/src/database-cli.ts` (built as `node apps/api/dist/database-cli.js`, or
`corepack pnpm --filter @kisantractor/api db:dev <command>` from source). Output is JSON with
ids, counts, and codes only; connection URLs are never printed.

| Command | Uses | Effect |
|---|---|---|
| `status` | `DATABASE_URL` (validated config) | Applied, pending, and unknown migrations. Exit 1 if the database knows a migration this release does not. |
| `migrate` | `DATABASE_URL` | Roll forward: applies pending migrations in order, each in one transaction with its ledger row, under an advisory lock. Refuses a changed applied migration or a history gap. |
| `seed-reference-data` | `DATABASE_URL` | Writes canonical Services and Equipment Types with their permanent UUIDs; refuses identity drift. |
| `verify` | `DATABASE_URL` | Read-only integrity report: pending migrations, extensions, append-only triggers, the no-overlap exclusion constraint, unvalidated constraints, overlapping blocking bookings, overpaid invoices, cash marked online, agreements from another booking, bookings without status history, and row counts. Exit 1 on any finding. |
| `drill` | `DRILL_SOURCE_DATABASE_URL`, `DRILL_TARGET_DATABASE_URL`, optional `DRILL_PG_CONTAINER`, `DRILL_PG_BIN_DIR`, `DRILL_RESET_TARGET=true` | `pg_dump` the source, `pg_restore` into the empty target in one transaction, roll the target forward, compare every row checksum of every source table, and run `verify`. The target's database name must contain `drill` or `test` and differ from the source. |

Credentials reach `pg_dump`/`pg_restore` only through `PG*` environment variables, never the
command line. `DRILL_PG_CONTAINER` runs the client tools inside a Docker container (for example
the local PostGIS container) when they are not installed on the host.

## Restore procedure

1. Declare an incident (`incident-response.md`) if the restore is due to data loss or corruption.
2. Stop writers: scale the API and outbox workers to zero so no new transactions or deliveries occur.
3. Restore the base backup to a new instance and replay WAL to the chosen recovery target time.
   Do not overwrite the damaged primary; keep it for investigation.
4. Point `DATABASE_URL` at the restored instance and run `status`. If the backup predates the
   release being deployed, run `migrate`; migrations are additive and roll forward over existing
   data (proven by the drill below). Never run an older release's `migrate` against a newer
   database; `status` reports such a database as `unknown` and `migrate` refuses it.
5. Run `verify`. Any finding stops the restore. Also check:
   - Row counts in the report are plausible against the dashboard for the recovery time.
   - A sample of encrypted fields decrypts with the current key versions.
6. Outbox: events with `status = 'PROCESSING'` are reclaimed after their lease expires. Events
   published after the recovery point will be published again; handlers are idempotent per
   notification dedupe key, but recipients may receive a duplicate message for events whose
   notification rows were lost. Note this in the incident log.
7. Re-apply account deletions made after the recovery point (`account-deletion.md`).
8. Point the API and workers at the restored instance, start them, and watch `ApiErrorRateHigh`,
   `OutboxLagHigh`, and transaction rollbacks for one hour.
9. Record the recovery point, duration, and any lost window in the incident log.

## Restore drill (quarterly, and before production release)

1. Restore the latest backup into an isolated environment with its own credentials, or for a
   logical drill run `drill` from a quiesced copy into an empty `*_drill` database.
2. Run `verify` (the `drill` command does this and also compares every row with the source).
3. Run the API against the restored copy with all provider capabilities `UNCONFIGURED`, so no
   messages or payments reach real people.
4. Record the measured restore time against the RTO, and the result, in the table below.
5. Destroy the drill environment.

`apps/api/src/release/backup-restore.integration.test.ts` runs the same drill in CI-style form:
current-release backup, a backup from release `0008` rolled forward to the current schema, a
deliberately damaged restore that `verify` must catch, and the target safety checks.

```powershell
docker exec kisan-e2e-pg psql -U kisantractor -d kisantractor_test -c "CREATE DATABASE kisantractor_backup_source_test" -c "CREATE DATABASE kisantractor_backup_target_test"
$env:BACKUP_RESTORE_SOURCE_DATABASE_URL = "postgresql://kisantractor:kisantractor@127.0.0.1:55432/kisantractor_backup_source_test"
$env:BACKUP_RESTORE_TARGET_DATABASE_URL = "postgresql://kisantractor:kisantractor@127.0.0.1:55432/kisantractor_backup_target_test"
$env:BACKUP_RESTORE_PG_CONTAINER = "kisan-e2e-pg"
corepack pnpm exec vitest run apps/api/src/release/backup-restore.integration.test.ts
```

One catalog difference is expected and tolerated: `pg_dump` writes CHECK expressions as
PostgreSQL deparsed them, and the restore can regroup the parentheses of `AND` chains. The drill
compares constraint definitions without grouping parentheses and the test proves the restored
constraints still reject invalid rows.

## Drill record

| Date | Environment | Backup | Result | Rows compared | Restore time | Notes |
|---|---|---|---|---|---|---|
| 2026-10-26 | Local Docker `postgis/postgis:17-3.5-alpine`, pg_dump 17.11 | Logical dump of the current release (17 migrations), three representative histories incl. one erased account | Passed: schema, all 34 table checksums, triggers, constraints, invariants | 143 | about 1.0 s restore, 2.3 s end to end | Procedure drill only; not a production backup |
| 2026-10-26 | Same | Logical dump taken at release `0008`, rolled forward with `migrate` (9 migrations) | Passed: old rows unchanged, final schema equals a fresh current schema | 101 | about 0.9 s restore, 2.4 s end to end | Proves roll-forward over restored data |
| — | Staging | Point-in-time restore of a real backup | **Not run** | — | — | Required before production (`STAGING_RESTORE_DRILL`) |
