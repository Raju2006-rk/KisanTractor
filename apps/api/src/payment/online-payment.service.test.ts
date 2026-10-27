import { createHmac } from "node:crypto";

import { projectPaymentRecord, type AuthPrincipal, type PaymentRecordSource } from "@kisantractor/domain";
import { InMemoryMetrics, OperationalIndicators } from "@kisantractor/observability";
import {
  CapabilityRegistry,
  CapabilityUnavailableError,
  RazorpayPaymentAdapter,
  type CapabilityRegistration,
  type PaymentHttpRequest,
} from "@kisantractor/providers";
import { describe, expect, it } from "vitest";

import type {
  PaymentApplicationPreview,
  PaymentApplicationResult,
  PaymentReceiptRecordSource,
  PaymentRequestContext,
  PaymentStore,
  ProviderEventOutcome,
  ValidatedPaymentApplication,
  VerifiedProviderEventRecord,
} from "./payment.contracts.js";
import {
  PaymentCapabilityUnavailableError,
  PaymentConflictError,
  PaymentNotFoundError,
  PaymentProviderFailedError,
  PaymentService,
  PaymentValidationError,
  toSettlementProjection,
} from "./payment.service.js";

const WEBHOOK_SECRET = "synthetic-webhook-secret-for-tests";
const now = new Date("2026-03-01T12:00:00.000Z");
const context: PaymentRequestContext = { correlationId: "corr-online-1", actorChannel: "WEB" };
const farmer: AuthPrincipal = { userId: "farmer-1", roles: ["FARMER"], sessionId: "session-1" } as AuthPrincipal;
const owner: AuthPrincipal = { userId: "owner-1", roles: ["OWNER"], sessionId: "session-2" } as AuthPrincipal;
const booking = { id: "booking-1", reference: "KT-2026-0001", customerId: "farmer-1", ownerId: "owner-1", status: "FINAL_BILL_GENERATED" as const, version: 7 };
const invoice = { id: "invoice-1", bookingId: "booking-1", invoiceVersion: 1, status: "ISSUED" as const, totalPaise: 120_000, currency: "INR" };
const command = { bookingId: "booking-1", invoiceId: "invoice-1", amountPaise: 120_000, idempotencyKey: "online-key-1" };

const onlinePayment = (status: PaymentRecordSource["status"] = "PENDING"): PaymentRecordSource => ({
  id: "payment-1", invoiceId: "invoice-1", method: "ONLINE", status, amountPaise: 120_000, currency: "INR",
  createdAt: now, ...(status === "PAID_ONLINE" ? { verifiedAt: now } : {}),
});

/** Records every store call; behaviour is set per test. */
class RecordingStore implements PaymentStore {
  readonly previews: ValidatedPaymentApplication[] = [];
  readonly applied: ValidatedPaymentApplication[] = [];
  readonly events: VerifiedProviderEventRecord[] = [];
  preview: PaymentApplicationPreview | Error = { kind: "PROCEED" };
  applyError?: Error;
  eventOutcome: ProviderEventOutcome = { disposition: "APPLIED", paymentId: "payment-1", paymentStatus: "PAID_ONLINE" };
  receipt?: PaymentReceiptRecordSource;

  async loadBookingPayments() { return { booking, invoice, payments: [] }; }
  async loadReceiptSource() { return this.receipt; }
  async transitionPayment(): Promise<never> { throw new Error("not used"); }
  async previewPaymentApplication(input: ValidatedPaymentApplication): Promise<PaymentApplicationPreview> {
    this.previews.push(input);
    if (this.preview instanceof Error) throw this.preview;
    return this.preview;
  }
  async applyPayment(input: ValidatedPaymentApplication): Promise<PaymentApplicationResult> {
    this.applied.push(input);
    if (this.applyError !== undefined) throw this.applyError;
    const payment = onlinePayment();
    return {
      payment: projectPaymentRecord(payment, booking),
      settlement: toSettlementProjection({ booking, invoice, payments: [payment] }),
      onlineIntent: { provider: input.provider!, providerReference: input.providerReference! },
    };
  }
  async recordProviderEvent(input: VerifiedProviderEventRecord): Promise<ProviderEventOutcome> {
    this.events.push(input);
    return this.eventOutcome;
  }
}

