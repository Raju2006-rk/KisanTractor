import type { AuthPrincipal, PaymentRecordSource, ProviderIntentSnapshot, ProviderRefundSnapshot } from "@kisantractor/domain";
import { InMemoryMetrics, OperationalIndicators } from "@kisantractor/observability";
import {
  CapabilityRegistry,
  CapabilityUnavailableError,
  OnlinePaymentProviderError,
  type CapabilityRegistration,
  type OnlinePaymentRecoveryAdapter,
} from "@kisantractor/providers";
import { describe, expect, it } from "vitest";

import { DenyAllSupportAccessPolicy, type SupportAccessPolicy } from "../authorization/index.js";
import type {
  OnlineIntentRecord,
  PaymentHistoryQuery,
  PaymentHistoryRow,
  PaymentReceiptRecordSource,
  PaymentRequestContext,
  ProviderEventOutcome,
  RefundRequestResult,
  RefundSubmissionSource,
  RefundSubmissionUpdate,
  ReleasePendingIntentInput,
  ValidatedRefundRequest,
  VerifiedProviderEventRecord,
} from "./payment.contracts.js";
import { PaymentHistoryService } from "./payment-history.service.js";
import { PaymentRecoveryService } from "./payment-recovery.service.js";
import { PaymentRefundService } from "./payment-refund.service.js";

const now = new Date("2026-03-01T12:00:00.000Z");
const context: PaymentRequestContext = { correlationId: "corr-recovery-1", actorChannel: "WEB" };
const farmer: AuthPrincipal = { userId: "farmer-1", sessionId: "s-1", roles: ["FARMER"] };
const stranger: AuthPrincipal = { userId: "farmer-2", sessionId: "s-2", roles: ["FARMER"] };
const operator: AuthPrincipal = { userId: "support-1", sessionId: "s-3", roles: ["FUTURE_OPERATOR"] };
const booking = { id: "booking-1", reference: "KT-2026-0001", customerId: "farmer-1", ownerId: "owner-1", status: "FINAL_BILL_GENERATED" as const, version: 3 };

const payment = (status: PaymentRecordSource["status"], createdAt = new Date(now.getTime() - 60 * 60_000)): PaymentRecordSource => ({
  id: "payment-1", invoiceId: "invoice-1", method: "ONLINE", status, amountPaise: 120_000, currency: "INR", createdAt, providerMode: "SANDBOX",
});
const intent = (status: PaymentRecordSource["status"] = "PENDING", createdAt?: Date): OnlineIntentRecord => {
  const record = payment(status, createdAt);
  return {
    paymentId: record.id, invoiceId: record.invoiceId, booking, provider: "razorpay", providerReference: "order_KtUnit00001",
    status, amountPaise: record.amountPaise, currency: "INR", createdAt: record.createdAt, payment: record,
  };
};

/** Records every store call; the intent and refund it holds change only through recorded calls. */
class RecordingRecoveryStore {
  intents: OnlineIntentRecord[] = [intent()];
  refunds: RefundSubmissionSource[] = [];
  readonly events: VerifiedProviderEventRecord[] = [];
  readonly releases: ReleasePendingIntentInput[] = [];
  readonly submissions: RefundSubmissionUpdate[] = [];
  readonly checked: string[] = [];
  eventOutcome: ProviderEventOutcome = { disposition: "APPLIED", paymentStatus: "PAID_ONLINE" };

