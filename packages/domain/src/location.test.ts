import { describe, expect, it } from "vitest";

import {
  describeCoordinateAccuracy,
  evaluateLocationFreshness,
  LocationValidationError,
  normalizeLocation,
  presentEstimatedDistance,
} from "./location.js";

const manualLocation = {
  state: "  Telangana ",
  district: " Warangal  Rural ",
  mandalOrTaluk: " Geesugonda ",
  village: " Vanchanagiri ",
  landmark: " Near  the market ",
  postalCode: "506330",
  source: "MANUAL_ADDRESS" as const,
  capturedAt: new Date("2026-01-01T00:00:00.000Z"),
};

describe("normalized locations", () => {
  /** Validates: Requirements 7.1, 7.7 */
  it("normalizes complete manual administrative locations without claiming map resolution", () => {
    expect(normalizeLocation(manualLocation)).toEqual({
      state: "Telangana",
      district: "Warangal Rural",
      mandalOrTaluk: "Geesugonda",
      village: "Vanchanagiri",
      landmark: "Near the market",
      postalCode: "506330",
      source: "MANUAL_ADDRESS",
      capturedAt: new Date("2026-01-01T00:00:00.000Z"),
      collectionPurpose: "SERVICE_LOCATION",
    });
  });

  /** Validates: Requirements 7.1, 12.6 */
  it("requires coordinates, accuracy, prior consent, and a disclosed purpose for device GPS", () => {
    const capturedAt = new Date("2026-01-01T00:01:00.000Z");
    expect(normalizeLocation({
      ...manualLocation,
      source: "DEVICE_GPS",
      latitude: 17.9689,
      longitude: 79.5941,
      accuracyMeters: 18.4,
      consentedAt: new Date("2026-01-01T00:00:00.000Z"),
      capturedAt,
      collectionPurpose: "SERVICE_LOCATION",
    })).toMatchObject({
      source: "DEVICE_GPS",
      latitude: 17.9689,
      longitude: 79.5941,
      accuracyMeters: 18.4,
      collectionPurpose: "SERVICE_LOCATION",
    });

    for (const invalid of [
      { ...manualLocation, source: "DEVICE_GPS" as const },
      { ...manualLocation, source: "DEVICE_GPS" as const, latitude: 18, longitude: 79, accuracyMeters: 10 },
      {
        ...manualLocation,
        source: "DEVICE_GPS" as const,
        latitude: 18,
        longitude: 79,
        accuracyMeters: 10,
        consentedAt: new Date("2026-01-01T00:02:00.000Z"),
      },
    ]) {
      expect(() => normalizeLocation(invalid)).toThrow(LocationValidationError);
    }
  });

  it("rejects partial or out-of-range coordinates and invalid PIN codes", () => {
    expect(() => normalizeLocation({ ...manualLocation, latitude: 18 })).toThrow(/supplied together/iu);
    expect(() => normalizeLocation({ ...manualLocation, latitude: 91, longitude: 79 })).toThrow(/latitude/iu);
    expect(() => normalizeLocation({ ...manualLocation, postalCode: "123" })).toThrow(/6-digit/iu);
    expect(() => normalizeLocation({ ...manualLocation, accuracyMeters: 10 })).toThrow(/requires coordinates/iu);
  });
});

describe("location freshness and privacy presentation", () => {
  /** Validates: Requirements 7.6 */
  it("labels fresh, aging, stale, and future-dated captures honestly", () => {
    const now = new Date("2026-01-02T00:00:00.000Z");
    const policy = { warningAgeMs: 1_000, maximumAgeMs: 2_000 };

    expect(evaluateLocationFreshness(new Date(now.getTime() - 500), policy, now).status).toBe("FRESH");
    expect(evaluateLocationFreshness(new Date(now.getTime() - 1_500), policy, now).status).toBe("AGING");
    expect(evaluateLocationFreshness(new Date(now.getTime() - 2_001), policy, now)).toMatchObject({
      status: "STALE",
      usableForDiscovery: false,
    });
    expect(evaluateLocationFreshness(new Date(now.getTime() + 1), policy, now).message).toMatch(/invalid/iu);
  });

  it("communicates coordinate accuracy and estimated distance without coordinates", () => {
    expect(describeCoordinateAccuracy(18.4)).toEqual({
      quality: "HIGH",
      accuracyMeters: 18.4,
      message: "Estimated coordinate accuracy: within about 19 metres.",
    });
    expect(describeCoordinateAccuracy(undefined).quality).toBe("UNKNOWN");
    expect(presentEstimatedDistance(2.34)).toEqual({
      kilometers: 2.3,
      label: "Approximately 2.3 km away",
      isEstimate: true,
      exactCoordinatesExposed: false,
    });
  });
});