const providerCalls: PaymentHttpRequest[] = [];
const razorpay = (respondStatus = 200) => new RazorpayPaymentAdapter({
  environment: "test", keyId: "rzp_test_Kt0Synthetic01", keySecret: "synthetic-key-secret-for-tests", webhookSecret: WEBHOOK_SECRET,
  http: async (request) => {
    providerCalls.push(request);
    const sent = JSON.parse(request.body) as { amount: number; currency: string; receipt: string };
    return {
      status: respondStatus,
      json: async () => ({ id: "order_KtSynthOrder01", entity: "order", amount: sent.amount, currency: sent.currency, receipt: sent.receipt, status: "created" }),
    };
  },
});

const setup = (registration: CapabilityRegistration = { state: "SANDBOX", provider: razorpay() }) => {
  providerCalls.length = 0;
  const store = new RecordingStore();
  const metrics = new InMemoryMetrics();
  const service = new PaymentService(store, () => now, new OperationalIndicators(metrics),
    new CapabilityRegistry({ ONLINE_PAYMENT: registration }));
  return { store, metrics, service };
};

const capturedBody = (amount = 120_000) => JSON.stringify({
  entity: "event", event: "payment.captured", contains: ["payment"], created_at: 1_767_225_700,
  payload: { payment: { entity: { id: "pay_KtSynthPay0001", entity: "payment", amount, currency: "INR", status: "captured", order_id: "order_KtSynthOrder01" } } },
});
const signed = (body: string, eventId = "KtSynthEvent0001") => ({
  "x-razorpay-signature": createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex"), "x-razorpay-event-id": eventId,
});
const bytes = (body: string) => new TextEncoder().encode(body);
const webhookContext: PaymentRequestContext = { correlationId: "corr-webhook-1", actorChannel: "PROVIDER" };

