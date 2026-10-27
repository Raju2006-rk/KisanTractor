import { describe, expect, it, vi } from "vitest";

import { CapabilityRegistry } from "./capability-registry.js";
import { ProviderGatedMapsAdapter, type MapGeocodingProvider } from "./maps-geocoding.js";

const candidate = {
  state: "Telangana",
  district: "Warangal",
  mandalOrTaluk: "Geesugonda",
  village: "Vanchanagiri",
  latitude: 17.9689,
  longitude: 79.5941,
  accuracyMeters: 40,
};

const provider = (): MapGeocodingProvider => ({
  search: vi.fn(async () => [candidate]),
  reverseGeocode: vi.fn(async () => candidate),
});

describe("ProviderGatedMapsAdapter", () => {
  /** Validates: Requirements 7.7, 14.2 */
  it("does not invoke a provider when maps are unconfigured and returns a manual alternative", async () => {
    const external = provider();
    const adapter = new ProviderGatedMapsAdapter(new CapabilityRegistry({
      MAPS_GEOCODING: { state: "UNCONFIGURED", manualAlternativeAvailable: true },
    }));

    await expect(adapter.search("Warangal", "SERVICE_LOCATION")).resolves.toMatchObject({
      kind: "UNAVAILABLE",
      state: "UNCONFIGURED",
      retryable: false,
      manualAlternativeAvailable: true,
    });
    expect(external.search).not.toHaveBeenCalled();
  });

  /** Validates: Requirements 7.1, 14.2 */
  it("normalizes sandbox map search results and labels them test-only", async () => {
    const external = provider();
    const adapter = new ProviderGatedMapsAdapter(
      new CapabilityRegistry({ MAPS_GEOCODING: { state: "SANDBOX", provider: external } }),
      { now: () => new Date("2026-01-01T00:00:00.000Z") },
    );

    await expect(adapter.search("  Vanchanagiri  ", "SERVICE_LOCATION")).resolves.toMatchObject({
      kind: "RESOLVED",
      state: "SANDBOX",
      testOnly: true,
      locations: [{
        source: "MAP_SEARCH",
        collectionPurpose: "SERVICE_LOCATION",
        capturedAt: new Date("2026-01-01T00:00:00.000Z"),
      }],
    });
    expect(external.search).toHaveBeenCalledWith("Vanchanagiri", undefined);
  });

  /** Validates: Requirements 14.4 */
  it("converts provider failures into a retryable degraded result with manual fallback", async () => {
    const external: MapGeocodingProvider = {
      search: vi.fn(async () => { throw new Error("provider timeout"); }),
      reverseGeocode: vi.fn(async () => { throw new Error("provider timeout"); }),
    };
    const adapter = new ProviderGatedMapsAdapter(new CapabilityRegistry({
      MAPS_GEOCODING: { state: "LIVE", provider: external },
    }));

    await expect(adapter.resolvePin(
      { latitude: 17.9689, longitude: 79.5941 },
      "SERVICE_LOCATION",
    )).resolves.toMatchObject({
      kind: "UNAVAILABLE",
      state: "DEGRADED",
      retryable: true,
      manualAlternativeAvailable: true,
    });
  });

  it("uses the selected pin as authoritative coordinates after reverse geocoding", async () => {
    const external = provider();
    const adapter = new ProviderGatedMapsAdapter(
      new CapabilityRegistry({ MAPS_GEOCODING: { state: "LIVE", provider: external } }),
      { now: () => new Date("2026-01-01T00:00:00.000Z") },
    );

    await expect(adapter.resolvePin(
      { latitude: 18, longitude: 80 },
      "SAVED_LOCATION",
    )).resolves.toMatchObject({
      kind: "RESOLVED",
      state: "LIVE",
      testOnly: false,
      location: { latitude: 18, longitude: 80, source: "MAP_PIN" },
    });
  });
});