  async loadOnlineIntent(paymentId: string) { return this.intents.find((candidate) => candidate.paymentId === paymentId); }
  async listPendingIntentsForRecovery(input: { createdBefore: Date; limit: number }) {
    return this.intents.filter((candidate) => candidate.status === "PENDING" && candidate.createdAt < input.createdBefore).slice(0, input.limit);
  }
  async markIntentChecked(paymentId: string) { this.checked.push(paymentId); }
  async releasePendingIntent(input: ReleasePendingIntentInput) {
    this.releases.push(input);
    this.intents = this.intents.map((candidate) => candidate.paymentId === input.paymentId
      ? { ...candidate, status: "PAYMENT_FAILED", payment: { ...candidate.payment, status: "PAYMENT_FAILED" } } : candidate);
    return { released: true, status: "PAYMENT_FAILED" as const };
  }
  async listRefundsForReconciliation() { return this.refunds; }
  async markRefundChecked(refundId: string) { this.checked.push(refundId); }
  async recordRefundSubmission(input: RefundSubmissionUpdate) { this.submissions.push(input); }
  async loadRefundSubmission(refundId: string) { return this.refunds.find((refund) => refund.refundId === refundId); }
  async recordProviderEvent(input: VerifiedProviderEventRecord) {
    this.events.push(input);
    return this.eventOutcome;
  }
}

/** A recovery adapter whose provider answers are set per test; no HTTP at all. */
const fakeAdapter = (answers: {
  intent?: ProviderIntentSnapshot | Error;
  refund?: ProviderRefundSnapshot | Error;
  found?: ProviderRefundSnapshot | undefined;
}) => {
  const calls: string[] = [];
  const read = <Snapshot>(value: Snapshot | Error | undefined, name: string) => {
    calls.push(name);
    if (value instanceof Error) return Promise.reject(value);
    if (value === undefined) return Promise.reject(new OnlinePaymentProviderError("PROVIDER_NOT_FOUND", false));
    return Promise.resolve({ snapshot: value, digest: `api:${name}` });
  };
  const adapter: OnlinePaymentRecoveryAdapter = {
    provider: "razorpay",
    mode: "SANDBOX",
    createIntent: async () => { throw new Error("unexpected createIntent"); },
    checkoutFor: (value) => ({
      provider: "razorpay", mode: "SANDBOX", testMode: true, statusLabel: "Test payment (sandbox): no real money moves",
      publicKey: "rzp_test_Kt0Synthetic01", providerReference: value.providerReference, amountPaise: value.amountPaise, currency: "INR",
    }),
    verifyWebhook: () => { throw new Error("unexpected verifyWebhook"); },
    fetchIntentStatus: () => read(answers.intent, "intent"),
    createRefund: () => read(answers.refund, "createRefund"),
    fetchRefund: () => read(answers.refund, "fetchRefund"),
    findRefund: async () => { calls.push("findRefund"); return answers.found === undefined ? undefined : { snapshot: answers.found, digest: "api:found" }; },
  };
  return { adapter, calls };
};

const snapshot = (payments: ProviderIntentSnapshot["payments"] = []): ProviderIntentSnapshot => ({
  providerReference: "order_KtUnit00001", amountPaise: 120_000, currency: "INR", orderState: payments.length > 0 ? "ATTEMPTED" : "OPEN", payments,
});

const setup = (adapter: OnlinePaymentRecoveryAdapter | undefined, state: CapabilityRegistration["state"] = "SANDBOX") => {
  const store = new RecordingRecoveryStore();
  const metrics = new InMemoryMetrics();
  const registration = (state === "UNCONFIGURED" ? { state } : { state, provider: adapter }) as CapabilityRegistration;
  const service = new PaymentRecoveryService(store, () => now, new OperationalIndicators(metrics), new CapabilityRegistry({ ONLINE_PAYMENT: registration }));
  return { store, metrics, service };
};

