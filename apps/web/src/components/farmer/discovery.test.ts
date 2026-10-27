import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  normalizeFarmerDiscoveryPage,
  normalizeFarmerTractorCard,
  parseFarmerSearchCriteria,
} from "../../lib/farmer-discovery";
import { FarmerHome, FarmerSearchResults, FarmerTractorDetails, TractorCard } from "./discovery";

const tractorResponse = {
  id: "tractor-1",
  brand: "Mahindra",
  model: "575 DI",
  photo: { altText: "Red Mahindra tractor" },
  approximateLocation: { state: "Telangana", district: "Warangal" },
  approximateDistance: {
    kilometers: 3.4,
    label: "3.4 km away",
    isEstimate: true,
    exactCoordinatesExposed: false,
  },
  ownerDisplayName: "Ravi",
  service: { offeringId: "offering-1", id: "ploughing", name: "Ploughing" },
  equipment: { id: "equipment-1", typeId: "plough", name: "Cultivator" },
  pricingRules: [{ id: "price-1", method: "HOURLY", ratePaise: 80000, currency: "INR", roundingPolicy: "PROPORTIONAL_MINUTE" }],
  availability: { available: true, rank: 0 },
  ownerPhone: "+919876543210",
  exactCoordinates: { latitude: 17.9689, longitude: 79.5941 },
  registrationNumber: "TS00AA0000",
  documentUrl: "https://private.example/document",
};

const criteria = parseFarmerSearchCriteria({
  state: "Telangana",
  district: "Warangal",
  mandalOrTaluk: "Warangal",
  village: "Gorrekunta",
  latitude: "17.9689",
  longitude: "79.5941",
  serviceId: "ploughing",
  start: "2027-01-02T08:00",
  end: "2027-01-02T12:00",
  radius: "5",
});

const unavailableMaps = {
  state: "UNCONFIGURED" as const,
  isOperational: false,
  isTest: false,
  canRetry: false,
  message: "This service is not configured.",
};

const tractor = normalizeFarmerTractorCard(tractorResponse)!;
const render = (component: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(component);

/** Validates: Requirements 3.3, 3.4, 7.6 */
describe("Farmer tractor discovery projections", () => {
  it("allowlists redacted card fields and drops private response fields", () => {
    const serialized = JSON.stringify(tractor);
    expect(tractor.approximateDistance.isEstimate).toBe(true);
    expect(serialized).not.toContain("9876543210");
    expect(serialized).not.toContain("17.9689");
    expect(serialized).not.toContain("TS00AA0000");
    expect(serialized).not.toContain("private.example");
  });

  it("rejects malformed cards rather than rendering partially trusted data", () => {
    expect(normalizeFarmerTractorCard({ ...tractorResponse, pricingRules: [] })).toBeUndefined();
    expect(normalizeFarmerTractorCard({ ...tractorResponse, approximateDistance: { kilometers: -1, label: "near" } })).toBeUndefined();
  });

  it("normalizes a bounded discovery page and server timestamp", () => {
    const page = normalizeFarmerDiscoveryPage({
      items: [tractorResponse],
      radiusKilometers: 5,
      canExpandRadius: true,
      maximumRadiusKilometers: 100,
      origin: { state: "Telangana", district: "Warangal" },
      evaluatedAt: "2027-01-01T00:00:00.000Z",
    });
    expect(page?.items).toHaveLength(1);
    expect(page?.evaluatedAt).toEqual(new Date("2027-01-01T00:00:00.000Z"));
  });
});

/** Validates: Requirements 3.1, 3.2, 3.3, 7.4, 7.6 */
describe("Farmer discovery experience", () => {
  it("renders all required Farmer Home actions with labeled links", () => {
    const markup = render(createElement(FarmerHome, { locale: "en" }));
    for (const label of ["Service location", "Farming work", "Date &amp; Time", "Pricing method", "Nearby tractors", "Current bookings", "Booking history", "Help", "Choose language"]) {
      expect(markup).toContain(label);
    }
    expect(markup).toContain('href="/farmer/search"');
  });

  it("renders an accessible result card with estimate, availability, pricing, details, and booking actions", () => {
    const markup = render(createElement(TractorCard, { criteria, locale: "en", tractor }));
    expect(markup).toContain("Mahindra 575 DI");
    expect(markup).toContain("estimated distance");
    expect(markup).toContain("Available for requested time");
    expect(markup).toContain("₹800 per hour");
    expect(markup).toContain("View details");
    expect(markup).toContain("Book now");
    expect(markup).toContain('role="img"');
    expect(markup).not.toContain("ownerPhone");
  });

  it("renders an adjustable-radius empty state preserving the search criteria", () => {
    const markup = render(createElement(FarmerSearchResults, {
      locale: "en",
      mapsCapability: unavailableMaps,
      result: {
        state: "READY",
        criteria,
        page: {
          items: [],
          radiusKilometers: 5,
          canExpandRadius: true,
          maximumRadiusKilometers: 100,
          origin: { state: "Telangana", district: "Warangal" },
          evaluatedAt: new Date("2027-01-01T00:00:00.000Z"),
        },
      },
    }));
    expect(markup).toContain("No suitable tractors found");
    expect(markup).toContain("Expand search to 10 km");
    expect(markup).toContain("serviceId=ploughing");
    expect(markup).toContain("radius=10");
    // Validates: Requirement 17.3 — results say when availability was checked and do not promise it.
    expect(markup).toContain('data-freshness="FRESH"');
    expect(markup).toContain("A tractor is reserved only when the Owner accepts your booking.");
  });

  it("renders details from the same redacted projection and explains privacy", () => {
    const markup = render(createElement(FarmerTractorDetails, { criteria, locale: "en", tractor }));
    expect(markup).toContain("Back to search results");
    expect(markup).toContain("Private coordinates and Owner contact details are not shown");
    expect(markup).not.toContain("9876543210");
  });
});
