# Phase 1 vertical-slice end-to-end suite

`phase1-vertical-slice.e2e.test.ts` drives the composed Nest API over real HTTP against a real
PostgreSQL/PostGIS database, as two OTP-authenticated principals (Farmer and Owner) plus an
unrelated Farmer:

OTP sandbox sign-in → Owner profile → two Tractors, Equipment, Service Offerings, Pricing Rules,
documents and eligibility → online → discovery from the selected Service Location → self and
someone-else (cross-city Recipient) bookings with idempotency → accept, overlap conflict, reject,
adjacent booking → start/pause/resume/complete → PRD final bills (₹1,200 / ₹3,600 / ₹3,000) →
dispute → cash records → completion, status history, receipts, outbox events → session revocation.

At each key step it reads the booking through `/farmer/...` and `/owner/...` and asserts identical
status, Quote Snapshot, invoice, payment state, and status history, with party-specific redaction.

## Running it

The suite is skipped unless `VERTICAL_SLICE_E2E_DATABASE_URL` is set. The URL must point at a
local database whose name contains `test`; the suite applies migrations and truncates all data
tables. Use a database of its own so it does not race other integration suites.

```powershell
docker run -d --rm --name kisan-e2e-pg -e POSTGRES_USER=kisantractor -e POSTGRES_PASSWORD=kisantractor `
  -e POSTGRES_DB=kisantractor_e2e_test -p 127.0.0.1:55432:5432 postgis/postgis:17-3.5-alpine
