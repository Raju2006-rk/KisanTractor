# Production readiness checklist

Status: Phase 1 is **not ready for production**. The automated gates pass; the operational gates
(production backups, a staging restore of a real backup, deployed monitoring, incident-response
staffing, legal review) are pending. Only ONLINE_PAYMENT (Razorpay, tasks 16.1-16.2) and MESSAGING
(MSG91 and FCM, task 16.4) have live adapters, and none of their six readiness checks has passed.
OTP has no live adapter, so OTP sign-in cannot run in production yet. Requirements 12.5, 12.7,
18.5, 18.7.

`ops/release/readiness.json` is the machine-readable form of this page. Change both together.

## Automated check

```powershell
# With the production environment loaded (APP_ENV=production and its variables):
corepack pnpm release:check
```

It validates the production configuration, then reports blockers and warnings as stable codes
and exits 1 unless the release is ready:

| Code | Meaning |
|---|---|
| `GATE_PENDING:<id>` | A blocking release gate has not passed (non-blocking gates are warnings). |
| `EVIDENCE_MISSING:<id>:<path>` | A gate names evidence that is not in the repository. |
| `CAPABILITY_NO_LIVE_ADAPTER:<capability>` | Configured `LIVE`, but this release has no live adapter for it. |
| `CAPABILITY_CHECK_PENDING:<capability>:<check>` | Configured `LIVE` without one of the six readiness checks below. |
| `SANDBOX_IN_PRODUCTION:<capability>` | Production never registers sandbox providers; the capability would run `DEGRADED`. |
| `REQUIRED_CAPABILITY_NOT_LIVE:<capability>` | The platform cannot work without it (OTP sign-in). |
| `PRODUCTION_ENVIRONMENT_NOT_VALIDATED` | Run without the production environment; capability states were not validated. |
| `CAPABILITY_DEGRADED:<capability>` (warning) | Allowed: clients show an honest degraded state. |

`packages/config/src/production-readiness.test.ts` keeps the manifest valid and every evidence
path real, and refuses a `PASSED` item without dated evidence.

## Phase 1 release gates

| Gate | Requirement | Kind | Status | Evidence |
|---|---|---|---|---|
| Additive migrations | 18.5 | Automated | Passed 2026-10-26 | `migration-additivity.test.ts`, `migrations.integration.test.ts`, `migration-policy.ts` |
| Stable reference identifiers | 18.5 | Automated | Passed 2026-10-26 | `reference-data.ts` and its unit and integration tests |
| Roll-forward and local restore drill | 12.7, 18.5 | Automated | Passed 2026-10-26 | `backup-restore.integration.test.ts`, `ops/runbooks/backup-restore.md` |
| Production backups configured | 12.1, 12.7 | Operational | **Pending** | PITR, encryption, separate region, failure alerts |
| Staging restore of a real backup | 12.7, 18.5 | Operational | **Pending** | Measured RTO/RPO recorded in the backup runbook |
| Account deletion | 12.5 | Automated | Passed 2026-10-26 | `account-deletion.integration.test.ts`, `ops/runbooks/account-deletion.md` |
| Retention and deletion policy review | 12.4, 12.5, 12.6 | Operational | **Pending** | Legal sign-off |
| Alert rules fire on thresholds | 12.7, 18.2 | Automated | Passed 2026-10-26 | `alert-rules.test.ts` |
| Monitoring deployed | 12.7, 18.1, 18.2 | Operational | **Pending** | Log store, metrics exporter and backend, alert manager, test page |
| Incident response ready | 12.7 | Operational | **Pending** | Roles and contacts, two tabletop exercises |
| Capability rollback tested | 14.2, 14.4, 18.7 | Automated | Passed 2026-10-26 | `capability-rollback.test.ts` and the service rollback tests |
| Security suite | 2.x, 4.5, 4.6, 12.1–12.3 | Automated | Passed 2026-10-26 | `http-boundary.security.test.ts`, `security.e2e.test.ts` |
| Initial load profile (non-blocking) | 18.3, 18.4 | Automated | Recorded by task 15.3 | `ops/performance/initial-load-profile.md` |

## Provider capability readiness (Requirement 18.7)

