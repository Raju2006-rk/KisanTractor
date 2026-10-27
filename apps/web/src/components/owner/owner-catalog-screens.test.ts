import { readFileSync } from "node:fs";

import type {
  OwnerPricingRuleProjection,
  OwnerProfileProjection,
  OwnerServiceOfferingProjection,
  OwnerTractorProjection,
} from "@kisantractor/domain";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  OwnerPricingScreen,
  OwnerProfileScreen,
  OwnerTractorFormScreen,
  OwnerTractorListScreen,
} from "./owner-catalog-screens";

const location = {
  id: "location-1",
  state: "Telangana",
  district: "Warangal",
  mandalOrTaluk: "Geesugonda",
  village: "Vanchanagiri",
  source: "MANUAL_ADDRESS" as const,
  capturedAt: new Date("2025-01-01T00:00:00.000Z"),
};

const profile: OwnerProfileProjection = {
  userId: "owner-1",
  fullName: "Raju Naik",
  preferredLocale: "te",
  contactSharingConsent: false,
  mobileVerified: true,
  verificationStatus: "UNVERIFIED",
  operatingLocation: location,
  version: 1,
};

const tractor: OwnerTractorProjection = {
  id: "tractor-1",
  ownerId: "owner-1",
  brand: "Mahindra",
  model: "575 DI",
  registrationNumber: "TS08AB1234",
  manufacturingYear: 2022,
  horsepower: 47,
  operationalStatus: "OFFLINE",
  eligibilityStatus: "INCOMPLETE",
  operatingLocation: location,
  photos: [{ id: "photo-1", mimeType: "image/webp", altText: "Red tractor", sortOrder: 0 }],
  version: 1,
};

const offering: OwnerServiceOfferingProjection = {
  id: "offering-1",
  tractorId: tractor.id,
  serviceId: "service-ploughing",
  serviceCode: "PLOUGHING",
  serviceName: "Ploughing",
  equipmentId: "equipment-1",
  equipmentName: "Heavy Plough",
  enabled: true,
  version: 1,
};

const hourlyRule: OwnerPricingRuleProjection = {
  id: "pricing-1",
  serviceOfferingId: offering.id,
  method: "HOURLY",
  ratePaise: 80_000,
  currency: "INR",
  roundingPolicy: "THIRTY_MINUTE_BLOCK",
  enabled: true,
  version: 2,
};

/** Validates: Requirements 4.1, 4.2, 4.3, 4.4 */
describe("Owner catalog screens", () => {
  it("renders identity and required operating-location fields with accessible labels", () => {
    const markup = renderToStaticMarkup(createElement(OwnerProfileScreen, { locale: "en", profile }));
    for (const name of ["fullName", "state", "district", "mandalOrTaluk", "village", "capturedAt"]) {
      expect(markup).toContain(`name="${name}"`);
    }
    expect(markup).toContain("Mobile number verified");
    for (const [value, label] of [["mr", "मराठी"], ["bn", "বাংলা"]]) {
      expect(markup).toContain(`value="${value}"`);
      expect(markup).toContain(label);
    }
  });

  it("renders multiple Owner tractors without publicizing exact coordinates", () => {
    const markup = renderToStaticMarkup(createElement(OwnerTractorListScreen, {
      locale: "en",
      tractors: [tractor, { ...tractor, id: "tractor-2", registrationNumber: "TS08AB5678" }],
    }));
    expect(markup).toContain("TS08AB1234");
    expect(markup).toContain("TS08AB5678");
    expect(markup).not.toContain("latitude");
  });

  it("renders tractor attributes, private-registration guidance, and photo metadata", () => {
    const markup = renderToStaticMarkup(createElement(OwnerTractorFormScreen, { locale: "en", tractor }));
    for (const name of ["brand", "model", "registrationNumber", "manufacturingYear", "horsepower"]) {
      expect(markup).toContain(`name="${name}"`);
    }
    expect(markup).toContain("Red tractor");
    expect(markup).toContain("Only you and explicitly authorized support");
  });

  it("offers separate accessible camera and file-picker inputs for responsive devices", () => {
    const markup = renderToStaticMarkup(createElement(OwnerTractorFormScreen, { locale: "en" }));

    expect(markup).toContain('for="tractorPhotoCamera"');
    expect(markup).toMatch(/<input(?=[^>]*id="tractorPhotoCamera")(?=[^>]*accept="image\/jpeg,image\/png,image\/webp")(?=[^>]*capture="environment")(?=[^>]*type="file")[^>]*>/u);
    expect(markup).toContain('for="tractorPhotoFiles"');
    expect(markup).toMatch(/<input(?=[^>]*id="tractorPhotoFiles")(?=[^>]*multiple="")(?=[^>]*type="file")[^>]*>/u);
    expect(markup.match(/aria-describedby="tractor-photos-hint"/gu)).toHaveLength(2);
  });

  it("stacks photo inputs on narrow screens and preserves accessible target and focus styling", () => {
    const css = readFileSync(new URL("../../app/globals.css", import.meta.url), "utf8");

    expect(css).toMatch(/\.kt-file-field input\[type="file"\][\s\S]*?min-height:\s*2\.75rem;/u);
    expect(css).toMatch(/\.kt-file-field input\[type="file"\]:focus-visible[\s\S]*?outline:/u);
    expect(css).toMatch(/@media \(max-width: 30rem\)[\s\S]*?\.kt-owner-photo-inputs\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\);/u);
  });

  /** Validates: Requirements 6.1, 6.2, 6.3 */
  it("renders all pricing methods against the selected Service Offering and Equipment", () => {
    const markup = renderToStaticMarkup(createElement(OwnerPricingScreen, {
      locale: "en",
      configurations: [{ tractor, offering, rules: [hourlyRule] }],
    }));

    expect(markup).toContain("Ploughing");
    expect(markup).toContain("Heavy Plough");
    expect(markup.match(/name="method"/gu)).toHaveLength(3);
    for (const method of ["HOURLY", "PER_ACRE", "PER_TRIP"]) {
      expect(markup).toContain(`value="${method}"`);
    }
    expect(markup.match(/name="ratePaise"/gu)).toHaveLength(3);
    expect(markup.match(/min="1"/gu)).toHaveLength(3);
    expect(markup.match(/step="1"/gu)).toHaveLength(3);
    expect(markup).toContain("100 paise equals ₹1");
  });

  it("discloses the saved hourly rounding policy and submits optimistic version", () => {
    const markup = renderToStaticMarkup(createElement(OwnerPricingScreen, {
      locale: "en",
      configurations: [{ tractor, offering, rules: [hourlyRule] }],
    }));

    expect(markup).toContain('name="roundingPolicy"');
    expect(markup).toContain('value="THIRTY_MINUTE_BLOCK" selected=""');
    expect(markup).toContain("Round up to 30-minute blocks");
    expect(markup).toMatch(/<input(?=[^>]*type="hidden")(?=[^>]*name="expectedVersion")(?=[^>]*value="2")[^>]*>/u);
    expect(markup).toContain('/api/owner/service-offerings/offering-1/pricing-rules');
  });
});