/** Validates: Requirements 11.3, 14.1, 14.2, 14.3 */
describe("PaymentService.createOnlineIntent", () => {
  it("creates a provider intent only in SANDBOX/LIVE and returns a test-labelled checkout with a pending payment", async () => {
    const { store, service } = setup();
    const result = await service.createOnlineIntent(farmer, command, context);

    expect(result.payment).toMatchObject({ method: "ONLINE", status: "PENDING", amountPaise: 120_000 });
    expect(result.payment.paidAt).toBeUndefined();
    expect(result.checkout).toMatchObject({
      provider: "razorpay", mode: "SANDBOX", testMode: true, providerReference: "order_KtSynthOrder01", amountPaise: 120_000,
    });
    expect(providerCalls).toHaveLength(1);
    expect(JSON.parse(providerCalls[0]!.body)).toMatchObject({ amount: 120_000, currency: "INR", notes: { booking_id: "booking-1", invoice_id: "invoice-1" } });
    // The provider receipt id is stable for the same Farmer, bill, and key.
    expect(JSON.parse(providerCalls[0]!.body).receipt).toMatch(/^kt[0-9a-f]{38}$/u);
    expect(store.previews).toHaveLength(1);
    expect(store.applied[0]).toMatchObject({
      method: "ONLINE", actorRole: "FARMER", actorId: "farmer-1", provider: "razorpay", providerReference: "order_KtSynthOrder01",
    });
    expect(store.applied[0]!.requestDigest).toBe(store.previews[0]!.requestDigest);
  });

  it("refuses UNCONFIGURED and DEGRADED capabilities before any store or provider call", async () => {
    for (const registration of [{ state: "UNCONFIGURED" }, { state: "DEGRADED", provider: razorpay() }] as const) {
      const { store, service } = setup(registration);
      const error = await service.createOnlineIntent(farmer, command, context).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(CapabilityUnavailableError);
      expect(error).toMatchObject({ capability: "ONLINE_PAYMENT", state: registration.state, retryable: registration.state === "DEGRADED" });
      expect(store.previews).toHaveLength(0);
      expect(providerCalls).toHaveLength(0);
    }
  });

  it("replays a completed retry without contacting the provider again", async () => {
    const { store, service } = setup();
    const first = await service.createOnlineIntent(farmer, command, context);
    const payment = onlinePayment();
    store.preview = { kind: "REPLAY", result: {
      payment: projectPaymentRecord(payment, booking),
      settlement: toSettlementProjection({ booking, invoice, payments: [payment] }),
      onlineIntent: { provider: "razorpay", providerReference: "order_KtSynthOrder01" },
    } };
    const replay = await service.createOnlineIntent(farmer, command, context);

    expect(replay.checkout).toEqual(first.checkout);
    expect(providerCalls).toHaveLength(1);
    expect(store.applied).toHaveLength(1);
  });

  it("never calls the provider for a request the ledger would refuse, and counts the refusal", async () => {
    const { store, metrics, service } = setup();
    store.preview = new PaymentConflictError("PAYMENT_OVERPAYMENT", "too much");
    await expect(service.createOnlineIntent(farmer, command, context)).rejects.toMatchObject({ code: "PAYMENT_OVERPAYMENT" });
    expect(providerCalls).toHaveLength(0);
    expect(metrics.value("kt_payment_verification_failures_total", { method: "ONLINE", reason: "PAYMENT_OVERPAYMENT" })).toBe(1);
  });

  it("validates the caller and the amount, and maps provider failures without recording a payment", async () => {
    const { store, service } = setup();
    await expect(service.createOnlineIntent(owner, command, context)).rejects.toBeInstanceOf(PaymentNotFoundError);
    await expect(service.createOnlineIntent(farmer, { ...command, amountPaise: 1.5 }, context)).rejects.toBeInstanceOf(PaymentValidationError);
    // Razorpay's minimum is ₹1; the check happens before the request leaves the server.
    await expect(service.createOnlineIntent(farmer, { ...command, amountPaise: 99 }, context))
      .rejects.toMatchObject({ field: "amountPaise" });
    expect(providerCalls).toHaveLength(0);

    for (const [status, retryable] of [[503, true], [401, false]] as const) {
      const failing = setup({ state: "SANDBOX", provider: razorpay(status) });
      const error = await failing.service.createOnlineIntent(farmer, command, context).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(PaymentProviderFailedError);
      expect(error).toMatchObject({ retryable });
      expect(failing.store.applied).toHaveLength(0);
    }
    expect(store.applied).toHaveLength(0);
  });
});

