import type { AuthPrincipal } from "@kisantractor/domain";
import { InMemoryMetrics, OperationalIndicators } from "@kisantractor/observability";
import { describe, expect, it } from "vitest";

import type {
  DiscoverySearchInput,
  DiscoveryStore,
  DiscoveryStoreRow,
  NormalizedDiscoveryQuery,
} from "./discovery.contracts.js";
import {
  DiscoveryAuthorizationError,
  DiscoveryService,
  DiscoveryValidationError,
} from "./discovery.service.js";

const farmer: AuthPrincipal = Object.freeze({
  userId: "farmer-1",
  sessionId: "session-1",
  roles: ["FARMER"],
});
const signingKey = new Uint8Array(32).fill(17);
const now = new Date("2025-03-01T10:00:00.000Z");

const searchInput = (overrides: Partial<DiscoverySearchInput> = {}): DiscoverySearchInput => ({
  serviceLocation: {
    state: "Telangana",
    district: "Warangal",
    mandalOrTaluk: "Hanamkonda",
    village: "Selected Farm",
    source: "MANUAL_ADDRESS",
    latitude: 17.9689,
    longitude: 79.5941,
    capturedAt: now,
  },
  serviceId: "service-ploughing",
  requestedInterval: {
    start: new Date("2025-03-02T04:00:00.000Z"),
    end: new Date("2025-03-02T08:00:00.000Z"),
  },
  ...overrides,
});

const row = (id: string, distanceMeters: number): DiscoveryStoreRow => ({
  tractorId: id,
  brand: "Mahindra",
  model: "575 DI",
  state: "Telangana",
  district: "Warangal",
  photoAltText: "Red tractor in a field",
  serviceOfferingId: `offering-${id}`,
  serviceId: "service-ploughing",
  serviceName: "Ploughing",
  equipmentId: `equipment-${id}`,
  equipmentTypeId: "equipment-type-plough",
  equipmentName: "Three-bottom plough",
  pricingRules: [{
    id: `pricing-${id}`,
    method: "PER_ACRE",
    ratePaise: 120_000,
    currency: "INR",
  }],
  availabilityRank: 0,
  distanceMeters,
});

class MemoryDiscoveryStore implements DiscoveryStore {
  readonly queries: NormalizedDiscoveryQuery[] = [];

  constructor(private readonly pages: readonly (readonly DiscoveryStoreRow[])[]) {}

  async search(query: NormalizedDiscoveryQuery): Promise<readonly DiscoveryStoreRow[]> {
    this.queries.push(query);
    return this.pages[this.queries.length - 1] ?? [];
  }
}

