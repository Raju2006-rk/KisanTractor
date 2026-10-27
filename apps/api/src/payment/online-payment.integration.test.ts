import "reflect-metadata";

import { createHmac, randomUUID } from "node:crypto";

import { validateEnvironment } from "@kisantractor/config";
import { createTelemetry } from "@kisantractor/observability";
import type { PaymentHttpRequest } from "@kisantractor/providers";
import { createTestDatabaseFactory, seedRepresentativeDataset, type TestDatabase } from "@kisantractor/test-utils";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../app.module.js";
import { ApiClient, DomainClock, ephemeralSecrets, listeningBaseUrl } from "../e2e/vertical-slice-harness.js";
import { CapturingNestLogger } from "../security/security-harness.js";
import { PgPoolAdapter } from "../sql-pool.js";
import { installApiTelemetry } from "../telemetry.js";

/**
 * Online payments over real HTTP against PostgreSQL/PostGIS (task 16.1): a SANDBOX Razorpay adapter
 * whose HTTP client is an in-process fake (no request leaves the machine), server-created intents,
 * idempotent retries, a non-authoritative checkout return, signed webhooks verified over the raw
 * body, amount/currency/reference checks, immutable provider events, and exactly-once settlement
 * under concurrent duplicate deliveries.
 *
 * Gated like the other database suites (see src/e2e/README.md):
 * ONLINE_PAYMENT_INTEGRATION_DATABASE_URL=postgresql://kisantractor:kisantractor@127.0.0.1:55432/kisantractor_online_payment_test
 *
 * Validates: Requirements 1.4, 11.3, 11.4, 11.5, 11.6, 12.3, 12.4, 14.1, 14.3
 */
const databaseUrl = process.env.ONLINE_PAYMENT_INTEGRATION_DATABASE_URL;
const describeDatabase = databaseUrl === undefined ? describe.skip : describe;

// Synthetic credentials for this suite only.
const KEY_ID = "rzp_test_Kt0Synthetic01";
const KEY_SECRET = "synthetic-key-secret-for-tests";
const WEBHOOK_SECRET = "synthetic-webhook-secret-for-tests";
const PHONES = { farmer: "9876543211", stranger: "9876543212", owner: "9848022340" } as const;
/** Contact details a real provider payload carries; they must never reach storage or logs. */
const PAYER_EMAIL = "payer.kisan@example.invalid";
const PAYER_CONTACT = "+919812345678";

type Json = Record<string, any>;

