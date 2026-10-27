import { describe, expect, it } from "vitest";

import type { AuthPrincipal } from "./identity.js";
import {
  evaluatePaymentApplication,
  evaluateRefundRequest,
  lateConfirmationCapacity,
  MAX_PAYMENT_RECORDS_PER_INVOICE,
  PaymentAccessDeniedError,
  planPaymentTransition,
  projectPaymentReceipt,
  projectPaymentRecord,
  summarizeInvoiceSettlement,
  type PayableInvoice,
  type PaymentLedgerEntry,
  type PaymentReceiptSource,
} from "./payments.js";

const invoice: PayableInvoice = { id: "invoice-1", totalPaise: 120_000, currency: "INR", status: "ISSUED", superseded: false };
const parties = { customerId: "farmer-1", ownerId: "owner-1" };
const open = { disputed: false };
let sequence = 0;
const entry = (overrides: Partial<PaymentLedgerEntry>): PaymentLedgerEntry => ({
  id: `payment-${++sequence}`,
  method: "CASH",
  status: "PAID_CASH",
  amountPaise: 60_000,
  currency: "INR",
  createdAt: new Date(Date.UTC(2026, 2, 1, 10, sequence)),
  ...overrides,
});
const cashByOwner = { method: "CASH" as const, amountPaise: 60_000, currency: "INR", actorId: "owner-1", actorRole: "OWNER" as const };

/** Validates: Requirements 11.1, 11.2, 11.7, 10.8 */
describe("summarizeInvoiceSettlement", () => {
  it("distinguishes awaiting-final-bill, payment-due, and settled cash states with exact paise", () => {
    expect(summarizeInvoiceSettlement(undefined, [], open)).toMatchObject({ status: "AWAITING_FINAL_BILL", settled: false });
    expect(summarizeInvoiceSettlement(invoice, [], open)).toMatchObject({
      status: "PAYMENT_DUE", settled: false, appliedPaise: 0, outstandingPaise: 120_000,
    });
    expect(summarizeInvoiceSettlement(invoice, [entry({})], open)).toMatchObject({
      status: "PAYMENT_DUE", settled: false, appliedPaise: 60_000, outstandingPaise: 60_000,
    });
    expect(summarizeInvoiceSettlement(invoice, [entry({}), entry({})], open)).toMatchObject({
      status: "PAID_CASH", settled: true, appliedPaise: 120_000, outstandingPaise: 0, settlementMethods: ["CASH"],
    });
  });

  it("never labels cash as paid-online and reports mixed, pending, failed, refund, and zero-total states", () => {
    const online = entry({ method: "ONLINE", status: "PAID_ONLINE" });
    expect(summarizeInvoiceSettlement(invoice, [entry({}), online], open)).toMatchObject({
      status: "PAID_MIXED", settled: true, settlementMethods: ["CASH", "ONLINE"],
    });
    expect(summarizeInvoiceSettlement(invoice, [entry({ method: "ONLINE", status: "PENDING" })], open))
      .toMatchObject({ status: "PENDING", pendingPaise: 60_000, appliedPaise: 0 });
    expect(summarizeInvoiceSettlement(invoice, [entry({ method: "ONLINE", status: "PAYMENT_FAILED" })], open).status)
      .toBe("PAYMENT_FAILED");
    expect(summarizeInvoiceSettlement(invoice, [entry({ amountPaise: 120_000, status: "REFUND_PENDING" })], open))
      .toMatchObject({ status: "REFUND_PENDING", settled: true });
    expect(summarizeInvoiceSettlement(invoice, [entry({ amountPaise: 120_000, status: "REFUNDED" })], open))
      .toMatchObject({ status: "REFUNDED", settled: false, appliedPaise: 0 });
    expect(summarizeInvoiceSettlement({ ...invoice, totalPaise: 0 }, [], open)).toMatchObject({ status: "NOTHING_DUE", settled: true });
  });

  it("flags disputed settlement as blocked and rejects inconsistent ledgers", () => {
    expect(summarizeInvoiceSettlement(invoice, [], { disputed: true }))
      .toMatchObject({ settlementBlocked: true, blockedReason: "DISPUTED" });
    expect(() => summarizeInvoiceSettlement(invoice, [entry({ status: "PAID_ONLINE" })], open))
      .toThrow(expect.objectContaining({ code: "PAYMENT_LEDGER_INCONSISTENT" }));
    expect(() => summarizeInvoiceSettlement(invoice, [entry({ amountPaise: 120_001 })], open))
      .toThrow(expect.objectContaining({ code: "PAYMENT_LEDGER_INCONSISTENT" }));
  });
});

