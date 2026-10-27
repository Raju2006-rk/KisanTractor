import { createHash, createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { OnlinePaymentProviderError, ProviderWebhookRejectedError } from "./online-payment.js";
import {
  RazorpayPaymentAdapter,
  razorpayModeForKeyId,
  type PaymentHttpRequest,
  type PaymentHttpResponse,
} from "./razorpay-payment-adapter.js";

// Synthetic credentials generated for this test only. A live-shaped key id is assembled at runtime
// so the repository never contains a literal that looks like a real live credential.
const TEST_KEY_ID = "rzp_test_Kt0Synthetic01";
const LIVE_KEY_ID = ["rzp", "live", "Kt0Synthetic01"].join("_");
const KEY_SECRET = "synthetic-key-secret-for-tests";
const WEBHOOK_SECRET = "synthetic-webhook-secret-for-tests";

interface FakeHttp {
  readonly requests: PaymentHttpRequest[];
  readonly client: (request: PaymentHttpRequest) => Promise<PaymentHttpResponse>;
}

const fakeHttp = (respond: (request: PaymentHttpRequest) => PaymentHttpResponse | Promise<PaymentHttpResponse>): FakeHttp => {
  const requests: PaymentHttpRequest[] = [];
  return { requests, client: async (request) => { requests.push(request); return respond(request); } };
};

const jsonResponse = (status: number, body: unknown): PaymentHttpResponse => ({ status, json: async () => body });

const orderResponse = (request: PaymentHttpRequest, overrides: Record<string, unknown> = {}) => {
  const sent = JSON.parse(request.body) as { amount: number; currency: string; receipt: string; notes: Record<string, string> };
  // Shape of the documented Orders API response.
  return jsonResponse(200, {
    id: "order_KtSynthOrder01", entity: "order", amount: sent.amount, amount_paid: 0, amount_due: sent.amount,
    currency: sent.currency, receipt: sent.receipt, offer_id: null, status: "created", attempts: 0, notes: sent.notes,
    created_at: 1_767_225_600, ...overrides,
  });
};

const adapter = (http?: FakeHttp, keyId = TEST_KEY_ID, environment: "local" | "test" | "staging" | "production" = "test") =>
  new RazorpayPaymentAdapter({
    environment, keyId, keySecret: KEY_SECRET, webhookSecret: WEBHOOK_SECRET,
    ...(http === undefined ? {} : { http: http.client }),
  });

const intentRequest = { intentKey: "kt_0123456789abcdef", amountPaise: 120_000, currency: "INR" as const,
  metadata: { booking_id: "8d3c5b1e-0000-4000-8000-000000000001", invoice_id: "8d3c5b1e-0000-4000-8000-000000000002" } };

/** Documented webhook shapes (payment.captured, order.paid, payment.failed). */
const paymentEntity = (overrides: Record<string, unknown> = {}) => ({
  id: "pay_KtSynthPay0001", entity: "payment", amount: 120_000, currency: "INR", status: "captured",
  order_id: "order_KtSynthOrder01", invoice_id: null, international: false, method: "upi", amount_refunded: 0,
  captured: true, description: null, email: "void@example.invalid", contact: "+910000000000", fee: 2_832, tax: 432,
  created_at: 1_767_225_660, ...overrides,
});
const webhookBody = (event: string, payload: Record<string, unknown>) => JSON.stringify({
  entity: "event", account_id: "acc_KtSynthAcct01", event, contains: Object.keys(payload), payload, created_at: 1_767_225_700,
});
const sign = (body: string, secret = WEBHOOK_SECRET) => createHmac("sha256", secret).update(body).digest("hex");
const bytes = (body: string) => new TextEncoder().encode(body);
/** `null` sends no event id header. */
const headers = (body: string, eventId: string | null = "KtSynthEvent0001") => ({
  "x-razorpay-signature": sign(body), ...(eventId === null ? {} : { "x-razorpay-event-id": eventId }),
});

/** Validates: Requirements 11.3, 14.1, 14.3, 14.5 */
describe("RazorpayPaymentAdapter configuration", () => {
  it("derives SANDBOX or LIVE from the key prefix and refuses unsafe environments", () => {
    expect(razorpayModeForKeyId(TEST_KEY_ID)).toBe("SANDBOX");
    expect(razorpayModeForKeyId(LIVE_KEY_ID)).toBe("LIVE");
    expect(razorpayModeForKeyId("pk_test_123")).toBeUndefined();

    expect(adapter(undefined, TEST_KEY_ID, "staging").mode).toBe("SANDBOX");
    expect(adapter(undefined, LIVE_KEY_ID, "production").mode).toBe("LIVE");
    // Test payment paths never run in production; live money never moves from local or test.
    expect(() => adapter(undefined, TEST_KEY_ID, "production")).toThrow(/not allowed in production/u);
    for (const environment of ["local", "test"] as const) {
      expect(() => adapter(undefined, LIVE_KEY_ID, environment)).toThrow(/staging or production/u);
    }
    expect(() => new RazorpayPaymentAdapter({ environment: "test", keyId: TEST_KEY_ID, keySecret: KEY_SECRET, webhookSecret: "short" }))
      .toThrow(/at least 16 characters/u);
    expect(() => new RazorpayPaymentAdapter({
      environment: "test", keyId: TEST_KEY_ID, keySecret: KEY_SECRET, webhookSecret: WEBHOOK_SECRET, apiBaseUrl: "http://api.example",
    })).toThrow(/HTTPS/u);
  });

  it("labels sandbox checkout as test-only and exposes only the publishable key", () => {
    const checkout = adapter().checkoutFor({ providerReference: "order_KtSynthOrder01", amountPaise: 120_000, currency: "INR" });
    expect(checkout).toEqual({
      provider: "razorpay", mode: "SANDBOX", testMode: true, statusLabel: "Test payment (sandbox): no real money moves",
      publicKey: TEST_KEY_ID, providerReference: "order_KtSynthOrder01", amountPaise: 120_000, currency: "INR",
    });
    expect(JSON.stringify(checkout)).not.toContain(KEY_SECRET);
    expect(adapter(undefined, LIVE_KEY_ID, "production").checkoutFor(checkout)).toMatchObject({ testMode: false, mode: "LIVE" });
  });
});

/** Validates: Requirements 11.3 */
describe("RazorpayPaymentAdapter.createIntent (Orders API contract)", () => {
  it("creates an order with Basic auth, integer paise, INR, the stable receipt, and non-personal notes", async () => {
    const http = fakeHttp((request) => orderResponse(request));
    const intent = await adapter(http).createIntent(intentRequest);

    expect(intent).toEqual({ provider: "razorpay", providerReference: "order_KtSynthOrder01", amountPaise: 120_000, currency: "INR" });
    const [request] = http.requests;
    expect(request).toMatchObject({ method: "POST", url: "https://api.razorpay.com/v1/orders" });
    expect(request!.headers.authorization).toBe(`Basic ${Buffer.from(`${TEST_KEY_ID}:${KEY_SECRET}`).toString("base64")}`);
    expect(JSON.parse(request!.body)).toEqual({
      amount: 120_000, currency: "INR", receipt: "kt_0123456789abcdef", notes: intentRequest.metadata, partial_payment: false,
    });
  });

  it("refuses responses that do not describe the requested order", async () => {
    for (const overrides of [{ amount: 119_999 }, { currency: "USD" }, { id: "pay_wrongEntity1" }, { entity: "payment" }, { receipt: "other" }]) {
      const http = fakeHttp((request) => orderResponse(request, overrides));
      await expect(adapter(http).createIntent(intentRequest), JSON.stringify(overrides))
        .rejects.toMatchObject({ code: "PROVIDER_RESPONSE_INVALID", retryable: false });
    }
  });

  it("maps documented error statuses, timeouts, and network failures to retryable or final codes", async () => {
    const cases: ReadonlyArray<readonly [number, string, boolean]> = [
      [400, "PROVIDER_REJECTED_REQUEST", false], [401, "PROVIDER_AUTH_FAILED", false], [429, "PROVIDER_THROTTLED", true],
      [500, "PROVIDER_UNAVAILABLE", true], [503, "PROVIDER_UNAVAILABLE", true],
    ];
    for (const [status, code, retryable] of cases) {
      // The documented error body is never copied into the error.
      const http = fakeHttp(() => jsonResponse(status, { error: { code: "BAD_REQUEST_ERROR", description: "contact +910000000000" } }));
      const error = await adapter(http).createIntent(intentRequest).catch((caught: unknown) => caught);
      expect(error, String(status)).toBeInstanceOf(OnlinePaymentProviderError);
      expect(error).toMatchObject({ code, retryable });
      expect(String((error as Error).message)).not.toContain("910000000000");
    }

    const unreachable = fakeHttp(() => { throw new TypeError("fetch failed"); });
    await expect(adapter(unreachable).createIntent(intentRequest)).rejects.toMatchObject({ code: "PROVIDER_UNREACHABLE", retryable: true });

    const hanging = fakeHttp((request) => new Promise<PaymentHttpResponse>((_resolve, rejectRequest) => {
      request.signal.addEventListener("abort", () => rejectRequest(request.signal.reason));
    }));
    const slow = new RazorpayPaymentAdapter({ environment: "test", keyId: TEST_KEY_ID, keySecret: KEY_SECRET, webhookSecret: WEBHOOK_SECRET, http: hanging.client, timeoutMs: 20 });
    await expect(slow.createIntent(intentRequest)).rejects.toMatchObject({ code: "PROVIDER_TIMEOUT", retryable: true });
  });

  it("validates amounts before calling the provider", async () => {
    const http = fakeHttp((request) => orderResponse(request));
    await expect(adapter(http).createIntent({ ...intentRequest, amountPaise: 99 }))
      .rejects.toMatchObject({ code: "PROVIDER_AMOUNT_BELOW_MINIMUM", retryable: false });
    await expect(adapter(http).createIntent({ ...intentRequest, amountPaise: 1.5 })).rejects.toThrow(TypeError);
    await expect(adapter(http).createIntent({ ...intentRequest, intentKey: "x".repeat(41) })).rejects.toThrow(TypeError);
    expect(http.requests).toHaveLength(0);
  });
});

/** Validates: Requirements 11.4, 11.5, 11.6, 14.5 */
describe("RazorpayPaymentAdapter.verifyWebhook (signature and payload contract)", () => {
  const captured = webhookBody("payment.captured", { payment: { entity: paymentEntity() } });

  it("verifies HMAC-SHA256 over the exact raw body and normalizes a capture", () => {
    const event = adapter().verifyWebhook(bytes(captured), headers(captured));
    expect(event).toEqual({
      provider: "razorpay", providerEventId: "KtSynthEvent0001", eventIdSource: "HEADER", eventType: "payment.captured",
      kind: "PAYMENT_CONFIRMED", providerReference: "order_KtSynthOrder01", providerPaymentId: "pay_KtSynthPay0001",
      amountPaise: 120_000, currency: "INR", occurredAt: new Date(1_767_225_700_000),
      payloadDigest: createHash("sha256").update(captured).digest("hex"),
    });
    // Contact details in the provider payload never reach the normalized event.
    expect(JSON.stringify(event)).not.toMatch(/example\.invalid|910000000000/u);
  });

  it("refuses unsigned, wrongly signed, re-serialized, and tampered bodies before parsing", () => {
    const reject = (body: Uint8Array, given: Record<string, string>) => {
      try {
        adapter().verifyWebhook(body, given);
      } catch (error) {
        expect(error).toBeInstanceOf(ProviderWebhookRejectedError);
        return (error as ProviderWebhookRejectedError).code;
      }
      throw new Error("expected the webhook to be rejected");
    };
    expect(reject(bytes(captured), {})).toBe("SIGNATURE_MISSING");
    expect(reject(bytes(captured), { "x-razorpay-signature": "not-hex" })).toBe("SIGNATURE_INVALID");
    expect(reject(bytes(captured), { "x-razorpay-signature": sign(captured, "another-webhook-secret-value") })).toBe("SIGNATURE_INVALID");
    // The API key secret is not the webhook secret.
    expect(reject(bytes(captured), { "x-razorpay-signature": sign(captured, KEY_SECRET) })).toBe("SIGNATURE_INVALID");
    const tampered = captured.replace("120000", "999999");
    expect(reject(bytes(tampered), headers(captured))).toBe("SIGNATURE_INVALID");
    // Re-serializing the parsed JSON changes the bytes, so only the raw body verifies.
    const pretty = JSON.stringify(JSON.parse(captured), null, 2);
    expect(reject(bytes(pretty), headers(captured))).toBe("SIGNATURE_INVALID");
  });

  it("refuses a signed money-moving event that lacks well-formed payment evidence", () => {
    for (const entity of [
      paymentEntity({ amount: "120000" }), paymentEntity({ amount: 1.5 }), paymentEntity({ currency: "inr" }),
      paymentEntity({ id: "order_wrong" }), paymentEntity({ status: "authorized" }), paymentEntity({ order_id: 42 }),
    ]) {
      const body = webhookBody("payment.captured", { payment: { entity } });
      expect(() => adapter().verifyWebhook(bytes(body), headers(body))).toThrow(
        expect.objectContaining({ code: "PAYLOAD_INVALID" }) as unknown as Error,
      );
    }
    for (const body of ["not json", JSON.stringify({ entity: "event" }), JSON.stringify([1, 2])]) {
      expect(() => adapter().verifyWebhook(bytes(body), headers(body))).toThrow(ProviderWebhookRejectedError);
    }
  });

  it("maps order.paid to a confirmation and payment.failed to a non-final attempt failure", () => {
    const paid = webhookBody("order.paid", {
      payment: { entity: paymentEntity() },
      order: { entity: { id: "order_KtSynthOrder01", entity: "order", amount: 120_000, amount_paid: 120_000, status: "paid" } },
    });
    expect(adapter().verifyWebhook(bytes(paid), headers(paid, "KtSynthEvent0002"))).toMatchObject({
      kind: "PAYMENT_CONFIRMED", providerReference: "order_KtSynthOrder01", amountPaise: 120_000, providerEventId: "KtSynthEvent0002",
    });
    const mismatched = webhookBody("order.paid", {
      payment: { entity: paymentEntity() },
      order: { entity: { id: "order_KtOtherOrder1", entity: "order", status: "paid" } },
    });
    expect(() => adapter().verifyWebhook(bytes(mismatched), headers(mismatched))).toThrow(ProviderWebhookRejectedError);

    const failed = webhookBody("payment.failed", { payment: { entity: paymentEntity({ status: "failed", captured: false }) } });
    expect(adapter().verifyWebhook(bytes(failed), headers(failed))).toMatchObject({
      kind: "PAYMENT_ATTEMPT_FAILED", providerReference: "order_KtSynthOrder01",
    });
    const authorized = webhookBody("payment.authorized", { payment: { entity: paymentEntity({ status: "authorized" }) } });
    expect(adapter().verifyWebhook(bytes(authorized), headers(authorized))).toMatchObject({ kind: "INFORMATIONAL" });
    // Refund creation is informational; a refund outcome needs a complete refund entity (task 16.2).
    const created = webhookBody("refund.created", { refund: { entity: { id: "rfnd_KtSynth0001", entity: "refund" } } });
    expect(adapter().verifyWebhook(bytes(created), headers(created))).toMatchObject({ kind: "INFORMATIONAL", providerRefundId: "rfnd_KtSynth0001" });
    const incomplete = webhookBody("refund.processed", { refund: { entity: { id: "rfnd_KtSynth0001", entity: "refund" } } });
    expect(() => adapter().verifyWebhook(bytes(incomplete), headers(incomplete))).toThrow(
      expect.objectContaining({ code: "PAYLOAD_INVALID" }) as unknown as Error,
    );
  });

  it("falls back to the body digest as the event identity when the event id header is absent or malformed", () => {
    const digest = createHash("sha256").update(captured).digest("hex");
    for (const eventId of [null, "../../etc", "x".repeat(101)]) {
      expect(adapter().verifyWebhook(bytes(captured), headers(captured, eventId))).toMatchObject({
        providerEventId: `sha256:${digest}`, eventIdSource: "DIGEST",
      });
    }
  });
});

/** Documented refund entity shape (Refunds API and refund.* webhooks). */
const refundEntity = (overrides: Record<string, unknown> = {}) => ({
  id: "rfnd_KtSynthRfnd01", entity: "refund", amount: 120_000, currency: "INR", payment_id: "pay_KtSynthPay0001",
  notes: { refund_id: "8d3c5b1e-0000-4000-8000-000000000009" }, receipt: "ktrf0123456789abcdef", acquirer_data: { arn: null },
  created_at: 1_767_225_800, batch_id: null, status: "processed", speed_processed: "normal", speed_requested: "normal", ...overrides,
});

/** Validates: Requirements 11.1, 11.5, 11.6, 11.7 */
describe("RazorpayPaymentAdapter status reads and refunds (Orders, Payments, Refunds API contract)", () => {
  const order = { id: "order_KtSynthOrder01", entity: "order", amount: 120_000, amount_paid: 0, amount_due: 120_000, currency: "INR",
    receipt: "kt_0123456789abcdef", status: "attempted", attempts: 2, created_at: 1_767_225_600 };
  const statusHttp = (payments: unknown[], orderOverrides: Record<string, unknown> = {}) => fakeHttp((request) =>
    request.url.endsWith("/payments")
      ? jsonResponse(200, { entity: "collection", count: payments.length, items: payments })
      : jsonResponse(200, { ...order, ...orderOverrides }));

  it("reads an order and its attempts with authenticated GETs and keeps only non-personal facts", async () => {
    const http = statusHttp([paymentEntity({ id: "pay_KtSynthPay0002", status: "failed", captured: false }), paymentEntity()]);
    const read = await adapter(http).fetchIntentStatus("order_KtSynthOrder01");
    expect(read.snapshot).toEqual({
      providerReference: "order_KtSynthOrder01", amountPaise: 120_000, currency: "INR", orderState: "ATTEMPTED",
      payments: [
        { providerPaymentId: "pay_KtSynthPay0001", state: "CAPTURED", captured: true, amountPaise: 120_000, currency: "INR" },
        { providerPaymentId: "pay_KtSynthPay0002", state: "FAILED", captured: false, amountPaise: 120_000, currency: "INR" },
      ],
    });
    expect(read.digest).toMatch(/^api:[0-9a-f]{64}$/u);
    expect(JSON.stringify(read)).not.toMatch(/example\.invalid|910000000000/u);
    expect(http.requests.map((request) => [request.method, request.url, request.body])).toEqual([
      ["GET", "https://api.razorpay.com/v1/orders/order_KtSynthOrder01", ""],
      ["GET", "https://api.razorpay.com/v1/orders/order_KtSynthOrder01/payments", ""],
    ]);
    expect(http.requests[0]!.headers.authorization).toMatch(/^Basic /u);
    // The same provider state always yields the same evidence digest.
    expect((await adapter(statusHttp([paymentEntity(), paymentEntity({ id: "pay_KtSynthPay0002", status: "failed", captured: false })]))
      .fetchIntentStatus("order_KtSynthOrder01")).digest).toBe(read.digest);
  });

  it("refuses malformed ids before calling the provider and malformed answers after", async () => {
    const http = statusHttp([]);
    await expect(adapter(http).fetchIntentStatus("order_../../v1/payments")).rejects.toThrow(TypeError);
    expect(http.requests).toHaveLength(0);
    for (const [payments, overrides] of [
      [[], { id: "order_KtOtherOrder1" }], [[], { status: "unknown" }], [[paymentEntity({ order_id: "order_KtOtherOrder1" })], {}],
      [[paymentEntity({ status: "mystery" })], {}], [[paymentEntity({ amount: -1 })], {}],
    ] as const) {
      await expect(adapter(statusHttp([...payments], overrides)).fetchIntentStatus("order_KtSynthOrder01"))
        .rejects.toMatchObject({ code: "PROVIDER_RESPONSE_INVALID" });
    }
    await expect(adapter(fakeHttp(() => jsonResponse(404, {}))).fetchIntentStatus("order_KtSynthOrder01"))
      .rejects.toMatchObject({ code: "PROVIDER_NOT_FOUND", retryable: false });
  });

  it("creates a full normal refund with the refund key as idempotency key and receipt", async () => {
    const http = fakeHttp(() => jsonResponse(200, refundEntity({ status: "pending" })));
    const read = await adapter(http).createRefund({
      providerPaymentId: "pay_KtSynthPay0001", amountPaise: 120_000, currency: "INR", refundKey: "ktrf0123456789abcdef",
      metadata: { refund_id: "8d3c5b1e-0000-4000-8000-000000000009" },
    });
    expect(read.snapshot).toEqual({
      providerRefundId: "rfnd_KtSynthRfnd01", providerPaymentId: "pay_KtSynthPay0001", amountPaise: 120_000, currency: "INR", state: "PENDING",
    });
    const [request] = http.requests;
    expect(request).toMatchObject({ method: "POST", url: "https://api.razorpay.com/v1/payments/pay_KtSynthPay0001/refund" });
    expect(request!.headers["x-refund-idempotency"]).toBe("ktrf0123456789abcdef");
    expect(JSON.parse(request!.body)).toEqual({
      amount: 120_000, speed: "normal", receipt: "ktrf0123456789abcdef", notes: { refund_id: "8d3c5b1e-0000-4000-8000-000000000009" },
    });
    // A refund for another payment or amount is never accepted as this one.
    for (const overrides of [{ payment_id: "pay_KtOtherPay001" }, { amount: 60_000 }, { status: "weird" }, { id: "pay_notarefund" }]) {
      await expect(adapter(fakeHttp(() => jsonResponse(200, refundEntity(overrides)))).createRefund({
        providerPaymentId: "pay_KtSynthPay0001", amountPaise: 120_000, currency: "INR", refundKey: "ktrf0123456789abcdef", metadata: {},
      }), JSON.stringify(overrides)).rejects.toMatchObject({ code: "PROVIDER_RESPONSE_INVALID" });
    }
    // A concurrent request with the same key is still in progress: retryable.
    await expect(adapter(fakeHttp(() => jsonResponse(409, {}))).createRefund({
      providerPaymentId: "pay_KtSynthPay0001", amountPaise: 120_000, currency: "INR", refundKey: "ktrf0123456789abcdef", metadata: {},
    })).rejects.toMatchObject({ code: "PROVIDER_CONFLICT", retryable: true });
    await expect(adapter(http).createRefund({
      providerPaymentId: "pay_KtSynthPay0001", amountPaise: 120_000, currency: "INR", refundKey: "short", metadata: {},
    })).rejects.toThrow(TypeError);
  });

  it("fetches one refund and finds a refund by its key", async () => {
    const fetched = fakeHttp(() => jsonResponse(200, refundEntity()));
    expect((await adapter(fetched).fetchRefund("pay_KtSynthPay0001", "rfnd_KtSynthRfnd01")).snapshot).toMatchObject({ state: "PROCESSED" });
    expect(fetched.requests[0]).toMatchObject({ method: "GET", url: "https://api.razorpay.com/v1/payments/pay_KtSynthPay0001/refunds/rfnd_KtSynthRfnd01" });

    const listed = fakeHttp(() => jsonResponse(200, { entity: "collection", count: 2, items: [
      refundEntity({ id: "rfnd_KtOtherRfnd1", receipt: "ktrfsomeotherkey00000" }), refundEntity({ status: "failed" }),
    ] }));
    expect((await adapter(listed).findRefund("pay_KtSynthPay0001", "ktrf0123456789abcdef"))?.snapshot).toMatchObject({
      providerRefundId: "rfnd_KtSynthRfnd01", state: "FAILED",
    });
    expect(listed.requests[0]!.url).toBe("https://api.razorpay.com/v1/payments/pay_KtSynthPay0001/refunds?count=100");
    expect(await adapter(listed).findRefund("pay_KtSynthPay0001", "ktrfnotlistedkey00000")).toBeUndefined();
  });

  it("maps signed refund outcomes to refund events with the refund facts", () => {
    for (const [event, status, kind] of [["refund.processed", "processed", "REFUND_CONFIRMED"], ["refund.failed", "failed", "REFUND_FAILED"]] as const) {
      const body = webhookBody(event, { refund: { entity: refundEntity({ status }) }, payment: { entity: paymentEntity({ status: "refunded" }) } });
      expect(adapter().verifyWebhook(bytes(body), headers(body))).toMatchObject({
        kind, providerReference: "order_KtSynthOrder01", providerPaymentId: "pay_KtSynthPay0001", providerRefundId: "rfnd_KtSynthRfnd01",
        refundKey: "ktrf0123456789abcdef", amountPaise: 120_000, currency: "INR",
      });
      // The refund status inside the payload must agree with the event.
      const contradictory = webhookBody(event, { refund: { entity: refundEntity({ status: status === "processed" ? "failed" : "processed" }) } });
      expect(() => adapter().verifyWebhook(bytes(contradictory), headers(contradictory))).toThrow(ProviderWebhookRejectedError);
    }
  });
});
