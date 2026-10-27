import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { farmerBookingStatuses, normalizeFarmerBooking } from "../../lib/farmer-bookings";
import { normalizeBookingSettlement } from "../../lib/payments";
import { FarmerBookingDetail, FarmerBookingList } from "./bookings";

const response = (overrides: Record<string, unknown> = {}) => ({
  id: "booking-1", publicReference: "KT-2027-001", status: "PENDING_OWNER_RESPONSE",
  tractor: { brand: "Mahindra", model: "575 DI", registrationNumber: "TS00AA0000" },
  owner: { displayName: "Ravi", privatePhone: "+919999999999" },
  ownerContact: { sharingPermitted: false, phone: "+919876543210" },
  serviceName: "Ploughing",
  requestedInterval: { start: "2027-01-02T08:00:00.000Z", end: "2027-01-02T12:00:00.000Z" },
  serviceLocation: { state: "Telangana", district: "Warangal", village: "Gorrekunta", landmark: "Water tank", latitude: 17.9, longitude: 79.5 },
  recipient: { name: "Lakshmi", coordinationPhone: "+919111111111" },
  quote: { method: "HOURLY", ratePaise: 80000, estimatedTotalPaise: 320000 },
  updatedAt: "2027-01-01T00:00:00.000Z",
  ...overrides,
});
const render = (element: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(element);

/** Validates: Requirements 2.4, 3.4 */
describe("Farmer booking projection privacy", () => {
  it("allowlists booking data and hides Owner contact unless policy explicitly permits it", () => {
    const hidden = normalizeFarmerBooking(response())!;
    expect(JSON.stringify(hidden)).not.toContain("9876543210");
    expect(JSON.stringify(hidden)).not.toContain("9999999999");
    expect(JSON.stringify(hidden)).not.toContain("1111111111");
    expect(JSON.stringify(hidden)).not.toContain("17.9");

    const shared = normalizeFarmerBooking(response({ ownerContact: { sharingPermitted: true, phone: "+919876543210" } }))!;
    expect(shared.owner.contactPhone).toBe("+919876543210");
  });

  it("rejects malformed booking records instead of partially displaying them", () => {
    expect(normalizeFarmerBooking(response({ status: "UNKNOWN" }))).toBeUndefined();
    expect(normalizeFarmerBooking(response({ requestedInterval: { start: "bad", end: "bad" } }))).toBeUndefined();
  });
});

/** Validates: Requirements 8.8, 10.8, 11.1 */
describe("Farmer booking list and detail experience", () => {
  it("renders every lifecycle state with a details link", () => {
    const items = farmerBookingStatuses.map((status, index) => normalizeFarmerBooking(response({ id: `booking-${index}`, publicReference: `KT-${index}`, status }))!);
    const markup = render(createElement(FarmerBookingList, { locale: "en", result: { state: "READY", items } }));
    for (const label of ["Waiting for owner response", "Accepted", "Scheduled", "Work in progress", "Completed", "Cancelled", "Disputed", "Final bill ready", "Payment recorded"]) expect(markup).toContain(label);
    expect(markup).toContain("Current bookings");
    expect(markup).toContain("Booking history");
    expect(markup).toContain("View details");
  });

  it("renders invoice, dispute, cash payment, evidence, and policy-permitted Owner contact", () => {
    const booking = normalizeFarmerBooking(response({
      status: "DISPUTED",
      ownerContact: { sharingPermitted: true, phone: "+919876543210" },
      invoice: { status: "DISPUTED", totalPaise: 120000, formula: "₹800 × 90 ÷ 60", evidenceSummary: "90 active minutes" },
      dispute: { status: "OPEN", note: "Quantity needs review" },
      payment: { status: "PAID_CASH", method: "CASH", amountPaise: 120000, recordedAt: "2027-01-02T13:00:00.000Z" },
    }))!;
    const markup = render(createElement(FarmerBookingDetail, { booking, locale: "en" }));
    for (const content of ["Final bill", "₹1,200", "90 active minutes", "Dispute", "Quantity needs review", "Paid in cash", "Owner contact", "+919876543210"]) expect(markup).toContain(content);
    expect(markup).not.toContain("registrationNumber");
  });

  it("keeps mixed and nothing-due settlement states instead of dropping them", () => {
    for (const [status, label] of [["PAID_MIXED", "Paid in cash and online"], ["NOTHING_DUE", "Nothing to pay"]] as const) {
      const booking = normalizeFarmerBooking(response({ status: "COMPLETED", payment: { status } }))!;
      expect(booking.payment?.status).toBe(status);
      expect(render(createElement(FarmerBookingDetail, { booking, locale: "en" }))).toContain(label);
    }
  });

  it("shows the authoritative settlement with receipt links in place of the summary payment card", () => {
    const booking = normalizeFarmerBooking(response({ status: "COMPLETED", payment: { status: "PAID_CASH" } }))!;
    const settlement = normalizeBookingSettlement({
      bookingId: "booking-1", bookingReference: "KT-2027-001", bookingStatus: "COMPLETED", invoiceId: "invoice-1", invoiceVersion: 1,
      currency: "INR",
      settlement: { totalPaise: 120000, appliedPaise: 120000, pendingPaise: 0, outstandingPaise: 0, settled: true, status: "PAID_CASH", settlementMethods: ["CASH"], settlementBlocked: false },
      payments: [{ id: "payment-1", invoiceId: "invoice-1", method: "CASH", status: "PAID_CASH", amountPaise: 120000, currency: "INR",
        recordedAt: "2027-01-02T13:00:00.000Z", paidAt: "2027-01-02T12:55:00.000Z", confirmedBy: "OWNER" }],
    })!;
    const markup = render(createElement(FarmerBookingDetail, { booking, locale: "en", settlement }));
    expect(markup).toContain('href="/farmer/bookings/booking-1/receipts/payment-1"');
    expect(markup).toContain("This bill is fully paid and the booking is complete.");
    expect(markup.match(/Paid in cash/gu)?.length).toBe(2);
    expect(markup).not.toContain("<form");
  });

  it("shows useful empty and error states", () => {
    expect(render(createElement(FarmerBookingList, { locale: "en", result: { state: "READY", items: [] } }))).toContain("No bookings yet");
    expect(render(createElement(FarmerBookingList, { locale: "en", result: { state: "ERROR", message: "Reconnect" } }))).toContain("Could not load bookings");
  });
});