/** Validates: Requirements 11.2, 11.3, 11.7, 10.8 */
describe("evaluatePaymentApplication", () => {
  it("records cash confirmed by the assigned Owner as paid-cash and online intents as pending", () => {
    expect(evaluatePaymentApplication(invoice, [], cashByOwner, parties, open)).toMatchObject({
      initialStatus: "PAID_CASH", eventType: "CASH_PAYMENT_RECORDED",
      settlementAfter: { appliedPaise: 60_000, outstandingPaise: 60_000, settled: false },
    });
    const full = evaluatePaymentApplication(invoice, [entry({})], cashByOwner, parties, open);
    expect(full.settlementAfter).toMatchObject({ settled: true, status: "PAID_CASH" });
    expect(evaluatePaymentApplication(invoice, [], {
      method: "ONLINE", amountPaise: 120_000, currency: "INR", actorId: "farmer-1", actorRole: "FARMER",
    }, parties, open)).toMatchObject({ initialStatus: "PENDING", settlementAfter: { status: "PENDING", settled: false } });
  });

  it("prevents overpayment including amounts reserved by pending online payments", () => {
    expect(() => evaluatePaymentApplication(invoice, [entry({ amountPaise: 100_000 })], cashByOwner, parties, open))
      .toThrow(expect.objectContaining({ code: "PAYMENT_OVERPAYMENT" }));
    const reserved = [entry({ method: "ONLINE", status: "PENDING", amountPaise: 80_000 })];
    expect(() => evaluatePaymentApplication(invoice, reserved, cashByOwner, parties, open))
      .toThrow(expect.objectContaining({ code: "PAYMENT_OVERPAYMENT" }));
    expect(evaluatePaymentApplication(invoice, reserved, { ...cashByOwner, amountPaise: 40_000 }, parties, open)
      .settlementAfter.outstandingPaise).toBe(80_000);
    const failed = [entry({ method: "ONLINE", status: "PAYMENT_FAILED", amountPaise: 120_000 })];
    expect(evaluatePaymentApplication(invoice, failed, { ...cashByOwner, amountPaise: 120_000 }, parties, open)
      .settlementAfter.settled).toBe(true);
  });

  it("rejects disputed, superseded, unrelated, and malformed applications", () => {
    const rejects = (code: string, run: () => unknown) => expect(run).toThrow(expect.objectContaining({ code }));
    rejects("PAYMENT_SETTLEMENT_BLOCKED", () => evaluatePaymentApplication(invoice, [], cashByOwner, parties, { disputed: true }));
    rejects("PAYMENT_INVOICE_NOT_PAYABLE", () =>
      evaluatePaymentApplication({ ...invoice, superseded: true }, [], cashByOwner, parties, open));
    rejects("PAYMENT_INVOICE_REQUIRED", () => evaluatePaymentApplication(undefined, [], cashByOwner, parties, open));
    rejects("PAYMENT_ACTOR_NOT_PERMITTED", () =>
      evaluatePaymentApplication(invoice, [], { ...cashByOwner, actorId: "owner-2" }, parties, open));
    rejects("PAYMENT_ACTOR_NOT_PERMITTED", () =>
      evaluatePaymentApplication(invoice, [], { ...cashByOwner, actorId: "farmer-1", actorRole: "FARMER" }, parties, open));
    rejects("PAYMENT_INVALID_AMOUNT", () =>
      evaluatePaymentApplication(invoice, [], { ...cashByOwner, amountPaise: 10.5 }, parties, open));
    rejects("PAYMENT_CURRENCY_MISMATCH", () =>
      evaluatePaymentApplication(invoice, [], { ...cashByOwner, currency: "USD" }, parties, open));
    rejects("PAYMENT_INVOICE_NOT_PAYABLE", () =>
      evaluatePaymentApplication(invoice, [entry({ status: "REFUND_PENDING" })], cashByOwner, parties, open));
    const many = Array.from({ length: MAX_PAYMENT_RECORDS_PER_INVOICE },
      () => entry({ method: "ONLINE", status: "PAYMENT_FAILED", amountPaise: 1 }));
    rejects("PAYMENT_LIMIT_REACHED", () => evaluatePaymentApplication(invoice, many, cashByOwner, parties, open));
  });
});