/** Validates: Requirements 11.3, 11.4, 14.2, 14.4 */
describe("PaymentRecoveryService checkout, status check, and cancel", () => {
  it("opens a checkout only for the paying Farmer, a pending intent, a configured provider, and inside the window", async () => {
    const { adapter } = fakeAdapter({});
    const { store, service } = setup(adapter);
    store.intents = [intent("PENDING", new Date(now.getTime() - 5 * 60_000))];
    const view = await service.getCheckout(farmer, "payment-1", context);
    expect(view).toMatchObject({ bookingId: "booking-1", checkout: { providerReference: "order_KtUnit00001", testMode: true } });
    expect(view.checkoutExpiresAt).toEqual(new Date(now.getTime() + 10 * 60_000));
    await expect(service.getCheckout(stranger, "payment-1", context)).rejects.toMatchObject({ code: "PAYMENT_NOT_FOUND" });

    store.intents = [intent("PENDING", new Date(now.getTime() - 15 * 60_000))];
    await expect(service.getCheckout(farmer, "payment-1", context)).rejects.toMatchObject({ code: "PAYMENT_CHECKOUT_EXPIRED" });
    store.intents = [intent("PAYMENT_FAILED")];
    await expect(service.getCheckout(farmer, "payment-1", context)).rejects.toMatchObject({ code: "PAYMENT_NOT_PENDING" });

    for (const state of ["UNCONFIGURED", "DEGRADED"] as const) {
      const degraded = setup(adapter, state);
      degraded.store.intents = [intent("PENDING", new Date(now.getTime() - 60_000))];
      await expect(degraded.service.getCheckout(farmer, "payment-1", context)).rejects.toBeInstanceOf(CapabilityUnavailableError);
    }
  });

  it("confirms a capture the provider reports, as API evidence, without releasing anything", async () => {
    const { adapter } = fakeAdapter({ intent: snapshot([{ providerPaymentId: "pay_KtUnit00001", state: "CAPTURED", captured: true, amountPaise: 120_000, currency: "INR" }]) });
    const { store, service } = setup(adapter);
    store.intents = [intent()];
    await service.checkStatus(farmer, "payment-1", context);
    expect(store.events).toEqual([expect.objectContaining({
      providerEventId: "api:payment.captured:pay_KtUnit00001", kind: "PAYMENT_CONFIRMED", evidenceSource: "PROVIDER_API",
      providerReference: "order_KtUnit00001", amountPaise: 120_000, payloadDigest: "api:intent",
    })]);
    expect(store.releases).toEqual([]);
  });

  it("never releases on a status check, refuses a cancel while a payment is in flight, and still reads in DEGRADED", async () => {
    const quiet = setup(fakeAdapter({ intent: snapshot() }).adapter);
    expect(await quiet.service.checkStatus(farmer, "payment-1", context)).toMatchObject({ released: false, confirmation: "AWAITING_PROVIDER_CONFIRMATION" });
    expect(quiet.store.releases).toEqual([]);

    const busy = setup(fakeAdapter({ intent: snapshot([{ providerPaymentId: "pay_KtUnit00001", state: "AUTHORIZED", captured: false, amountPaise: 120_000, currency: "INR" }]) }).adapter);
    await expect(busy.service.cancel(farmer, "payment-1", context)).rejects.toMatchObject({ code: "PAYMENT_IN_PROGRESS" });
    expect(busy.store.releases).toEqual([]);

    const degraded = setup(fakeAdapter({ intent: snapshot() }).adapter, "DEGRADED");
    expect(await degraded.service.cancel(farmer, "payment-1", context)).toMatchObject({ released: true, payment: { status: "PAYMENT_FAILED" } });
    expect(degraded.store.releases).toEqual([expect.objectContaining({ reason: "CANCELLED", actorId: "farmer-1", providerEvidenceDigest: "api:intent" })]);
  });

  it("changes nothing when the provider cannot be read", async () => {
    const { store, metrics, service } = setup(fakeAdapter({ intent: new OnlinePaymentProviderError("PROVIDER_UNAVAILABLE", true) }).adapter);
    await expect(service.cancel(farmer, "payment-1", context)).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE", retryable: true });
    expect(store.releases).toEqual([]);
    expect(metrics.value("kt_payment_recovery_total", { subject: "INTENT", outcome: "PROVIDER_ERROR" })).toBe(1);
  });
});

