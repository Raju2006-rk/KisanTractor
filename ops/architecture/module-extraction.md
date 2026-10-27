# Module extraction architecture gate

Status: **no service split is approved**. This decision records the conditions that must be met before a module leaves the modular monolith. The machine-readable companion is `ops/architecture/module-extraction-gate.json`; the operating procedure is `ops/runbooks/module-extraction.md`.

Applies to Requirements 18.3–18.6. In particular, booking, invoice, and payment ownership remains in the monolith until versioned contracts, delivery, reconciliation, and rollback have all passed in staging with production-shaped data and load.

## Decision

Extraction is a reliability change, not a directory move. A candidate may be extracted only when it has one authoritative writer, an explicit transaction boundary, a versioned and backward-compatible contract, idempotent at-least-once consumption, bounded cursor queries, measured latency, reconciliation, and a rehearsed rollback. Business pressure (independent scaling, isolation, or release cadence) must be measured; team preference alone is not sufficient.

Discovery read models, notifications, analytics, and reports are preferred first candidates because they can be rebuilt from authoritative records. Booking, job/billing, and payments form one consistency cell. They must not be separated until an approved saga specifies reservations, compensation, timeout ownership, and recovery for every partial outcome. There is no distributed transaction or saga approved today.

## Invariants that cannot move

| ID | Invariant | Authoritative evidence |
|---|---|---|
| `BOOKING_AGREEMENT_IMMUTABLE` | Agreement versions are append-only; a booking names one current agreement and prior versions remain readable. | `booking_agreements`, `bookings.current_agreement_id` |
| `INVOICE_AGREEMENT_LINK` | Every invoice belongs to the same booking as its agreement and retains that agreement version, rate, method, formula, evidence, and rounding trace. | `invoices.agreement_id`, billing trace |
| `INVOICE_REPRODUCIBLE` | Replaying the stored trace reproduces the subtotal and `total = subtotal + adjustments` in integer paise. | `calculateFinalBill`, `reproduceSubtotalFromTrace` |
| `PAYMENT_CONSERVATION` | Applied payments never exceed the current invoice total; settled is true if and only if applied paise equal total paise. | `summarizeInvoiceSettlement` |
| `COMPLETION_REQUIRES_SETTLEMENT` | A booking cannot become `COMPLETED` while its current invoice is unpaid, superseded, void, or disputed. | booking/payment transition stores |
| `PROVIDER_EVIDENCE_IDEMPOTENT` | Only verified provider evidence has a financial effect, and duplicate/out-of-order evidence cannot apply money twice. | provider-event uniqueness and evaluator |

Cash and online method labels remain distinct. Reconciliation is not allowed to invent money, rewrite agreement history, or repair a mismatch by force.

## Ownership and consistency boundary

Before cutover, the monolith remains the only writer for bookings, agreements, work evidence, invoices, payments, provider events, and their status histories. The extracted candidate consumes committed outbox events into a disposable shadow projection. It may serve shadow reads, but no command or public read is routed to it.

After promotion, each aggregate still has exactly one command owner. Cross-owner operations use explicit commands and facts, never direct writes into another service's database. If booking, invoice, and payment ever become separate owners, the approved saga must define:

1. the initiating command and idempotency scope;
2. the exact state machine and monotonic aggregate versions;
3. timeout and retry behavior;
4. compensations that preserve append-only history;
5. which service decides settlement and booking completion;
6. reconciliation when an event is missing, delayed, duplicated, or reordered;
7. a reverse synchronization path for rollback.

Until all seven exist and pass failure injection, the consistency cell stays together.

## Versioned contract

Every cross-process message uses this envelope:

```json
{
  "id": "outbox-event-uuid",
  "eventType": "BookingFinancialSnapshot",
  "eventVersion": 1,
  "aggregateType": "Booking",
  "aggregateId": "booking-uuid",
  "occurredAt": "2026-11-01T00:00:00.000Z",
  "correlationId": "request-or-job-id",
  "payload": {}
}
```

`eventVersion` is the major contract version. Within a major version, producers may add optional fields only. They may not rename/remove fields, narrow accepted values, change paise units/currency meaning, change timestamp meaning, or change idempotency identity. Consumers select known fields and ignore unknown additive fields. An unsupported major version is rejected without state mutation and dead-lettered for operator action; it is never guessed.

Each contract release requires checked-in producer/consumer fixtures for the oldest supported and current versions. Deployment order is expand consumer, deploy producer, observe, then remove support only after the retention/replay window. Database changes follow the same expand/backfill/switch/contract sequence and remain additive while either version runs.

## Delivery model

The domain transaction and its outbox row commit atomically. Delivery is at least once: leases, retries, process crashes, and replay can invoke a consumer repeatedly. Therefore every consumer stores the outbox event id in the same local transaction as its projection change. A repeated id is a successful no-op. Aggregate versions prevent stale events from overwriting newer state; two different payloads with the same aggregate version are a blocking divergence.

No handler may make the originating booking/invoice/payment transaction depend on provider delivery. Dead letters pause promotion and are replayed only after their cause is understood.

## Reconciliation model

The monolith exposes a bounded, cursor-paginated snapshot ordered by `(updatedAt, id)`. A snapshot includes booking id/status/version/current agreement version, current invoice id/version/agreement version/trace/total/currency, and payment id/version/method/status/amount/currency. Pages and batch sizes are capped; offset scans and unbounded histories are forbidden (Requirement 18.3).

The reconciler compares source and shadow by id, version, and canonical digest. It may insert missing rows and advance lower versions from authoritative snapshots. It must not overwrite a higher shadow version or a different payload at the same version; either result blocks cutover and pages an operator. Reconciliation is idempotent and produces no domain side effects.

Promotion requires three consecutive full passes with zero missing, extra, stale, same-version-divergent, or invariant-violating records, plus zero dead letters and outbox lag within the declared SLO.

## Performance and observability gate

The extracted path must preserve cursor pagination and bounded provider/database queries. Under the documented initial load it must meet p95 below 500 ms for reads and below 800 ms for state changes, excluding asynchronous provider completion (Requirement 18.4). Measure end-to-end and per-hop latency, saturation, timeout/error rate, outbox lag, dead letters, reconciliation mismatch count/age, contract-version rejection, duplicate suppression, and saga age if a saga is later approved. Logs and traces carry correlation ids and no PII.

## Cutover and rollback shape

Cutover progresses through contract fixtures, shadow consume, replay, dual-read comparison, a small read canary, and only then command ownership. Before command ownership moves, rollback is a routing/configuration change back to the monolith; the shadow projection is discarded or rebuilt. After command ownership moves, rollback is prohibited unless reverse synchronization has been proven and reconciliation is clean.

Rollback triggers include any invariant violation, same-version divergence, unsupported contract version, dead letter, rising lag, reconciliation mismatch, p95 breach, or elevated error rate. Rollback never runs a destructive down migration. Restore routing first, stop candidate writes, drain/reconcile evidence, and use additive roll-forward remediation.

## Extraction approval record

The candidate owner, architecture reviewer, database owner, operations lead, and security/privacy reviewer must sign a dated evidence bundle. The bundle names the contract versions, load profile, reconciliation reports, failure-injection results, rollback drill RTO, dashboards, alerts, data classification, and retention controls. `approvalStatus` remains `BLOCKED` in the gate manifest until this evidence exists for a named candidate; changing it is a separate reviewed production decision.
