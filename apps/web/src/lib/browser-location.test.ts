import { describe, expect, it } from "vitest";

import {
  captureConsentedBrowserLocation,
  type BrowserGeolocation,
} from "./browser-location";

const consent = {
  granted: true,
  consentedAt: new Date("2026-01-01T00:00:00.000Z"),
  purpose: "SERVICE_LOCATION" as const,
};

const successfulGeolocation: BrowserGeolocation = {
  getCurrentPosition(success, _error, options) {
    expect(options).toEqual({ enableHighAccuracy: true, maximumAge: 0, timeout: 10_000 });
    success({
      coords: { latitude: 17.9689, longitude: 79.5941, accuracy: 24.2 },
      timestamp: Date.parse("2026-01-01T00:00:01.000Z"),
    });
  },
};

describe("captureConsentedBrowserLocation", () => {
  /** Validates: Requirements 7.1, 12.6 */
  it("does not access browser GPS before explicit purpose-bound consent", async () => {
    let calls = 0;
    const geolocation: BrowserGeolocation = {
      getCurrentPosition() { calls += 1; },
    };

    await expect(captureConsentedBrowserLocation(geolocation, {
      granted: false,
      purpose: "SERVICE_LOCATION",
    })).resolves.toMatchObject({ kind: "CONSENT_REQUIRED", manualEntryAvailable: true });
    expect(calls).toBe(0);
  });

  /** Validates: Requirements 7.1, 7.6 */
  it("captures coordinates with accuracy, consent, purpose, and freshness metadata", async () => {
    await expect(captureConsentedBrowserLocation(successfulGeolocation, consent, {
      now: () => new Date("2026-01-01T00:00:02.000Z"),
    })).resolves.toMatchObject({
      kind: "CAPTURED",
      location: {
        latitude: 17.9689,
        longitude: 79.5941,
        accuracyMeters: 24.2,
        capturedAt: new Date("2026-01-01T00:00:01.000Z"),
        consentedAt: new Date("2026-01-01T00:00:00.000Z"),
        collectionPurpose: "SERVICE_LOCATION",
        source: "DEVICE_GPS",
        accuracy: { quality: "HIGH" },
        freshness: { status: "FRESH", usableForDiscovery: true },
      },
    });
  });

  /** Validates: Requirements 7.1, 7.7 */
  it.each([
    [1, "PERMISSION_DENIED"],
    [2, "POSITION_UNAVAILABLE"],
    [3, "TIMED_OUT"],
  ] as const)("communicates geolocation error %s and preserves manual entry", async (code, kind) => {
    const geolocation: BrowserGeolocation = {
      getCurrentPosition(_success, error) { error({ code }); },
    };
    await expect(captureConsentedBrowserLocation(geolocation, consent, {
      mapAlternativeAvailable: true,
    })).resolves.toMatchObject({
      kind,
      manualEntryAvailable: true,
      mapAlternativeAvailable: true,
    });
  });

  it("communicates browsers without geolocation support", async () => {
    await expect(captureConsentedBrowserLocation(undefined, consent)).resolves.toMatchObject({
      kind: "UNAVAILABLE",
      manualEntryAvailable: true,
    });
  });
});
