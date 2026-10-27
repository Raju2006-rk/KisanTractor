import { translate } from "@kisantractor/i18n";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  cashRecordablePaise,
  formatRupeesInput,
  normalizeBookingSettlement,
  normalizePaymentReceipt,
  parseIndiaLocalDateTime,
  parseRupeesToPaise,
  readCashRetryState,
  toIndiaLocalDateTime,
} from "../../lib/payments";
import { FarmerPaymentPanel, OwnerPaymentPanel, PaymentReceiptScreen } from "./payment-screens";

const cashRecord = (id: string, amountPaise: number) => ({
  id, invoiceId: "invoice-1", method: "CASH", status: "PAID_CASH", amountPaise, currency: "INR",
  recordedAt: "2026-03-01T12:00:00.000Z", paidAt: "2026-03-01T11:55:00.000Z", confirmedBy: "OWNER",
  providerReference: "never-render", recordedByUserId: "owner-secret",
});
const apiSettlement = (overrides: Record<string, unknown> = {}, settlement: Record<string, unknown> = {}) => ({
  bookingId: "booking-1", bookingReference: "KT-2026-0001", bookingStatus: "PAYMENT_RECORDED",
  invoiceId: "invoice-1", invoiceVersion: 1, currency: "INR",
  settlement: {
    invoiceId: "invoice-1", totalPaise: 120_000, appliedPaise: 50_000, pendingPaise: 0, outstandingPaise: 70_000,
    settled: false, status: "PAYMENT_DUE", settlementMethods: ["CASH"], settlementBlocked: false, ...settlement,
  },
  payments: [cashRecord("payment-1", 50_000)],
  ...overrides,
});
const now = new Date("2026-03-01T12:30:00.000Z");
const render = (element: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(element);

/** Validates: Requirements 11.1, 11.2, 12.2 */
describe("settlement projection", () => {
  it("allowlists party-safe fields and keeps mixed and nothing-due settlement states", () => {
    const view = normalizeBookingSettlement(apiSettlement())!;
    expect(view).toMatchObject({ status: "PAYMENT_DUE", outstandingPaise: 70_000, invoiceId: "invoice-1" });
    expect(JSON.stringify(view)).not.toMatch(/never-render|owner-secret/u);

    const mixed = normalizeBookingSettlement(apiSettlement({
      bookingStatus: "COMPLETED",
      payments: [cashRecord("payment-1", 50_000), { ...cashRecord("payment-2", 70_000), method: "ONLINE", status: "PAID_ONLINE", confirmedBy: "PAYMENT_PROVIDER" }],
    }, { appliedPaise: 120_000, outstandingPaise: 0, settled: true, status: "PAID_MIXED" }));
    expect(mixed?.status).toBe("PAID_MIXED");
    const nothingDue = normalizeBookingSettlement(apiSettlement({ payments: [] }, {
      totalPaise: 0, appliedPaise: 0, outstandingPaise: 0, settled: true, status: "NOTHING_DUE",
    }));
    expect(nothingDue?.status).toBe("NOTHING_DUE");
  });

  it("rejects totals that do not add up and cash labelled as paid online", () => {
    expect(normalizeBookingSettlement(apiSettlement({}, { outstandingPaise: 69_999 }))).toBeUndefined();
    expect(normalizeBookingSettlement(apiSettlement({}, { settled: true }))).toBeUndefined();
    expect(normalizeBookingSettlement(apiSettlement({ payments: [{ ...cashRecord("payment-1", 50_000), status: "PAID_ONLINE" }] }))).toBeUndefined();
  });
});

/** Validates: Requirements 11.2, 11.7, 17.4 */
describe("cash entry parsing and retry state", () => {
  it("converts rupees to exact integer paise and India time to an instant", () => {
    expect(parseRupeesToPaise("1,200")).toBe(120_000);
    expect(parseRupeesToPaise("0.07")).toBe(7);
    expect(parseRupeesToPaise("700.5")).toBe(70_050);
    for (const invalid of ["0", "-5", "1.234", "12e3", "abc", ""]) expect(parseRupeesToPaise(invalid)).toBeUndefined();
    expect(formatRupeesInput(70_050)).toBe("700.50");
    expect(formatRupeesInput(120_000)).toBe("1200");

    expect(parseIndiaLocalDateTime("2026-03-01T17:25")).toEqual(new Date("2026-03-01T11:55:00.000Z"));
    expect(parseIndiaLocalDateTime("2026-02-30T10:00")).toBeUndefined();
    expect(toIndiaLocalDateTime(now)).toBe("2026-03-01T18:00");
  });

  it("offers a same-key retry only after an unknown outcome", () => {
    const offline = readCashRetryState({ cashError: "offline", cashKey: "cash-key-0001", cashAmount: "700", cashReceivedAt: "2026-03-01T17:25" });
    expect(offline).toEqual({ feedback: "offline", retry: { key: "cash-key-0001", amountRupees: "700", receivedAt: "2026-03-01T17:25" } });
    expect(readCashRetryState({ cashError: "overpayment", cashKey: "cash-key-0001", cashAmount: "700" })).toEqual({ feedback: "overpayment" });
    expect(readCashRetryState({ cashError: "failed", cashKey: "<script>", cashAmount: "700" })).toEqual({ feedback: "failed" });
    expect(readCashRetryState({ cash: "recorded" })).toEqual({ feedback: "recorded" });
  });

  it("allows cash only while the current bill is payable and undisputed", () => {
    expect(cashRecordablePaise(normalizeBookingSettlement(apiSettlement())!)).toBe(70_000);
    expect(cashRecordablePaise(normalizeBookingSettlement(apiSettlement({}, { pendingPaise: 20_000 }))!)).toBe(50_000);
    expect(cashRecordablePaise(normalizeBookingSettlement(apiSettlement({ bookingStatus: "DISPUTED" }, { settlementBlocked: true, blockedReason: "DISPUTED" }))!)).toBe(0);
  });
});

/** Validates: Requirements 17.3 */
describe("payment freshness and pending state", () => {
  it("labels payment status with its check time and shows pending confirmations as pending", () => {
    const due = normalizeBookingSettlement(apiSettlement())!;
    const owner = render(createElement(OwnerPaymentPanel, { bookingId: "booking-1", cashKey: "fresh-cash-key-1", locale: "en", now, settlement: due }));
    expect(owner).toContain('data-freshness="FRESH"');
    expect(owner).toContain("Payment status checked at");

    const pending = normalizeBookingSettlement(apiSettlement({}, { pendingPaise: 20_000 }))!;
    const farmer = render(createElement(FarmerPaymentPanel, { checkedAt: now, locale: "en", settlement: pending }));
    expect(farmer).toContain('data-freshness="PENDING"');
    expect(farmer).toContain("A payment is awaiting confirmation");
    expect(farmer).toContain(">Refresh<");
    expect(farmer).not.toContain("<form");
  });
});

/** Validates: Requirements 11.2, 11.8, 13.4, 17.4 */
describe("Owner cash record panel", () => {
  it("renders an accessible cash form with a stable key, the remaining amount, and a bounded receipt time", () => {
    const settlement = normalizeBookingSettlement(apiSettlement())!;
    const markup = render(createElement(OwnerPaymentPanel, { bookingId: "booking-1", cashKey: "fresh-cash-key-1", locale: "en", now, settlement }));

    expect(markup).toContain('action="/api/owner/bookings/booking-1/payments/cash"');
    expect(markup).toMatch(/name="idempotencyKey"[^>]*value="fresh-cash-key-1"/u);
    expect(markup).toMatch(/name="invoiceId"[^>]*value="invoice-1"/u);
    expect(markup).toMatch(/<label[^>]*for="cashAmount"/u);
    expect(markup).toMatch(/name="amountRupees"[^>]*value="700"|value="700"[^>]*name="amountRupees"/u);
    expect(markup).toContain("Up to ₹700 can be recorded on this bill.");
    expect(markup).toMatch(/type="datetime-local"[^>]*max="2026-03-01T18:00"|max="2026-03-01T18:00"[^>]*type="datetime-local"/u);
    expect(markup).toContain("Cash: ₹500");
    expect(markup).toContain("Confirmed by");
    expect(markup).not.toContain("View receipt");
  });

  it("replaces the form with an explicit same-key retry after a lost connection", () => {
    const settlement = normalizeBookingSettlement(apiSettlement())!;
    const markup = render(createElement(OwnerPaymentPanel, {
      bookingId: "booking-1", cashKey: "fresh-cash-key-1", locale: "en", now, settlement, feedback: "offline",
      retry: { key: "cash-key-0001", amountRupees: "700", receivedAt: "2026-03-01T17:25" },
    }));

    expect(markup).toContain('role="alert"');
    expect(markup).toContain("nothing was queued");
    expect(markup).toMatch(/name="idempotencyKey"[^>]*value="cash-key-0001"/u);
    expect(markup).toMatch(/type="hidden"[^>]*name="receivedAt"[^>]*value="2026-03-01T17:25"/u);
    expect(markup).toContain("Retry recording ₹700");
    expect(markup).not.toContain("fresh-cash-key-1");
  });

  it("shows receipts and no form once settled, and blocks cash while disputed", () => {
    const settled = normalizeBookingSettlement(apiSettlement({
      bookingStatus: "COMPLETED", payments: [cashRecord("payment-1", 50_000), cashRecord("payment-2", 70_000)],
    }, { appliedPaise: 120_000, outstandingPaise: 0, settled: true, status: "PAID_CASH" }))!;
    const settledMarkup = render(createElement(OwnerPaymentPanel, { bookingId: "booking-1", cashKey: "k-00000001", locale: "en", now, settlement: settled, feedback: "recorded" }));
    expect(settledMarkup).toContain('role="status"');
    expect(settledMarkup).toContain('href="/owner/bookings/booking-1/receipts/payment-2"');
    expect(settledMarkup).not.toContain("<form");

    const disputed = normalizeBookingSettlement(apiSettlement({ bookingStatus: "DISPUTED" }, { settlementBlocked: true }))!;
    const disputedMarkup = render(createElement(OwnerPaymentPanel, { bookingId: "booking-1", cashKey: "k-00000001", locale: "en", now, settlement: disputed }));
    expect(disputedMarkup).toContain("Payment cannot be recorded until the dispute is reviewed.");
    expect(disputedMarkup).not.toContain("<form");
  });
});

/** Validates: Requirements 11.1, 11.8, 13.2 */
describe("Farmer payment status and receipt", () => {
  it("explains cash payment without offering a cash form to the Farmer", () => {
    const markup = render(createElement(FarmerPaymentPanel, { locale: "hi", settlement: normalizeBookingSettlement(apiSettlement())! }));
    expect(markup).toContain("भुगतान देय");
    expect(markup).toContain(translate("hi", "payment.farmerHelp"));
    expect(markup).not.toContain("<form");
    expect(markup).not.toMatch(/\bpayment\.[a-zA-Z.]+\b/u);
  });

  it("renders an authorized receipt with booking, bill, method, amount, status, and time", () => {
    const receipt = normalizePaymentReceipt({
      bookingId: "booking-1", bookingReference: "KT-2026-0001", invoiceId: "invoice-1", invoiceVersion: 1, invoiceTotalPaise: 120_000,
      paymentId: "payment-2", method: "CASH", status: "PAID_CASH", settlementStatus: "PAID_MIXED", amountPaise: 70_000,
      currency: "INR", paidAt: "2026-03-01T11:55:00.000Z", recordedAt: "2026-03-01T12:00:00.000Z", confirmedBy: "OWNER",
    })!;
    const markup = render(createElement(PaymentReceiptScreen, { locale: "en", receipt, role: "farmer" }));
    for (const content of ["KT-2026-0001", "₹700", "₹1,200", "Cash", "Paid in cash and online", "Owner", "payment-2"]) expect(markup).toContain(content);
    expect(markup).toContain('href="/farmer/bookings/booking-1#payment-section"');

    expect(normalizePaymentReceipt({ ...receipt, paidAt: receipt.paidAt.toISOString(), recordedAt: receipt.recordedAt.toISOString(), status: "PENDING" })).toBeUndefined();
  });
});

/** Validates: Requirements 11.4, 14.3 */
describe("sandbox online payment labelling", () => {
  const onlineRecord = { ...cashRecord("payment-2", 70_000), method: "ONLINE", status: "PENDING", paidAt: undefined, confirmedBy: undefined };
  const sandbox = { state: "SANDBOX", statusLabel: "Test service (sandbox)", available: true, testMode: true, canRetry: false };
  const onlineReceipt = {
    bookingId: "booking-1", bookingReference: "KT-2026-0001", invoiceId: "invoice-1", invoiceVersion: 1, invoiceTotalPaise: 120_000,
    paymentId: "payment-2", method: "ONLINE", status: "PAID_ONLINE", settlementStatus: "PAID_ONLINE", amountPaise: 120_000,
    currency: "INR", paidAt: "2026-03-01T11:55:00.000Z", recordedAt: "2026-03-01T11:50:00.000Z", confirmedBy: "PAYMENT_PROVIDER",
  };

  it("labels online records as sandbox test money only when the API reports test mode", () => {
    const settlement = (onlinePayment?: unknown) => normalizeBookingSettlement(apiSettlement({
      payments: [cashRecord("payment-1", 50_000), onlineRecord],
      ...(onlinePayment === undefined ? {} : { onlinePayment }),
    }, { pendingPaise: 70_000, status: "PENDING" }))!;

    const test = settlement(sandbox);
    expect(test.onlineTestMode).toBe(true);
    for (const markup of [
      render(createElement(FarmerPaymentPanel, { locale: "en", settlement: test })),
      render(createElement(OwnerPaymentPanel, { bookingId: "booking-1", cashKey: "fresh-cash-key-1", locale: "en", now, settlement: test })),
    ]) {
      // One label, on the online record only; the cash record is real money.
      expect(markup.match(/Test service \(sandbox\)/gu)).toHaveLength(1);
      expect(markup).toContain("No real money moved.");
    }
    // Localized chip text; never a raw message key.
    const hindi = render(createElement(FarmerPaymentPanel, { locale: "hi", settlement: test }));
    expect(hindi).toContain("परीक्षण सेवा (सैंडबॉक्स)");
    expect(hindi).not.toMatch(/\bpayment\.[a-zA-Z.]+\b/u);

    for (const notTest of [settlement(), settlement({ ...sandbox, state: "LIVE", testMode: false }), settlement({ testMode: "yes" })]) {
      expect(notTest.onlineTestMode).toBe(false);
      expect(render(createElement(FarmerPaymentPanel, { locale: "en", settlement: notTest }))).not.toContain("sandbox");
    }
  });

  it("labels a sandbox online receipt and never labels a cash receipt", () => {
    const receipt = normalizePaymentReceipt({ ...onlineReceipt, testMode: true })!;
    expect(receipt.testMode).toBe(true);
    expect(render(createElement(PaymentReceiptScreen, { locale: "en", receipt, role: "farmer" }))).toContain("Test service (sandbox)");

    const live = normalizePaymentReceipt(onlineReceipt)!;
    expect(live).not.toHaveProperty("testMode");
    expect(render(createElement(PaymentReceiptScreen, { locale: "en", receipt: live, role: "farmer" }))).not.toContain("sandbox");
    const cash = normalizePaymentReceipt({
      ...onlineReceipt, method: "CASH", status: "PAID_CASH", settlementStatus: "PAID_CASH", confirmedBy: "OWNER", testMode: true,
    })!;
    expect(cash).not.toHaveProperty("testMode");
  });
});
