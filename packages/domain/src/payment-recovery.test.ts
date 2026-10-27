import { describe, expect, it } from "vitest";

import {
  defaultPendingIntentRecoveryPolicy,
  planPendingIntentRecovery,
  planRefundReconciliation,
  validatePendingIntentRecoveryPolicy,
  type ProviderIntentPaymentSnapshot,
  type ProviderIntentSnapshot,
} from "./payment-recovery.js";

const createdAt = new Date("2026-03-01T10:00:00.000Z");
const minutes = (count: number) => new Date(createdAt.getTime() + count * 60_000);
const intent = { status: "PENDING" as const, amountPaise: 120_000, currency: "INR", providerReference: "order_A1", createdAt };
const attempt = (state: ProviderIntentPaymentSnapshot["state"], overrides: Partial<ProviderIntentPaymentSnapshot> = {}) => ({
  providerPaymentId: "pay_A1", state, captured: state === "CAPTURED", amountPaise: 120_000, currency: "INR", ...overrides,
});
const snapshot = (payments: ProviderIntentPaymentSnapshot[], overrides: Partial<ProviderIntentSnapshot> = {}): ProviderIntentSnapshot => ({
  providerReference: "order_A1", amountPaise: 120_000, currency: "INR", orderState: payments.length > 0 ? "ATTEMPTED" : "OPEN",
  payments, ...overrides,
});

/** Validates: Requirements 11.1, 11.4, 11.5, 11.7 */
describe("planPendingIntentRecovery", () => {
  it("confirms only a single captured payment that matches the intent", () => {
    expect(planPendingIntentRecovery(intent, snapshot([attempt("FAILED"), attempt("CAPTURED", { providerPaymentId: "pay_B2" })]),
      "STATUS_CHECK", minutes(1))).toEqual({ action: "CONFIRM", providerPaymentId: "pay_B2", amountPaise: 120_000, currency: "INR" });
    expect(planPendingIntentRecovery(intent, snapshot([attempt("CAPTURED", { amountPaise: 1 })]), "RECONCILIATION", minutes(60)))
      .toMatchObject({ action: "MISMATCH", code: "AMOUNT_MISMATCH" });
    expect(planPendingIntentRecovery(intent, snapshot([attempt("CAPTURED"), attempt("CAPTURED", { providerPaymentId: "pay_B2" })]),
      "RECONCILIATION", minutes(60))).toMatchObject({ action: "MISMATCH", code: "RECONCILIATION_MISMATCH" });
    expect(planPendingIntentRecovery(intent, snapshot([attempt("REFUNDED", { captured: true })]), "RECONCILIATION", minutes(60)))
      .toMatchObject({ action: "MISMATCH", code: "RECONCILIATION_MISMATCH" });
    expect(planPendingIntentRecovery(intent, snapshot([], { orderState: "PAID" }), "RECONCILIATION", minutes(60)))
      .toMatchObject({ action: "MISMATCH", code: "RECONCILIATION_MISMATCH" });
    expect(planPendingIntentRecovery(intent, snapshot([], { providerReference: "order_B2" }), "RECONCILIATION", minutes(60)))
      .toMatchObject({ action: "MISMATCH", code: "REFERENCE_MISMATCH" });
  });

  it("never releases an intent while a payment is in flight", () => {
    for (const trigger of ["RECONCILIATION", "FARMER_CANCEL", "STATUS_CHECK"] as const) {
      expect(planPendingIntentRecovery(intent, snapshot([attempt("AUTHORIZED")]), trigger, minutes(10_000)))
        .toEqual({ action: "WAIT", reason: "IN_PROGRESS" });
    }
    expect(planPendingIntentRecovery(intent, snapshot([attempt("CREATED")]), "FARMER_CANCEL", minutes(10_000)))
      .toEqual({ action: "WAIT", reason: "IN_PROGRESS" });
    expect(planPendingIntentRecovery(intent, snapshot([attempt("CREATED")]), "RECONCILIATION", minutes(24 * 60 - 1)))
      .toEqual({ action: "WAIT", reason: "IN_PROGRESS" });
    expect(planPendingIntentRecovery(intent, snapshot([attempt("CREATED")]), "RECONCILIATION", minutes(24 * 60)))
      .toEqual({ action: "RELEASE", reason: "EXPIRED" });
  });

  it("releases an abandoned intent on cancel at any age, and on reconciliation only once it is stale", () => {
    const abandoned = snapshot([attempt("FAILED"), attempt("REFUNDED", { captured: false, providerPaymentId: "pay_C3" })]);
    expect(planPendingIntentRecovery(intent, abandoned, "FARMER_CANCEL", minutes(1))).toEqual({ action: "RELEASE", reason: "CANCELLED" });
    expect(planPendingIntentRecovery(intent, abandoned, "RECONCILIATION", minutes(44))).toEqual({ action: "WAIT", reason: "NOT_STALE" });
    expect(planPendingIntentRecovery(intent, abandoned, "RECONCILIATION", minutes(45))).toEqual({ action: "RELEASE", reason: "EXPIRED" });
    expect(planPendingIntentRecovery(intent, snapshot([]), "STATUS_CHECK", minutes(10_000))).toEqual({ action: "WAIT", reason: "NOT_STALE" });
    expect(planPendingIntentRecovery({ ...intent, status: "PAID_ONLINE" }, snapshot([]), "RECONCILIATION", minutes(60)))
      .toEqual({ action: "WAIT", reason: "NOT_PENDING" });
  });

  it("requires the release age to leave room for the checkout window", () => {
    expect(validatePendingIntentRecoveryPolicy(defaultPendingIntentRecoveryPolicy)).toEqual(defaultPendingIntentRecoveryPolicy);
    expect(() => validatePendingIntentRecoveryPolicy({ ...defaultPendingIntentRecoveryPolicy, releaseAfterMs: 20 * 60_000 })).toThrow(RangeError);
    expect(() => validatePendingIntentRecoveryPolicy({ ...defaultPendingIntentRecoveryPolicy, checkoutWindowMs: 0 })).toThrow(RangeError);
  });
});

