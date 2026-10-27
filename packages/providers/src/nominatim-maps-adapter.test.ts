import { describe, expect, it, vi } from "vitest";

import { CapabilityRegistry } from "./capability-registry.js";
import { ProviderGatedMapsAdapter } from "./maps-geocoding.js";
import { NominatimMapsAdapter, type MapsHttpClient } from "./nominatim-maps-adapter.js";

const searchPayload = [
  {
    place_id: 12345,
    lat: "17.9689",
    lon: "79.5941",
    display_name: "Vanchanagiri, Geesugonda, Warangal, Telangana, 506007, India",
    address: {
      village: "Vanchanagiri",
      county: "Geesugonda",
      state_district: "Warangal",
      state: "Telangana",
      postcode: "506007",
      country_code: "in",
    },
  },
];

const reversePayload = {
  place_id: 67890,
  lat: "18.0",
  lon: "80.0",
  display_name: "Some Village, Some Taluk, Some District, Karnataka, India",
  address: {
    hamlet: "Some Village",
    county: "Some Taluk",
    state_district: "Some District",
    state: "Karnataka",
    country_code: "in",
  },
};

const ok = (body: unknown): MapsHttpClient => vi.fn(async () => ({ status: 200, json: async () => body }));

describe("NominatimMapsAdapter", () => {
  it("rejects a LIVE adapter outside staging or production", () => {
    expect(() => new NominatimMapsAdapter({ environment: "local", mode: "LIVE", userAgent: "KisanTractor (ops@example.com)" }))
      .toThrow(/staging or production/);
  });

  it("requires a non-empty User-Agent", () => {
    expect(() => new NominatimMapsAdapter({ environment: "local", mode: "SANDBOX", userAgent: "   " }))
      .toThrow(/User-Agent/);
  });

  it("maps OSM address fields to the required location slots and sends a User-Agent", async () => {
    const http = ok(searchPayload);
    const adapter = new NominatimMapsAdapter({
      environment: "test",
      mode: "SANDBOX",
      userAgent: "KisanTractor (ops@example.com)",
      http,
    });

    const results = await adapter.search("Vanchanagiri");
    expect(results).toEqual([
      expect.objectContaining({
        state: "Telangana",
        district: "Warangal",
        mandalOrTaluk: "Geesugonda",
        village: "Vanchanagiri",
        postalCode: "506007",
        latitude: 17.9689,
        longitude: 79.5941,
        providerPlaceId: "12345",
      }),
    ]);
    const request = (http as unknown as { mock: { calls: [{ headers: Record<string, string>; url: string }] } }).mock.calls[0][0];
    expect(request.headers["User-Agent"]).toBe("KisanTractor (ops@example.com)");
    expect(request.url).toContain("countrycodes=in");
  });

  it("reverse geocodes a pin into a normalized-ready candidate", async () => {
    const adapter = new NominatimMapsAdapter({
      environment: "test",
      mode: "SANDBOX",
      userAgent: "KisanTractor (ops@example.com)",
      http: ok(reversePayload),
    });
    const location = await adapter.reverseGeocode({ latitude: 18, longitude: 80 });
    expect(location).toMatchObject({ state: "Karnataka", village: "Some Village", latitude: 18, longitude: 80 });
  });

  it("drops results missing a required slot rather than guessing", async () => {
    const adapter = new NominatimMapsAdapter({
      environment: "test",
      mode: "SANDBOX",
      userAgent: "KisanTractor (ops@example.com)",
      http: ok([{ lat: "1", lon: "1", address: { country_code: "in" } }]),
    });
    await expect(adapter.search("nowhere")).resolves.toEqual([]);
  });

  it("flows through the provider-gated adapter as test-only in SANDBOX", async () => {
    const adapter = new NominatimMapsAdapter({
      environment: "test",
      mode: "SANDBOX",
      userAgent: "KisanTractor (ops@example.com)",
      http: ok(searchPayload),
    });
    const gated = new ProviderGatedMapsAdapter(
      new CapabilityRegistry({ MAPS_GEOCODING: { state: "SANDBOX", provider: adapter } }),
      { now: () => new Date("2027-01-01T00:00:00.000Z") },
    );
    await expect(gated.search("Vanchanagiri", "SERVICE_LOCATION")).resolves.toMatchObject({
      kind: "RESOLVED",
      state: "SANDBOX",
      testOnly: true,
      locations: [expect.objectContaining({ source: "MAP_SEARCH", village: "Vanchanagiri" })],
    });
  });

  it("turns a non-2xx response into a throw the gated adapter degrades", async () => {
    const adapter = new NominatimMapsAdapter({
      environment: "test",
      mode: "SANDBOX",
      userAgent: "KisanTractor (ops@example.com)",
      http: vi.fn(async () => ({ status: 503, json: async () => ({}) })),
    });
    const gated = new ProviderGatedMapsAdapter(
      new CapabilityRegistry({ MAPS_GEOCODING: { state: "SANDBOX", provider: adapter } }),
    );
    await expect(gated.search("anything", "SERVICE_LOCATION")).resolves.toMatchObject({
      kind: "UNAVAILABLE",
      state: "DEGRADED",
      retryable: true,
      manualAlternativeAvailable: true,
    });
  });
});