/** Validates: Requirements 11.1, 11.6, 11.7, 18.2 */
describe("PaymentRecoveryService reconciliation", () => {
  it("releases only stale intents without a successful payment and counts every outcome", async () => {
    const { store, metrics, service } = setup(fakeAdapter({ intent: snapshot() }).adapter);
    store.intents = [intent("PENDING", new Date(now.getTime() - 46 * 60_000))];
    expect(await service.recoverPendingIntents(context)).toMatchObject({ checked: 1, outcomes: { RELEASED: 1 } });
    expect(store.releases).toEqual([expect.objectContaining({ reason: "EXPIRED", paymentId: "payment-1" })]);
    expect(metrics.value("kt_payment_recovery_total", { subject: "INTENT", outcome: "RELEASED" })).toBe(1);

    const young = setup(fakeAdapter({ intent: snapshot() }).adapter);
    young.store.intents = [intent("PENDING", new Date(now.getTime() - 20 * 60_000))];
    expect(await young.service.recoverPendingIntents(context)).toMatchObject({ outcomes: { STILL_PENDING: 1 } });
    expect(young.store.checked).toEqual(["payment-1"]);

    const mismatch = setup(fakeAdapter({ intent: { ...snapshot(), orderState: "PAID" } }).adapter);
    expect(await mismatch.service.recoverPendingIntents(context)).toMatchObject({ outcomes: { MISMATCH: 1 } });
    expect(mismatch.metrics.value("kt_payment_verification_failures_total", { method: "ONLINE", reason: "RECONCILIATION_MISMATCH" })).toBe(1);
    expect(mismatch.store.releases).toEqual([]);

    const unconfigured = setup(undefined, "UNCONFIGURED");
    expect(await unconfigured.service.recoverPendingIntents(context)).toEqual({ checked: 0, outcomes: {} });
  });

  const requested: RefundSubmissionSource = {
    refundId: "refund-1", paymentId: "payment-1", bookingId: "booking-1", provider: "razorpay", providerPaymentId: "pay_KtUnit00001",
    refundKey: "ktrf0123456789abcdef0123456789abcdef", amountPaise: 120_000, currency: "INR", status: "REQUESTED",
    requestedAt: new Date(now.getTime() - 5 * 60_000), submitAttempts: 0,
  };
  const providerRefund: ProviderRefundSnapshot = {
    providerRefundId: "rfnd_KtUnit00001", providerPaymentId: "pay_KtUnit00001", amountPaise: 120_000, currency: "INR", state: "PENDING",
  };

  it("links a submitted refund, and treats an unknown outcome as retryable with the same key", async () => {
    const accepted = setup(fakeAdapter({ refund: providerRefund }).adapter);
    accepted.store.refunds = [requested];
    expect(await accepted.service.submitRefund("refund-1", context)).toBe("SUBMITTED");
    expect(accepted.store.submissions).toEqual([expect.objectContaining({ refundId: "refund-1", providerRefundId: "rfnd_KtUnit00001" })]);
    expect(accepted.store.events).toEqual([]);

    const unknown = setup(fakeAdapter({ refund: new OnlinePaymentProviderError("PROVIDER_TIMEOUT", true) }).adapter);
    unknown.store.refunds = [requested];
    expect(await unknown.service.submitRefund("refund-1", context)).toBe("PROVIDER_ERROR");
    expect(unknown.store.submissions).toEqual([expect.objectContaining({ refundId: "refund-1", errorCode: "PROVIDER_TIMEOUT" })]);
    expect(unknown.store.events).toEqual([]);
  });

  it("records a definite refusal as a failed refund only when the provider holds no refund under the key", async () => {
    const refused = setup(fakeAdapter({ refund: new OnlinePaymentProviderError("PROVIDER_REJECTED_REQUEST", false) }).adapter);
    refused.store.refunds = [requested];
    refused.store.eventOutcome = { disposition: "APPLIED", refundStatus: "FAILED", paymentStatus: "PAID_ONLINE" };
    expect(await refused.service.submitRefund("refund-1", context)).toBe("REFUND_FAILED");
    expect(refused.store.events).toEqual([expect.objectContaining({
      kind: "REFUND_FAILED", providerEventId: "api:refund.rejected:refund-1", paymentRefundId: "refund-1", amountPaise: 120_000,
    })]);

    const existing = fakeAdapter({ refund: new OnlinePaymentProviderError("PROVIDER_REJECTED_REQUEST", false), found: { ...providerRefund, state: "PROCESSED" } });
    const found = setup(existing.adapter);
    found.store.refunds = [requested];
    found.store.eventOutcome = { disposition: "APPLIED", refundStatus: "PROCESSED", paymentStatus: "REFUNDED" };
    expect(await found.service.submitRefund("refund-1", context)).toBe("REFUNDED");
    expect(found.store.events).toEqual([expect.objectContaining({ kind: "REFUND_CONFIRMED", providerRefundId: "rfnd_KtUnit00001" })]);
    expect(existing.calls).toEqual(["createRefund", "findRefund"]);
  });

  it("does not submit refunds while the capability is not SANDBOX or LIVE", async () => {
    const { adapter, calls } = fakeAdapter({ refund: providerRefund });
    const degraded = setup(adapter, "DEGRADED");
    degraded.store.refunds = [requested];
    expect(await degraded.service.submitRefund("refund-1", context)).toBe("SKIPPED");
    expect(calls).toEqual([]);
  });
});