/** Validates: Requirements 11.2, 11.4, 11.7 */
describe("planPaymentTransition", () => {
  it("requires verified provider evidence for paid-online and never moves cash online", () => {
    const pending = { method: "ONLINE" as const, status: "PENDING" as const };
    expect(() => planPaymentTransition(pending, "PAID_ONLINE", "FARMER"))
      .toThrow(expect.objectContaining({ code: "PAYMENT_ACTOR_NOT_PERMITTED" }));
    expect(() => planPaymentTransition(pending, "PAID_ONLINE", "PROVIDER"))
      .toThrow(expect.objectContaining({ code: "PAYMENT_EVIDENCE_REQUIRED" }));
    expect(planPaymentTransition(pending, "PAID_ONLINE", "PROVIDER", {
      evidence: { kind: "VERIFIED_PROVIDER_EVENT", providerEventId: "evt_1" },
    })).toMatchObject({ eventType: "ONLINE_PAYMENT_CONFIRMED" });
    expect(() => planPaymentTransition({ method: "CASH", status: "PAID_CASH" }, "PAID_ONLINE", "PROVIDER"))
      .toThrow(expect.objectContaining({ code: "PAYMENT_TRANSITION_NOT_ALLOWED" }));
  });

  it("models refund placeholders with reasons and terminal refunded state", () => {
    const cash = { method: "CASH" as const, status: "PAID_CASH" as const };
    expect(() => planPaymentTransition(cash, "REFUND_PENDING", "SUPPORT"))
      .toThrow(expect.objectContaining({ code: "PAYMENT_REASON_REQUIRED" }));
    expect(planPaymentTransition(cash, "REFUND_PENDING", "SUPPORT", { reason: "Dispute upheld" }).to).toBe("REFUND_PENDING");
    expect(() => planPaymentTransition({ method: "CASH", status: "REFUNDED" }, "PAID_CASH", "SUPPORT"))
      .toThrow(expect.objectContaining({ code: "PAYMENT_TRANSITION_NOT_ALLOWED" }));
  });
});

/** Validates: Requirements 11.8, 2.3, 2.4, 2.5, 12.2 */
describe("projectPaymentReceipt", () => {
  const farmer: AuthPrincipal = { userId: "farmer-1", sessionId: "s-1", roles: ["FARMER"] };
  const owner: AuthPrincipal = { userId: "owner-1", sessionId: "s-2", roles: ["OWNER"] };
  const payment = {
    id: "payment-9", invoiceId: "invoice-1", method: "CASH" as const, status: "PAID_CASH" as const,
    amountPaise: 120_000, currency: "INR", recordedByUserId: "owner-1",
    receivedAt: new Date("2026-03-01T12:00:00.000Z"), createdAt: new Date("2026-03-01T12:05:00.000Z"),
  };
  const source = (settled: boolean): PaymentReceiptSource => ({
    booking: { id: "booking-1", reference: "KT-2026-0001", ...parties },
    invoice: { id: "invoice-1", invoiceVersion: 2, totalPaise: 120_000, currency: "INR" },
    payment,
    settlement: summarizeInvoiceSettlement(invoice, settled ? [{ ...payment }] : [], open),
  });

  it("returns booking, invoice, method, amount, status, and timestamps to either related party", () => {
    const receipt = projectPaymentReceipt(farmer, "FARMER", source(true));
    expect(receipt).toEqual({
      bookingId: "booking-1", bookingReference: "KT-2026-0001", invoiceId: "invoice-1", invoiceVersion: 2,
      invoiceTotalPaise: 120_000, paymentId: "payment-9", method: "CASH", status: "PAID_CASH",
      settlementStatus: "PAID_CASH", amountPaise: 120_000, currency: "INR",
      paidAt: payment.receivedAt, recordedAt: payment.createdAt, confirmedBy: "OWNER",
    });
    expect(projectPaymentReceipt(owner, "OWNER", source(true)).paymentId).toBe("payment-9");
  });

  it("denies unrelated principals and role confusion, and withholds receipts until settlement", () => {
    const stranger: AuthPrincipal = { userId: "farmer-2", sessionId: "s-3", roles: ["FARMER", "OWNER"] };
    expect(() => projectPaymentReceipt(stranger, "FARMER", source(true))).toThrow(PaymentAccessDeniedError);
    expect(() => projectPaymentReceipt(owner, "FARMER", source(true))).toThrow(PaymentAccessDeniedError);
    expect(() => projectPaymentReceipt(undefined, "OWNER", source(true))).toThrow(PaymentAccessDeniedError);
    expect(() => projectPaymentReceipt(farmer, "FARMER", source(false)))
      .toThrow(expect.objectContaining({ code: "PAYMENT_RECEIPT_UNAVAILABLE" }));
  });
});