/** Validates: Requirements 11.1, 11.6, 11.7 */
describe("planRefundReconciliation", () => {
  const refund = { status: "SUBMITTED" as const, amountPaise: 120_000, currency: "INR", providerPaymentId: "pay_A1", providerRefundId: "rfnd_A1" };
  const provider = { providerRefundId: "rfnd_A1", providerPaymentId: "pay_A1", amountPaise: 120_000, currency: "INR", state: "PROCESSED" as const };

  const { providerRefundId: _submittedId, ...unsubmitted } = refund;
  const requested = { ...unsubmitted, status: "REQUESTED" as const };

  it("submits an unknown requested refund, links a pending one, and finishes a final one", () => {
    expect(planRefundReconciliation(requested, undefined)).toEqual({ action: "SUBMIT" });
    expect(planRefundReconciliation(requested, { ...provider, state: "PENDING" }))
      .toEqual({ action: "LINK", providerRefundId: "rfnd_A1" });
    expect(planRefundReconciliation(refund, { ...provider, state: "PENDING" })).toEqual({ action: "WAIT" });
    expect(planRefundReconciliation(refund, provider)).toEqual({ action: "APPLY", kind: "REFUND_CONFIRMED", providerRefundId: "rfnd_A1" });
    expect(planRefundReconciliation(refund, { ...provider, state: "FAILED" })).toEqual({ action: "APPLY", kind: "REFUND_FAILED", providerRefundId: "rfnd_A1" });
    expect(planRefundReconciliation({ ...refund, status: "PROCESSED" }, provider)).toEqual({ action: "WAIT" });
  });

  it("flags provider refunds that disagree with the platform's request", () => {
    expect(planRefundReconciliation(refund, undefined)).toMatchObject({ action: "MISMATCH", code: "RECONCILIATION_MISMATCH" });
    expect(planRefundReconciliation(refund, { ...provider, amountPaise: 1 })).toMatchObject({ action: "MISMATCH", code: "AMOUNT_MISMATCH" });
    expect(planRefundReconciliation(refund, { ...provider, providerPaymentId: "pay_B2" })).toMatchObject({ action: "MISMATCH", code: "REFERENCE_MISMATCH" });
    expect(planRefundReconciliation(refund, { ...provider, currency: "USD" })).toMatchObject({ action: "MISMATCH", code: "CURRENCY_MISMATCH" });
  });
});
