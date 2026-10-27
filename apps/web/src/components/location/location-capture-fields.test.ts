import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LocationCaptureFields } from "./location-capture-fields";

const unavailableMaps = {
  state: "UNCONFIGURED" as const,
  isOperational: false,
  isTest: false,
  canRetry: false,
  message: "This service is not configured.",
};

describe("LocationCaptureFields", () => {
  /** Validates: Requirements 7.1, 7.7, 12.6, 14.2 */
  it("always renders manual administrative entry and explains GPS purpose and unavailable maps", () => {
    const html = renderToStaticMarkup(createElement(LocationCaptureFields, {
      collectionPurpose: "SERVICE_LOCATION",
      locale: "en",
      mapsCapability: unavailableMaps,
    }));

    for (const name of ["state", "district", "mandalOrTaluk", "village", "landmark"]) {
      expect(html).toContain(`name="${name}"`);
    }
    expect(html).toContain("Allow KisanTractor to use this device location for this service location");
    expect(html).toContain("Maps are unavailable. Enter the service location manually.");
    expect(html).toContain("name=\"collectionPurpose\" value=\"SERVICE_LOCATION\"");
    expect(html).not.toContain("name=\"latitude\"");
  });

  /** Validates: Requirements 7.1, 7.2, 14.1 */
  it("offers provider address search and approved coordinate entry without removing manual fields", () => {
    const html = renderToStaticMarkup(createElement(LocationCaptureFields, {
      collectionPurpose: "SERVICE_LOCATION",
      locale: "en",
      mapsCapability: {
        state: "SANDBOX",
        isOperational: true,
        isTest: true,
        canRetry: false,
        message: "Test map provider",
      },
      showCoordinateEntry: true,
    }));

    expect(html).toContain("Search village, landmark, or PIN code");
    expect(html).toContain("Search map provider");
    expect(html).toContain("Test service (sandbox)");
    expect(html).toContain('name="latitude"');
    expect(html).toContain('name="longitude"');
    expect(html).toContain('name="source" value="MANUAL_ADDRESS"');
  });

  /** Validates: Requirements 7.6, 14.4 */
  it("communicates stale data and degraded map retry/manual alternatives", () => {
    const html = renderToStaticMarkup(createElement(LocationCaptureFields, {
      collectionPurpose: "TRACTOR_OPERATING_LOCATION",
      locale: "en",
      location: {
        id: "location-1",
        state: "Telangana",
        district: "Warangal",
        mandalOrTaluk: "Geesugonda",
        village: "Vanchanagiri",
        source: "DEVICE_GPS",
        latitude: 17.9,
        longitude: 79.5,
        accuracyMeters: 50,
        capturedAt: new Date("2020-01-01T00:00:00.000Z"),
        consentedAt: new Date("2019-12-31T23:59:00.000Z"),
      },
      mapsCapability: {
        state: "DEGRADED",
        isOperational: false,
        isTest: false,
        canRetry: true,
        message: "Temporarily unavailable",
      },
    }));

    expect(html).toContain("Location is stale");
    expect(html).toContain("Retry maps safely or continue with manual entry.");
    expect(html).toContain("name=\"accuracyMeters\" value=\"50\"");
    expect(html).toContain("name=\"consentedAt\"");
  });
});