/** Validates: Requirements 11.4, 11.5, 11.6, 14.4, 14.5, 18.2 */
describe("PaymentService.handleProviderWebhook", () => {
  it("verifies the raw body and hands the normalized event to the store once", async () => {
    const { store, service } = setup();
    const body = capturedBody();
    const result = await service.handleProviderWebhook("razorpay", bytes(body), signed(body), webhookContext);

    expect(result).toMatchObject({ outcome: "ACCEPTED", httpStatus: 200 });
    expect(store.events).toEqual([expect.objectContaining({
      provider: "razorpay", providerEventId: "KtSynthEvent0001", eventType: "payment.captured", kind: "PAYMENT_CONFIRMED",
      providerReference: "order_KtSynthOrder01", providerPaymentId: "pay_KtSynthPay0001", amountPaise: 120_000, currency: "INR",
      receivedAt: now,
    })]);
  });

  it("passes refund facts to the store and counts refund outcomes from signed events (task 16.2)", async () => {
    const { store, metrics, service } = setup();
    const body = JSON.stringify({
      entity: "event", event: "refund.failed", contains: ["refund"], created_at: 1_767_225_900,
      payload: { refund: { entity: {
        id: "rfnd_KtSynthRfnd01", entity: "refund", amount: 120_000, currency: "INR", payment_id: "pay_KtSynthPay0001",
        receipt: "ktrf0123456789abcdef0123456789abcdef", status: "failed",
      } } },
    });
    store.eventOutcome = { disposition: "APPLIED", paymentId: "payment-1", paymentStatus: "PAID_ONLINE", refundId: "refund-1", refundStatus: "FAILED" };
    expect(await service.handleProviderWebhook("razorpay", bytes(body), signed(body, "KtSynthEvent0009"), webhookContext))
      .toMatchObject({ outcome: "ACCEPTED", httpStatus: 200 });
    expect(store.events.at(-1)).toMatchObject({
      kind: "REFUND_FAILED", providerPaymentId: "pay_KtSynthPay0001", providerRefundId: "rfnd_KtSynthRfnd01",
      refundKey: "ktrf0123456789abcdef0123456789abcdef", amountPaise: 120_000,
    });
    expect(metrics.value("kt_payment_recovery_total", { subject: "REFUND", outcome: "REFUND_FAILED" })).toBe(1);
  });

  it("rejects unsigned, mis-signed, and body-less deliveries with no store call and counts them", async () => {
    const { store, metrics, service } = setup();
    const body = capturedBody();
    expect(await service.handleProviderWebhook("razorpay", bytes(body), {}, webhookContext))
      .toMatchObject({ outcome: "REJECTED_SIGNATURE", httpStatus: 401, reasonCode: "SIGNATURE_MISSING" });
    expect(await service.handleProviderWebhook("razorpay", bytes(capturedBody(1)), signed(body), webhookContext))
      .toMatchObject({ outcome: "REJECTED_SIGNATURE", httpStatus: 401, reasonCode: "SIGNATURE_INVALID" });
    expect(await service.handleProviderWebhook("razorpay", undefined, signed(body), webhookContext))
      .toMatchObject({ outcome: "REJECTED_PAYLOAD", httpStatus: 400, reasonCode: "RAW_BODY_UNAVAILABLE" });
    expect(store.events).toHaveLength(0);
    expect(metrics.value("kt_payment_verification_failures_total", { method: "ONLINE", reason: "SIGNATURE_INVALID" })).toBe(2);
    expect(metrics.value("kt_payment_verification_failures_total", { method: "ONLINE", reason: "PAYMENT_EVIDENCE_REQUIRED" })).toBe(1);
  });

  it("reports duplicates, replays under a new event id, and evidence mismatches with the right indicators", async () => {
    const { store, metrics, service } = setup();
    const body = capturedBody();
    store.eventOutcome = { disposition: "DUPLICATE" };
    expect(await service.handleProviderWebhook("razorpay", bytes(body), signed(body), webhookContext))
      .toMatchObject({ outcome: "DUPLICATE", httpStatus: 200 });
    store.eventOutcome = { disposition: "DUPLICATE", replayedUnderNewEventId: true };
    await service.handleProviderWebhook("razorpay", bytes(body), signed(body, "KtSynthEvent0002"), webhookContext);
    store.eventOutcome = { disposition: "REJECTED", rejectionCode: "AMOUNT_MISMATCH", paymentId: "payment-1", paymentStatus: "PENDING" };
    // A provider retry cannot change the evidence, so the rejection is acknowledged with 200.
    expect(await service.handleProviderWebhook("razorpay", bytes(body), signed(body, "KtSynthEvent0003"), webhookContext))
      .toMatchObject({ outcome: "REJECTED_PAYLOAD", httpStatus: 200, reasonCode: "AMOUNT_MISMATCH" });

    expect(metrics.value("kt_payment_verification_failures_total", { method: "ONLINE", reason: "REPLAYED_EVENT" })).toBe(1);
    expect(metrics.value("kt_payment_verification_failures_total", { method: "ONLINE", reason: "AMOUNT_MISMATCH" })).toBe(1);
    expect(metrics.total("kt_payment_verification_failures_total")).toBe(2);
  });

  it("still verifies callbacks while DEGRADED, but refuses them when no adapter is configured", async () => {
    const degraded = setup({ state: "DEGRADED", provider: razorpay() });
    const body = capturedBody();
    expect(await degraded.service.handleProviderWebhook("razorpay", bytes(body), signed(body), webhookContext))
      .toMatchObject({ outcome: "ACCEPTED" });

    const unconfigured = setup({ state: "UNCONFIGURED" });
    await expect(unconfigured.service.handleProviderWebhook("razorpay", bytes(body), signed(body), webhookContext))
      .rejects.toMatchObject({ code: "PAYMENT_CAPABILITY_UNAVAILABLE", retryable: true });
    expect(unconfigured.store.events).toHaveLength(0);
    await expect(degraded.service.handleProviderWebhook("stripe", bytes(body), signed(body), webhookContext))
      .rejects.toBeInstanceOf(PaymentNotFoundError);
  });
});

