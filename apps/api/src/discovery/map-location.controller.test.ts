import type { AuthPrincipal } from "@kisantractor/domain";
import { CapabilityRegistry, ProviderGatedMapsAdapter, type MapGeocodingProvider } from "@kisantractor/providers";
import { describe, expect, it, vi } from "vitest";

import type { DiscoverySessionAuthenticator } from "./discovery.contracts.js";
import { MapLocationController } from "./map-location.controller.js";

const farmer: AuthPrincipal = { userId: "farmer-1", sessionId: "session-1", roles: ["FARMER"] };

class Authenticator implements DiscoverySessionAuthenticator {
  constructor(private readonly principal: AuthPrincipal = farmer) {}
  async authenticateAccessCredential(): Promise<AuthPrincipal> { return this.principal; }
}

const candidate = {
  state: "Telangana",
  district: "Warangal",
  mandalOrTaluk: "Geesugonda",
  village: "Vanchanagiri",
  latitude: 17.9689,
  longitude: 79.5941,
};

const request = { headers: { authorization: "Bearer access-token" } };

/** Validates: Requirements 7.1, 7.2, 7.7, 14.1, 14.4 */
describe("FarmerMapLocationController", () => {
  it("returns normalized provider search locations through the existing location contract", async () => {
    const provider: MapGeocodingProvider = {
      search: vi.fn(async () => [candidate]),
      reverseGeocode: vi.fn(async () => candidate),
    };
    const controller = new MapLocationController(
      new Authenticator(),
      new ProviderGatedMapsAdapter(new CapabilityRegistry({
        MAPS_GEOCODING: { state: "SANDBOX", provider },
      }), { now: () => new Date("2027-01-01T00:00:00.000Z") }),
    );

    await expect(controller.search(request, {
      query: "Vanchanagiri",
      collectionPurpose: "SERVICE_LOCATION",
    })).resolves.toMatchObject({
      kind: "RESOLVED",
      state: "SANDBOX",
      testOnly: true,
      locations: [{
        source: "MAP_SEARCH",
        latitude: 17.9689,
        longitude: 79.5941,
        collectionPurpose: "SERVICE_LOCATION",
      }],
    });
  });

  it("does not call a provider while unconfigured and preserves manual fallback", async () => {
    const provider: MapGeocodingProvider = {
      search: vi.fn(async () => [candidate]),
      reverseGeocode: vi.fn(async () => candidate),
    };
    const controller = new MapLocationController(
      new Authenticator(),
      new ProviderGatedMapsAdapter(new CapabilityRegistry({
        MAPS_GEOCODING: { state: "UNCONFIGURED", manualAlternativeAvailable: true },
      })),
    );

    await expect(controller.search(request, {
      query: "Warangal",
      collectionPurpose: "SERVICE_LOCATION",
    })).resolves.toMatchObject({
      kind: "UNAVAILABLE",
      state: "UNCONFIGURED",
      manualAlternativeAvailable: true,
    });
    expect(provider.search).not.toHaveBeenCalled();
  });

  it("rejects unsupported principals and invalid pin coordinates before provider use", async () => {
    const provider: MapGeocodingProvider = {
      search: vi.fn(async () => [candidate]),
      reverseGeocode: vi.fn(async () => candidate),
    };
    const maps = new ProviderGatedMapsAdapter(new CapabilityRegistry({
      MAPS_GEOCODING: { state: "LIVE", provider },
    }));
    const ownerController = new MapLocationController(
      new Authenticator({ userId: "user-1", sessionId: "session-2", roles: [] }),
      maps,
    );
    await expect(ownerController.search(request, {
      query: "Warangal",
      collectionPurpose: "SERVICE_LOCATION",
    })).rejects.toMatchObject({ status: 404 });

    const controller = new MapLocationController(new Authenticator(), maps);
    await expect(controller.resolvePin(request, {
      latitude: 91,
      longitude: 79,
      collectionPurpose: "SERVICE_LOCATION",
    })).rejects.toMatchObject({ status: 422 });
    expect(provider.reverseGeocode).not.toHaveBeenCalled();
  });
});