$env:VERTICAL_SLICE_E2E_DATABASE_URL = "postgresql://kisantractor:kisantractor@127.0.0.1:55432/kisantractor_e2e_test"
corepack pnpm test:e2e
```

Set `VERTICAL_SLICE_E2E_BROWSER=1` to add a thin UI smoke. It serves the existing
`apps/web/.next` production build with `next start` (pointing `PUBLIC_API_ORIGIN` at the test API),
opens the Farmer and Owner booking screens in headless Chrome/Edge through the
`apps/web/quality` DevTools driver, and checks that both render the same booking reference,
estimate, and final bill. Build the web app first (`corepack pnpm --filter @kisantractor/web build`).
The smoke signs in by setting the session cookie from the API sign-in: the web login screen does
not display the sandbox development code, so the UI login itself is not driven.

## Security suite

`security.e2e.test.ts` drives the same composed API over HTTP against PostgreSQL as two Owners and
two Farmers: OTP throttles, enumeration resistance, phone/purpose binding, attempt caps, expiry,
replay and concurrent verification; refresh rotation, reuse, expiry and revocation; cross-role and
cross-object denial with an unchanged-state check; upload type/signature/size/file-name/scan
validation; short-lived, Owner-only download grants and signed discovery cursors; client-supplied
price/total/party tampering; concurrent acceptance races; counterparty redaction; encryption at
rest; and PII-free logs (it captures both the telemetry sink and Nest's own logger).

It is skipped unless `SECURITY_E2E_DATABASE_URL` is set. Give it its own database so it does not
race the vertical slice (both truncate all data tables):

```powershell
docker exec kisan-e2e-pg psql -U kisantractor -d kisantractor_e2e_test -c "CREATE DATABASE kisantractor_security_test"
$env:SECURITY_E2E_DATABASE_URL = "postgresql://kisantractor:kisantractor@127.0.0.1:55432/kisantractor_security_test"
corepack pnpm test:e2e
```

`PAYMENT_RECOVERY_INTEGRATION_DATABASE_URL` gates the task 16.2 suite
(`src/payment/payment-recovery.integration.test.ts`): checkout values, Farmer cancel and stale-intent
release, late captures, captures recovered from the provider API, support refunds with idempotent
submission, refund outcomes from signed events and reconciliation, and party-scoped payment history.
Its Razorpay is an in-process fake of the Orders, Payments, and Refunds APIs.
`DISCOVERY_INTEGRATION_DATABASE_URL` and `OUTBOX_INTEGRATION_DATABASE_URL` gate the other database
suites the same way; use a separate database for each.

## Online payment suite (task 16.1)

`src/payment/online-payment.integration.test.ts` runs the API over HTTP against PostgreSQL with a
SANDBOX Razorpay adapter whose HTTP client is an in-process fake, so no request leaves the
machine. It covers server-created intents and idempotent retries, the non-authoritative checkout
return, unsigned and mis-signed webhooks, exactly-once settlement under six concurrent duplicate
deliveries, replays under new event ids, amount/currency/reference mismatches, immutable provider
events, and provider contact details kept out of storage and logs. Webhooks are signed locally
with synthetic secrets (`ops/runbooks/online-payments.md`).

```powershell
docker exec kisan-e2e-pg psql -U kisantractor -d kisantractor_e2e_test -c "CREATE DATABASE kisantractor_online_payment_test"
$env:ONLINE_PAYMENT_INTEGRATION_DATABASE_URL = "postgresql://kisantractor:kisantractor@127.0.0.1:55432/kisantractor_online_payment_test"
corepack pnpm vitest run apps/api/src/payment/online-payment.integration.test.ts
```

## Payment trust property (task 16.3)

`src/payment/payment-trust.property.test.ts` checks Property 12 (payment trust and provider-event
deduplication) through `PaymentService`, the Razorpay adapter, and `PostgresPaymentStore`. Its
in-memory variant always runs. `PAYMENT_TRUST_PROPERTY_DATABASE_URL` enables the PostgreSQL
variant, which adds concurrent duplicate deliveries (same event id, same body under new ids, and
webhook plus API-read evidence together). The suite migrates and truncates the database once at
start; each property run then seeds its own booking and intents.

```powershell
docker exec kisan-e2e-pg psql -U kisantractor -d kisantractor_e2e_test -c "CREATE DATABASE kisantractor_payment_trust_test"
$env:PAYMENT_TRUST_PROPERTY_DATABASE_URL = "postgresql://kisantractor:kisantractor@127.0.0.1:55432/kisantractor_payment_trust_test"
corepack pnpm vitest run apps/api/src/payment/payment-trust.property.test.ts
```

## Release suites (`src/release`, task 15.4)

| Variable | Suite |
|---|---|
| `MIGRATION_INTEGRATION_DATABASE_URL` | Additive migrations, down/up round-trips, roll-forward over existing data (drops and recreates `public`) |
| `REFERENCE_DATA_INTEGRATION_DATABASE_URL` | Stable reference identifiers and idempotent seeding |
| `ACCOUNT_DELETION_INTEGRATION_DATABASE_URL` | Account erasure keeps financial and audit rows and leaves no personal data |
| `BACKUP_RESTORE_SOURCE_DATABASE_URL`, `BACKUP_RESTORE_TARGET_DATABASE_URL`, optional `BACKUP_RESTORE_PG_CONTAINER` | pg_dump/pg_restore drill, roll-forward of an older backup, damage detection |

`capability-rollback.test.ts` needs no database and runs in the default suite. The vertical
slice also exercises `POST /account/deletion` over HTTP.

```powershell
docker exec kisan-e2e-pg psql -U kisantractor -d kisantractor_e2e_test -c "CREATE DATABASE kisantractor_migration_test" -c "CREATE DATABASE kisantractor_reference_data_test" -c "CREATE DATABASE kisantractor_account_deletion_test" -c "CREATE DATABASE kisantractor_backup_source_test" -c "CREATE DATABASE kisantractor_backup_target_test"
```

`LOAD_TEST_DATABASE_URL` gates the initial-load suite (`src/performance`, `corepack pnpm test:load`). It
seeds the launch data volume and drives an API child process with an open-loop request mix. The profile,
how to run it, and the measured results are in `ops/performance/initial-load-profile.md`.

The default `vitest run` also covers the database-free security checks in `src/security/`:
credential handling on every protected route, identifier validation before SQL, parameterized
statements, correlation-header hygiene, production refusal of development OTP codes, and a
repository scan for committed secrets.

## Test seams (local/test only)

- OTP uses the labelled `LocalDevelopmentOtpAdapter`, registered by `buildCapabilityRegistry` only
  when `APP_ENV` is `local`/`test`, `OTP_CAPABILITY_STATE=SANDBOX`, and `ALLOW_LOCAL_OTP_CODES=true`.
- Object storage is an in-process SANDBOX store (`SandboxObjectStorage`) supplied through
  `AppModule.register({ sandboxProviders })`; the malware scanner is a labelled sandbox scanner.
- `domainClock` drives catalog, discovery, booking, job, payment, and document services so work
  durations are exact. Sessions use the real clock. The clock starts ten minutes ahead of the
  database clock because pricing validity is stamped with `CURRENT_TIMESTAMP`.
- Reference data (`services`, `equipment_types`) is seeded directly; no API manages it.

The default `vitest run` covers the non-database parts: composition and routes
(`app.module.test.ts`), sandbox capability wiring (`runtime-config.test.ts`), and party-view
redaction, settlement summary, history ordering, and pagination (`booking-query.service.test.ts`).