/** Validates: Requirements 11.4, 14.3 */
describe("online payment status and labelling", () => {
  const receiptSource = (payment: PaymentRecordSource): PaymentReceiptRecordSource => ({
    booking, invoice, invoiceSuperseded: false, payment, invoicePayments: [payment],
  });

  it("answers a checkout return from stored state only", async () => {
    const { store, service } = setup();
    store.receipt = receiptSource(onlinePayment("PENDING"));
    expect(await service.getOnlinePaymentStatus(farmer, "payment-1", context)).toMatchObject({
      confirmation: "AWAITING_PROVIDER_CONFIRMATION", testMode: true, payment: { status: "PENDING" },
    });
    store.receipt = receiptSource(onlinePayment("PAID_ONLINE"));
    expect(await service.getOnlinePaymentStatus(farmer, "payment-1", context)).toMatchObject({ confirmation: "CONFIRMED" });

    // Unrelated Farmers, Owners on this route, and cash records all look unavailable.
    await expect(service.getOnlinePaymentStatus({ ...farmer, userId: "farmer-2" } as AuthPrincipal, "payment-1", context))
      .rejects.toBeInstanceOf(PaymentNotFoundError);
    await expect(service.getOnlinePaymentStatus(owner, "payment-1", context)).rejects.toBeInstanceOf(PaymentNotFoundError);
    store.receipt = receiptSource({ ...onlinePayment(), method: "CASH", status: "PAID_CASH", recordedByUserId: "owner-1", receivedAt: now });
    await expect(service.getOnlinePaymentStatus(farmer, "payment-1", context)).rejects.toBeInstanceOf(PaymentNotFoundError);
  });

  it("labels settlement views and online receipts as test money in SANDBOX, and never in LIVE-less states", async () => {
    const sandbox = setup();
    expect((await sandbox.service.getBookingSettlement(farmer, "booking-1", "FARMER", context)).onlinePayment).toEqual({
      state: "SANDBOX", statusLabel: "Test service (sandbox)", available: true, testMode: true, canRetry: false,
    });
    sandbox.store.receipt = receiptSource(onlinePayment("PAID_ONLINE"));
    expect(await sandbox.service.getReceipt(farmer, "payment-1", "FARMER", context)).toMatchObject({ method: "ONLINE", testMode: true });

    const unconfigured = setup({ state: "UNCONFIGURED" });
    expect((await unconfigured.service.getBookingSettlement(owner, "booking-1", "OWNER", context)).onlinePayment).toEqual({
      state: "UNCONFIGURED", statusLabel: "Unavailable", available: false, testMode: false, canRetry: false,
    });
    unconfigured.store.receipt = receiptSource(onlinePayment("PAID_ONLINE"));
    expect(await unconfigured.service.getReceipt(farmer, "payment-1", "FARMER", context)).not.toHaveProperty("testMode");
  });

  it("reports a provider that disappeared after an intent was created instead of reopening a checkout", async () => {
    const { store, service } = setup();
    const payment = onlinePayment();
    store.preview = { kind: "REPLAY", result: {
      payment: projectPaymentRecord(payment, booking),
      settlement: toSettlementProjection({ booking, invoice, payments: [payment] }),
      onlineIntent: { provider: "another-gateway", providerReference: "order_KtSynthOrder01" },
    } };
    await expect(service.createOnlineIntent(farmer, command, context)).rejects.toBeInstanceOf(PaymentCapabilityUnavailableError);
  });
});
