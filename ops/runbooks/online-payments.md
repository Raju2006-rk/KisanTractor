# Online payments (Razorpay)

Status: implemented in tasks 16.1 (intents, signed webhooks) and 16.2 (checkout, receipts,
refunds, pending-intent recovery, reconciliation, payment history). Tested only with synthetic
credentials, locally signed fixtures, and an in-process fake of the Razorpay APIs; no request has
reached Razorpay. `ONLINE_PAYMENT` must not run `LIVE` until its six readiness checks in
`ops/release/readiness.json` pass. Requirements 1.4, 11.1, 11.3-11.8, 12.4, 14.1, 14.3, 14.5, 18.7.

## Provider choice

Razorpay, behind the provider-independent `OnlinePaymentProviderAdapter` and
`OnlinePaymentRecoveryAdapter` (`packages/providers/src/online-payment.ts`, adapter in
`razorpay-payment-adapter.ts`):

- Indian gateway covering UPI, cards, net banking, and wallets in INR.
- Server-side [Orders API](https://razorpay.com/docs/api/orders/create/) with integer-paise amounts, so
  the server creates every intent and the browser only receives an order id.
- [Webhooks](https://razorpay.com/docs/webhooks/validate-test/) signed with HMAC-SHA256 over the
  raw body (`X-Razorpay-Signature`) and a unique `X-Razorpay-Event-Id` for deduplication.
- Status reads: `GET /v1/orders/:id` and `GET /v1/orders/:id/payments`
  ([fetch payments for an order](https://razorpay.com/docs/api/payments/fetch-payments-orders/)).
- [Normal refunds](https://razorpay.com/docs/api/refunds/create-normal/) with the
  `X-Refund-Idempotency` header, so a retried request with the same key never refunds twice;
  `GET /v1/payments/:id/refunds[/:refund_id]` to read them back.
- Separate test (`rzp_test_`) and live (`rzp_live_`) keys, so the mode is checked from the key.

Settlement rules do not depend on Razorpay: `evaluateProviderPaymentEvent`,
`evaluateProviderRefundEvent`, `planPendingIntentRecovery`, `planRefundReconciliation`, and the
payment transition table in `packages/domain` decide every financial effect. Another gateway is a
new adapter, not a domain change.

## Configuration

| Variable | Where | Rule |
|---|---|---|
| `PAYMENT_PROVIDER` | config | `none` (default) or `razorpay` |
| `RAZORPAY_KEY_ID` | config | Publishable key id; required for `razorpay` |
| `PAYMENT_CAPABILITY_STATE` | config | `SANDBOX` needs a test key, `LIVE` a live key; `DEGRADED`/`UNCONFIGURED` work with either |
| `RAZORPAY_KEY_SECRET` | secret store | API key secret; never sent to clients. Needed by the API and the worker |
| `RAZORPAY_WEBHOOK_SECRET` | secret store | The webhook's own secret (at least 16 characters), not the key secret |

Startup refuses a test key in production, a live key in local or test, a state that does not
match the key, and a configured provider with a missing secret. The `.env.*.example` files carry
empty placeholders only.

In the Razorpay Dashboard (test mode for staging):

- Add a webhook for `https://<api-origin>/payments/webhooks/razorpay` with the events
  `payment.captured`, `order.paid`, `payment.failed`, `refund.created`, `refund.processed`, and
  `refund.failed`, using `RAZORPAY_WEBHOOK_SECRET` as its secret.
- Turn on automatic capture. Recovery waits on an `authorized` payment and never releases its
  intent; with manual capture, authorized payments would hold bills until Razorpay voids them.

## Payment flow

1. On the booking page the Farmer presses **Pay ₹X online** (offered only while the capability is
   `SANDBOX` or `LIVE`, the bill is current and undisputed, at least ₹1 remains, and no online
   payment is already pending). The web route calls
   `POST /farmer/bookings/:bookingId/payments/online` with a stable idempotency key. The server
   checks the ledger read-only first, creates a Razorpay order, and records a `PENDING` payment
   with the provider mode (`SANDBOX` or `LIVE`) stored on it. Retrying with the same key returns the
   same order without calling Razorpay again.
2. The browser goes to the checkout launcher `/farmer/pay/:paymentId`. It reads
   `GET /farmer/payments/:paymentId/checkout` (the order id, publishable key, amount, and a
   deadline 15 minutes after the intent was created) and only then loads
   `https://checkout.razorpay.com/v1/checkout.js`. No other page loads a provider script.
3. When the checkout closes, the launcher posts only "returned" or "dismissed" to
   `POST /farmer/payments/:paymentId/checkout-return`. The payment id and signature the checkout
   reports are never sent anywhere; the payment stays `PENDING` until verified provider evidence.
4. `POST /payments/webhooks/razorpay` verifies the signature over the exact request bytes in
   constant time before parsing anything. One serializable transaction then deduplicates by
   `(provider, event id)` or body digest, finds the payment by `(provider, order id)`, checks
   reference, currency, and amount, appends an immutable `provider_events` row, and applies the
   effect: `PENDING` to `PAID_ONLINE` with the captured `pay_` id stored, the booking moving to
   `PAYMENT_RECORDED` and then `COMPLETED` when the bill is settled, an audit record, and outbox events.
5. The receipt (`GET /{farmer|owner}/payments/:paymentId/receipt`) exists only for money that
   counts toward a fully paid bill, so an online receipt appears only after provider confirmation.
   Receipts and records of sandbox money carry `testMode: true` from the mode stored on the payment.

| Event | Effect |
|---|---|
| `payment.captured`, `order.paid` | Confirms the money once. A second, different capture on one order is `REJECTED` (`PAYMENT_LEDGER_INCONSISTENT`) |
| `payment.failed` | Recorded only; the order stays payable |
| `refund.processed` | Finishes a refund the platform requested: payment `REFUNDED` |
| `refund.failed` | The refund failed: payment back to `PAID_ONLINE`, money still applied |
| `refund.created` | Recorded; links the provider refund id to the request |
| A refund the platform never requested | `REJECTED` (`PAYMENT_LEDGER_INCONSISTENT`) and pages |
| Anything else | Recorded only |

| Response | Meaning |
|---|---|
| 200 `ACCEPTED` | Recorded, and applied when the domain allows |
| 200 `DUPLICATE` | Already seen by event id or body digest; nothing changed |
| 200 `REJECTED_PAYLOAD` | Signed, but contradicts the platform; stored `REJECTED` with an audit record and an alert |
| 400 | Raw body unavailable, or a signed body that is not a well-formed event |
| 401 | Signature missing or invalid |
| 404 | Unknown provider path |
| 503 | `ONLINE_PAYMENT` is `UNCONFIGURED`; Razorpay retries |

## Provider API reads are evidence too

Status reads go server to server with the key secret over HTTPS, so their answers are verified
provider evidence, just as a signed webhook is. They are recorded through the same
`recordProviderEvent` path with `evidence_source = 'PROVIDER_API'` and a deterministic event id
(`api:payment.captured:<pay_id>`, `api:refund.processed:<rfnd_id>`, ...). A webhook and an API read
of the same fact therefore apply once: whichever lands second finds the payment already moved.

## Pending intents and recovery

A pending intent reserves its amount on the bill, which also blocks cash for that amount. It ends
in one of these ways:

- **Confirmed**: a webhook, the Farmer's **Check payment status** (`POST .../status-check`), or
  reconciliation sees a capture.
- **Cancelled by the Farmer** (`POST .../cancel`, for example to pay in cash): the server asks
  Razorpay first. A capture confirms the payment instead; an `authorized` or `created` attempt
  refuses the cancel (`PAYMENT_IN_PROGRESS`); otherwise the intent moves to `PAYMENT_FAILED`
  (`ONLINE_PAYMENT_FAILED` payment event, `ONLINE_PAYMENT_RELEASED` audit, `OnlinePaymentReleased`
  outbox) and the reservation ends.
- **Expired by reconciliation**: an intent older than 45 minutes (three times the 15-minute
  checkout window) whose order shows no successful or in-flight attempt is released the same way.
  An attempt stuck in `created` is given up on after 24 hours.

The provider read that justified a release is kept as an `api.intent.unpaid` provider event.

**Late captures.** Razorpay can still capture an order after the platform released it (for
example a slow UPI approval). The capture is applied late (`ONLINE_PAYMENT_LATE_CONFIRMED`) only if
the bill is current, payable, undisputed, and still has room for the whole amount. Otherwise it is
stored `REJECTED` with `PAYMENT_LEDGER_INCONSISTENT` and pages: refund it from the Razorpay
Dashboard and note the provider event id in the incident.

## Refunds

- **Who**: support only, per the payment transition table. The caller needs the
  `FUTURE_OPERATOR` role and an explicit grant from the server-side `SupportAccessPolicy` for the
  payment's booking. The default policy denies everyone, so no refund can be requested until
  support access is configured (task 16.5). Farmers and Owners cannot request refunds.
- **What**: a full refund of one confirmed online payment (`PAID_ONLINE`) on a booking that is
  `DISPUTED` or already `REFUND_PENDING`. The amount is the payment amount; a different amount is
  refused (`PAYMENT_REFUND_EXCEEDS_PAYMENT`, `PAYMENT_PARTIAL_REFUND_UNSUPPORTED`). At most one
  refund per payment can be in flight or processed (a unique index enforces it). Partial refunds
  and cash refunds are not implemented.
- **API**: `POST /support/payments/:paymentId/refunds` with `reasonCode` (`DISPUTE_RESOLVED`,
  `DUPLICATE_PAYMENT`, `SERVICE_NOT_DELIVERED`, `OTHER`) and an idempotency key. Reasons are codes,
  never free text. One transaction records the `payment_refunds` row, the payment's move to
  `REFUND_PENDING`, the booking's move from `DISPUTED` to `REFUND_PENDING`, audit, and outbox.
- **Submission**: right after the commit the server calls Razorpay with
  `X-Refund-Idempotency = receipt = ktrf<refund id>`. An unknown outcome leaves the refund
  `REQUESTED` with `last_error_code`; reconciliation resubmits it with the same key. A definite
  refusal counts as a failed refund only if Razorpay lists no refund under that key.
- **Finish**: only verified evidence (`refund.processed`/`refund.failed` webhook or a refund read)
  moves the payment to `REFUNDED` or back to `PAID_ONLINE`. The booking becomes `REFUNDED` when no
  applied money and no refund in progress remains on its current bill; a failed refund leaves it
  `REFUND_PENDING` for support.

## Reconciliation job

`PaymentReconciliationJob` runs inside the worker process (`node dist/outbox-worker.js`) whenever
a provider handle exists (`SANDBOX`, `LIVE`, or `DEGRADED` with in-flight intents), every
5 minutes, 25 intents and 25 refunds per pass, least recently checked first:

1. Pending intents older than the checkout window: read the order and its payments, then confirm,
   release, wait, or flag a mismatch as described above.
2. Refunds `REQUESTED` (submit or resubmit with the same key) or `SUBMITTED` (read the refund and
   finish it when Razorpay reports a final state).

Every effect is state-gated, so several workers or a repeated pass cannot double-apply. Nothing is
released or refunded without a successful provider read. Mismatches (a second capture, a refund
nobody requested, a paid order without a capture, a submitted refund the provider no longer lists)
change nothing, count as `RECONCILIATION_MISMATCH`, and page.

## Payment history

`GET /farmer/payments` and `GET /owner/payments` list every payment on the caller's own bookings
(the booking Farmer's, or the assigned Owner's), newest first, 20 per page by default and at most
50, with a keyset cursor. Items carry the party-safe payment projection, the booking reference, the
test label, and whether a receipt is available; never provider references or payloads. The web
app shows them at `/farmer/payments` and `/owner/payments`.

## Content security policy

The app has no global CSP. The checkout launcher is a route handler with its own policy:
`default-src 'none'`, `script-src 'self' https://checkout.razorpay.com`, `frame-src
https://api.razorpay.com https://checkout.razorpay.com`, `connect-src 'self' https://api.razorpay.com
https://lumberjack.razorpay.com`, `img-src 'self' data: https://*.razorpay.com`, inline styles
(Razorpay styles its overlay), `form-action 'self'`, `frame-ancestors 'none'`, and no inline
script. These hosts are from Razorpay's integration pattern and have not been confirmed against a
real checkout; the sandbox run must check the browser console for CSP violations.

## Telemetry

- `kt_payment_verification_failures_total{method="ONLINE"}`: `SIGNATURE_INVALID`,
  `PAYMENT_EVIDENCE_REQUIRED`, `AMOUNT_MISMATCH`, `CURRENCY_MISMATCH`, `REFERENCE_MISMATCH`,
  `PAYMENT_LEDGER_INCONSISTENT`, `RECONCILIATION_MISMATCH`, `REPLAYED_EVENT`, refund refusals, and
  intent refusals such as `PAYMENT_OVERPAYMENT`. The integrity reasons page through
  `PaymentIntegrityFailure` (`alerts.md`).
- `kt_payment_recovery_total{subject, outcome}`: `INTENT`/`REFUND` by `CONFIRMED`, `RELEASED`,
  `STILL_PENDING`, `SUBMITTED`, `REFUNDED`, `REFUND_FAILED`, `MISMATCH`, `PROVIDER_ERROR`.
  `PaymentRefundFailed` and `PaymentReconciliationErrors` alert on it.
- `kt_provider_callbacks_total{capability="ONLINE_PAYMENT"}` by outcome.
- `payment.webhook.rejected` logs carry the provider, reason code, and body digest only;
  `payment.reconciliation.*` logs carry payment or refund ids, outcomes, and codes only.

The payer's email, phone, and card details in Razorpay payloads and API responses are dropped by
the adapter and never stored or logged.

## Rollback and secret rotation

Rollback is a configuration change (`ops/release/production-readiness.md`). Prefer `DEGRADED`
while intents are in flight: new intents, checkouts, and refund submissions are refused, while
signed webhooks, status checks, cancels, and reconciliation still resolve intents and refunds
created before the rollback. `UNCONFIGURED` answers webhooks `503` and stops reconciliation;
pending intents then keep their reservation and requested refunds wait until the capability
returns. Razorpay retries a failing webhook for 24 hours and then disables it; re-enable it in the
Dashboard after rolling forward. Reconciliation recovers missed captures and refund outcomes from
the API, so replaying events is optional.

Razorpay signs retries of older events with the secret that was current when they were sent,
and the adapter accepts one secret. Rotate `RAZORPAY_WEBHOOK_SECRET` only while no deliveries
are failing. Rotating `RAZORPAY_KEY_SECRET` needs the API and worker restarted together.

## Before LIVE

- All six readiness checks, including an end-to-end run against Razorpay's sandbox with real
  test-mode credentials in staging: checkout in a real browser (watch for CSP violations), capture,
  a missed webhook recovered by reconciliation, cancel, release and late capture, a refund
  processed and a refund failed, and idempotent refund retries.
- Confirm how Razorpay treats a repeated order receipt (a retry whose first order was created but
  never recorded reuses the receipt) and how long it keeps refund idempotency keys.
- Configure the support access policy and the support workflow that calls the refund API
  (task 16.5). Until then refunds cannot be requested.
