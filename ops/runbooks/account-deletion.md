# Account deletion

Status: implemented and tested against PostgreSQL (`apps/api/src/release/account-deletion.integration.test.ts`).
The retention choices below need legal review before production (gate
`RETENTION_AND_DELETION_POLICY_REVIEW` in `ops/release/readiness.json`). Requirement 12.5.

## How a user deletes an account

`POST /account/deletion` with the account's access credential and body
`{ "confirmation": "DELETE_MY_ACCOUNT" }`. The response contains counts only.

| Response | Meaning |
|---|---|
| 200 `ERASED` | Personal data erased; every session of the account has ended. |
| 409 `ACCOUNT_HAS_OPEN_BOOKINGS` | A booking the user is a party to is not closed. Nothing changed. |
| 422 `ACCOUNT_DELETION_CONFIRMATION_REQUIRED` | The confirmation phrase was missing or wrong. Nothing changed. |
| 401 | Not signed in, or the account is no longer active. |

A booking is closed when its status has no further transition: `COMPLETED`, `REJECTED`,
`CANCELLED`, `EXPIRED`, or `REFUNDED`. A disputed, unpaid, scheduled, or in-progress booking
still needs both parties, so deletion waits. Support can help close it first.

Every request, accepted or refused, appends an `account.delete` audit record with counts and a
reason code, never names or numbers.

## What is erased or anonymized

All of it happens in one serializable transaction (`PostgresAccountDeletionStore`).

| Data | Action |
|---|---|
| Phone number (`users`) | Ciphertext emptied; lookup hash replaced with a per-row tombstone, so the number can register a new, unlinked account. Status `DELETED`. |
| Sessions, role memberships | Revoked (`ACCOUNT_DELETED`). |
| Profile | Name becomes `Deleted user`; contact sharing off; default location cleared. |
| OTP challenges for the phone | Deleted. |
| Locations owned by the user | Deleted when nothing references them; otherwise reduced to state, district, mandal/taluk, and village (coordinates, accuracy, PIN code, landmark, and GPS consent removed). |
| Recipient snapshots on the Farmer's bookings | Name becomes `Redacted recipient`; phone and directions removed. This is the only change the append-only guard allows (migration `0017_account_erasure`). |
| IVR sessions for the user or phone | Caller phone ciphertext emptied; lookup hash tombstoned. |
| Idempotency records | Deleted (they can hold response bodies). |
| Owner Tractors | Kept (bookings reference them) but `OFFLINE` and `INELIGIBLE`, registration number erased, offerings disabled, Equipment unavailable, availability history appended. |
| Owner documents and Tractor photos | Rows deleted. The stored object keys are written to the `AccountErased` outbox event for the storage purge. |

## What is kept, and why

Kept unchanged and still linked to the now-pseudonymous user id: bookings, booking agreements
(including the Quote Snapshot and the service location where the work happened), status history,
work events and measurements, invoices, payments, payment events, notifications and delivery
events, audit events, and outbox events. These are the financial and contractual record and the
audit trail (Requirement 12.4). The integration test proves these rows are byte-identical before
and after deletion and that no name, phone, directions, or ciphertext of the user remains
anywhere else.

Legal review must confirm the retention period for these records and whether the agreement's
service location may be kept at village-and-coordinate precision.

## Known gaps before specific launches

- **Private object bytes.** No consumer of `AccountErased` exists yet. While `OBJECT_STORAGE` is
  `UNCONFIGURED` (Phase 1 production) no objects are stored, so nothing is left behind. Before
  object storage goes `LIVE`, a purge consumer must delete the objects named in `AccountErased`
  events, including events the worker already marked `PUBLISHED` without a handler. This is
  listed under `OBJECT_STORAGE` in `ops/release/readiness.json`.
- **Backups.** Deleted data remains in backups until they age out (35 days proposed in
  `backup-restore.md`). After a restore, re-run deletion for every account deleted after the
  recovery point. Take the list of user ids from the `account.delete` / `SUCCESS` audit rows of
  the damaged primary (kept for investigation), or from the API request logs if the primary is
  unavailable, and call the store again; a second erasure of an already deleted account is
  refused harmlessly.

## Verifying a deletion

```sql
SELECT status, deleted_at, phone_lookup_hash LIKE 'erased:%' AS tombstoned FROM public.users WHERE id = $1;
SELECT outcome, reason_code, pii_safe_metadata FROM public.audit_events
 WHERE action = 'account.delete' AND resource_id = $1 ORDER BY occurred_at;
```