/** Validates: Requirements 11.1, 11.7, 12.4 */
describe("evaluateRefundRequest", () => {
  const paidOnline = { id: "payment-online", method: "ONLINE" as const, status: "PAID_ONLINE" as const, amountPaise: 120_000, currency: "INR" };
  const request = {
    payment: paidOnline, providerPaymentId: "pay_A1", bookingStatus: "DISPUTED", actorRole: "SUPPORT" as const, reasonCode: "DISPUTE_RESOLVED",
  };

  it("refunds the whole confirmed online payment for a disputed booking, once", () => {
    expect(evaluateRefundRequest(request)).toMatchObject({
      refundPaise: 120_000, currency: "INR", reasonCode: "DISPUTE_RESOLVED", bookingRefundRequested: true,
      rule: { from: "PAID_ONLINE", to: "REFUND_PENDING", eventType: "REFUND_REQUESTED" },
    });
    expect(evaluateRefundRequest({ ...request, bookingStatus: "REFUND_PENDING", amountPaise: 120_000 }))
      .toMatchObject({ refundPaise: 120_000, bookingRefundRequested: false });
    for (const status of ["PENDING", "REFUND_PENDING", "REFUNDED", "PAYMENT_FAILED"] as const) {
      expect(() => evaluateRefundRequest({ ...request, payment: { ...paidOnline, status } }), status)
        .toThrow(expect.objectContaining({ code: "PAYMENT_TRANSITION_NOT_ALLOWED" }));
    }
  });

  it("never refunds more than was paid, part of a payment, cash, or outside a dispute", () => {
    const code = (overrides: Record<string, unknown>) => {
      try {
        evaluateRefundRequest({ ...request, ...overrides });
        return undefined;
      } catch (error) {
        return (error as { code?: string }).code;
      }
    };
    expect(code({ amountPaise: 120_001 })).toBe("PAYMENT_REFUND_EXCEEDS_PAYMENT");
    expect(code({ amountPaise: 60_000 })).toBe("PAYMENT_PARTIAL_REFUND_UNSUPPORTED");
    expect(code({ amountPaise: 0 })).toBe("PAYMENT_INVALID_AMOUNT");
    expect(code({ payment: { ...paidOnline, method: "CASH", status: "PAID_CASH" } })).toBe("PAYMENT_REFUND_UNSUPPORTED");
    expect(code({ bookingStatus: "COMPLETED" })).toBe("PAYMENT_REFUND_NOT_ALLOWED");
    expect(code({ actorRole: "FARMER" })).toBe("PAYMENT_ACTOR_NOT_PERMITTED");
    expect(code({ actorRole: "OWNER" })).toBe("PAYMENT_ACTOR_NOT_PERMITTED");
    expect(code({ reasonCode: "because I said so" })).toBe("PAYMENT_REASON_REQUIRED");
    expect(code({ providerPaymentId: undefined })).toBe("PAYMENT_EVIDENCE_REQUIRED");
  });
});

