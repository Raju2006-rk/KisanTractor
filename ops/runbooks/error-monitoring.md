# Error monitoring

Status: the signals below are emitted by the code today, and the alert thresholds are tested
(`packages/observability/src/alert-rules.test.ts`). Collection, retention, and alert delivery
depend on infrastructure that is not provisioned yet. Requirement 12.7 requires this procedure
to be in operation before production release (gate `MONITORING_DEPLOYED` in
`ops/release/readiness.json`).

## Signals

| Signal | How to find it |
|---|---|
| API request failures | `http.request.completed` log lines at `error` level (status >= 500), `kt_http_server_requests_total{status_class="5xx"}` |
| Domain transaction rollbacks | `db.transaction.rolled_back` log lines with `errorName`/`errorCode`, `kt_domain_transactions_total{outcome="ROLLED_BACK"}` |
| Outbox delivery failures | `outbox.event.retry_scheduled` (warn), `outbox.event.dead_lettered` (error), `outbox.poll.failed` (error) |
| Provider capability degradation | `OtpDeliveryFailing`, `OutboxLagHigh` alerts; capability state from the public runtime config |
| Client experience | web-vital reports, translation misses |

Error log lines never contain exception messages or stacks, because those can carry personal
data. They contain `errorName` (exception class) and `errorCode` (a stable machine code or
`SQLSTATE_*`). `UNCLASSIFIED` means an exception without a code; treat a rising count as a bug
and add a typed error.

## Daily checks (until alert delivery is automated)

1. Review the operational-indicators dashboard sections for anomalies.
2. Review dead-lettered outbox events and their `last_error_code`.
3. Review rollback codes from the last 24 hours, excluding expected conflicts
   (`SQLSTATE_40001` serialization retries, `BOOKING_CONFLICT`).

## Triage

1. Get a correlation ID from the failing response header, the log line, or the audit row.
2. Search logs for that `correlationId`. The request span, transaction spans, and outbox spans
   share it, and the outbox worker logs it for every attempt of events the request produced.
3. Classify: client bug (4xx patterns), server bug (`UNCLASSIFIED`), dependency (`SQLSTATE_*`,
   provider codes), or abuse (throttling patterns).
4. Open a ticket with the correlation ID, route template, error code, and time window. Do not
   paste personal data.

## Pre-production readiness checklist

- [ ] A log store receives API and worker stdout and retains it per the retention policy.
- [ ] A metrics backend receives the catalog metrics through a deployed exporter.
- [ ] Alert rules from `ops/observability/alerts/operational-alerts.json` are loaded, and a test
      alert reached the on-call rotation.
- [ ] On-call rotation and escalation contacts are documented in the incident log.
- [ ] A sample of production-like logs was reviewed and contained no personal data.
