# Observability

Status: **defined in the repository, not deployed.** The code emits structured
logs, metrics, and traces. The dashboard and alert files here are version-controlled
definitions. No metrics backend, alert manager, or log store is provisioned yet,
and nothing in this directory claims otherwise.

## What the code emits

| Signal | Where | Notes |
|---|---|---|
| Structured JSON logs | `createStructuredLogger` in `packages/observability` | One JSON object per line on stdout. Every entry passes the central PII redaction and carries `correlationId`, `traceId`, and `spanId` when a request, outbox, or transaction context is active. |
| Metrics | `METRIC_DEFINITIONS` in `packages/observability/src/metrics.ts` | Process-local registry. Labels are enumerated or code-pattern bounded; out-of-set values become `OTHER`. No user, phone, booking, or other entity IDs are labels. |
| Traces | `Tracer` in `packages/observability/src/tracing.ts` | Span kinds: `http.server.request` (client requests), `db.transaction` (domain transactions), `outbox.event.process` (outbox jobs), `provider.callback` (provider callbacks, Phase 2+). W3C `traceparent` is continued when present. |

### Exporters

`TELEMETRY_EXPORTER` selects where spans and metric snapshots go:

- `none` (default in every profile): spans and metrics stay in process. Logs are still written.
- `stdout`: finished spans are written as `trace.span` JSON lines and metric snapshots as
  `metrics.snapshot` JSON lines every 60 seconds, for a log shipper or collector to forward.

An OTLP or Prometheus exporter is not implemented. Adding one means implementing
`SpanExporter` and reading `InMemoryMetrics.snapshot()`; the metric names and labels in
the catalog are already Prometheus-compatible, which is what the PromQL in the
dashboard and alert files assumes.

### Correlation IDs

- The API accepts `x-correlation-id` when it is an opaque token of 8 to 128 characters
  (`[A-Za-z0-9._:-]`) that does not look like a phone number, OTP, token, or other personal data;
  otherwise it generates a UUID. The value is echoed on every response (`x-correlation-id`,
  exposed to the web origin through CORS).
- `withTransaction` writes it to the transaction-local `app.correlation_id` setting.
  `audit_events.correlation_id` and the new `outbox_events.correlation_id` column (migration
  `0014_outbox_correlation`) both record it.
- The outbox worker runs each attempt in a span carrying the event's stored correlation ID,
  passes it to handlers, and includes it in every worker log line.
- Web route handlers that proxy to the API forward only a validated correlation ID.

### Indicators (Requirement 18.2)

| Indicator | Metric(s) | Source |
|---|---|---|
| OTP abuse/failure | `kt_otp_requests_total`, `kt_otp_verifications_total` | `IdentityService` |
| Zero-result discovery | `kt_discovery_searches_total` | `DiscoveryService` (first pages only) |
| Booking conversion | `kt_booking_funnel_events_total` | Outbox worker, once per committed booking event |
| Acceptance conflicts | `kt_booking_acceptance_conflicts_total` | `BookingService` |
| Invalid transitions | `kt_invalid_transitions_total` | `BookingService`, `JobService` |
| Invoice disputes | `kt_invoice_disputes_total` | Outbox worker, once per `BookingDisputed` event |
| Payment verification failures | `kt_payment_verification_failures_total` | `PaymentService` (cash rules, online intent refusals, and payment webhook verification) |
| Outbox lag | `kt_outbox_dispatch_lag_ms`, `kt_outbox_oldest_pending_age_ms`, `kt_outbox_backlog_events`, `kt_outbox_dead_letter_events`, `kt_outbox_events_resolved_total`, `kt_outbox_poll_failures_total` | `OutboxWorker` |
| Translation misses | `kt_translation_misses_total` | i18n miss hook in API, worker, and web server |
| Web vitals | `kt_web_vitals_reports_total`, `kt_web_vital_duration_ms`, `kt_web_vital_cls` | Browser beacon to `POST /api/telemetry/web-vitals` |
| IVR abandonment | `kt_ivr_calls_total` | **Contract only (Phase 3).** Nothing emits it yet. |
| 3D fallback rate | `kt_landing_3d_outcomes_total` | Browser beacon to `POST /api/telemetry/landing-3d`; dashboard computes non-`LOADED` outcomes / all terminal outcomes |

Booking conversion and disputes are counted from committed outbox events rather than at
request time, so idempotent replays and rolled-back transactions do not inflate them. They
lag by the outbox dispatch delay. Requeuing a dead-lettered event counts it again.

## Files

- `dashboards/operational-indicators.json`: panel definitions with PromQL queries. The landing 3D panel measures the 24-hour fallback rate as all non-`LOADED` outcomes divided by all terminal outcomes; capability fallbacks remain visible while the alert considers only failures and timeouts.
- `alerts/operational-alerts.json`: alert rules, severities, and runbook links. Phase 3/4 rules are
  `"enabled": false` until their emitters exist.
- `../runbooks/`: alert runbooks, error monitoring, backup and restore, and incident response.

`packages/observability/src/ops-config.test.ts` fails if a dashboard or alert references a
metric that is not in the catalog, or if an alert's runbook anchor is missing.
`packages/observability/src/alert-rules.test.ts` evaluates every enabled rule (with a small,
deterministic evaluator for the PromQL subset the rules use) against series scraped from the
real metric registry, and fails if a rule does not fire on its threshold scenario or fires on a
quiet one. Rules may use only that subset; the test rejects anything else.

Processes publish zero-valued series for the counters that low-threshold alerts read with
`increase()` (`OperationalIndicators.initializeAlertBaselines`, called by `createTelemetry`).
Without them the first event after a deploy, such as a payment-ledger inconsistency, would be
invisible to the alert.

## Privacy rules for contributors

- Log identifiers, counts, and machine codes. Never log message bodies, payloads, names,
  phone numbers, OTPs, tokens, coordinates, registration numbers, or free-text reasons.
  Redaction is a safety net, not permission.
- Never add a metric label whose values come from user input or entity IDs.
- Errors are logged as `errorName` and `errorCode` only; messages and stacks are dropped.
