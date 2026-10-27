import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  normalizeBookingSettlement,
  normalizeOnlineCheckout,
  normalizePaymentHistory,
  onlinePayablePaise,
  readOnlineRetryState,
} from "../../lib/payments";
import { FarmerPaymentPanel, OwnerPaymentPanel, PaymentHistoryScreen } from "./payment-screens";

const now = new Date("2026-03-01T12:30:00.000Z");
const record = (id: string, overrides: Record<string, unknown> = {}) => ({
  id, invoiceId: "invoice-1", method: "ONLINE", status: "PENDING", amountPaise: 120_000, currency: "INR",
  recordedAt: "2026-03-01T12:00:00.000Z", testMode: true, providerReference: "order_never_render", ...overrides,
});
const apiSettlement = (payments: unknown[], settlement: Record<string, unknown> = {}, onlinePayment: Record<string, unknown> = {}) => ({
  bookingId: "11111111-1111-4111-8111-111111111111", bookingReference: "KT-2026-0001", bookingStatus: "FINAL_BILL_GENERATED",
  invoiceId: "22222222-2222-4222-8222-222222222222", invoiceVersion: 1, currency: "INR",
  settlement: {
    totalPaise: 120_000, appliedPaise: 0, pendingPaise: 0, outstandingPaise: 120_000, settled: false, status: "PAYMENT_DUE",
    settlementBlocked: false, ...settlement,
  },
  payments,
  onlinePayment: { state: "SANDBOX", available: true, testMode: true, ...onlinePayment },
});
const render = (element: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(element);
const panel = (settlement: ReturnType<typeof normalizeBookingSettlement>, online: Record<string, unknown> = {}) =>
  render(createElement(FarmerPaymentPanel, { checkedAt: now, locale: "en", settlement: settlement!, online: { key: "online-key-0001", ...online } }));

/** Validates: Requirements 11.3, 11.4, 14.2, 14.3, 17.4 */
describe("Farmer online payment panel", () => {
  it("offers a same-key Pay online form for what remains on the bill, labelled as sandbox money", () => {
    const due = normalizeBookingSettlement(apiSettlement([]))!;
    expect(onlinePayablePaise(due)).toBe(120_000);
    const markup = panel(due);
    expect(markup).toContain('action="/api/farmer/bookings/11111111-1111-4111-8111-111111111111/payments/online"');
    expect(markup).toMatch(/name="idempotencyKey"[^>]*value="online-key-0001"/u);
    expect(markup).toMatch(/name="amountPaise"[^>]*value="120000"/u);
    expect(markup).toContain("Pay ₹1,200 online");
    expect(markup).toContain("Test service (sandbox)");
    expect(markup).toContain("only after the provider confirms");
  });

  it("never offers online payment when the capability is not SANDBOX or LIVE, the bill is disputed, or under ₹1", () => {
    const unavailable = normalizeBookingSettlement(apiSettlement([], {}, { state: "UNCONFIGURED", available: false, testMode: false }))!;
    expect(onlinePayablePaise(unavailable)).toBe(0);
    const markup = panel(unavailable);
    expect(markup).not.toContain("/payments/online");
    expect(markup).toContain("Online payment is not available right now");
    expect(onlinePayablePaise(normalizeBookingSettlement({ ...apiSettlement([], { settlementBlocked: true }), bookingStatus: "DISPUTED" })!)).toBe(0);
    expect(onlinePayablePaise(normalizeBookingSettlement(apiSettlement([], { appliedPaise: 119_950, outstandingPaise: 50 }))!)).toBe(0);
  });

  it("shows a pending online payment with continue, status check, and cancel, and no second Pay form", () => {
    const pending = normalizeBookingSettlement(apiSettlement([record("33333333-3333-4333-8333-333333333333")], { pendingPaise: 120_000, status: "PENDING" }))!;
    expect(onlinePayablePaise(pending)).toBe(0);
    const markup = panel(pending);
    expect(markup).toContain('href="/farmer/pay/33333333-3333-4333-8333-333333333333?booking=11111111-1111-4111-8111-111111111111"');
    expect(markup).toContain('action="/api/farmer/payments/33333333-3333-4333-8333-333333333333/status-check"');
    expect(markup).toContain('action="/api/farmer/payments/33333333-3333-4333-8333-333333333333/cancel"');
    expect(markup).not.toContain("/payments/online");
    expect(markup).toContain("waiting for the payment provider&#x27;s confirmation");
    expect(markup).not.toContain("order_never_render");
  });

  it("explains a not-completed attempt, reports feedback, and offers a same-key retry only after an unknown outcome", () => {
    const failed = normalizeBookingSettlement(apiSettlement([record("44444444-4444-4444-8444-444444444444", { status: "PAYMENT_FAILED" })], { status: "PAYMENT_FAILED" }))!;
    const markup = panel(failed, { feedback: "cancelled" });
    expect(markup).toContain("The last online payment was not completed");
    expect(markup).toContain("The online payment was cancelled");
    expect(markup).toContain("Pay ₹1,200 online");

    const retry = readOnlineRetryState({ online: "offline", onlineKey: "online-key-0009", onlineAmount: "120000" });
    expect(retry).toEqual({ feedback: "offline", retry: { key: "online-key-0009", amountPaise: 120_000 } });
    const retried = panel(normalizeBookingSettlement(apiSettlement([]))!, { feedback: retry.feedback, retry: retry.retry });
    expect(retried).toMatch(/name="idempotencyKey"[^>]*value="online-key-0009"/u);
    expect(retried).toContain("Retry paying ₹1,200 online");
    expect(retried).not.toMatch(/value="online-key-0001"/u);
    expect(readOnlineRetryState({ online: "overpayment", onlineKey: "online-key-0009", onlineAmount: "120000" })).toEqual({ feedback: "overpayment" });
    expect(readOnlineRetryState({ online: "failed", onlineKey: "<script>", onlineAmount: "120000" })).toEqual({ feedback: "failed" });
    expect(readOnlineRetryState({ online: "made-up" })).toEqual({});
  });

  it("tells the Owner why cash is held while an online payment awaits confirmation", () => {
    const pending = normalizeBookingSettlement(apiSettlement([record("33333333-3333-4333-8333-333333333333")], { pendingPaise: 120_000, status: "PENDING" }))!;
    const markup = render(createElement(OwnerPaymentPanel, { bookingId: pending.bookingId, cashKey: "cash-key-0001", locale: "en", now, settlement: pending }));
    expect(markup).toContain("waiting for the payment provider&#x27;s confirmation");
    expect(markup).not.toContain("/payments/cash\"");
  });
});

/** Validates: Requirements 11.8, 12.2, 14.3, 18.3 */
describe("checkout and payment history projections", () => {
  const checkout = {
    payment: { id: "33333333-3333-4333-8333-333333333333", status: "PENDING" },
    bookingId: "11111111-1111-4111-8111-111111111111", bookingReference: "KT-2026-0001",
    checkout: { provider: "razorpay", mode: "SANDBOX", testMode: false, publicKey: "rzp_test_Kt0Synthetic01",
      providerReference: "order_KtSynthOrder01", amountPaise: 120_000, currency: "INR", keySecret: "never" },
    checkoutExpiresAt: "2026-03-01T12:45:00.000Z",
  };

  it("allowlists checkout values and always labels a test key as sandbox money", () => {
    const view = normalizeOnlineCheckout(checkout)!;
    expect(view).toEqual({
      paymentId: "33333333-3333-4333-8333-333333333333", bookingId: "11111111-1111-4111-8111-111111111111", bookingReference: "KT-2026-0001",
      amountPaise: 120_000, publicKey: "rzp_test_Kt0Synthetic01", providerReference: "order_KtSynthOrder01", testMode: true,
      expiresAt: new Date("2026-03-01T12:45:00.000Z"),
    });
    for (const broken of [
      { ...checkout, payment: { ...checkout.payment, status: "PAID_ONLINE" } },
      { ...checkout, checkout: { ...checkout.checkout, publicKey: "sk_live_secret" } },
      { ...checkout, checkout: { ...checkout.checkout, providerReference: "javascript:alert(1)" } },
      { ...checkout, checkout: { ...checkout.checkout, amountPaise: 50 } },
    ]) {
      expect(normalizeOnlineCheckout(broken)).toBeUndefined();
    }
  });

  it("renders history with booking links, test labels, and receipts only for counted money on fully paid bills", () => {
    const history = normalizePaymentHistory({
      items: [
        { ...record("55555555-5555-4555-8555-555555555555", { status: "PAID_ONLINE", paidAt: "2026-03-01T12:05:00.000Z", confirmedBy: "PAYMENT_PROVIDER" }),
          bookingId: "11111111-1111-4111-8111-111111111111", bookingReference: "KT-2026-0001", invoiceVersion: 1, receiptAvailable: true },
        { ...record("66666666-6666-4666-8666-666666666666", { status: "REFUNDED", testMode: false }),
          bookingId: "11111111-1111-4111-8111-111111111111", bookingReference: "KT-2026-0001", invoiceVersion: 1, receiptAvailable: true },
      ],
      nextCursor: "eyJjIjoiMjAyNiJ9",
    })!;
    expect(history.items.map((item) => item.receiptAvailable)).toEqual([true, false]);
    const markup = render(createElement(PaymentHistoryScreen, { history, locale: "en", role: "farmer" }));
    expect(markup).toContain('href="/farmer/bookings/11111111-1111-4111-8111-111111111111/receipts/55555555-5555-4555-8555-555555555555"');
    expect(markup).not.toContain("receipts/66666666");
    expect(markup).toContain('href="/farmer/payments?cursor=eyJjIjoiMjAyNiJ9"');
    expect(markup.match(/Test service \(sandbox\)/gu)).toHaveLength(1);
    expect(markup).not.toContain("order_never_render");
    expect(normalizePaymentHistory({ items: [{ id: "x" }] })).toBeUndefined();
    expect(render(createElement(PaymentHistoryScreen, { history: { items: [] }, locale: "en", role: "owner" }))).toContain("No payments have been recorded yet.");
  });
});