/** Validates: Requirements 3.3, 3.4, 7.2, 7.4, 7.6, 7.8, 18.3 */
describe("DiscoveryService", () => {
  it("uses the selected Service Location, applies the configurable 5 km default, and projects only redacted cards", async () => {
    const privateSource = {
      ...row("tractor-1", 3_432),
      ownerPhone: "+919876543210",
      exactCoordinates: { latitude: 18, longitude: 80 },
      registrationNumber: "TS00AA0000",
      documentObjectKey: "private/owner/document.pdf",
    };
    const store = new MemoryDiscoveryStore([[privateSource]]);
    const service = new DiscoveryService(store, signingKey, undefined, () => now);

    const result = await service.search(farmer, searchInput());

    expect(store.queries[0]).toMatchObject({
      radiusKilometers: 5,
      pageSize: 20,
      serviceLocation: { latitude: 17.9689, longitude: 79.5941 },
      staleBefore: new Date("2025-02-28T10:00:00.000Z"),
    });
    expect(result).toMatchObject({
      radiusKilometers: 5,
      defaultRadiusApplied: true,
      canExpandRadius: true,
      maximumRadiusKilometers: 100,
      origin: { state: "Telangana", district: "Warangal" },
      items: [{
        id: "tractor-1",
        photo: { altText: "Red tractor in a field" },
        approximateDistance: {
          kilometers: 3.4,
          isEstimate: true,
          exactCoordinatesExposed: false,
        },
        service: { offeringId: "offering-tractor-1", name: "Ploughing" },
        equipment: { name: "Three-bottom plough" },
        availability: { available: true, rank: 0 },
      }],
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("9876543210");
    expect(serialized).not.toContain("TS00AA0000");
    expect(serialized).not.toContain("private/owner");
    expect(serialized).not.toContain("\"latitude\"");
    expect(serialized).not.toContain("\"longitude\"");
  });

  it("returns a signed keyset cursor and rejects tampering or reuse with changed filters", async () => {
    const store = new MemoryDiscoveryStore([
      [row("tractor-1", 1_000), row("tractor-2", 2_000), row("tractor-3", 3_000)],
      [row("tractor-3", 3_000)],
    ]);
    const service = new DiscoveryService(store, signingKey, undefined, () => now);
    const input = searchInput({ pageSize: 2, radiusKilometers: 10 });

    const first = await service.search(farmer, input);
    expect(first.items.map((item) => item.id)).toEqual(["tractor-1", "tractor-2"]);
    expect(first.nextCursor).toBeTypeOf("string");

    const second = await service.search(farmer, { ...input, cursor: first.nextCursor });
    expect(store.queries[1]?.cursor).toEqual({
      availabilityRank: 0,
      distanceMeters: 2_000,
      tractorId: "tractor-2",
    });
    expect(second.items.map((item) => item.id)).toEqual(["tractor-3"]);

    const tampered = `${first.nextCursor!.slice(0, -1)}x`;
    await expect(service.search(farmer, { ...input, cursor: tampered }))
      .rejects.toBeInstanceOf(DiscoveryValidationError);
    await expect(service.search(farmer, { ...input, radiusKilometers: 20, cursor: first.nextCursor }))
      .rejects.toThrow("does not match this search");
  });

  it("enforces Farmer authorization and bounded radius, page size, coordinates, and intervals", async () => {
    const service = new DiscoveryService(new MemoryDiscoveryStore([[]]), signingKey, undefined, () => now);
    await expect(service.search(
      { userId: "owner-1", sessionId: "session-owner", roles: ["OWNER"] },
      searchInput(),
    )).rejects.toBeInstanceOf(DiscoveryAuthorizationError);
    await expect(service.search(farmer, searchInput({ radiusKilometers: 101 })))
      .rejects.toThrow("at most 100");
    await expect(service.search(farmer, searchInput({ pageSize: 51 })))
      .rejects.toThrow("from 1 to 50");
    await expect(service.search(farmer, searchInput({
      serviceLocation: {
        state: "Telangana",
        district: "Warangal",
        mandalOrTaluk: "Hanamkonda",
        village: "Selected Farm",
        source: "MANUAL_ADDRESS",
        capturedAt: now,
      },
    }))).rejects.toThrow("requires approved service-location coordinates");
    await expect(service.search(farmer, searchInput({
      requestedInterval: { start: now, end: now },
    }))).rejects.toThrow("non-empty half-open interval");
  });
});

/** Validates: Requirements 18.2 */
describe("DiscoveryService zero-result indicator", () => {
  it("counts first-page searches by outcome and ignores follow-up pages", async () => {
    const metrics = new InMemoryMetrics();
    const store = new MemoryDiscoveryStore([
      [],
      [row("tractor-1", 1_000), row("tractor-2", 2_000)],
      [row("tractor-2", 2_000)],
    ]);
    const service = new DiscoveryService(store, signingKey, undefined, () => now, new OperationalIndicators(metrics));

    await service.search(farmer, searchInput({ pricingMethod: "PER_ACRE" }));
    const first = await service.search(farmer, searchInput({ pageSize: 1 }));
    expect(first.nextCursor).toBeTypeOf("string");
    await service.search(farmer, searchInput({ pageSize: 1, cursor: first.nextCursor! }));

    expect(metrics.value("kt_discovery_searches_total", { outcome: "ZERO_RESULTS", pricing_method: "PER_ACRE" })).toBe(1);
    expect(metrics.value("kt_discovery_searches_total", { outcome: "RESULTS", pricing_method: "ANY" })).toBe(1);
    expect(metrics.total("kt_discovery_searches_total")).toBe(2);
  });
});
