import { describe, expect, it } from "vitest";

import {
  evaluateProviderPaymentEvent,
  evaluateProviderRefundEvent,
  type ProviderEventPaymentTarget,
  type ProviderEventRefundTarget,
  type ProviderPaymentEventFacts,
} from "./provider-payment-events.js";

const pending: ProviderEventPaymentTarget = {
  method: "ONLINE", status: "PENDING", amountPaise: 120_000, currency: "INR", providerReference: "order_A1",
};
type FactOverrides = { [Key in keyof ProviderPaymentEventFacts]?: ProviderPaymentEventFacts[Key] | undefined };

/** Builds event facts; an override of `undefined` removes that fact. */
const confirmed = (overrides: FactOverrides = {}): ProviderPaymentEventFacts => {
  const facts: Record<string, unknown> = {
    kind: "PAYMENT_CONFIRMED", providerEventId: "evt_1", providerReference: "order_A1", amountPaise: 120_000, currency: "INR",
    ...overrides,
  };
  for (const key of Object.keys(facts)) if (facts[key] === undefined) delete facts[key];
  return facts as unknown as ProviderPaymentEventFacts;
};

/** Validates: Requirements 11.4, 11.5, 11.6 */
describe("evaluateProviderPaymentEvent", () => {
  it("marks a pending intent paid online only when reference, currency, and amount all match", () => {
    expect(evaluateProviderPaymentEvent(pending, confirmed())).toEqual({
      outcome: "APPLY", toStatus: "PAID_ONLINE", eventType: "ONLINE_PAYMENT_CONFIRMED",
    });
    expect(evaluateProviderPaymentEvent(pending, confirmed({ providerReference: "order_B2" })))
      .toMatchObject({ outcome: "REJECT", code: "REFERENCE_MISMATCH" });
    expect(evaluateProviderPaymentEvent(pending, confirmed({ providerReference: undefined })))
      .toMatchObject({ outcome: "REJECT", code: "REFERENCE_MISMATCH" });
    expect(evaluateProviderPaymentEvent(pending, confirmed({ currency: "USD" })))
      .toMatchObject({ outcome: "REJECT", code: "CURRENCY_MISMATCH" });
    expect(evaluateProviderPaymentEvent(pending, confirmed({ currency: undefined })))
      .toMatchObject({ outcome: "REJECT", code: "CURRENCY_MISMATCH" });
    for (const amountPaise of [119_999, 120_001, 1_200, undefined, 120_000.5]) {
      expect(evaluateProviderPaymentEvent(pending, confirmed({ amountPaise })), String(amountPaise))
        .toMatchObject({ outcome: "REJECT", code: "AMOUNT_MISMATCH" });
    }
  });

  it("rejects confirmations that name no platform intent, and ignores unmatched non-financial events", () => {
    expect(evaluateProviderPaymentEvent(undefined, confirmed())).toMatchObject({ outcome: "REJECT", code: "REFERENCE_MISMATCH" });
    expect(evaluateProviderPaymentEvent(undefined, confirmed({ kind: "PAYMENT_FAILED" })))
      .toMatchObject({ outcome: "REJECT", code: "REFERENCE_MISMATCH" });
    expect(evaluateProviderPaymentEvent(undefined, confirmed({ kind: "PAYMENT_ATTEMPT_FAILED" })))
      .toEqual({ outcome: "RECORD_ONLY", note: "UNMATCHED" });
    expect(evaluateProviderPaymentEvent(undefined, confirmed({ kind: "INFORMATIONAL" })))
      .toEqual({ outcome: "RECORD_ONLY", note: "UNMATCHED" });
    // A cash record can never be settled by a provider event.
    expect(evaluateProviderPaymentEvent({ ...pending, method: "CASH", status: "PAID_CASH" }, confirmed()))
      .toMatchObject({ outcome: "REJECT", code: "REFERENCE_MISMATCH" });
  });

  it("applies a second confirmation, a late failure, or an attempt failure with no financial effect", () => {
    for (const status of ["PAID_ONLINE", "REFUND_PENDING", "REFUNDED"] as const) {
      expect(evaluateProviderPaymentEvent({ ...pending, status }, confirmed())).toEqual({ outcome: "RECORD_ONLY", note: "ALREADY_APPLIED" });
      expect(evaluateProviderPaymentEvent({ ...pending, status }, confirmed({ kind: "PAYMENT_FAILED" })))
        .toEqual({ outcome: "RECORD_ONLY", note: "ALREADY_FINAL" });
    }
    // A declined attempt leaves the order payable, so the intent stays pending.
    expect(evaluateProviderPaymentEvent(pending, confirmed({ kind: "PAYMENT_ATTEMPT_FAILED", amountPaise: 1 })))
      .toEqual({ outcome: "RECORD_ONLY", note: "ATTEMPT_FAILED" });
    expect(evaluateProviderPaymentEvent(pending, confirmed({ kind: "INFORMATIONAL" })))
      .toEqual({ outcome: "RECORD_ONLY", note: "INFORMATIONAL" });
  });

  it("closes a pending intent on a terminal failure and flags money captured after closure", () => {
    expect(evaluateProviderPaymentEvent(pending, confirmed({ kind: "PAYMENT_FAILED" }))).toMatchObject({
      outcome: "APPLY", toStatus: "PAYMENT_FAILED", eventType: "ONLINE_PAYMENT_FAILED",
    });
    expect(evaluateProviderPaymentEvent({ ...pending, status: "PAYMENT_FAILED" }, confirmed({ kind: "PAYMENT_FAILED" })))
      .toEqual({ outcome: "RECORD_ONLY", note: "ALREADY_FINAL" });
    expect(evaluateProviderPaymentEvent({ ...pending, status: "PAYMENT_FAILED" }, confirmed()))
      .toMatchObject({ outcome: "REJECT", code: "PAYMENT_LEDGER_INCONSISTENT" });
  });

  it("accepts a late capture for a released intent only while the bill still has room for it", () => {
    const released = { ...pending, status: "PAYMENT_FAILED" as const };
    expect(evaluateProviderPaymentEvent(released, confirmed(), { lateConfirmationCapacityPaise: 120_000 })).toEqual({
      outcome: "APPLY", toStatus: "PAID_ONLINE", eventType: "ONLINE_PAYMENT_LATE_CONFIRMED",
    });
    for (const capacity of [0, 119_999]) {
      expect(evaluateProviderPaymentEvent(released, confirmed(), { lateConfirmationCapacityPaise: capacity }))
        .toMatchObject({ outcome: "REJECT", code: "PAYMENT_LEDGER_INCONSISTENT" });
    }
    // The reference, currency, and amount checks still come first.
    expect(evaluateProviderPaymentEvent(released, confirmed({ amountPaise: 1 }), { lateConfirmationCapacityPaise: 120_000 }))
      .toMatchObject({ outcome: "REJECT", code: "AMOUNT_MISMATCH" });
  });

  it("flags a second captured payment on an intent that is already paid", () => {
    const paid = { ...pending, status: "PAID_ONLINE" as const, providerPaymentId: "pay_First0001" };
    expect(evaluateProviderPaymentEvent(paid, confirmed({ providerPaymentId: "pay_First0001" })))
      .toEqual({ outcome: "RECORD_ONLY", note: "ALREADY_APPLIED" });
    expect(evaluateProviderPaymentEvent(paid, confirmed({ providerPaymentId: "pay_Second002" })))
      .toMatchObject({ outcome: "REJECT", code: "PAYMENT_LEDGER_INCONSISTENT" });
  });

  it("leaves refund events to the refund evaluator", () => {
    expect(evaluateProviderPaymentEvent(pending, confirmed({ kind: "REFUND_CONFIRMED" })))
      .toEqual({ outcome: "RECORD_ONLY", note: "INFORMATIONAL" });
  });
});

