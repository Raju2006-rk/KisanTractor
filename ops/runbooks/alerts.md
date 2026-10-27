# Alert runbooks

Rules live in `ops/observability/alerts/operational-alerts.json`. They are defined but not
yet loaded into an alert manager. Each section below is linked from a rule's `runbook` field.
`packages/observability/src/alert-rules.test.ts` proves every enabled rule fires on its
threshold (after its `for` hold) and stays quiet below it.

General rules for every alert:

- Alerts notify people. They never change booking, invoice, payment, or capability state.
  Changing a capability state (for example setting `OTP_CAPABILITY_STATE=DEGRADED`) is a
  deliberate configuration change made by an operator and recorded in the incident log.
- Start from the correlation ID. Pick a failing request's `x-correlation-id` (response header,
  log line, or `audit_events.correlation_id`) and search logs for it to see the request span,
  its `db.transaction` spans, and any `outbox.event.process` spans it produced.
- Logs contain codes, not personal data. Do not copy database rows with personal data into
  tickets or chat; reference IDs instead.
- Critical alerts follow `incident-response.md`.

## ApiErrorRateHigh

1. Open the API health panel and find the routes with 5xx responses (`route` label).
2. Search logs for `event="http.request.completed"` with `statusCode>=500`, then follow one
   `correlationId` to the `db.transaction.rolled_back` line and its `errorCode`.
3. `SQLSTATE_*` codes point to the database (connections, migrations, locks); `UNCLASSIFIED`
   means an unexpected exception and needs a code fix.
4. If a deploy preceded the spike, roll back the deploy (migrations are additive, so the
   previous release runs against the new schema).

## ApiLatencyHigh

1. Compare read and state-changing p95 by `route` on the dashboard.
2. Check `kt_domain_transaction_duration_ms` and rollback rates. Serializable retries and lock
   waits on `bookings`/`tractors` show up as long `db.transaction` spans.
3. Check database CPU, connections, and slow-query logs. Discovery and history endpoints must
   stay cursor-paginated (Requirement 18.3); an unbounded query is a bug.

## OtpThrottleSpike

1. Throttling is working as designed; the question is whether this is abuse.
2. Look at `otp.request` audit rows with reason `RATE_LIMITED` grouped by hour. Audit rows hold
   only hashed requester and phone lookups, which is enough to see whether few requesters
   drive most of the volume.
3. If one requester population dominates, tighten edge rate limits or block at the CDN/WAF.
   Do not lower application throttles below policy without a security review.
4. Watch SMS spend with the provider if a live OTP provider is configured.

## OtpVerificationFailureRateHigh

1. Break down by `reason`. `INVALID_CODE` and `ATTEMPTS_EXHAUSTED` together suggest guessing;
   `EXPIRED` suggests slow SMS delivery; `BINDING_MISMATCH` suggests a client bug.
2. For `EXPIRED`, check provider delivery latency and consider `OtpDeliveryFailing`.
3. For guessing patterns, follow `OtpThrottleSpike` step 2.

## OtpDeliveryFailing

1. Check the OTP provider's status page and the provider dashboard (when live).
2. If the provider is down, an operator may set `OTP_CAPABILITY_STATE=DEGRADED` so clients show
   the degraded state honestly. Record the change in the incident log; revert after recovery.
3. Never enable local development OTP codes in staging or production.

## ZeroResultDiscoveryHigh

1. Check whether Owners went offline in bulk (availability changes in `audit_events`) or whether
   tractor location freshness lapsed.
2. Check for a deploy that changed discovery policy (radius, freshness window).
3. This is a product signal as much as an incident; open a ticket for supply/coverage review.

## BookingAcceptanceConversionLow

1. Compare `REQUESTED`, `ACCEPTED`, `REJECTED`, and `EXPIRED` stages on the funnel panel.
2. A rise in `EXPIRED` means Owners are not responding; check notification delivery
   (`OutboxLagHigh`, `OutboxDeadLetters`) before assuming a product problem.
3. Funnel counts come from committed outbox events; if the worker is down the funnel stalls.

## AcceptanceConflictsElevated

1. Break down by `reason`. `OVERLAP` and `CONCURRENT_RESERVATION` mean the no-overlap rules are
   protecting a Tractor's schedule; `VERSION_CONFLICT` means clients act on stale state.
2. Persistent `VERSION_CONFLICT` usually means a client is not refreshing after a change; check
   the latest web release.
3. Never relax the exclusion constraint to reduce conflicts.

## InvalidTransitionsElevated

1. Break down by `aggregate` and `action`. A single action dominating usually points to a client
   that offers a button the current state no longer allows.
2. Reproduce with the booking's current state from the API; the error response lists valid next
   actions for job events.

## InvoiceDisputeRateHigh

1. Look for a recent change to pricing rules or billing calculation.
2. Sample disputed bookings (IDs only) and compare invoice traces against agreed quotes.
3. Settlement for disputed bookings is already blocked by the lifecycle; do not unblock manually.

## PaymentIntegrityFailure

1. Treat as a possible integrity or fraud issue. Follow `incident-response.md`.
2. `PAYMENT_LEDGER_INCONSISTENT` means stored payments exceed or contradict the invoice; freeze
   manual adjustments for the affected booking and escalate to engineering.