/** Validates: Requirements 2.3, 11.7, 12.4 */
describe("PaymentRefundService authorization", () => {
  const receiptSource: PaymentReceiptRecordSource = {
    booking: { ...booking, status: "DISPUTED" },
    invoice: { id: "invoice-1", bookingId: "booking-1", invoiceVersion: 1, status: "ISSUED", totalPaise: 120_000, currency: "INR" },
    invoiceSuperseded: false,
    payment: payment("PAID_ONLINE"),
    invoicePayments: [payment("PAID_ONLINE")],
  };
  const store = (requests: ValidatedRefundRequest[]) => ({
    loadReceiptSource: async () => receiptSource,
    requestRefund: async (input: ValidatedRefundRequest): Promise<RefundRequestResult> => {
      requests.push(input);
      return {
        refund: { id: "refund-1", paymentId: input.paymentId, bookingId: "booking-1", status: "REQUESTED", amountPaise: 120_000,
          currency: "INR", reasonCode: input.reasonCode, requestedAt: now },
        payment: { id: "payment-1", invoiceId: "invoice-1", method: "ONLINE", status: "REFUND_PENDING", amountPaise: 120_000, currency: "INR", recordedAt: now },
        bookingStatus: "REFUND_PENDING",
      };
    },
    loadRefundSubmission: async () => undefined,
    recordRefundSubmission: async () => undefined,
  });
  const command = { paymentId: "payment-1", reasonCode: "DISPUTE_RESOLVED", idempotencyKey: "refund-key-1" };
  const registry = new CapabilityRegistry({ ONLINE_PAYMENT: { state: "SANDBOX", provider: fakeAdapter({}).adapter } });
  const allowAll: SupportAccessPolicy = { hasExplicitAccess: async () => true };

  it("is denied to everyone by default, to non-operators, and to operators without a grant", async () => {
    const requests: ValidatedRefundRequest[] = [];
    const submit = { submitRefund: async () => "SKIPPED" as const };
    const denied = new PaymentRefundService(store(requests), submit, new DenyAllSupportAccessPolicy(), () => now, undefined, registry);
    await expect(denied.requestRefund(operator, command, context)).rejects.toMatchObject({ code: "PAYMENT_NOT_FOUND" });
    const permissive = new PaymentRefundService(store(requests), submit, allowAll, () => now, undefined, registry);
    for (const principal of [farmer, { ...farmer, roles: ["OWNER" as const] }]) {
      await expect(permissive.requestRefund(principal, command, context)).rejects.toMatchObject({ code: "PAYMENT_NOT_FOUND" });
    }
    expect(requests).toEqual([]);
  });

  it("records a granted support request as SUPPORT, then submits it", async () => {
    const requests: ValidatedRefundRequest[] = [];
    const submitted: string[] = [];
    const service = new PaymentRefundService(store(requests), { submitRefund: async (id: string) => { submitted.push(id); return "SUBMITTED" as const; } },
      allowAll, () => now, undefined, registry);
    expect(await service.requestRefund(operator, command, context)).toMatchObject({ refund: { id: "refund-1" }, bookingStatus: "REFUND_PENDING" });
    expect(requests).toEqual([expect.objectContaining({ actorId: "support-1", actorRole: "SUPPORT", provider: "razorpay", reasonCode: "DISPUTE_RESOLVED" })]);
    expect(submitted).toEqual(["refund-1"]);
    const unconfigured = new PaymentRefundService(store(requests), { submitRefund: async () => "SKIPPED" as const }, allowAll, () => now, undefined,
      new CapabilityRegistry({ ONLINE_PAYMENT: { state: "UNCONFIGURED" } }));
    await expect(unconfigured.requestRefund(operator, command, context)).rejects.toBeInstanceOf(CapabilityUnavailableError);
  });
});

