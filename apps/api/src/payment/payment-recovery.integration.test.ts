import "reflect-metadata";

import { createHmac, randomUUID } from "node:crypto";

import { validateEnvironment } from "@kisantractor/config";
import { createTelemetry } from "@kisantractor/observability";
import type { PaymentHttpRequest, PaymentHttpResponse } from "@kisantractor/providers";
import { createTestDatabaseFactory, seedRepresentativeDataset, type TestDatabase } from "@kisantractor/test-utils";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../app.module.js";
import type { SupportAccessPolicy } from "../authorization/index.js";
import { ApiClient, DomainClock, ephemeralSecrets, listeningBaseUrl } from "../e2e/vertical-slice-harness.js";
import { CapturingNestLogger } from "../security/security-harness.js";
import { PgPoolAdapter } from "../sql-pool.js";
import { installApiTelemetry } from "../telemetry.js";
import { PaymentReconciliationJob, PaymentRecoveryService } from "./index.js";

/**
 * Online receipts, refunds, pending-intent recovery, reconciliation, and payment history over real
 * HTTP against PostgreSQL/PostGIS (task 16.2). The SANDBOX Razorpay adapter talks to an in-process
 * fake of the documented Orders, Payments, and Refunds APIs, so no request leaves the machine.
 *
 * Gated like the other database suites (see src/e2e/README.md):
 * PAYMENT_RECOVERY_INTEGRATION_DATABASE_URL=postgresql://kisantractor:kisantractor@127.0.0.1:55432/kisantractor_payment_recovery_test
 *
 * Validates: Requirements 11.1, 11.4, 11.5, 11.6, 11.7, 11.8, 12.2, 12.4, 14.3, 18.3
 */
const databaseUrl = process.env.PAYMENT_RECOVERY_INTEGRATION_DATABASE_URL;
const describeDatabase = databaseUrl === undefined ? describe.skip : describe;

// Synthetic credentials for this suite only.
const KEY_ID = "rzp_test_Kt0Synthetic02";
const KEY_SECRET = "synthetic-key-secret-for-tests";
const WEBHOOK_SECRET = "synthetic-webhook-secret-for-tests";
const PHONES = { farmer: "9876543221", stranger: "9876543222", owner: "9848022350", operator: "9876543223" } as const;
const PAYER_EMAIL = "payer.recovery@example.invalid";
const PAYER_CONTACT = "+919812345679";

type Json = Record<string, any>;

interface FakePayment { id: string; status: "created" | "authorized" | "captured" | "refunded" | "failed"; captured: boolean; amount: number }
interface FakeOrder { id: string; amount: number; receipt: string; status: "created" | "attempted" | "paid"; payments: FakePayment[] }
interface FakeRefund { id: string; payment_id: string; amount: number; status: "pending" | "processed" | "failed"; receipt: string }

/** In-process stand-in for the documented Razorpay Orders, Payments, and Refunds APIs. */
class FakeRazorpay {
  readonly orders = new Map<string, FakeOrder>();
  readonly refunds = new Map<string, FakeRefund>();
  readonly refundsByKey = new Map<string, string>();
  readonly requests: PaymentHttpRequest[] = [];
  refundMode: "ok" | "unavailable" | "reject" = "ok";
  #sequence = 0;

