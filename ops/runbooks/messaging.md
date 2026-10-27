# Messaging (MSG91 SMS, FCM push)

Status: implemented in task 16.4 (SMS and push adapters, consent-aware Owner contact sharing,
booking, receipt, and refund templates, delivery telemetry, degraded-provider recovery). Tested
only against local fixtures with synthetic credentials; no request has reached MSG91, Google, or
FCM, and no DLT template is registered yet. `MESSAGING` must not run `LIVE` until its six
readiness checks in `ops/release/readiness.json` pass. Requirements 1.4, 3.4, 14.4, 14.6, 17.6.

## Provider choice

Both adapters sit behind the provider-independent `ModalNotificationChannelAdapter` and the
capability-gated dispatcher (`packages/providers/src/notification-channel.ts`); another provider
is a new adapter, not a domain change.

- **SMS: MSG91** (`msg91-sms-adapter.ts`), Flow API `POST /api/v5/flow`. Indian commercial SMS
  needs a DLT-registered sender and template; MSG91 binds both to its own template id, so a request
  carries only that id, the recipient, and the declared template variables, never free text.
  MSG91 has no test mode, so `SANDBOX` validates everything and resolves the number but never
  calls MSG91.
- **Push: Firebase Cloud Messaging HTTP v1** (`fcm-push-adapter.ts`). A service-account JWT
  (RS256) is exchanged for a short-lived OAuth token, cached until shortly before expiry. Each
  device (at most 5 per user, newest first) gets one `messages:send` with a collapse key derived
  from the notification id, so a resend replaces rather than duplicates. `SANDBOX` sends with
  `validate_only: true`, so FCM checks the request and delivers nothing.

Neither provider gives signed delivery receipts (MSG91 delivery reports are unsigned and are not
accepted), so `SENT` means the provider accepted the request, never that the handset received it.

## Configuration and secrets

| Variable | Where | Rule |
|---|---|---|
| `SMS_PROVIDER` | config | `none` (default) or `msg91` |
| `PUSH_PROVIDER` | config | `none` (default) or `fcm` |
| `MESSAGING_CAPABILITY_STATE` | config | `SANDBOX` is refused in production, `LIVE` in local and test; `DEGRADED`/`UNCONFIGURED` work anywhere |
| `MSG91_TEMPLATE_IDS` | config | JSON `{"notification.<name>@<version>:<locale>": "<MSG91 template id>"}`; required for `msg91`; per environment, never in code |
| `FCM_PROJECT_ID`, `FCM_SERVICE_ACCOUNT_EMAIL` | config | Required for `fcm` |
| `ENABLE_OWNER_CONTACT_SHARING` | config | `false` until Phase 2 launch of contact sharing |
| `MSG91_AUTH_KEY` | secret store | Read only when `SMS_PROVIDER=msg91` |
| `FCM_SERVICE_ACCOUNT_PRIVATE_KEY` | secret store | RSA PEM of the service account (`\n` escapes accepted); read only when `PUSH_PROVIDER=fcm` |

Startup refuses a configured provider with a missing or malformed secret, malformed template ids,
and a mode the environment does not allow. Phone numbers are decrypted, and push tokens encrypted
and hashed, with the same runtime keys the identity and catalog stores already use. The
`.env.*.example` files carry empty placeholders only.

## DLT registration

1. Register the sender (header) and each SMS template with a DLT operator under the platform's
   principal entity, using the English (and each regional) text from `packages/i18n/catalogs` with
   every variable as `{#var#}`.
2. In the MSG91 dashboard create one Flow template per DLT template, linking the DLT template id,
   and name its variables as in the template contract (`reference`, and `ownerPhone` for
   `notification.booking.ownerContact`).
3. Add `"<templateKey>@<version>:<locale>": "<MSG91 template id>"` to `MSG91_TEMPLATE_IDS`.
   Versions come from `notificationTemplates` in `apps/api/src/notification/notification-templates.ts`.
   Changing a template's text or variables bumps its version and needs a new registration before
   it can be sent.

An unregistered template, version, or locale is recorded `NOT_SENT` (`SMS_TEMPLATE_NOT_REGISTERED`)
and alerts; it is never sent with other content. Variables are limited to 30 safe characters.

## Flow

1. A domain transaction appends an outbox event (booking, bill, cash payment, and the payment
   outbox events `OnlinePaymentConfirmed`, `OnlinePaymentReceived`, `OnlinePaymentFailed`,
   `OnlinePaymentReleased`, `PaymentRefundRequested`, `PaymentRefundProcessed`,
   `PaymentRefundFailed`). Rules in `notification-rules.ts` map it to templates and audiences.
