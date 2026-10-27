# Module extraction, reconciliation, and rollback runbook

Use this runbook only for a named module whose architecture evidence satisfies `ops/architecture/module-extraction.md`. Current status: **blocked; the monolith is authoritative**. Requirements 18.3–18.6.

## Roles and evidence

Assign an incident commander, source owner, candidate owner, database owner, and operations observer. Record release ids, contract versions, migration ids, dashboards, alert links, load-test result, start/end times, and every reconciliation report. Do not put phone numbers, coordinates, provider payloads, or other PII in the record.

## Preflight (stop on any failure)

1. Run the targeted extraction proof, API typecheck, and build.
2. Verify all migrations are additive and both old/new binaries run against the expanded schema.
3. Verify oldest-supported and current contract fixtures in both directions. Additive unknown fields must be ignored; unsupported major versions must mutate nothing and alert/dead-letter.
4. Confirm the candidate's reads are cursor-paginated and every query/provider call has a batch cap and timeout.
5. Run the initial production-shaped load profile. Require p95 read `<500 ms` and state change `<800 ms`, excluding asynchronous provider completion.
6. Confirm outbox lag/dead-letter, contract rejection, duplicate suppression, reconciliation mismatch/age, latency, error, and saturation dashboards and alerts.
7. Confirm the monolith is the sole writer. If command ownership is planned, verify the approved saga and reverse synchronization evidence; otherwise stop before command cutover.
8. Take and verify a restorable backup. Rollback uses routing and additive roll-forward, never a destructive down migration.

## Shadow and replay

1. Deploy the candidate with public/command routing disabled.
2. Start its consumer at a recorded outbox position. In one local transaction, apply the projection and store the outbox event id. Ignore a repeated event id.
3. Reject stale aggregate versions. Page and stop on different payloads at the same version or an unsupported `eventVersion`.
4. Replay retained events in bounded batches. A replay must not change booking/invoice/payment totals or create a second financial effect.
5. Keep dead-letter count at zero. Investigate before replay; do not edit payloads in place.

## Reconciliation pass

Read authoritative snapshots from the monolith using a stable cursor `(updatedAt, id)` and a capped page size. Compare canonical records and report these counts separately: `missing`, `extra`, `stale`, `ahead`, `sameVersionDivergence`, `invariantViolation`.

For each booking consistency cell verify:

- the booking's current agreement exists and prior agreement versions remain append-only;
- every invoice agreement belongs to the same booking;
- invoice subtotal reproduces from its stored rounding trace and total equals subtotal plus adjustments;
- payment method/status combinations are valid and currency matches the invoice;
- applied paise never exceed invoice total and settled is equivalent to applied paise equalling total;
- `COMPLETED` has a current, non-disputed, non-superseded settled invoice;
- every verified provider fact has at most one financial effect.

The reconciler may create a missing projection or advance it from a lower version. It must not overwrite an `ahead` record or a same-version divergence. Re-run is a no-op. Require three consecutive complete passes with all mismatch counts zero before any canary.

Useful shared-database diagnostics before a split (all results must be zero):

```sql
-- An invoice cannot reference another booking's agreement.
SELECT count(*) AS invoice_agreement_mismatch
FROM public.invoices i
JOIN public.booking_agreements a ON a.id = i.agreement_id
WHERE i.booking_id <> a.booking_id;

-- Applied money cannot exceed an invoice total.
SELECT count(*) AS overpaid_invoices
FROM public.invoices i
JOIN public.payments p ON p.invoice_id = i.id
WHERE p.status IN ('PAID_CASH', 'PAID_ONLINE', 'REFUND_PENDING')
GROUP BY i.id, i.total_paise
HAVING sum(p.amount_paise) > i.total_paise;

-- Method labels cannot claim the other settlement path.
SELECT count(*) AS method_status_mismatch
FROM public.payments
WHERE (method = 'CASH' AND status IN ('PENDING', 'PAID_ONLINE', 'PAYMENT_FAILED'))
   OR (method = 'ONLINE' AND status = 'PAID_CASH');
```

Use the application reconciler for settlement/completion and invoice-trace checks; SQL is diagnostic, not a repair mechanism.

## Canary and promotion

1. Enable shadow dual reads; compare responses but return the monolith response.
2. After three clean reconciliations, route a small read-only canary. Increase only while invariants, lag, errors, and latency stay healthy.
3. Do not move writes for booking, billing, or payment independently. A consistency-cell write cutover needs the separately approved saga and reverse-sync drill.
4. Announce the authority change and record the exact event/cursor boundary only after all approvers sign.

## Rollback triggers

Rollback immediately on an invariant violation, same-version divergence, unsupported contract major, dead letter, unbounded query, data exposure, reconciliation mismatch that survives one pass, outbox lag beyond SLO, p95 read `>=500 ms`, p95 state change `>=800 ms`, or material error-rate increase.

## Rollback procedure

### Before command ownership moves

1. Disable candidate routing and return all reads/commands to the monolith.
2. Stop candidate consumers only after recording their cursor; leave the monolith and outbox running.
3. Confirm the monolith's booking/invoice/payment invariant checks and provider reconciliation are healthy.
4. Preserve logs, traces, dead letters, digests, and reconciliation reports. Discard/rebuild only the shadow projection.
5. Correct with an additive migration or compatible consumer, replay from the recorded cursor, and restart at Shadow and replay.

### After command ownership moves

Do not improvise. Freeze new commands at the gateway, invoke the candidate-specific reverse synchronization plan, reconcile both directions, and restore monolith routing only when the source owner proves it has every committed version. If reverse sync was not rehearsed, command cutover was invalid: keep traffic frozen and escalate to incident response.

## Payment-specific failure handling

Provider reads and signed callbacks remain evidence. A missing callback is recovered through `PaymentReconciliationJob`; the same fact flows through the same provider-event evaluator, so webhook/API duplicates do not apply twice. A mismatch changes no money and pages an operator. During payment-provider rollback prefer `DEGRADED` for in-flight intents so signed callbacks and reconciliation can finish; see `ops/runbooks/online-payments.md`.

## Closeout

Run one final full reconciliation after rollback or promotion, verify zero dead letters and invariant violations, record measured RTO and data-loss result, and hold a review. Do not delete old contract support, event history, or expanded columns until the replay/retention window has elapsed and a separate contract-removal review passes.
