import { readFileSync } from "node:fs";

import type { OwnerEquipmentProjection, OwnerTractorProjection } from "@kisantractor/domain";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { normalizeOwnerBooking, type OwnerBookingProjection, type OwnerDocumentProjection } from "../../lib/owner-management";
import {
  OwnerBookingDetail,
  OwnerBookingList,
  OwnerDocumentsScreen,
  OwnerEquipmentScreen,
  OwnerServicesScreen,
} from "./owner-management-screens";

const location = {
  id: "location-1",
  state: "Telangana",
  district: "Warangal",
  mandalOrTaluk: "Geesugonda",
  village: "Vanchanagiri",
  source: "MANUAL_ADDRESS" as const,
  capturedAt: new Date("2025-01-01T00:00:00.000Z"),
};
const tractor: OwnerTractorProjection = {
  id: "tractor-1", ownerId: "owner-1", brand: "Mahindra", model: "575 DI", registrationNumber: "TS08AB1234",
  manufacturingYear: 2022, horsepower: 47, operationalStatus: "ONLINE", eligibilityStatus: "ELIGIBLE",
  operatingLocation: location, photos: [], version: 4,
};
const equipment: OwnerEquipmentProjection = {
  id: "equipment-1", ownerId: "owner-1", tractorId: tractor.id, equipmentTypeId: "type-plough",
  equipmentTypeCode: "PLOUGH", equipmentTypeName: "Plough", displayName: "Heavy Plough", availabilityStatus: "AVAILABLE", version: 2,
};
const bookingResponse = (status = "PENDING_OWNER_RESPONSE") => ({
  id: "booking-1",
  publicReference: "KT-2025-001",
  status,
  version: 3,
  customer: { displayName: "Anita Rao" },
  recipient: { name: "Suresh Rao", landmarkOrDirections: "Near the water tank" },
  tractor: { id: tractor.id, brand: tractor.brand, model: tractor.model },
  serviceName: "Ploughing",
  equipmentName: equipment.displayName,
  requestedInterval: { start: "2025-02-10T03:00:00.000Z", end: "2025-02-10T07:00:00.000Z" },
  serviceLocationSnapshot: { state: "Telangana", district: "Warangal", mandalOrTaluk: "Geesugonda", village: "Vanchanagiri", landmark: "Near the school" },
  quoteSnapshot: {
    pricingRuleVersion: 7,
    method: "HOURLY",
    ratePaise: 80_000,
    roundingPolicy: "THIRTY_MINUTE_BLOCK",
    estimatedQuantity: "4",
    estimatedTotalPaise: 320_000,
    disclosedAt: "2025-02-01T10:00:00.000Z",
  },
  paymentExpectation: "Cash after the final bill",
  updatedAt: "2025-02-01T10:00:00.000Z",
});
const booking = normalizeOwnerBooking(bookingResponse())!;