describeDatabase("online payments over HTTP and PostgreSQL", () => {
  const clock = new DomainClock();
  const telemetryLines: string[] = [];
  const nestLogger = new CapturingNestLogger();
  const providerRequests: PaymentHttpRequest[] = [];
  let orderSequence = 0;
  let database: TestDatabase;
  let pool: PgPoolAdapter;
  let app: INestApplication;
  let removeTelemetry: () => void;
  let baseUrl: string;
  let farmer: ApiClient;
  let stranger: ApiClient;
  let owner: ApiClient;
  const ids: Record<string, string> = {};

  const signIn = async (phone: string, purpose: "REGISTER_FARMER" | "REGISTER_OWNER") => {
    const client = new ApiClient(baseUrl, `kisan-online-payment-${phone}`);
    const challenge = await client.post("/identity/otp/challenges", { phone, purpose });
    expect(challenge.status, JSON.stringify(challenge.body)).toBe(201);
    const verified = await client.post("/identity/otp/verify", {
      challengeId: challenge.body.challengeId, phone, purpose, code: challenge.body.developmentCode,
    });
    expect(verified.status, JSON.stringify(verified.body)).toBe(200);
    return { client: client.withCredential(verified.body.accessCredential), userId: verified.body.principal.userId as string };
  };

  /** Fixed provider timestamp, so equal arguments always produce byte-identical (equal-digest) bodies. */
  const providerCreatedAt = Math.floor(clock.now().getTime() / 1_000);
  const capturedBody = (orderId: string, overrides: Json = {}, event = "payment.captured") => JSON.stringify({
    entity: "event", account_id: "acc_KtSynthAcct01", event, contains: ["payment"], created_at: providerCreatedAt,
    payload: { payment: { entity: {
      id: "pay_KtIntegPay0001", entity: "payment", amount: 120_000, currency: "INR", status: "captured", order_id: orderId,
      method: "upi", captured: true, email: PAYER_EMAIL, contact: PAYER_CONTACT, ...overrides,
    } } },
  });

  const deliver = async (body: string, eventId: string | null, options: { secret?: string; contentType?: string } = {}) => {
    const response = await fetch(`${baseUrl}/payments/webhooks/razorpay`, {
      method: "POST",
      headers: {
        "content-type": options.contentType ?? "application/json",
        "x-razorpay-signature": createHmac("sha256", options.secret ?? WEBHOOK_SECRET).update(body).digest("hex"),
        ...(eventId === null ? {} : { "x-razorpay-event-id": eventId }),
      },
      body,
    });
    const text = await response.text();
    return { status: response.status, body: text.length === 0 ? undefined : JSON.parse(text) as Json };
  };

  const ledger = async () => {
    const result = await pool.query<{ state: Json }>(`SELECT json_build_object(
      'payments', (SELECT json_agg(json_build_object('id', id, 'status', status, 'method', method, 'version', version,
         'provider', provider, 'reference', provider_reference, 'verified', verified_at IS NOT NULL) ORDER BY created_at, id)
         FROM public.payments WHERE invoice_id = $1),
      'paymentEvents', (SELECT json_agg(pe.event_type ORDER BY pe.occurred_at, pe.id) FROM public.payment_events pe
         JOIN public.payments p ON p.id = pe.payment_id WHERE p.invoice_id = $1),
      'providerEvents', (SELECT json_agg(json_build_object('eventId', provider_event_id, 'status', status,
         'eventType', event_type, 'signed', signature_verified) ORDER BY provider_event_id) FROM public.provider_events),
      'booking', (SELECT json_build_object('status', status, 'version', version) FROM public.bookings WHERE id = $2),
      'history', (SELECT json_agg(to_status ORDER BY occurred_at, id) FROM public.booking_status_history WHERE booking_id = $2)
    ) AS state`, [ids.invoice, ids.booking]);
    return result.rows[0]!.state;
  };

  beforeAll(async () => {
    pool = new PgPoolAdapter(new Pool({ connectionString: databaseUrl, max: 12 }));
    database = await createTestDatabaseFactory({ databaseUrl: databaseUrl!, createPool: async () => pool })();
    const telemetry = createTelemetry({ service: "api", logLevel: "debug", sink: (line) => telemetryLines.push(line) });
    app = await NestFactory.create(AppModule.register({
      config: validateEnvironment({
        APP_ENV: "test", NODE_ENV: "test", DATABASE_URL: databaseUrl, LOG_LEVEL: "error",
        OTP_CAPABILITY_STATE: "SANDBOX", ALLOW_LOCAL_OTP_CODES: "true",
        PAYMENT_CAPABILITY_STATE: "SANDBOX", PAYMENT_PROVIDER: "razorpay", RAZORPAY_KEY_ID: KEY_ID,
      }),
      sqlPool: pool,
      secrets: ephemeralSecrets(),
      telemetry,
      domainClock: clock.now,
      paymentProviderSecrets: { razorpayKeySecret: KEY_SECRET, razorpayWebhookSecret: WEBHOOK_SECRET },
      // In-process stand-in for the documented Orders API; nothing reaches Razorpay.
      paymentProviderHttp: async (request) => {
        providerRequests.push(request);
        const sent = JSON.parse(request.body) as { amount: number; currency: string; receipt: string; notes: Json };
        orderSequence += 1;
        return { status: 200, json: async () => ({
          id: `order_KtIntegOrder${String(orderSequence).padStart(4, "0")}`, entity: "order", amount: sent.amount,
          amount_paid: 0, amount_due: sent.amount, currency: sent.currency, receipt: sent.receipt, status: "created",
          attempts: 0, notes: sent.notes, created_at: Math.floor(Date.now() / 1_000),
        }) };
      },
    }), { logger: nestLogger, rawBody: true });
    removeTelemetry = installApiTelemetry(app, telemetry);
    await app.listen(0, "127.0.0.1");
    baseUrl = listeningBaseUrl(app);

    const signed = await Promise.all([
      signIn(PHONES.farmer, "REGISTER_FARMER"), signIn(PHONES.stranger, "REGISTER_FARMER"), signIn(PHONES.owner, "REGISTER_OWNER"),
    ]);
    [farmer, stranger, owner] = signed.map((entry) => entry.client) as [ApiClient, ApiClient, ApiClient];
    [ids.farmer, ids.stranger, ids.owner] = signed.map((entry) => entry.userId);

    // A Tractor, offering, and price from the representative dataset, then a billed, unpaid booking.
    const dataset = await seedRepresentativeDataset(pool, { ordinal: 41, customerId: ids.farmer, ownerId: ids.owner });
    ids.booking = randomUUID();
    ids.agreement = randomUUID();
    ids.invoice = randomUUID();
    const start = new Date(clock.now().getTime() + 3 * 86_400_000).toISOString();
    const end = new Date(clock.now().getTime() + 3 * 86_400_000 + 90 * 60_000).toISOString();
    await pool.query(
      `INSERT INTO public.bookings (id, public_reference, customer_id, owner_id, tractor_id, service_offering_id,
         requested_start_at, requested_end_at, expected_quantity, status)
       VALUES ($1, 'KT-OP000041', $2, $3, $4, $5, $6, $7, 1.500, 'FINAL_BILL_GENERATED')`,
      [ids.booking, ids.farmer, ids.owner, dataset.tractorId, dataset.serviceOfferingId, start, end],
    );
    await pool.query(
      `INSERT INTO public.booking_agreements (id, booking_id, agreement_version, pricing_rule_id, pricing_rule_version, method,
         rate_paise, rounding_policy, estimated_quantity, estimated_total_paise, service_location_snapshot, approved_by_customer_at, disclosed_at)
       VALUES ($1, $2, 1, $3, 1, 'HOURLY', 80000, 'PROPORTIONAL_MINUTE', 1.500, 120000,
         '{"state":"Telangana","district":"Warangal","mandalOrTaluk":"Hanamkonda","village":"Kazipet","source":"MANUAL_ADDRESS"}'::jsonb,
         CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [ids.agreement, ids.booking, dataset.pricingRuleId],
    );
    await pool.query("UPDATE public.bookings SET current_agreement_id = $2 WHERE id = $1", [ids.booking, ids.agreement]);
    await pool.query(
      `INSERT INTO public.invoices (id, booking_id, agreement_id, invoice_version, status, rate_paise, billable_quantity,
         subtotal_paise, adjustments_paise, total_paise, evidence_references, calculation_formula, rounding_trace)
       VALUES ($1, $2, $3, 1, 'ISSUED', 80000, 1.500, 120000, 0, 120000, '[]'::jsonb, '90 min x ₹800.00/h = ₹1,200.00',
         '{"rawSubtotalNumerator":"120000","rawSubtotalDenominator":"1","minorUnitRounding":"HALF_UP"}'::jsonb)`,
      [ids.invoice, ids.booking, ids.agreement],
    );
  }, 120_000);

  afterAll(async () => {
    removeTelemetry?.();
    await app?.close();
    await database?.dispose();
  });

  const intentPath = () => `/farmer/bookings/${ids.booking}/payments/online`;
  const intentBody = (idempotencyKey: string, amountPaise = 120_000) => ({ invoiceId: ids.invoice, amountPaise, idempotencyKey });

  it("labels online payment as a sandbox test service in both parties' settlement views", async () => {
    for (const [client, role] of [[farmer, "farmer"], [owner, "owner"]] as const) {
      const view = await client.get(`/${role}/bookings/${ids.booking}/payments`);
      expect(view.status, JSON.stringify(view.body)).toBe(200);
      expect(view.body.onlinePayment).toEqual({
        state: "SANDBOX", statusLabel: "Test service (sandbox)", available: true, testMode: true, canRetry: false,
      });
      expect(view.body.settlement).toMatchObject({ status: "PAYMENT_DUE", outstandingPaise: 120_000 });
    }
  });

  it("creates one server-side intent, replays it on retry, and refuses strangers and overpayment before the provider", async () => {
    const denied = await stranger.post(intentPath(), intentBody("stranger-key-0001"));
    expect(denied.status).toBe(404);
    expect(providerRequests).toHaveLength(0);

    const created = await farmer.post(intentPath(), intentBody("online-key-0001"));
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.payment).toMatchObject({ method: "ONLINE", status: "PENDING", amountPaise: 120_000 });
    expect(created.body.payment.paidAt).toBeUndefined();
    expect(created.body.checkout).toEqual({
      provider: "razorpay", mode: "SANDBOX", testMode: true, statusLabel: "Test payment (sandbox): no real money moves",
      publicKey: KEY_ID, providerReference: "order_KtIntegOrder0001", amountPaise: 120_000, currency: "INR",
    });
    expect(created.body.settlement.settlement).toMatchObject({ status: "PENDING", pendingPaise: 120_000, settled: false });
    expect(JSON.stringify(created.body)).not.toContain(KEY_SECRET);
    ids.payment = created.body.payment.id;
    expect(providerRequests).toHaveLength(1);
    expect(JSON.parse(providerRequests[0]!.body)).toMatchObject({ amount: 120_000, currency: "INR", notes: { booking_id: ids.booking, invoice_id: ids.invoice } });

    const retried = await farmer.post(intentPath(), intentBody("online-key-0001"));
    expect(retried.status).toBe(201);
    expect(retried.body.payment.id).toBe(ids.payment);
    expect(retried.body.checkout.providerReference).toBe("order_KtIntegOrder0001");
    const reused = await farmer.post(intentPath(), intentBody("online-key-0001", 100_000));
    expect(reused.status).toBe(409);
    expect(reused.body.code).toBe("IDEMPOTENCY_KEY_REUSED");
    // The pending intent reserves the whole bill, so a second intent is refused before the provider.
    const second = await farmer.post(intentPath(), intentBody("online-key-0002", 100));
    expect(second.status).toBe(409);
    expect(second.body.code).toBe("PAYMENT_OVERPAYMENT");
    expect(providerRequests).toHaveLength(1);

    expect((await ledger()).payments).toEqual([expect.objectContaining({
      id: ids.payment, status: "PENDING", method: "ONLINE", provider: "razorpay", reference: "order_KtIntegOrder0001", verified: false,
    })]);
  });

  it("treats a browser return claiming success as pending until the provider confirms", async () => {
    const returned = await farmer.post(`/farmer/payments/${ids.payment}/checkout-return`, {
      razorpay_payment_id: "pay_KtIntegPay0001", razorpay_order_id: "order_KtIntegOrder0001", razorpay_signature: "a".repeat(64), status: "SUCCESS",
    });
    expect(returned.status, JSON.stringify(returned.body)).toBe(200);
    expect(returned.body).toMatchObject({ confirmation: "AWAITING_PROVIDER_CONFIRMATION", testMode: true, payment: { status: "PENDING" } });
    expect(await stranger.post(`/farmer/payments/${ids.payment}/checkout-return`, {})).toMatchObject({ status: 404 });
    expect(await ledger()).toMatchObject({ booking: { status: "FINAL_BILL_GENERATED" }, payments: [{ status: "PENDING" }] });
  });

  it("refuses unsigned, mis-signed, unknown-provider, and non-JSON webhooks without recording or applying anything", async () => {
    const before = await ledger();
    const body = capturedBody("order_KtIntegOrder0001");
    const unsigned = await fetch(`${baseUrl}/payments/webhooks/razorpay`, {
      method: "POST", headers: { "content-type": "application/json", "x-razorpay-event-id": "KtIntegEvent0000" }, body,
    });
    expect(unsigned.status).toBe(401);
    expect(await deliver(body, "KtIntegEvent0000", { secret: "an-attacker-chosen-secret" }))
      .toMatchObject({ status: 401, body: { code: "SIGNATURE_INVALID" } });
    // Without the exact JSON bytes there is nothing trustworthy to verify.
    expect(await deliver(body, "KtIntegEvent0000", { contentType: "text/plain" })).toMatchObject({ status: 400 });
    const otherProvider = await fetch(`${baseUrl}/payments/webhooks/stripe`, { method: "POST", headers: { "content-type": "application/json" }, body });
    expect(otherProvider.status).toBe(404);

    const after = await ledger();
    expect(before.providerEvents).toBeNull();
    expect(after).toEqual(before);
  });

  it("applies a verified capture exactly once under concurrent deliveries and completes the booking", async () => {
    // At-least-once delivery: the provider may send the same event several times at once.
    const body = capturedBody("order_KtIntegOrder0001");
    clock.advanceMinutes(3);
    const deliveries = await Promise.all(Array.from({ length: 6 }, () => deliver(body, "KtIntegEvent0000")));
    expect(deliveries.map((response) => response.status), JSON.stringify(deliveries.map((response) => response.body)))
      .toEqual([200, 200, 200, 200, 200, 200]);
    expect(deliveries.map((response) => response.body?.outcome).sort())
      .toEqual(["ACCEPTED", "DUPLICATE", "DUPLICATE", "DUPLICATE", "DUPLICATE", "DUPLICATE"]);
    const state = await ledger();
    expect(state.providerEvents).toEqual([{ eventId: "KtIntegEvent0000", status: "APPLIED", eventType: "payment.captured", signed: true }]);
    expect(state.payments).toEqual([expect.objectContaining({ id: ids.payment, status: "PAID_ONLINE", verified: true, version: 2 })]);
    expect(state.paymentEvents).toEqual(["ONLINE_PAYMENT_INITIATED", "ONLINE_PAYMENT_CONFIRMED"]);
    expect(state.booking).toMatchObject({ status: "COMPLETED" });
    // Both system transitions commit with the capture in one transaction (same timestamp), once each.
    expect([...state.history].sort()).toEqual(["COMPLETED", "PAYMENT_RECORDED"]);
    const outbox = await pool.query<{ event_type: string }>(
      "SELECT event_type FROM public.outbox_events WHERE aggregate_id = $1 ORDER BY created_at, id", [ids.payment]);
    expect(outbox.rows.map((row) => row.event_type)).toEqual(["OnlinePaymentInitiated", "OnlinePaymentConfirmed"]);
  });

  it("gives repeated deliveries, replays under new ids, and late confirmations no further effect", async () => {
    const body = capturedBody("order_KtIntegOrder0001");
    expect(await deliver(body, "KtIntegEvent0000")).toMatchObject({ status: 200, body: { outcome: "DUPLICATE" } });
    // The event id header is not signed: the same signed body under a new id is still a duplicate.
    expect(await deliver(body, "KtIntegEvent9999")).toMatchObject({ status: 200, body: { outcome: "DUPLICATE" } });
    expect(await deliver(body, null)).toMatchObject({ status: 200, body: { outcome: "DUPLICATE" } });

    // order.paid confirms the same money again; it is recorded but changes nothing.
    const orderPaid = JSON.stringify({
      entity: "event", event: "order.paid", contains: ["payment", "order"], created_at: providerCreatedAt + 1,
      payload: {
        payment: { entity: { id: "pay_KtIntegPay0001", entity: "payment", amount: 120_000, currency: "INR", status: "captured", order_id: "order_KtIntegOrder0001" } },
        order: { entity: { id: "order_KtIntegOrder0001", entity: "order", amount: 120_000, amount_paid: 120_000, status: "paid" } },
      },
    });
    expect(await deliver(orderPaid, "KtIntegEvent0001")).toMatchObject({ status: 200, body: { outcome: "ACCEPTED" } });

    const state = await ledger();
    expect(state.providerEvents.map((event: Json) => [event.eventId, event.status])).toEqual([
      ["KtIntegEvent0000", "APPLIED"], ["KtIntegEvent0001", "VERIFIED"],
    ]);
    expect(state.paymentEvents).toEqual(["ONLINE_PAYMENT_INITIATED", "ONLINE_PAYMENT_CONFIRMED"]);
    expect(state.history.filter((status: string) => status === "COMPLETED")).toHaveLength(1);
    expect(state.payments).toEqual([expect.objectContaining({ status: "PAID_ONLINE", version: 2 })]);
  });

  it("records verified events whose amount, currency, or reference do not match as rejected, with no effect", async () => {
    const before = await ledger();
    const mismatches: ReadonlyArray<readonly [string, Json, string]> = [
      ["KtIntegEvent0002", { amount: 1_200 }, "AMOUNT_MISMATCH"],
      ["KtIntegEvent0003", { currency: "USD" }, "CURRENCY_MISMATCH"],
      ["KtIntegEvent0004", { order_id: "order_KtUnknownOrd1" }, "REFERENCE_MISMATCH"],
    ];
    for (const [eventId, overrides, code] of mismatches) {
      const response = await deliver(capturedBody(overrides.order_id ?? "order_KtIntegOrder0001", overrides), eventId);
      expect(response, code).toMatchObject({ status: 200, body: { outcome: "REJECTED_PAYLOAD" } });
    }
    const failedAttempt = await deliver(capturedBody("order_KtIntegOrder0001", { status: "failed", captured: false }, "payment.failed"), "KtIntegEvent0005");
    expect(failedAttempt).toMatchObject({ status: 200, body: { outcome: "ACCEPTED" } });

    const after = await ledger();
    expect(after.payments).toEqual(before.payments);
    expect(after.paymentEvents).toEqual(before.paymentEvents);
    expect(after.booking).toEqual(before.booking);
    expect(after.providerEvents.slice(-4).map((event: Json) => event.status)).toEqual(["REJECTED", "REJECTED", "REJECTED", "VERIFIED"]);
    const audits = await pool.query<{ reason_code: string; outcome: string; actor_channel: string }>(
      `SELECT reason_code, outcome, actor_channel FROM public.audit_events WHERE action = 'PROVIDER_PAYMENT_EVENT_REJECTED' ORDER BY reason_code`);
    expect(audits.rows).toEqual([
      { reason_code: "AMOUNT_MISMATCH", outcome: "REJECTED", actor_channel: "PROVIDER" },
      { reason_code: "CURRENCY_MISMATCH", outcome: "REJECTED", actor_channel: "PROVIDER" },
      { reason_code: "REFERENCE_MISMATCH", outcome: "REJECTED", actor_channel: "PROVIDER" },
    ]);
  });

  it("shows the same provider-confirmed state, test-labelled, to both parties and on the checkout return", async () => {
    const returned = await farmer.post(`/farmer/payments/${ids.payment}/checkout-return`, {});
    expect(returned.body).toMatchObject({ confirmation: "CONFIRMED", payment: { status: "PAID_ONLINE", confirmedBy: "PAYMENT_PROVIDER" } });
    const views = await Promise.all([farmer.get(`/farmer/bookings/${ids.booking}/payments`), owner.get(`/owner/bookings/${ids.booking}/payments`)]);
    for (const view of views) {
      expect(view.body).toMatchObject({ bookingStatus: "COMPLETED", settlement: { status: "PAID_ONLINE", settled: true, appliedPaise: 120_000 } });
    }
    expect(views[0]!.body.payments).toEqual(views[1]!.body.payments);
    const receipt = await farmer.get(`/farmer/payments/${ids.payment}/receipt`);
    expect(receipt.status, JSON.stringify(receipt.body)).toBe(200);
    expect(receipt.body).toMatchObject({ method: "ONLINE", status: "PAID_ONLINE", confirmedBy: "PAYMENT_PROVIDER", testMode: true, amountPaise: 120_000 });
  });

  it("keeps provider events immutable and provider contact details out of storage and logs", async () => {
    expect(Number((await pool.query<{ count: string }>("SELECT count(*) AS count FROM public.provider_events")).rows[0]!.count)).toBe(6);
    await expect(pool.query("UPDATE public.provider_events SET status = 'APPLIED'")).rejects.toThrow(/append-only/u);
    await expect(pool.query("DELETE FROM public.provider_events")).rejects.toThrow(/append-only/u);
    const stored = await pool.query<{ dump: string }>(`SELECT concat_ws('|',
      (SELECT json_agg(p)::text FROM public.provider_events p), (SELECT json_agg(a)::text FROM public.audit_events a),
      (SELECT json_agg(o)::text FROM public.outbox_events o), (SELECT json_agg(e)::text FROM public.payment_events e)) AS dump`);
    const logs = [...telemetryLines, ...nestLogger.lines].join("\n");
    for (const text of [stored.rows[0]!.dump, logs]) {
      expect(text).not.toContain(PAYER_EMAIL);
      expect(text).not.toContain(PAYER_CONTACT.slice(3));
      expect(text).not.toContain(KEY_SECRET);
      expect(text).not.toContain(WEBHOOK_SECRET);
    }
    expect(logs).toContain("payment.webhook.rejected");
    expect(logs).toContain("provider.callback.handled");
  });
});
