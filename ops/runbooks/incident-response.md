# Incident response

Status: procedure defined; roles and contacts are not assigned and no exercise has been run.
Both are required before production release (Requirement 12.7; gate `INCIDENT_RESPONSE_READY`
in `ops/release/readiness.json`). Jurisdiction-specific notification
duties (for example under India's Digital Personal Data Protection Act and CERT-In directions)
need legal review before launch; this document does not replace that review.

## Severity

| Severity | Examples | Response |
|---|---|---|
| SEV1 | Booking or payment data corruption, suspected personal-data breach, API down | Page on-call immediately; incident lead within 15 minutes; updates every 30 minutes |
| SEV2 | A provider capability degraded (OTP, messaging), outbox lag over 15 minutes, sustained 5xx | On-call within 30 minutes; updates every hour |
| SEV3 | Elevated conflicts, translation misses, poor web vitals | Ticket; next business day |

Critical alerts in `ops/observability/alerts/operational-alerts.json` start at SEV2 and are
raised to SEV1 when data integrity or personal data is involved.

## Roles

- **Incident lead**: owns decisions and the timeline. _Name and contact: to be assigned._
- **Operations**: runs mitigations (rollbacks, scaling, capability state changes).
- **Communications**: updates Farmers, Owners, and support staff in their languages.
- **Scribe**: keeps the incident log.

## Procedure

1. **Declare.** Open an incident log entry with time, severity, triggering alert or report, and
   the incident lead.
2. **Stabilize.** Prefer reversible actions: roll back the last deploy, scale workers, or set an
   affected capability to `DEGRADED` so clients show an honest state (procedure and expected
   effects: `ops/release/production-readiness.md`, "Capability rollback procedure"). Never mark
   bookings, invoices, or payments as changed to hide an outage. Application rollbacks are safe
   because migrations are additive: the previous release runs against the newer schema; never
   run a down migration in production.
3. **Preserve evidence.** Keep logs, the affected database (do not overwrite it during restores),
   and audit rows. Logs contain codes and IDs rather than personal data; keep it that way when
   copying evidence.
4. **Diagnose.** Use correlation IDs to follow affected requests through transactions and outbox
   jobs (`alerts.md`, general rules).
5. **Recover.** Restore from backup only per `backup-restore.md`. Requeue dead-lettered outbox
   events after fixing their cause.
6. **Communicate.** Tell affected users what happened and what they need to do, without
   promising unverified outcomes (for example, never say a payment succeeded before it is verified).
7. **Close.** Confirm alerts are clear for one hour and record the end time.
8. **Review.** Within five business days, write a blameless review: timeline, impact, root cause,
   what worked, and follow-up actions with owners.

## Personal-data incidents

1. Treat any suspected exposure of phone numbers, exact locations, documents, OTP material, or
   payment details as SEV1.
2. Revoke exposed credentials and sessions; rotate affected keys through the secret store
   (encrypted fields need re-encryption under the new key version).
3. Determine scope from audit rows (document access, session issuance) using IDs only.
4. Escalate to legal for regulatory and user notification decisions and deadlines.

## Exercises

Run a tabletop exercise before production release and twice a year after: one SEV1 data
scenario (for example a payment-ledger inconsistency) and one provider outage (OTP delivery
failure). Record gaps as follow-up tasks.