/** Validates: Requirements 2.4, 2.5, 11.8, 12.2, 18.3 */
describe("PaymentHistoryService", () => {
  const row = (index: number, overrides: Partial<PaymentHistoryRow> = {}): PaymentHistoryRow => ({
    payment: { ...payment("PAID_ONLINE"), id: `a0000000-0000-4000-8000-00000000000${index}`, verifiedAt: now },
    booking,
    invoiceVersion: 1,
    invoiceTotalPaise: 120_000,
    invoiceAppliedPaise: 120_000,
    cursorCreatedAt: `2026-03-01T10:00:0${index}.123456Z`,
    ...overrides,
  });

  it("pages with a keyset cursor, projects only party-safe fields, and never shows another party's rows", async () => {
    const queries: PaymentHistoryQuery[] = [];
    const rows = [row(3), row(2, { invoiceAppliedPaise: 60_000 }), row(1, { booking: { ...booking, customerId: "farmer-9" } })];
    const service = new PaymentHistoryService({
      listPaymentHistory: async (query) => {
        queries.push(query);
        const after = query.after;
        return rows.filter((candidate) => after === undefined || candidate.cursorCreatedAt < after.createdAt).slice(0, query.limit);
      },
    });
    const first = await service.list(farmer, "FARMER", { limit: 2 }, context);
    expect(first.items.map((item) => [item.id.at(-1), item.receiptAvailable, item.testMode])).toEqual([["3", true, true], ["2", false, true]]);
    expect(JSON.stringify(first)).not.toMatch(/order_|provider/u);
    expect(queries[0]).toEqual({ partyRole: "FARMER", partyId: "farmer-1", limit: 3 });
    const second = await service.list(farmer, "FARMER", { limit: 2, cursor: first.nextCursor! }, context);
    expect(queries[1]?.after).toEqual({ createdAt: "2026-03-01T10:00:02.123456Z", id: "a0000000-0000-4000-8000-000000000002" });
    // The third row names another Farmer; defence in depth drops it.
    expect(second).toEqual({ items: [] });
    await expect(service.list(farmer, "OWNER", {}, context)).rejects.toMatchObject({ code: "PAYMENT_NOT_FOUND" });
    await expect(service.list(farmer, "FARMER", { cursor: "bogus" }, context)).rejects.toMatchObject({ field: "cursor" });
    await expect(service.list(farmer, "FARMER", { limit: 51 }, context)).rejects.toMatchObject({ field: "limit" });
  });
});