/** Validates: Requirements 4.2, 4.3, 6.2, 6.3, 8.6, 8.12 */
describe("Owner management screens", () => {
  it("normalizes only complete Owner booking decision projections", () => {
    expect(booking).toMatchObject({
      id: "booking-1",
      customer: { displayName: "Anita Rao" },
      recipient: { name: "Suresh Rao" },
      quote: { pricingRuleVersion: 7, method: "HOURLY", ratePaise: 80_000, estimatedQuantity: "4", estimatedTotalPaise: 320_000 },
    });
    expect(normalizeOwnerBooking({ ...bookingResponse(), customer: undefined })).toBeUndefined();
    expect(normalizeOwnerBooking({ ...bookingResponse(), quoteSnapshot: { ...bookingResponse().quoteSnapshot, roundingPolicy: undefined } })).toBeUndefined();
    expect(normalizeOwnerBooking({ ...bookingResponse(), requestedInterval: { start: "bad", end: "bad" } })).toBeUndefined();
  });

  it("shows requested work, location, quantity, interval, and the immutable Quote Snapshot before decision actions", () => {
    const markup = renderToStaticMarkup(createElement(OwnerBookingDetail, { booking, locale: "en" }));
    for (const expected of ["Ploughing", "Vanchanagiri", "Estimated quantity", "Requested interval", "Agreed Quote Snapshot", "₹3,200", "Round up to 30-minute blocks", "Pricing rule version", "Anita Rao", "Suresh Rao"]) {
      expect(markup).toContain(expected);
    }
    expect(markup.indexOf("Agreed Quote Snapshot")).toBeLessThan(markup.indexOf("Respond to this request"));
    expect(markup).toContain('/api/owner/bookings/booking-1/accept');
    expect(markup).toContain('/api/owner/bookings/booking-1/reject');
    expect(markup.match(/name="expectedVersion" value="3"/gu)).toHaveLength(2);
    expect(markup).toContain('name="reason"');
  });

  it("separates booking requests, accepted jobs, active jobs, and history", () => {
    const items = [
      booking,
      normalizeOwnerBooking(bookingResponse("ACCEPTED"))!,
      normalizeOwnerBooking(bookingResponse("IN_PROGRESS"))!,
      normalizeOwnerBooking(bookingResponse("COMPLETED"))!,
    ].map((item, index) => ({ ...item, id: `booking-${index}` })) as readonly OwnerBookingProjection[];
    const markup = renderToStaticMarkup(createElement(OwnerBookingList, { locale: "en", result: { state: "READY", items } }));
    for (const heading of ["Booking requests", "Accepted jobs", "Active jobs", "Booking history"]) expect(markup).toContain(heading);
  });

  /** Validates: Requirements 17.4 */
  it("keeps accept and reject as version-guarded native forms and explains an unconfirmed decision", () => {
    const markup = renderToStaticMarkup(createElement(OwnerBookingDetail, { booking, decisionNotConfirmed: true, decisionOutcomeReported: true, locale: "en" }));
    expect(markup).toMatch(/<form[^>]*action="\/api\/owner\/bookings\/booking-1\/accept"[^>]*method="post"><input[^>]*name="expectedVersion"[^>]*value="3"/u);
    expect(markup).toMatch(/<form[^>]*action="\/api\/owner\/bookings\/booking-1\/reject"[^>]*method="post"><input[^>]*name="expectedVersion"/u);
    expect(markup).not.toContain('name="idempotencyKey"');
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("The decision was not confirmed and nothing was queued.");
  });

  it("renders an accepted-job surface without request decision controls", () => {
    const accepted = normalizeOwnerBooking(bookingResponse("SCHEDULED"))!;
    const markup = renderToStaticMarkup(createElement(OwnerBookingDetail, { booking: accepted, locale: "en" }));
    expect(markup).toContain("Accepted job");
    expect(markup).toContain("This interval is reserved");
    expect(markup).not.toContain("Respond to this request");
  });

  it("renders Equipment inventory creation, updates, availability, and Tractor assignment", () => {
    const markup = renderToStaticMarkup(createElement(OwnerEquipmentScreen, { equipment: [equipment], locale: "en", tractors: [tractor] }));
    for (const action of ["/api/owner/equipment", "/api/owner/equipment/equipment-1", "/api/owner/equipment/equipment-1/assignment"]) expect(markup).toContain(`action="${action}"`);
    expect(markup).toContain("Heavy Plough");
    expect(markup).toContain("Under maintenance");
    expect(markup).toContain("Mahindra 575 DI");
  });

  it("renders private document upload and current validation status", () => {
    const documents: readonly OwnerDocumentProjection[] = [{
      id: "document-1", tractorId: tractor.id, documentKind: "INSURANCE", fileName: "insurance.pdf",
      declaredMimeType: "application/pdf", declaredSizeBytes: 2048, scanStatus: "ACCEPTED", version: 1,
    }];
    const markup = renderToStaticMarkup(createElement(OwnerDocumentsScreen, { documents, locale: "en", tractors: [tractor] }));
    expect(markup).toContain('accept="application/pdf,image/jpeg,image/png,image/webp"');
    expect(markup).toContain("short-lived private upload grant");
    expect(markup).toContain("Verified");
    expect(markup).toContain("/api/owner/documents/document-1/download-grant");
  });

  it("renders Service Offering creation before method-specific pricing", () => {
    const configurations = [{
      tractor,
      offering: { id: "offering-1", tractorId: tractor.id, serviceId: "service-plough", serviceCode: "PLOUGHING", serviceName: "Ploughing", equipmentId: equipment.id, equipmentName: equipment.displayName, enabled: true, version: 1 },
      rules: [{ id: "rule-1", serviceOfferingId: "offering-1", method: "HOURLY" as const, ratePaise: 80_000, currency: "INR" as const, roundingPolicy: "PROPORTIONAL_MINUTE" as const, enabled: true, version: 1 }],
    }];
    const markup = renderToStaticMarkup(createElement(OwnerServicesScreen, { configurations, equipment: [equipment], locale: "en", tractors: [tractor] }));
    expect(markup).toContain("Service Offerings");
    expect(markup).toContain('/api/owner/tractors/tractor-1/service-offerings');
    expect(markup).toContain('name="serviceId"');
    expect(markup).toContain('name="equipmentId"');
    expect(markup).toContain("Set one or more rates for each tractor service");
    expect(markup).toContain("Charge proportional to each active minute");
  });

  it("uses responsive one-column layouts and full-width decision controls on narrow screens", () => {
    const css = readFileSync(new URL("../../app/globals.css", import.meta.url), "utf8");
    expect(css).toMatch(/@media \(max-width: 40rem\)[\s\S]*?\.kt-owner-booking-decision__actions[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\);/u);
    expect(css).toMatch(/\.kt-owner-booking-grid[\s\S]*?repeat\(auto-fit, minmax\(min\(100%, 20rem\), 1fr\)\)/u);
    expect(css).toMatch(/\.kt-owner-booking-decision__actions \.kt-button[\s\S]*?width:\s*100%;/u);
  });
});