/** Validates: Requirements 11.4, 11.7 */
describe("late confirmation and refund transitions", () => {
  const failed = { method: "ONLINE" as const, status: "PAYMENT_FAILED" as const };
  const evidence = { kind: "VERIFIED_PROVIDER_EVENT" as const, providerEventId: "evt_1" };
  const context = { currentInvoice: true, bookingPayable: true, disputed: false };

  it("reopens a closed intent only from verified evidence with room on the bill", () => {
    expect(() => planPaymentTransition(failed, "PAID_ONLINE", "PROVIDER", { evidence }))
      .toThrow(expect.objectContaining({ code: "PAYMENT_EVIDENCE_REQUIRED" }));
    expect(() => planPaymentTransition(failed, "PAID_ONLINE", "PROVIDER", { evidence, lateConfirmation: { amountPaise: 2, capacityPaise: 1 } }))
      .toThrow(expect.objectContaining({ code: "PAYMENT_OVERPAYMENT" }));
    expect(planPaymentTransition(failed, "PAID_ONLINE", "PROVIDER", { evidence, lateConfirmation: { amountPaise: 1, capacityPaise: 1 } }))
      .toMatchObject({ eventType: "ONLINE_PAYMENT_LATE_CONFIRMED" });
    expect(() => planPaymentTransition(failed, "PAID_ONLINE", "SYSTEM", { evidence, lateConfirmation: { amountPaise: 1, capacityPaise: 1 } }))
      .toThrow(expect.objectContaining({ code: "PAYMENT_ACTOR_NOT_PERMITTED" }));
  });

  it("computes the room a closed intent could still use on its current, undisputed bill", () => {
    const closed = entry({ id: "closed", method: "ONLINE", status: "PAYMENT_FAILED", amountPaise: 120_000 });
    expect(lateConfirmationCapacity(invoice, [closed], "closed", context)).toBe(120_000);
    const cash = entry({ amountPaise: 50_000 });
    const pendingOther = entry({ method: "ONLINE", status: "PENDING", amountPaise: 20_000 });
    expect(lateConfirmationCapacity(invoice, [closed, cash, pendingOther], "closed", context)).toBe(50_000);
    expect(lateConfirmationCapacity(invoice, [closed], "closed", { ...context, disputed: true })).toBe(0);
    expect(lateConfirmationCapacity(invoice, [closed], "closed", { ...context, currentInvoice: false })).toBe(0);
    expect(lateConfirmationCapacity(invoice, [closed], "closed", { ...context, bookingPayable: false })).toBe(0);
    expect(lateConfirmationCapacity({ ...invoice, status: "SETTLED" }, [closed], "closed", context)).toBe(0);
  });

  it("returns a failed refund to paid-online and finishes a processed one only from the provider", () => {
    const refundPending = { method: "ONLINE" as const, status: "REFUND_PENDING" as const };
    expect(planPaymentTransition(refundPending, "PAID_ONLINE", "PROVIDER", { evidence })).toMatchObject({ eventType: "REFUND_FAILED" });
    expect(planPaymentTransition(refundPending, "REFUNDED", "PROVIDER", { evidence })).toMatchObject({ eventType: "REFUND_CONFIRMED" });
    expect(() => planPaymentTransition(refundPending, "PAID_ONLINE", "SUPPORT", { evidence }))
      .toThrow(expect.objectContaining({ code: "PAYMENT_ACTOR_NOT_PERMITTED" }));
    expect(() => planPaymentTransition(refundPending, "REFUNDED", "PROVIDER"))
      .toThrow(expect.objectContaining({ code: "PAYMENT_EVIDENCE_REQUIRED" }));
  });

  it("labels sandbox online records and receipts as test money, never cash", () => {
    const base = { id: "p1", invoiceId: "invoice-1", amountPaise: 120_000, currency: "INR", createdAt: new Date(0) };
    expect(projectPaymentRecord({ ...base, method: "ONLINE", status: "PAID_ONLINE", verifiedAt: new Date(1), providerMode: "SANDBOX" }, parties))
      .toMatchObject({ testMode: true });
    expect(projectPaymentRecord({ ...base, method: "ONLINE", status: "PAID_ONLINE", verifiedAt: new Date(1), providerMode: "LIVE" }, parties))
      .not.toHaveProperty("testMode");
    expect(projectPaymentRecord({ ...base, method: "CASH", status: "PAID_CASH", recordedByUserId: "owner-1", receivedAt: new Date(1),
      providerMode: "SANDBOX" }, parties)).not.toHaveProperty("testMode");
  });
});
