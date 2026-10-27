import { describe, expect, it } from "vitest";

import {
  CatalogValidationError,
  evaluateTractorEligibility,
  normalizeRegistrationNumber,
  validateEquipment,
  validateOwnerProfile,
  validatePricingRule,
  validateServiceOffering,
  validateTractor,
} from "./owner-catalog.js";

const location = {
  state: "Telangana",
  district: "Warangal",
  mandalOrTaluk: "Geesugonda",
  village: "Vanchanagiri",
  postalCode: "506330",
  source: "MANUAL_ADDRESS" as const,
  capturedAt: new Date("2025-01-01T00:00:00.000Z"),
};

describe("Owner catalog validation", () => {
  it("normalizes Owner identity, location, and registration data", () => {
    expect(validateOwnerProfile({
      fullName: "  రాజు   నాయక్ ",
      preferredLocale: "TE",
      contactSharingConsent: false,
      operatingLocation: location,
    })).toMatchObject({ fullName: "రాజు నాయక్", preferredLocale: "te" });

    expect(normalizeRegistrationNumber("ts 08-ab-1234")).toBe("TS08AB1234");
  });

  it("accepts tractor attributes and private photo references without projecting keys", () => {
    const tractor = validateTractor({
      brand: "Mahindra",
      model: "575 DI",
      registrationNumber: "TS08AB1234",
      manufacturingYear: 2022,
      horsepower: 47,
      operatingLocation: location,
      photos: [{
        privateObjectKey: "owners/owner-1/tractors/photo.webp",
        mimeType: "image/webp",
        altText: "Red tractor viewed from the front",
      }],
    }, new Date("2025-01-01T00:00:00.000Z"));

    expect(tractor.registrationNumber).toBe("TS08AB1234");
    expect(tractor.photos).toHaveLength(1);
  });

  it.each([
    ["postalCode", { ...location, postalCode: "123" }],
    ["coordinates", { ...location, latitude: 18 }],
  ])("rejects invalid %s", (_field, operatingLocation) => {
    expect(() => validateOwnerProfile({
      fullName: "Raju",
      preferredLocale: "en",
      contactSharingConsent: false,
      operatingLocation,
    })).toThrow(CatalogValidationError);
  });

  it("rejects future years, invalid power, and too many photos", () => {
    expect(() => validateTractor({
      brand: "Mahindra",
      model: "575 DI",
      registrationNumber: "TS08AB1234",
      manufacturingYear: 2030,
      horsepower: 0,
      operatingLocation: location,
      photos: [],
    }, new Date("2025-01-01T00:00:00.000Z"))).toThrow(CatalogValidationError);
  });

  it("validates Equipment inventory and Service Offering inputs", () => {
    expect(validateEquipment({
      equipmentTypeId: "type-plough",
      displayName: "  Heavy   Plough ",
    })).toEqual({
      equipmentTypeId: "type-plough",
      displayName: "Heavy Plough",
      availabilityStatus: "AVAILABLE",
    });
    expect(validateServiceOffering({
      serviceId: "service-ploughing",
      equipmentId: "equipment-1",
      enabled: true,
    })).toMatchObject({ enabled: true, equipmentId: "equipment-1" });
  });

  /** Validates: Requirements 6.1, 6.2, 6.3 */
  it("accepts positive paise rates and requires rounding disclosure only for hourly pricing", () => {
    expect(validatePricingRule({
      method: "HOURLY",
      ratePaise: 80_000,
      roundingPolicy: "THIRTY_MINUTE_BLOCK",
      enabled: true,
    })).toEqual({
      method: "HOURLY",
      ratePaise: 80_000,
      roundingPolicy: "THIRTY_MINUTE_BLOCK",
      enabled: true,
    });
    expect(validatePricingRule({ method: "PER_ACRE", ratePaise: 120_000, enabled: true }))
      .toEqual({ method: "PER_ACRE", ratePaise: 120_000, enabled: true });
    expect(validatePricingRule({ method: "PER_TRIP", ratePaise: 150_000, enabled: true }))
      .toEqual({ method: "PER_TRIP", ratePaise: 150_000, enabled: true });

    for (const ratePaise of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => validatePricingRule({ method: "PER_TRIP", ratePaise, enabled: true }))
        .toThrow(CatalogValidationError);
    }
    expect(() => validatePricingRule({
      method: "HOURLY",
      ratePaise: 1,
      roundingPolicy: undefined,
      enabled: true,
    } as never)).toThrowError(/rounding policy/iu);
    expect(() => validatePricingRule({
      method: "PER_ACRE",
      ratePaise: 1,
      roundingPolicy: "ONE_HOUR_BLOCK",
      enabled: true,
    } as never)).toThrowError(/only to hourly/iu);
  });

  it("returns every unmet eligibility reason and blocks publication", () => {
    const evaluation = evaluateTractorEligibility(
      "tractor-1",
      {
        hasRequiredTractorInformation: false,
        missingRequiredDocumentKinds: ["INSURANCE", "REGISTRATION_CERTIFICATE"],
        hasEnabledServiceOffering: false,
        hasActiveServicePricing: false,
        locationUpdatedAt: new Date("2024-12-01T00:00:00.000Z"),
        operationalStatus: "ONLINE",
      },
      {
        requiredDocumentKinds: ["REGISTRATION_CERTIFICATE", "INSURANCE"],
        maximumLocationAgeMs: 24 * 60 * 60 * 1000,
      },
      new Date("2025-01-01T00:00:00.000Z"),
    );

    expect(evaluation.status).toBe("INCOMPLETE");
    expect(evaluation.discoverable).toBe(false);
    expect(evaluation.reasons.map((reason) => reason.code)).toEqual([
      "REQUIRED_TRACTOR_INFORMATION_MISSING",
      "REQUIRED_DOCUMENTS_MISSING",
      "ENABLED_SERVICE_OFFERING_MISSING",
      "ACTIVE_SERVICE_PRICING_MISSING",
      "LOCATION_STALE",
    ]);
    expect(evaluation.reasons[1]?.missingDocumentKinds).toEqual([
      "INSURANCE",
      "REGISTRATION_CERTIFICATE",
    ]);
  });

  it("publishes only an online Tractor with complete, fresh eligibility facts", () => {
    const facts = {
      hasRequiredTractorInformation: true,
      missingRequiredDocumentKinds: [],
      hasEnabledServiceOffering: true,
      hasActiveServicePricing: true,
      locationUpdatedAt: new Date("2025-01-01T00:00:00.000Z"),
    } as const;
    const policy = { requiredDocumentKinds: ["INSURANCE"], maximumLocationAgeMs: 1_000 };
    const now = new Date("2025-01-01T00:00:00.500Z");

    expect(evaluateTractorEligibility("tractor-1", {
      ...facts,
      operationalStatus: "OFFLINE",
    }, policy, now)).toMatchObject({ status: "ELIGIBLE", discoverable: false, reasons: [] });
    expect(evaluateTractorEligibility("tractor-1", {
      ...facts,
      operationalStatus: "ONLINE",
    }, policy, now)).toMatchObject({ status: "ELIGIBLE", discoverable: true, reasons: [] });
  });
});