/** Validates: Requirements 11.5, 11.6, 11.7 */
describe("evaluateProviderRefundEvent", () => {
  const refund: ProviderEventRefundTarget = {
    status: "SUBMITTED", amountPaise: 120_000, currency: "INR", providerPaymentId: "pay_A1", providerRefundId: "rfnd_A1",
    payment: { method: "ONLINE", status: "REFUND_PENDING" },
  };
  const refundEvent = (overrides: FactOverrides = {}) => confirmed({
    kind: "REFUND_CONFIRMED", providerPaymentId: "pay_A1", providerRefundId: "rfnd_A1", providerReference: undefined, ...overrides,
  });

  it("finishes a requested refund as processed or failed from matching provider evidence", () => {
    expect(evaluateProviderRefundEvent(refund, refundEvent())).toEqual({
      outcome: "APPLY", refundStatus: "PROCESSED", paymentStatus: "REFUNDED", eventType: "REFUND_CONFIRMED",
    });
    const { providerRefundId: _submittedId, ...requested } = refund;
    expect(evaluateProviderRefundEvent({ ...requested, status: "REQUESTED" }, refundEvent({ kind: "REFUND_FAILED" })))
      .toEqual({ outcome: "APPLY", refundStatus: "FAILED", paymentStatus: "PAID_ONLINE", eventType: "REFUND_FAILED" });
  });

  it("rejects refunds nobody requested and evidence that does not match the request", () => {
    expect(evaluateProviderRefundEvent(undefined, refundEvent())).toMatchObject({ outcome: "REJECT", code: "PAYMENT_LEDGER_INCONSISTENT" });
    expect(evaluateProviderRefundEvent(refund, refundEvent({ providerPaymentId: "pay_B2" })))
      .toMatchObject({ outcome: "REJECT", code: "REFERENCE_MISMATCH" });
    expect(evaluateProviderRefundEvent(refund, refundEvent({ providerRefundId: "rfnd_B2" })))
      .toMatchObject({ outcome: "REJECT", code: "REFERENCE_MISMATCH" });
    expect(evaluateProviderRefundEvent(refund, refundEvent({ amountPaise: 120_001 }))).toMatchObject({ outcome: "REJECT", code: "AMOUNT_MISMATCH" });
    expect(evaluateProviderRefundEvent(refund, refundEvent({ currency: "USD" }))).toMatchObject({ outcome: "REJECT", code: "CURRENCY_MISMATCH" });
    expect(evaluateProviderRefundEvent({ ...refund, payment: { method: "ONLINE", status: "PAID_ONLINE" } }, refundEvent()))
      .toMatchObject({ outcome: "REJECT", code: "PAYMENT_LEDGER_INCONSISTENT" });
  });

  it("gives repeated and out-of-order refund events no further effect", () => {
    const processed = { ...refund, status: "PROCESSED" as const, payment: { method: "ONLINE" as const, status: "REFUNDED" as const } };
    expect(evaluateProviderRefundEvent(processed, refundEvent())).toEqual({ outcome: "RECORD_ONLY", note: "ALREADY_APPLIED" });
    expect(evaluateProviderRefundEvent(processed, refundEvent({ kind: "REFUND_FAILED" }))).toEqual({ outcome: "RECORD_ONLY", note: "ALREADY_FINAL" });
    const failed = { ...refund, status: "FAILED" as const, payment: { method: "ONLINE" as const, status: "PAID_ONLINE" as const } };
    expect(evaluateProviderRefundEvent(failed, refundEvent({ kind: "REFUND_FAILED" }))).toEqual({ outcome: "RECORD_ONLY", note: "ALREADY_APPLIED" });
    expect(evaluateProviderRefundEvent(failed, refundEvent())).toMatchObject({ outcome: "REJECT", code: "PAYMENT_LEDGER_INCONSISTENT" });
  });
});