  readonly http = async (request: PaymentHttpRequest): Promise<PaymentHttpResponse> => {
    this.requests.push(request);
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    const json = (status: number, body: unknown): PaymentHttpResponse => ({ status, json: async () => body });
    if (request.method === "POST" && url.pathname === "/v1/orders") {
      const sent = JSON.parse(request.body) as { amount: number; receipt: string };
      const order: FakeOrder = { id: `order_KtRecOrd${this.#next()}`, amount: sent.amount, receipt: sent.receipt, status: "created", payments: [] };
      this.orders.set(order.id, order);
      return json(200, this.#order(order));
    }
    if (parts[1] === "orders" && request.method === "GET") {
      const order = this.orders.get(parts[2]!);
      if (order === undefined) return json(404, { error: { code: "BAD_REQUEST_ERROR" } });
      if (parts[3] === "payments") {
        return json(200, { entity: "collection", count: order.payments.length, items: order.payments.map((payment) => this.#payment(order, payment)) });
      }
      return json(200, this.#order(order));
    }
    if (parts[1] === "payments" && parts[3] === "refund" && request.method === "POST") {
      const key = request.headers["x-refund-idempotency"]!;
      const known = this.refundsByKey.get(key);
      if (known !== undefined) return json(200, this.#refund(this.refunds.get(known)!));
      if (this.refundMode === "unavailable") return json(503, { error: { code: "SERVER_ERROR" } });
      if (this.refundMode === "reject") return json(400, { error: { code: "BAD_REQUEST_ERROR", description: "The payment has been fully refunded already" } });
      const sent = JSON.parse(request.body) as { amount: number; receipt: string };
      const refund: FakeRefund = { id: `rfnd_KtRecRfd${this.#next()}`, payment_id: parts[2]!, amount: sent.amount, status: "pending", receipt: sent.receipt };
      this.refunds.set(refund.id, refund);
      this.refundsByKey.set(key, refund.id);
      return json(200, this.#refund(refund));
    }
    if (parts[1] === "payments" && parts[3] === "refunds" && request.method === "GET") {
      if (parts[4] !== undefined) {
        const refund = this.refunds.get(parts[4]);
        return refund === undefined ? json(404, {}) : json(200, this.#refund(refund));
      }
      const items = [...this.refunds.values()].filter((refund) => refund.payment_id === parts[2]).map((refund) => this.#refund(refund));
      return json(200, { entity: "collection", count: items.length, items });
    }
    return json(404, {});
  };

  addPayment(orderId: string, status: FakePayment["status"]): FakePayment {
    const order = this.orders.get(orderId)!;
    const payment: FakePayment = { id: `pay_KtRecPay${this.#next()}`, status, captured: status === "captured", amount: order.amount };
    order.payments.push(payment);
    order.status = status === "captured" ? "paid" : "attempted";
    return payment;
  }

  paymentEntity(orderId: string, payment: FakePayment): Json {
    return this.#payment(this.orders.get(orderId)!, payment);
  }

  refundEntity(refund: FakeRefund): Json {
    return this.#refund(refund);
  }

  #next(): string {
    this.#sequence += 1;
    return String(this.#sequence).padStart(6, "0");
  }

  #order(order: FakeOrder): Json {
    return { id: order.id, entity: "order", amount: order.amount, amount_paid: order.status === "paid" ? order.amount : 0,
      currency: "INR", receipt: order.receipt, status: order.status, attempts: order.payments.length, created_at: 1_767_225_600 };
  }

  #payment(order: FakeOrder, payment: FakePayment): Json {
    return { id: payment.id, entity: "payment", amount: payment.amount, currency: "INR", status: payment.status, order_id: order.id,
      captured: payment.captured, method: "upi", email: PAYER_EMAIL, contact: PAYER_CONTACT };
  }

  #refund(refund: FakeRefund): Json {
    return { id: refund.id, entity: "refund", amount: refund.amount, currency: "INR", payment_id: refund.payment_id,
      receipt: refund.receipt, notes: {}, status: refund.status, created_at: 1_767_225_900, speed_requested: "normal" };
  }
}

/** Grants support access to exactly the bookings the test names. */
class ListedSupportAccess implements SupportAccessPolicy {
  readonly bookings = new Set<string>();
  async hasExplicitAccess(request: Parameters<SupportAccessPolicy["hasExplicitAccess"]>[0]): Promise<boolean> {
    return request.action === "booking:command" && request.resource.kind === "BOOKING" && this.bookings.has(request.resource.id);
  }
}

describeDatabase("online refunds, pending-intent recovery, reconciliation, and payment history over HTTP and PostgreSQL", () => {
  const clock = new DomainClock();
  const provider = new FakeRazorpay();
  const support = new ListedSupportAccess();
  const telemetryLines: string[] = [];
  const nestLogger = new CapturingNestLogger();
  let database: TestDatabase;
  let pool: PgPoolAdapter;
  let app: INestApplication;
  let removeTelemetry: () => void;
  let baseUrl: string;
  let farmer: ApiClient;
  let stranger: ApiClient;
  let owner: ApiClient;
  let operator: ApiClient;
  let job: PaymentReconciliationJob;
  const users: Record<string, string> = {};
  const bills: Record<string, { booking: string; invoice: string; payment?: string; order?: string; capture?: FakePayment }> = {};
  let ordinal = 3;
  let dataset: Awaited<ReturnType<typeof seedRepresentativeDataset>>;

  const signIn = async (phone: string, purpose: "REGISTER_FARMER" | "REGISTER_OWNER") => {
    const client = new ApiClient(baseUrl, `kisan-payment-recovery-${phone}`);
    const challenge = await client.post("/identity/otp/challenges", { phone, purpose });
    expect(challenge.status, JSON.stringify(challenge.body)).toBe(201);
    const verified = await client.post("/identity/otp/verify", {
      challengeId: challenge.body.challengeId, phone, purpose, code: challenge.body.developmentCode,
    });
    expect(verified.status, JSON.stringify(verified.body)).toBe(200);
    return { client: client.withCredential(verified.body.accessCredential), userId: verified.body.principal.userId as string };
  };

  /** A billed, unpaid booking for the Farmer and Owner on the seeded Tractor, each on its own day. */
  const seedBill = async (name: string, totalPaise = 120_000) => {
    ordinal += 1;
    const booking = randomUUID();
    const agreement = randomUUID();
    const invoice = randomUUID();
    const start = new Date(clock.now().getTime() + ordinal * 86_400_000).toISOString();
    const end = new Date(clock.now().getTime() + ordinal * 86_400_000 + 90 * 60_000).toISOString();
    await pool.query(
      `INSERT INTO public.bookings (id, public_reference, customer_id, owner_id, tractor_id, service_offering_id,
         requested_start_at, requested_end_at, expected_quantity, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1.500, 'FINAL_BILL_GENERATED')`,
      [booking, `KT-RC${String(ordinal).padStart(6, "0")}`, users.farmer, users.owner, dataset.tractorId, dataset.serviceOfferingId, start, end],
    );
    await pool.query(
      `INSERT INTO public.booking_agreements (id, booking_id, agreement_version, pricing_rule_id, pricing_rule_version, method,
         rate_paise, rounding_policy, estimated_quantity, estimated_total_paise, service_location_snapshot, approved_by_customer_at, disclosed_at)
       VALUES ($1, $2, 1, $3, 1, 'HOURLY', 80000, 'PROPORTIONAL_MINUTE', 1.500, $4,
         '{"state":"Telangana","district":"Warangal","mandalOrTaluk":"Hanamkonda","village":"Kazipet","source":"MANUAL_ADDRESS"}'::jsonb,
         CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [agreement, booking, dataset.pricingRuleId, totalPaise],
    );
    await pool.query("UPDATE public.bookings SET current_agreement_id = $2 WHERE id = $1", [booking, agreement]);
    await pool.query(
      `INSERT INTO public.invoices (id, booking_id, agreement_id, invoice_version, status, rate_paise, billable_quantity,
         subtotal_paise, adjustments_paise, total_paise, evidence_references, calculation_formula, rounding_trace)
       VALUES ($1, $2, $3, 1, 'ISSUED', 80000, 1.500, $4, 0, $4, '[]'::jsonb, '90 min x ₹800.00/h',
         '{"rawSubtotalNumerator":"120000","rawSubtotalDenominator":"1","minorUnitRounding":"HALF_UP"}'::jsonb)`,
      [invoice, booking, agreement, totalPaise],
    );
    bills[name] = { booking, invoice };
    return bills[name]!;
  };

  const startOnline = async (name: string, amountPaise = 120_000) => {
    const bill = bills[name]!;
    const created = await farmer.post(`/farmer/bookings/${bill.booking}/payments/online`, {
      invoiceId: bill.invoice, amountPaise, idempotencyKey: `online-${name}-0001`,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    bill.payment = created.body.payment.id;
    bill.order = created.body.checkout.providerReference;
    // Later events get later timestamps, so ordered histories are deterministic.
    clock.advanceMinutes(1);
    return created.body;
  };

  const deliver = async (body: string, eventId: string) => {
    const response = await fetch(`${baseUrl}/payments/webhooks/razorpay`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-razorpay-signature": createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex"),
        "x-razorpay-event-id": eventId,
      },
      body,
    });
    const text = await response.text();
    return { status: response.status, body: text.length === 0 ? undefined : JSON.parse(text) as Json };
  };
  const capturedWebhook = (name: string) => {
    const bill = bills[name]!;
    return JSON.stringify({
      entity: "event", event: "payment.captured", contains: ["payment"], created_at: 1_767_226_000,
      payload: { payment: { entity: provider.paymentEntity(bill.order!, bill.capture!) } },
    });
  };
  const refundWebhook = (name: string, refund: FakeRefund, event: "refund.processed" | "refund.failed") => {
    const bill = bills[name]!;
    return JSON.stringify({
      entity: "event", event, contains: ["refund", "payment"], created_at: 1_767_227_000,
      payload: {
        refund: { entity: provider.refundEntity(refund) },
        payment: { entity: { ...provider.paymentEntity(bill.order!, bill.capture!), status: "refunded" } },
      },
    });
  };

  const state = async (name: string) => {
    const bill = bills[name]!;
    const result = await pool.query<{ state: Json }>(`SELECT json_build_object(
      'payments', (SELECT json_agg(json_build_object('id', id, 'method', method, 'status', status, 'amount', amount_paise,
         'providerPaymentId', provider_payment_id, 'mode', provider_mode) ORDER BY created_at, id) FROM public.payments WHERE invoice_id = $1),
      'paymentEvents', (SELECT json_agg(pe.event_type ORDER BY pe.occurred_at, pe.id) FROM public.payment_events pe
         JOIN public.payments p ON p.id = pe.payment_id WHERE p.invoice_id = $1),
      'refunds', (SELECT json_agg(json_build_object('id', r.id, 'status', r.status, 'amount', r.amount_paise, 'providerRefundId', r.provider_refund_id,
         'attempts', r.submit_attempts, 'error', r.last_error_code) ORDER BY r.created_at) FROM public.payment_refunds r
         JOIN public.payments p ON p.id = r.payment_id WHERE p.invoice_id = $1),
      'booking', (SELECT status FROM public.bookings WHERE id = $2)
    ) AS state`, [bill.invoice, bill.booking]);
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
      paymentProviderHttp: provider.http,
      supportAccessPolicy: support,
    }), { logger: nestLogger, rawBody: true });
    removeTelemetry = installApiTelemetry(app, telemetry);
    await app.listen(0, "127.0.0.1");
    baseUrl = listeningBaseUrl(app);
    job = new PaymentReconciliationJob(app.get(PaymentRecoveryService));

    const signed = await Promise.all([
      signIn(PHONES.farmer, "REGISTER_FARMER"), signIn(PHONES.stranger, "REGISTER_FARMER"),
      signIn(PHONES.owner, "REGISTER_OWNER"), signIn(PHONES.operator, "REGISTER_FARMER"),
    ]);
    [farmer, stranger, owner, operator] = signed.map((entry) => entry.client) as [ApiClient, ApiClient, ApiClient, ApiClient];
    [users.farmer, users.stranger, users.owner, users.operator] = signed.map((entry) => entry.userId);
    // Roles are read per request, so the operator's next call carries the support membership.
    await pool.query(`INSERT INTO public.user_role_memberships (user_id, role_code) VALUES ($1, 'FUTURE_OPERATOR')`, [users.operator]);
    // A Tractor, offering, and price (plus one completed cash booking) from the representative dataset.
    dataset = await seedRepresentativeDataset(pool, { ordinal: 61, customerId: users.farmer!, ownerId: users.owner! });
  }, 120_000);

  afterAll(async () => {
    removeTelemetry?.();
    await app?.close();
    await database?.dispose();
  });

  it("opens a checkout only for the paying Farmer's pending intent, within its window", async () => {
    await seedBill("cancel");
    const created = await startOnline("cancel");
    const checkout = await farmer.get(`/farmer/payments/${bills.cancel!.payment}/checkout`);
    expect(checkout.status, JSON.stringify(checkout.body)).toBe(200);
    expect(checkout.body).toMatchObject({
      bookingId: bills.cancel!.booking,
      payment: { status: "PENDING", testMode: true },
      checkout: { provider: "razorpay", testMode: true, publicKey: KEY_ID, providerReference: created.checkout.providerReference, amountPaise: 120_000 },
    });
    expect(new Date(checkout.body.checkoutExpiresAt).getTime()).toBe(new Date(created.payment.recordedAt).getTime() + 15 * 60_000);
    expect(JSON.stringify(checkout.body)).not.toContain(KEY_SECRET);
    expect((await stranger.get(`/farmer/payments/${bills.cancel!.payment}/checkout`)).status).toBe(404);
    expect((await owner.get(`/farmer/payments/${bills.cancel!.payment}/checkout`)).status).toBe(404);
    // The pending intent reserves the bill, so cash cannot be recorded on top of it.
    const cash = await owner.post(`/owner/bookings/${bills.cancel!.booking}/payments/cash`, {
      invoiceId: bills.cancel!.invoice, amountPaise: 50_000, idempotencyKey: "cash-cancel-0001",
    });
    expect(cash.status).toBe(409);
    expect(cash.body.code).toBe("PAYMENT_OVERPAYMENT");
  });

  it("refuses to cancel while the provider is still processing, then releases the bill for cash", async () => {
    const bill = bills.cancel!;
    provider.addPayment(bill.order!, "authorized");
    const busy = await farmer.post(`/farmer/payments/${bill.payment}/cancel`);
    expect(busy.status, JSON.stringify(busy.body)).toBe(409);
    expect(busy.body.code).toBe("PAYMENT_IN_PROGRESS");
    expect((await state("cancel")).payments[0].status).toBe("PENDING");

    provider.orders.get(bill.order!)!.payments[0]!.status = "failed";
    expect((await stranger.post(`/farmer/payments/${bill.payment}/cancel`)).status).toBe(404);
    const cancelled = await farmer.post(`/farmer/payments/${bill.payment}/cancel`);
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(cancelled.body).toMatchObject({ released: true, confirmation: "NOT_COMPLETED", payment: { status: "PAYMENT_FAILED" } });
    // Cancelling again changes nothing.
    expect((await farmer.post(`/farmer/payments/${bill.payment}/cancel`)).body).toMatchObject({ released: false });

    clock.advanceMinutes(1);
    const cash = await owner.post(`/owner/bookings/${bill.booking}/payments/cash`, {
      invoiceId: bill.invoice, amountPaise: 50_000, idempotencyKey: "cash-cancel-0002",
    });
    expect(cash.status, JSON.stringify(cash.body)).toBe(201);
    const evidence = await pool.query<{ event_type: string; evidence_source: string; signature_verified: boolean }>(
      "SELECT event_type, evidence_source, signature_verified FROM public.provider_events WHERE payment_id = $1", [bill.payment]);
    expect(evidence.rows).toEqual([{ event_type: "api.intent.unpaid", evidence_source: "PROVIDER_API", signature_verified: false }]);
  });

  it("flags money captured after a release when the bill no longer has room for it", async () => {
    const bill = bills.cancel!;
    bill.capture = provider.addPayment(bill.order!, "captured");
    const late = await deliver(capturedWebhook("cancel"), "KtRecEvent0001");
    expect(late).toMatchObject({ status: 200, body: { outcome: "REJECTED_PAYLOAD" } });
    const after = await state("cancel");
    expect(after.payments.map((payment: Json) => payment.status)).toEqual(["PAYMENT_FAILED", "PAID_CASH"]);
    const audit = await pool.query<{ reason_code: string }>(
      "SELECT reason_code FROM public.audit_events WHERE action = 'PROVIDER_PAYMENT_EVENT_REJECTED' AND pii_safe_metadata->>'paymentId' = $1", [bill.payment]);
    expect(audit.rows).toEqual([{ reason_code: "PAYMENT_LEDGER_INCONSISTENT" }]);
  });

  it("releases a stale abandoned intent in reconciliation and accepts its late capture while the bill has room", async () => {
    await seedBill("late");
    await startOnline("late");
    // Within the checkout window nothing is touched.
    expect((await job.runOnce()).intents.outcomes.RELEASED ?? 0).toBe(0);
    clock.advanceMinutes(46);
    const pass = await job.runOnce();
    expect(pass.intents.outcomes.RELEASED).toBeGreaterThanOrEqual(1);
    expect((await state("late")).payments[0].status).toBe("PAYMENT_FAILED");
    expect((await farmer.get(`/farmer/payments/${bills.late!.payment}/checkout`)).body.code).toBe("PAYMENT_NOT_PENDING");

    bills.late!.capture = provider.addPayment(bills.late!.order!, "captured");
    clock.advanceMinutes(1);
    const late = await deliver(capturedWebhook("late"), "KtRecEvent0002");
    expect(late).toMatchObject({ status: 200, body: { outcome: "ACCEPTED" } });
    const after = await state("late");
    expect(after.payments[0]).toMatchObject({ status: "PAID_ONLINE", providerPaymentId: bills.late!.capture.id, mode: "SANDBOX" });
    expect(after.paymentEvents).toEqual(["ONLINE_PAYMENT_INITIATED", "ONLINE_PAYMENT_FAILED", "ONLINE_PAYMENT_LATE_CONFIRMED"]);
    expect(after.booking).toBe("COMPLETED");
  });

  it("confirms a capture whose webhook never arrived from the provider's API, once", async () => {
    await seedBill("missed");
    await startOnline("missed");
    bills.missed!.capture = provider.addPayment(bills.missed!.order!, "captured");
    // The Farmer's status check reads the provider and confirms the payment.
    const checked = await farmer.post(`/farmer/payments/${bills.missed!.payment}/status-check`);
    expect(checked.status, JSON.stringify(checked.body)).toBe(200);
    expect(checked.body).toMatchObject({ confirmation: "CONFIRMED", payment: { status: "PAID_ONLINE", confirmedBy: "PAYMENT_PROVIDER" } });
    clock.advanceMinutes(46);
    await job.runOnce();
    // The delayed webhook for the same capture is recorded with no second effect.
    expect(await deliver(capturedWebhook("missed"), "KtRecEvent0003")).toMatchObject({ status: 200, body: { outcome: "ACCEPTED" } });
    const after = await state("missed");
    expect(after.paymentEvents).toEqual(["ONLINE_PAYMENT_INITIATED", "ONLINE_PAYMENT_CONFIRMED"]);
    expect(after.booking).toBe("COMPLETED");
    const evidence = await pool.query<{ evidence_source: string; status: string }>(
      "SELECT evidence_source, status FROM public.provider_events WHERE payment_id = $1 ORDER BY received_at, id", [bills.missed!.payment]);
    expect(evidence.rows).toEqual([{ evidence_source: "PROVIDER_API", status: "APPLIED" }, { evidence_source: "WEBHOOK", status: "VERIFIED" }]);
    const receipt = await owner.get(`/owner/payments/${bills.missed!.payment}/receipt`);
    expect(receipt.status, JSON.stringify(receipt.body)).toBe(200);
    expect(receipt.body).toMatchObject({ method: "ONLINE", status: "PAID_ONLINE", testMode: true, confirmedBy: "PAYMENT_PROVIDER" });
  });

  const dispute = async (name: string) => {
    const bill = bills[name]!;
    await pool.query("UPDATE public.bookings SET status = 'DISPUTED', version = version + 1 WHERE id = $1", [bill.booking]);
    await pool.query(
      `INSERT INTO public.booking_status_history (booking_id, from_status, to_status, actor_id, actor_channel, reason, occurred_at)
       VALUES ($1, 'PAYMENT_RECORDED', 'DISPUTED', $2, 'WEB', 'Acreage was lower', $3)`,
      [bill.booking, users.farmer, clock.now().toISOString()],
    );
  };
  const refundPath = (name: string) => `/support/payments/${bills[name]!.payment}/refunds`;

  it("lets only granted support request a full refund of a confirmed online payment, idempotently", async () => {
    await seedBill("refund");
    await startOnline("refund", 50_000);
    bills.refund!.capture = provider.addPayment(bills.refund!.order!, "captured");
    expect(await deliver(capturedWebhook("refund"), "KtRecEvent0004")).toMatchObject({ body: { outcome: "ACCEPTED" } });
    clock.advanceMinutes(1);
    await dispute("refund");
    clock.advanceMinutes(1);

    const body = { reasonCode: "DISPUTE_RESOLVED", idempotencyKey: "refund-key-0001" };
    // Farmers, Owners, and operators without an explicit grant learn nothing.
    expect((await farmer.post(refundPath("refund"), body)).status).toBe(404);
    expect((await owner.post(refundPath("refund"), body)).status).toBe(404);
    expect((await operator.post(refundPath("refund"), body)).status).toBe(404);
    support.bookings.add(bills.refund!.booking);
    expect((await operator.post(refundPath("refund"), { ...body, amountPaise: 50_001, idempotencyKey: "refund-key-x1" })).body.code)
      .toBe("PAYMENT_REFUND_EXCEEDS_PAYMENT");
    expect((await operator.post(refundPath("refund"), { ...body, amountPaise: 10_000, idempotencyKey: "refund-key-x2" })).body.code)
      .toBe("PAYMENT_PARTIAL_REFUND_UNSUPPORTED");
    expect((await state("refund")).refunds).toBeNull();

    const requested = await operator.post(refundPath("refund"), body);
    expect(requested.status, JSON.stringify(requested.body)).toBe(201);
    expect(requested.body).toMatchObject({
      bookingStatus: "REFUND_PENDING", payment: { status: "REFUND_PENDING" },
      refund: { status: "SUBMITTED", amountPaise: 50_000, reasonCode: "DISPUTE_RESOLVED" },
    });
    const refundCalls = provider.requests.filter((request) => request.url.endsWith("/refund"));
    expect(refundCalls).toHaveLength(1);
    expect(refundCalls[0]!.headers["x-refund-idempotency"]).toMatch(/^ktrf[0-9a-f]{32}$/u);
    expect(JSON.parse(refundCalls[0]!.body)).toMatchObject({ amount: 50_000, speed: "normal" });

    const replay = await operator.post(refundPath("refund"), body);
    expect(replay.status).toBe(201);
    expect(replay.body.refund.id).toBe(requested.body.refund.id);
    expect(provider.requests.filter((request) => request.url.endsWith("/refund"))).toHaveLength(1);
    const again = await operator.post(refundPath("refund"), { ...body, idempotencyKey: "refund-key-0002" });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("PAYMENT_TRANSITION_NOT_ALLOWED");
    expect((await state("refund")).booking).toBe("REFUND_PENDING");
  });

  it("finishes the refund once from concurrent signed provider events and refunds the booking", async () => {
    const refund = [...provider.refunds.values()].find((candidate) => candidate.payment_id === bills.refund!.capture!.id)!;
    refund.status = "processed";
    clock.advanceMinutes(1);
    const webhook = refundWebhook("refund", refund, "refund.processed");
    const deliveries = await Promise.all([1, 2, 3].map(() => deliver(webhook, "KtRecEvent0005")));
    expect(deliveries.map((delivery) => delivery.body?.outcome).sort()).toEqual(["ACCEPTED", "DUPLICATE", "DUPLICATE"]);
    const after = await state("refund");
    expect(after.payments[0].status).toBe("REFUNDED");
    expect(after.refunds).toEqual([expect.objectContaining({ status: "PROCESSED", amount: 50_000, providerRefundId: refund.id })]);
    expect(after.paymentEvents).toEqual(["ONLINE_PAYMENT_INITIATED", "ONLINE_PAYMENT_CONFIRMED", "REFUND_REQUESTED", "REFUND_CONFIRMED"]);
    expect(after.booking).toBe("REFUNDED");
    // A later failure report never re-applies money that was refunded.
    expect(await deliver(refundWebhook("refund", { ...refund, status: "failed" }, "refund.failed"), "KtRecEvent0006"))
      .toMatchObject({ body: { outcome: "ACCEPTED" } });
    expect((await state("refund")).payments[0].status).toBe("REFUNDED");
    expect((await farmer.get(`/farmer/payments/${bills.refund!.payment}/receipt`)).status).toBe(409);
  });

  it("retries an unconfirmed refund submission with the same key and applies a provider failure", async () => {
    await seedBill("refundFail");
    await startOnline("refundFail", 40_000);
    bills.refundFail!.capture = provider.addPayment(bills.refundFail!.order!, "captured");
    await deliver(capturedWebhook("refundFail"), "KtRecEvent0007");
    clock.advanceMinutes(1);
    await dispute("refundFail");
    clock.advanceMinutes(1);
    support.bookings.add(bills.refundFail!.booking);
    provider.refundMode = "unavailable";
    const requested = await operator.post(refundPath("refundFail"), { reasonCode: "SERVICE_NOT_DELIVERED", idempotencyKey: "refund-key-0003" });
    expect(requested.status, JSON.stringify(requested.body)).toBe(201);
    expect(requested.body.refund.status).toBe("REQUESTED");
    expect((await state("refundFail")).refunds[0]).toMatchObject({ status: "REQUESTED", attempts: 1, error: "PROVIDER_UNAVAILABLE" });

    provider.refundMode = "ok";
    clock.advanceMinutes(2);
    await job.runOnce();
    const submitted = (await state("refundFail")).refunds[0];
    expect(submitted).toMatchObject({ status: "SUBMITTED", attempts: 2 });
    const keys = provider.requests.filter((request) => request.url.endsWith("/refund")).map((request) => request.headers["x-refund-idempotency"]);
    expect(keys.at(-1)).toBe(keys.at(-2));

    provider.refunds.get(submitted.providerRefundId)!.status = "failed";
    await job.runOnce();
    const after = await state("refundFail");
    expect(after.refunds[0]).toMatchObject({ status: "FAILED" });
    // A failed refund leaves the money applied; support decides what happens next.
    expect(after.payments[0].status).toBe("PAID_ONLINE");
    expect(after.booking).toBe("REFUND_PENDING");
    expect(after.paymentEvents.slice(-2)).toEqual(["REFUND_REQUESTED", "REFUND_FAILED"]);
  });

  it("rejects a refund the platform never requested", async () => {
    const bill = bills.missed!;
    const unexpected = { id: "rfnd_KtDashboard01", payment_id: bill.capture!.id, amount: 120_000, status: "processed" as const, receipt: "" };
    expect(await deliver(refundWebhook("missed", unexpected, "refund.processed"), "KtRecEvent0008"))
      .toMatchObject({ status: 200, body: { outcome: "REJECTED_PAYLOAD" } });
    expect((await state("missed")).payments[0].status).toBe("PAID_ONLINE");
    const audit = await pool.query<{ reason_code: string; payment: string }>(
      `SELECT reason_code, pii_safe_metadata->>'paymentId' AS payment FROM public.audit_events
       WHERE action = 'PROVIDER_REFUND_EVENT_REJECTED'`);
    expect(audit.rows).toEqual([{ reason_code: "PAYMENT_LEDGER_INCONSISTENT", payment: bill.payment }]);
  });

  it("lists each party's own payments, newest first, in bounded pages", async () => {
    const pages: Json[] = [];
    let cursor: string | undefined;
    do {
      const page = await farmer.get(`/farmer/payments?limit=3${cursor === undefined ? "" : `&cursor=${encodeURIComponent(cursor)}`}`);
      expect(page.status, JSON.stringify(page.body)).toBe(200);
      expect(page.body.items.length).toBeLessThanOrEqual(3);
      pages.push(...page.body.items);
      cursor = page.body.nextCursor;
    } while (cursor !== undefined);
    const ids = pages.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const name of ["cancel", "late", "missed", "refund", "refundFail"]) expect(ids).toContain(bills[name]!.payment);
    const recorded = pages.map((item) => new Date(item.recordedAt).getTime());
    expect([...recorded].sort((left, right) => right - left)).toEqual(recorded);
    const missed = pages.find((item) => item.id === bills.missed!.payment)!;
    expect(missed).toMatchObject({ method: "ONLINE", status: "PAID_ONLINE", testMode: true, receiptAvailable: true, bookingId: bills.missed!.booking });
    expect(pages.find((item) => item.id === bills.refund!.payment)).toMatchObject({ status: "REFUNDED", receiptAvailable: false });
    expect(JSON.stringify(pages)).not.toMatch(/order_|pay_Kt|rfnd_|provider/u);

    const ownerView = await owner.get("/owner/payments?limit=50");
    expect(ownerView.body.items.map((item: Json) => item.id)).toEqual(expect.arrayContaining(ids));
    expect((await stranger.get("/farmer/payments")).body.items).toEqual([]);
    expect((await owner.get("/farmer/payments")).status).toBe(404);
    expect((await farmer.get("/farmer/payments?limit=500")).status).toBe(422);
    expect((await farmer.get("/farmer/payments?cursor=not-a-cursor")).status).toBe(422);
  });

  it("keeps provider contact details and secrets out of storage and logs", async () => {
    const stored = await pool.query<{ dump: string }>(`SELECT concat_ws('|',
      (SELECT json_agg(p)::text FROM public.provider_events p), (SELECT json_agg(r)::text FROM public.payment_refunds r),
      (SELECT json_agg(a)::text FROM public.audit_events a), (SELECT json_agg(o)::text FROM public.outbox_events o)) AS dump`);
    const logs = [...telemetryLines, ...nestLogger.lines].join("\n");
    for (const text of [stored.rows[0]!.dump, logs]) {
      expect(text).not.toContain(PAYER_EMAIL);
      expect(text).not.toContain(PAYER_CONTACT.slice(3));
      expect(text).not.toContain(KEY_SECRET);
      expect(text).not.toContain(WEBHOOK_SECRET);
    }
    await expect(pool.query("UPDATE public.provider_events SET status = 'APPLIED'")).rejects.toThrow(/append-only/u);
  });
});