2. The notification outbox handler writes one record per event, template, channel, and recipient
   (the dedupe key), renders the template in the recipient's locale, and dispatches it. In-app
   delivery never depends on the capability.
3. The dispatcher checks `MESSAGING`, then the adapter resolves the number or push tokens at send
   time; contact data never enters the outbox, records, logs, or metrics. A recipient without a
   reachable number or device is `NOT_SENT` (`RECIPIENT_UNREACHABLE`, `NO_PUSH_DEVICE`). An FCM
   `UNREGISTERED` token is deleted.
4. Retryable failures back off and retry up to the attempt limit, then dead-letter.

**Push devices.** `PUT /account/push-devices` (`{token, platform: WEB|ANDROID|IOS}`) registers a
token while push can be sent; `DELETE /account/push-devices` (`{token}`) always works. Tokens are
stored AES-256-GCM encrypted, found by keyed hash, move to the account that registers them last,
and are deleted on account deletion. No web client registers tokens yet.

**Owner contact sharing.** Server-enforced by `canShareOwnerContact`
(`packages/domain/src/contact-sharing.ts`): sharing enabled, the Owner's
`contact_sharing_consent`, the viewer is the booking's Farmer, and the booking is in a coordinating
state (`ACCEPTED` through `REFUND_PENDING`). Then the Farmer can read
`GET /farmer/bookings/:bookingId/owner-contact` (`no-store`, audited without the number) and gets
one `notification.booking.ownerContact` SMS. Consent and state are re-checked before every retry;
a withdrawal records `NOT_SENT` (`CONTACT_SHARING_WITHDRAWN`). Other callers get a 404 as for a
missing booking. The number never appears in discovery or other public projections, logs, or
telemetry.

## Telemetry

- `kt_notification_deliveries_total{channel, provider, outcome, reason}`: every SMS, push, and
  in-app attempt by recorded state and a PII-free reason code. Dashboard:
  `ops/observability/dashboards/operational-indicators.json`.
- `kt_outbox_*` lag and dead-letter metrics (`ops/runbooks/alerts.md#outboxlaghigh`).
- Delivery logs carry notification ids, channel, provider, outcome, and codes only; never numbers,
  tokens, rendered text, or provider payloads.

### NotificationDeliveryFailing

More than 20% of SMS or push attempts fail at the provider for 15 minutes (degraded attempts are
excluded). Check the reason codes on the dashboard: `PROVIDER_REJECTED_REQUEST` usually means a
DLT scrub or a wrong template link, `PROVIDER_AUTH_FAILED` a rotated or revoked secret,
timeouts and 5xx a provider outage. For an outage set `MESSAGING_CAPABILITY_STATE=DEGRADED` (see
Rollback). Booking and payment state is unaffected.

### SmsTemplateNotRegistered

An SMS was not sent because its `templateKey@version:locale` has no entry in `MSG91_TEMPLATE_IDS`.
Register the template (DLT registration above) and add the id, then restart. Notifications already
recorded `NOT_SENT` are not resent; in-app copies were delivered.

## Rollback

Rollback is a configuration change and a restart (`ops/release/production-readiness.md`).

- `DEGRADED`: SMS and push wait as `FAILED` (`CAPABILITY_DEGRADED`) without contacting MSG91 or
  FCM, without contact lookups, and without spending their retry budget, so a long outage
  dead-letters nothing. After roll-forward each waiting notification is sent once.
- `UNCONFIGURED`: SMS and push are recorded `NOT_SENT` (`CHANNEL_UNCONFIGURED`) and never claim
  delivery; they are not resent later.
- In-app notifications continue in both states.

Rotating `MSG91_AUTH_KEY` or the FCM key needs the API and worker restarted together; the cached
FCM access token expires within an hour.

## Before LIVE

- All six readiness checks, including a staging run with real credentials: an MSG91 send per
  registered template and locale, an FCM send to a real web device, an `UNREGISTERED` token, a
  provider outage handled through `DEGRADED` and roll-forward, and secret rotation.
- DLT registration of the sender and every template version and locale in use, and the matching
  `MSG91_TEMPLATE_IDS` per environment.
- A web client that requests notification permission and registers its FCM token.
- Legal review of the Owner consent wording before `ENABLE_OWNER_CONTACT_SHARING=true`.
