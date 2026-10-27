import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  bookingDiscoveryParameters,
  bookingRequestBody,
  bookingStepErrors,
  createBookingDraft,
  restoreBookingDraft,
  type FarmerBookingDraft,
} from "../../lib/farmer-booking";
import type { FarmerTractorCardProjection } from "../../lib/farmer-discovery";
import { BookingReview, FarmerBookingStepper } from "./booking-stepper";

const draft: FarmerBookingDraft = {
  bookingTarget: "SOMEONE_ELSE",
  recipientName: "Ravi Kumar",
  coordinationPhone: "+919876543210",
  coordinationConsent: true,
  landmarkOrDirections: "Opposite school",
  state: "Karnataka",
  district: "Mysuru",
  mandalOrTaluk: "Nanjangud",
  village: "Hullahalli",
  landmark: "Water tank",
  latitude: "12.056",
  longitude: "76.684",
  serviceId: "ploughing",
  equipmentTypeId: "cultivator",
  start: "2027-01-02T08:00",
  end: "2027-01-02T12:00",
  pricingMethod: "HOURLY",
  pricingRuleId: "price-1",
  expectedQuantity: "4",
  tractorId: "tractor-1",
  serviceOfferingId: "offering-1",
};

const tractor: FarmerTractorCardProjection = {
  id: "tractor-1",
  brand: "Mahindra",
  model: "575 DI",
  approximateLocation: { state: "Karnataka", district: "Mysuru" },
  approximateDistance: { kilometers: 2.1, label: "2.1 km away", isEstimate: true },
  ownerDisplayName: "Lakshmi",
  service: { offeringId: "offering-1", id: "ploughing", name: "Ploughing" },
  equipment: { id: "equipment-1", typeId: "cultivator", name: "Cultivator" },
  pricingRules: [{ id: "price-1", method: "HOURLY", ratePaise: 80_000, currency: "INR", roundingPolicy: "PROPORTIONAL_MINUTE" }],
  available: true,
};

/** Validates: Requirements 7.3, 8.1, 8.2, 8.3 */
describe("Farmer booking draft", () => {
  it("uses the Recipient service location as the someone-else discovery origin", () => {
    const parameters = bookingDiscoveryParameters(draft);
    expect(parameters.get("target")).toBe("SOMEONE_ELSE");
    expect(parameters.get("district")).toBe("Mysuru");
    expect(parameters.get("latitude")).toBe("12.056");
    expect(parameters.get("longitude")).toBe("76.684");
    expect(parameters.toString()).not.toContain("customerLocation");
  });

  it("creates a separate Recipient and service-location snapshot request", () => {
    const body = bookingRequestBody(draft);
    expect(body).toMatchObject({
      bookingTarget: "SOMEONE_ELSE",
      tractorId: "tractor-1",
      serviceOfferingId: "offering-1",
      recipient: { name: "Ravi Kumar", coordinationConsent: true, landmarkOrDirections: "Opposite school" },
      serviceLocation: { district: "Mysuru", village: "Hullahalli", collectionPurpose: "SERVICE_LOCATION" },
    });
  });

  it("validates required Recipient, consent, location, selection, interval, and pricing fields", () => {
    const empty = createBookingDraft({ target: "SOMEONE_ELSE" });
    expect(bookingStepErrors("target", empty)).toContain("Recipient name is required.");
    expect(bookingStepErrors("location", empty)).not.toHaveLength(0);
    expect(bookingStepErrors("work", empty)).not.toHaveLength(0);
    expect(bookingStepErrors("schedule", empty)).not.toHaveLength(0);
    expect(bookingStepErrors("pricing", empty)).not.toHaveLength(0);
    for (const step of ["target", "location", "work", "schedule", "pricing"] as const) {
      expect(bookingStepErrors(step, draft)).toEqual([]);
    }
  });

  it("resumes saved fields while allowing a newly selected tractor and search origin to win", () => {
    const fallback = createBookingDraft({ tractorId: "tractor-new", offeringId: "offering-new", district: "Bidar" });
    const restored = restoreBookingDraft(JSON.stringify(draft), fallback);
    expect(restored.recipientName).toBe("Ravi Kumar");
    expect(restored.tractorId).toBe("tractor-new");
    expect(restored.serviceOfferingId).toBe("offering-new");
    expect(restored.district).toBe("Bidar");
  });
});

/** Validates: Requirements 8.12 */
describe("Farmer booking stepper presentation", () => {
  it("renders accessible progress and both booking-target choices", () => {
    const markup = renderToStaticMarkup(createElement(FarmerBookingStepper, { locale: "en", parameters: {} }));
    expect(markup).toContain('aria-label="Booking progress"');
    expect(markup).toContain('aria-current="step"');
    expect(markup).toContain("Book for myself");
    expect(markup).toContain("Book for someone else");
  });

  it("shows every required confirmation field without direct owner contact", () => {
    const markup = renderToStaticMarkup(createElement(BookingReview, {
      draft,
      estimatedTotal: 320_000,
      locale: "en",
      selectedRule: tractor.pricingRules[0],
      tractor,
    }));
    for (const label of ["Booked by", "Recipient", "Service location", "Tractor", "Owner", "Farming work", "Equipment", "Pricing", "Estimated total", "Schedule", "Payment expectation"]) {
      expect(markup).toContain(label);
    }
    expect(markup).toContain("Ravi Kumar");
    expect(markup).toContain("Hullahalli");
    expect(markup).toContain("Mahindra 575 DI");
    expect(markup).toContain("Lakshmi");
    expect(markup).toContain("₹3,200");
    expect(markup).not.toContain("9876543210");
  });
});