3. Provider mismatch reasons come from the payment webhook (`ops/runbooks/online-payments.md`).
   `SIGNATURE_INVALID` covers unsigned and wrongly signed requests: check the `payment.webhook.rejected`
   log digests first, since a stray scanner and a rotated webhook secret look the same.
   `AMOUNT_MISMATCH`, `CURRENCY_MISMATCH`, and `REFERENCE_MISMATCH` are signed events that
   contradict the server-created intent; they are stored as `REJECTED` provider events with an
   audit record and no financial effect. Never mark a payment paid to work around them.
4. The rule fires on a single failure because every process publishes these series at zero on
   start (`OperationalIndicators.initializeAlertBaselines`); without the zero sample, `increase()`
   cannot see the first failure after a deploy. Keep that baseline if you add a reason.
5. `RECONCILIATION_MISMATCH` comes from the payment reconciliation job: the provider's API
   disagrees with the platform (a second capture on one order, a refund nobody requested, an order
   marked paid without a capture, or a submitted refund the provider no longer lists). Nothing was
   changed. Find the payment in `provider_events` (`evidence_source = 'PROVIDER_API'`) and the
   `PROVIDER_*_EVENT_REJECTED` audit records, compare with the provider dashboard, and refund any
   money the bill cannot hold from the dashboard (`ops/runbooks/online-payments.md`).

## PaymentRefundFailed

1. The provider reported a refund as failed (for example a payment older than six months), or
   refused the refund request. The payment is back to `PAID_ONLINE` and still counts toward the
   bill; the booking stays `REFUND_PENDING`.
2. Find the refund in `payment_refunds` (`status = 'FAILED'`, `last_error_code`) and its
   `REFUND_FAILED` payment event. Decide with the Farmer how to return the money; support can
   request a new refund once the cause is fixed.

## PaymentReconciliationErrors

1. The payment worker logs `payment.reconciliation.provider_error` with a provider error code.
   `PROVIDER_AUTH_FAILED` means the key secret is wrong or was rotated; `PROVIDER_THROTTLED` and
   `PROVIDER_UNAVAILABLE` are provider-side and retried on the next cycle.
2. Nothing is released or refunded without a successful provider read, so pending intents keep
   their bill reservation until the provider answers. Check the provider status page.

## PaymentVerificationFailuresElevated

1. Break down by `reason`. `PAYMENT_OVERPAYMENT` and `PAYMENT_BOOKING_NOT_PAYABLE` usually mean
   Owners retry cash entry on stale screens; check the web release.
2. `IDEMPOTENCY_KEY_REUSED` means a client reused a key for a different amount; that is a client bug.
3. `REPLAYED_EVENT` means a signed webhook body arrived again under a new event id. It is applied
   at most once; a burst suggests someone is replaying captured requests.

## OutboxLagHigh

1. Check `OutboxWorkerSilent` and `OutboxPollFailing` first.
2. If workers are healthy but slow, look at `outbox.event.retry_scheduled` lines by `errorCode`;
   a slow or failing provider causes retries that occupy the batch.
3. Scale out workers (claims use `SKIP LOCKED`, so more workers are safe).
4. Domain state is never affected by outbox lag; only notifications are delayed.

## OutboxWorkerSilent

1. Check the worker process (`node dist/outbox-worker.js`) is running and can reach the database.
2. The metric is sampled by the worker every 15 seconds and exported at the configured interval;
   confirm `TELEMETRY_EXPORTER=stdout` (or the deployed exporter) is set for the worker.
3. Limitation: this rule detects a worker that stopped exporting metrics (process down). A live
   process whose poll loop is stuck keeps exporting its last backlog sample, so neither this rule
   nor `OutboxLagHigh` fires. If notifications look stalled while both are quiet, compare the
   oldest `PENDING` row in `outbox_events` with the dashboard and restart the worker.

## OutboxDeadLetters

1. List dead letters with `PostgresOutboxLeaseStore.listDeadLetters` (IDs, event type, attempt
   count, `last_error_code`).
2. Fix the cause first (provider configuration, template, payload bug).
3. Requeue with `requeueDeadLetter(eventId, now)`. Handlers are idempotent, so a requeue does not
   send duplicate notifications for already-delivered recipients. A requeued booking event is
   counted again in the funnel metric.

## OutboxPollFailing

1. The worker logs `outbox.poll.failed` with an `errorCode`; `SQLSTATE_*` points to the database.
2. Check database availability and connection limits.

## TranslationMissesElevated

1. Search `i18n.translation.missed` debug logs (enable `LOG_LEVEL=debug` temporarily if needed)
   for the `translationKey` values.
2. Add the missing catalog entries for the affected locale. English fallback keeps screens usable
   in the meantime.

## WebVitalsPoor

1. Break down by `vital` and `route_group`.
2. Check recent web releases for bundle growth, unoptimized images, or layout shifts.
3. The 3D landing scene (Phase 4) must never load on booking routes.

## IvrAbandonmentHigh

Phase 3 only; the rule is disabled until the IVR channel emits `kt_ivr_calls_total`.

1. Break down by `last_step` to find the prompt where callers give up.
2. Check prompt audio and language selection for that step, and telephony provider latency.

## Landing3dFallbackRateHigh

The client reports one terminal outcome per scripted page view to `POST /api/telemetry/landing-3d`.
The dashboard counts every non-`LOADED` outcome as fallback. Paging remains disabled until Phase 4
operational approval; when enabled, the alert intentionally evaluates only `FAILED` and `TIMED_OUT`
outcomes so user preferences and low-capability devices do not page operators.

1. Separate failures (`FAILED`, `TIMED_OUT`) from intended fallbacks (reduced motion, data saver,
   low capability), which are not errors.
2. Check model/texture CDN delivery and the compressed asset budget.