A capability may be configured `LIVE` in production only when its adapter exists and all six
checks have passed for that provider, with dated evidence in `readiness.json`:

1. **Security**: threat model reviewed; credentials in the secret store; webhook/callback
   signatures verified and replay-protected; no personal data in provider logs or our logs.
2. **Contract**: adapter contract tests against the provider's documented API and error codes,
   including idempotency keys and timeouts.
3. **Sandbox**: end-to-end flows pass against the provider sandbox with explicit sandbox
   credentials, labelled test-only throughout.
4. **Failure mode**: timeouts, 5xx, throttling, duplicate and out-of-order callbacks, and partial
   outages leave domain state consistent and show `DEGRADED` with a safe retry or manual path.
5. **Operational**: dashboards and alerts for the capability are live, on-call knows the
   runbook, provider support contacts and quotas are recorded, cost limits are set.
6. **Rollback**: the capability rolled back to `DEGRADED` and `UNCONFIGURED` in staging with no
   lost or duplicated domain effects, and in-flight work (codes, intents, messages, uploads)
   handled as the rollback tests describe.

| Capability | Phase | Live adapter | Notes |
|---|---|---|---|
| OTP | 1 (required to launch) | No | Only the labelled local-development adapter exists; production refuses it. |
| MAPS_GEOCODING | 4 | No | Manual administrative location works without it. |
| ONLINE_PAYMENT | 2 | Yes (Razorpay) | All six checks pending; tested only against local signed fixtures and an in-process API fake with synthetic keys. Refunds need a support access policy (task 16.5). Cash recording does not depend on it. See `ops/runbooks/online-payments.md`. |
| MESSAGING | 2 | Yes (MSG91 SMS, FCM push) | All six checks pending; tested only against local fixtures with synthetic credentials, and no DLT template is registered yet. `UNCONFIGURED` records notifications as `NOT_SENT`; in-app delivery continues. See `ops/runbooks/messaging.md`. |
| OBJECT_STORAGE | 1–2 | No | Needs the `AccountErased` purge consumer and a malware scanner before `LIVE`. |
| TELEPHONY | 3 | No | The booking number stays hidden until `LIVE`. |

## Capability rollback procedure

Rollback is a configuration change and a restart; no code or data change is needed.

1. Set the capability's variable (`OTP_CAPABILITY_STATE`, `MAPS_CAPABILITY_STATE`,
   `PAYMENT_CAPABILITY_STATE`, `MESSAGING_CAPABILITY_STATE`, `STORAGE_CAPABILITY_STATE`,
   `TELEPHONY_CAPABILITY_STATE`) to `DEGRADED` (provider misbehaving, retry expected) or
   `UNCONFIGURED` (provider withdrawn).
2. Restart the API and the outbox worker so both rebuild their capability registry.
3. Confirm the public runtime configuration shows the new state and, for telephony, no booking
   number.
4. Expect, as the rollback tests prove:
   - OTP: new codes are refused with a typed, retryable-when-degraded error; codes already
     delivered still verify; signed-in users stay signed in.
   - Object storage: new grants, completions, and downloads are refused with no provider call;
     document metadata is unchanged and readable; in-flight uploads complete after roll-forward.
   - Messaging: `DEGRADED` keeps SMS/push notifications waiting without contacting MSG91 or FCM
     and without spending their retry budget; after roll-forward each is sent once (one record
     per event, template, channel, and recipient). `UNCONFIGURED` records them `NOT_SENT` and
     never claims delivery. In-app notifications continue in both; booking state is untouched.
   - Online payment: both states refuse new intents with no provider call. `DEGRADED` keeps
     verifying signed webhooks, so intents created before the rollback still settle exactly once;
     `UNCONFIGURED` answers webhooks `503`, so the provider retries them (for up to 24 hours) and
     nothing is applied. Prefer `DEGRADED` while intents are in flight.
5. Never set `SANDBOX` in production as a "rollback"; it runs as `DEGRADED` and the readiness
   check blocks it.
6. Record the change in the incident log; roll forward by restoring the previous value once the
   provider recovers.

## Sign-off

| Role | Name | Date |
|---|---|---|
| Engineering lead | _to be assigned_ | |
| Operations lead | _to be assigned_ | |
| Legal / privacy | _to be assigned_ | |
