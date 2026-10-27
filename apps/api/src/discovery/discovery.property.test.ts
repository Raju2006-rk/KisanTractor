import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { AuthPrincipal, LocationInput, PricingMethod } from "@kisantractor/domain";

import type {
  DiscoverySearchInput,
  DiscoveryStore,
  DiscoveryStoreRow,
  NormalizedDiscoveryQuery,
} from "./discovery.contracts.js";
import { DiscoveryService } from "./discovery.service.js";

const propertyRuns = 250;
const seeds = {
  recipientOrigin: 7_203_803,
  radiusSoundness: 7_405_503,
} as const;

const earthRadiusMeters = 6_371_008.8;
const spatialToleranceMeters = 1;
const now = new Date("2025-03-01T10:00:00.000Z");
const requestedInterval = Object.freeze({
  start: new Date("2025-03-02T04:00:00.000Z"),
  end: new Date("2025-03-02T08:00:00.000Z"),
});
const farmer: AuthPrincipal = Object.freeze({
  userId: "farmer-property",
  sessionId: "session-property",
  roles: ["FARMER"],
});
const signingKey = new Uint8Array(32).fill(73);
const serviceId = "service-ploughing";
const equipmentTypeId = "equipment-type-plough";

interface GeoPoint {
  readonly latitude: number;
  readonly longitude: number;
}

interface GeneratedFilters {
  readonly equipmentRequired: boolean;
  readonly pricingMethod?: PricingMethod;
}

interface CandidateSpecification {
  readonly bearingDegrees: number;
  readonly boundaryOffsetCentimeters: number;
  readonly tractorOnline: boolean;
  readonly availabilityOnline: boolean;
  readonly eligible: boolean;
  readonly fresh: boolean;
  readonly offeringEnabled: boolean;
  readonly serviceMatches: boolean;
  readonly hasEquipment: boolean;
  readonly equipmentTypeMatches: boolean;
  readonly equipmentAvailable: boolean;
  readonly activePricing: boolean;
  readonly pricingMethod: PricingMethod;
  readonly hasBlockingOverlap: boolean;
}

interface GeneratedCandidate extends CandidateSpecification {
  readonly id: string;
  readonly point: GeoPoint;
  readonly locationUpdatedAt: Date;
}

interface GeneratedScenario {
  readonly recipientLocation: GeoPoint;
  readonly firstCustomerLocation: GeoPoint;
  readonly secondCustomerLocation: GeoPoint;
  readonly radiusKilometers: number;
  readonly useDefaultRadius: boolean;
  readonly filters: GeneratedFilters;
  readonly candidates: readonly GeneratedCandidate[];
}

const degreesToRadians = (degrees: number): number => degrees * Math.PI / 180;
const radiansToDegrees = (radians: number): number => radians * 180 / Math.PI;

function destinationPoint(origin: GeoPoint, bearingDegrees: number, distanceMeters: number): GeoPoint {
  const angularDistance = distanceMeters / earthRadiusMeters;
  const bearing = degreesToRadians(bearingDegrees);
  const latitude = degreesToRadians(origin.latitude);
  const longitude = degreesToRadians(origin.longitude);
  const destinationLatitude = Math.asin(
    Math.sin(latitude) * Math.cos(angularDistance)
      + Math.cos(latitude) * Math.sin(angularDistance) * Math.cos(bearing),
  );
  const destinationLongitude = longitude + Math.atan2(
    Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(latitude),
    Math.cos(angularDistance) - Math.sin(latitude) * Math.sin(destinationLatitude),
  );

  return Object.freeze({
    latitude: radiansToDegrees(destinationLatitude),
    longitude: ((radiansToDegrees(destinationLongitude) + 540) % 360) - 180,
  });
}

function sphericalLawOfCosinesMeters(origin: GeoPoint, candidate: GeoPoint): number {
  const originLatitude = degreesToRadians(origin.latitude);
  const candidateLatitude = degreesToRadians(candidate.latitude);
  const longitudeDelta = degreesToRadians(candidate.longitude - origin.longitude);
  const cosine = Math.sin(originLatitude) * Math.sin(candidateLatitude)
    + Math.cos(originLatitude) * Math.cos(candidateLatitude) * Math.cos(longitudeDelta);
  return earthRadiusMeters * Math.acos(Math.max(-1, Math.min(1, cosine)));
}

function haversineDistanceMeters(origin: GeoPoint, candidate: GeoPoint): number {
  const latitudeDelta = degreesToRadians(candidate.latitude - origin.latitude);
  const longitudeDelta = degreesToRadians(candidate.longitude - origin.longitude);
  const originLatitude = degreesToRadians(origin.latitude);
  const candidateLatitude = degreesToRadians(candidate.latitude);
  const haversine = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(originLatitude) * Math.cos(candidateLatitude) * Math.sin(longitudeDelta / 2) ** 2;
  return 2 * earthRadiusMeters * Math.asin(Math.sqrt(Math.min(1, haversine)));
}

function locationInput(point: GeoPoint, village: string): LocationInput {
  return {
    state: "Telangana",
    district: "Warangal",
    mandalOrTaluk: "Hanamkonda",
    village,
    source: "MANUAL_ADDRESS",
    latitude: point.latitude,
    longitude: point.longitude,
    capturedAt: now,
  };
}

function candidatePassesFilters(candidate: GeneratedCandidate, query: NormalizedDiscoveryQuery): boolean {
  const equipmentMatches = query.equipmentTypeId === undefined
    ? !candidate.hasEquipment || candidate.equipmentAvailable
    : candidate.hasEquipment && candidate.equipmentTypeMatches && candidate.equipmentAvailable;
  const pricingMatches = query.pricingMethod === undefined
    || candidate.pricingMethod === query.pricingMethod;

  return candidate.tractorOnline
    && candidate.availabilityOnline
    && candidate.eligible
    && candidate.locationUpdatedAt.getTime() >= query.staleBefore.getTime()
    && candidate.locationUpdatedAt.getTime() <= query.evaluatedAt.getTime()
    && candidate.offeringEnabled
    && candidate.serviceMatches
    && equipmentMatches
    && candidate.activePricing
    && pricingMatches
    && !candidate.hasBlockingOverlap;
}

class GeneratedDiscoveryStore implements DiscoveryStore {
  readonly queries: NormalizedDiscoveryQuery[] = [];

  constructor(readonly candidates: readonly GeneratedCandidate[]) {}

  async search(query: NormalizedDiscoveryQuery): Promise<readonly DiscoveryStoreRow[]> {
    this.queries.push(query);
    const origin = query.serviceLocation;
    // PostGIS ST_DWithin includes the boundary (distance <= radius) and computes
    // geodesic distance on a spheroid. Reproducing that boundary here with a
    // spherical law of cosines round-trips a boundary point a few nanometres past
    // the radius, which a strict comparison would wrongly drop. A 1 cm tolerance
    // (far below the test's own 1 m soundness tolerance) matches the real store's
    // inclusive boundary semantics without weakening radius soundness.
    const boundaryToleranceMeters = 0.01;
    const maximumDistanceMeters = query.radiusKilometers * 1_000 + boundaryToleranceMeters;

    return this.candidates
      .map((candidate) => ({
        candidate,
        distanceMeters: sphericalLawOfCosinesMeters(origin, candidate.point),
      }))
      .filter(({ candidate, distanceMeters }) =>
        distanceMeters <= maximumDistanceMeters && candidatePassesFilters(candidate, query),
      )
      .sort((left, right) =>
        left.distanceMeters - right.distanceMeters
          || left.candidate.id.localeCompare(right.candidate.id),
      )
      .slice(0, query.pageSize + 1)
      .map(({ candidate, distanceMeters }) => Object.freeze({
        tractorId: candidate.id,
        brand: "Mahindra",
        model: "575 DI",
        state: "Telangana",
        district: "Warangal",
        serviceOfferingId: `offering-${candidate.id}`,
        serviceId,
        serviceName: "Ploughing",
        ...(candidate.hasEquipment
          ? {
              equipmentId: `equipment-${candidate.id}`,
              equipmentTypeId: candidate.equipmentTypeMatches ? equipmentTypeId : "equipment-type-other",
              equipmentName: "Generated implement",
            }
          : {}),
        pricingRules: Object.freeze([{
          id: `pricing-${candidate.id}`,
          method: candidate.pricingMethod,
          ratePaise: 120_000,
          currency: "INR",
          ...(candidate.pricingMethod === "HOURLY"
            ? { roundingPolicy: "PROPORTIONAL_MINUTE" as const }
            : {}),
        }]),
        availabilityRank: 0,
        distanceMeters,
      }));
  }
}

function searchInput(
  recipientLocation: GeoPoint,
  scenario: GeneratedScenario,
): DiscoverySearchInput {
  return {
    serviceLocation: locationInput(recipientLocation, "Recipient farm"),
    serviceId,
    requestedInterval,
    ...(scenario.useDefaultRadius ? {} : { radiusKilometers: scenario.radiusKilometers }),
    ...(scenario.filters.equipmentRequired ? { equipmentTypeId } : {}),
    ...(scenario.filters.pricingMethod === undefined
      ? {}
      : { pricingMethod: scenario.filters.pricingMethod }),
    pageSize: 50,
  };
}

async function searchForSomeoneElse(
  service: DiscoveryService,
  customerLocation: GeoPoint,
  scenario: GeneratedScenario,
) {
  // The customer location is deliberately retained in booking context but is not
  // substituted for the separately selected Recipient Service Location.
  const bookingContext = Object.freeze({
    customerLocation,
    recipientServiceLocation: scenario.recipientLocation,
  });
  return service.search(
    farmer,
    searchInput(bookingContext.recipientServiceLocation, scenario),
  );
}

function compatibleControlSpecification(
  filters: GeneratedFilters,
  bearingDegrees: number,
  boundaryOffsetCentimeters: number,
  fallbackPricingMethod: PricingMethod,
): CandidateSpecification {
  return Object.freeze({
    bearingDegrees,
    boundaryOffsetCentimeters,
    tractorOnline: true,
    availabilityOnline: true,
    eligible: true,
    fresh: true,
    offeringEnabled: true,
    serviceMatches: true,
    hasEquipment: filters.equipmentRequired,
    equipmentTypeMatches: true,
    equipmentAvailable: true,
    activePricing: true,
    pricingMethod: filters.pricingMethod ?? fallbackPricingMethod,
    hasBlockingOverlap: false,
  });
}

const pointArbitrary: fc.Arbitrary<GeoPoint> = fc.record({
  latitudeMicrodegrees: fc.integer({ min: -60_000_000, max: 60_000_000 }),
  longitudeMicrodegrees: fc.integer({ min: -170_000_000, max: 170_000_000 }),
}).map(({ latitudeMicrodegrees, longitudeMicrodegrees }) => Object.freeze({
  latitude: latitudeMicrodegrees / 1_000_000,
  longitude: longitudeMicrodegrees / 1_000_000,
}));

const pricingMethodArbitrary = fc.constantFrom<PricingMethod>("HOURLY", "PER_ACRE", "PER_TRIP");
const bearingArbitrary = fc.integer({ min: 0, max: 35_999 }).map((value) => value / 100);
const nearBoundaryOffsetArbitrary = fc.oneof(
  fc.constantFrom(-100, -10, -1, 0, 1, 10, 100),
  fc.integer({ min: -2_500, max: 2_500 }),
);
const candidateSpecificationArbitrary: fc.Arbitrary<CandidateSpecification> = fc.record({
  bearingDegrees: bearingArbitrary,
  boundaryOffsetCentimeters: nearBoundaryOffsetArbitrary,
  tractorOnline: fc.boolean(),
  availabilityOnline: fc.boolean(),
  eligible: fc.boolean(),
  fresh: fc.boolean(),
  offeringEnabled: fc.boolean(),
  serviceMatches: fc.boolean(),
  hasEquipment: fc.boolean(),
  equipmentTypeMatches: fc.boolean(),
  equipmentAvailable: fc.boolean(),
  activePricing: fc.boolean(),
  pricingMethod: pricingMethodArbitrary,
  hasBlockingOverlap: fc.boolean(),
});

const scenarioArbitrary: fc.Arbitrary<GeneratedScenario> = fc.record({
  recipientLocation: pointArbitrary,
  firstCustomerBearing: bearingArbitrary,
  secondCustomerBearingDelta: fc.integer({ min: 1, max: 35_999 }).map((value) => value / 100),
  firstCustomerDistanceMeters: fc.integer({ min: 1_000, max: 100_000 }),
  secondCustomerDistanceMeters: fc.integer({ min: 1_000, max: 100_000 }),
  useDefaultRadius: fc.boolean(),
  configuredRadiusMeters: fc.integer({ min: 100, max: 100_000 }),
  equipmentRequired: fc.boolean(),
  selectedPricingMethod: fc.option(pricingMethodArbitrary, { nil: undefined }),
  controlBearing: bearingArbitrary,
  controlBoundaryOffsetCentimeters: fc.constantFrom(-100, -10, -1, 0),
  controlFallbackPricingMethod: pricingMethodArbitrary,
  additionalCandidates: fc.array(candidateSpecificationArbitrary, { minLength: 2, maxLength: 14 }),
}).map((generated) => {
  const radiusKilometers = generated.useDefaultRadius
    ? 5
    : generated.configuredRadiusMeters / 1_000;
  const filters: GeneratedFilters = Object.freeze({
    equipmentRequired: generated.equipmentRequired,
    ...(generated.selectedPricingMethod === undefined
      ? {}
      : { pricingMethod: generated.selectedPricingMethod }),
  });
  const specifications = [
    compatibleControlSpecification(
      filters,
      generated.controlBearing,
      generated.controlBoundaryOffsetCentimeters,
      generated.controlFallbackPricingMethod,
    ),
    ...generated.additionalCandidates,
  ];
  const candidates = specifications.map((specification, index): GeneratedCandidate => {
    const distanceMeters = Math.max(
      0,
      radiusKilometers * 1_000 + specification.boundaryOffsetCentimeters / 100,
    );
    return Object.freeze({
      ...specification,
      id: `tractor-${String(index).padStart(3, "0")}`,
      point: destinationPoint(
        generated.recipientLocation,
        specification.bearingDegrees,
        distanceMeters,
      ),
      locationUpdatedAt: specification.fresh
        ? new Date(now.getTime() - 60 * 60 * 1_000)
        : new Date(now.getTime() - 25 * 60 * 60 * 1_000),
    });
  });

  return Object.freeze({
    recipientLocation: generated.recipientLocation,
    firstCustomerLocation: destinationPoint(
      generated.recipientLocation,
      generated.firstCustomerBearing,
      generated.firstCustomerDistanceMeters,
    ),
    secondCustomerLocation: destinationPoint(
      generated.recipientLocation,
      generated.firstCustomerBearing + generated.secondCustomerBearingDelta,
      generated.secondCustomerDistanceMeters,
    ),
    radiusKilometers,
    useDefaultRadius: generated.useDefaultRadius,
    filters,
    candidates: Object.freeze(candidates),
  });
});

function runSeededProperty(
  name: string,
  seed: number,
  assertion: () => void | Promise<void>,
): Promise<void> {
  return Promise.resolve()
    .then(assertion)
    .then(() => {
      console.info(`[PBT] ${name}: seed=${seed} runs=${propertyRuns} minimizedCounterexample=none`);
    })
    .catch((error: unknown) => {
      console.error(`[PBT] ${name}: seed=${seed} minimizedCounterexample=reported by fast-check below`);
      throw error;
    });
}

describe("Property 2: Recipient-Origin Discovery", () => {
  /** **Validates: Requirements 7.2, 7.3, 8.3** */
  it("uses only the Recipient Service Location when customer location changes", async () => {
    const seed = seeds.recipientOrigin;

    await runSeededProperty("recipient-origin-discovery", seed, async () => {
      await fc.assert(
        fc.asyncProperty(scenarioArbitrary, async (scenario) => {
          const store = new GeneratedDiscoveryStore(scenario.candidates);
          const service = new DiscoveryService(store, signingKey, undefined, () => now);

          const first = await searchForSomeoneElse(service, scenario.firstCustomerLocation, scenario);
          const second = await searchForSomeoneElse(service, scenario.secondCustomerLocation, scenario);
          const firstIds = first.items.map((item) => item.id);
          const secondIds = second.items.map((item) => item.id);

          expect(firstIds.length).toBeGreaterThan(0);
          expect(secondIds).toEqual(firstIds);
          expect(store.queries).toHaveLength(2);
          for (const query of store.queries) {
            expect(query.serviceLocation.latitude).toBe(scenario.recipientLocation.latitude);
            expect(query.serviceLocation.longitude).toBe(scenario.recipientLocation.longitude);
            expect(query.serviceLocation).not.toMatchObject(scenario.firstCustomerLocation);
            expect(query.serviceLocation).not.toMatchObject(scenario.secondCustomerLocation);
          }

          const candidatesById = new Map(scenario.candidates.map((candidate) => [candidate.id, candidate]));
          for (const item of first.items) {
            const candidate = candidatesById.get(item.id);
            expect(candidate).toBeDefined();
            const recipientDistanceKilometers = haversineDistanceMeters(
              scenario.recipientLocation,
              candidate!.point,
            ) / 1_000;
            expect(Math.abs(item.approximateDistance.kilometers - recipientDistanceKilometers))
              .toBeLessThanOrEqual(0.050_001);
          }
        }),
        { seed, numRuns: propertyRuns, verbose: 2 },
      );
    });
  });
});

describe("Property 14: Geospatial Radius Soundness", () => {
  /** **Validates: Requirements 7.2, 7.4, 7.5** */
  it("returns only compatible Tractors inside the configured or default radius tolerance", async () => {
    const seed = seeds.radiusSoundness;

    await runSeededProperty("geospatial-radius-soundness", seed, async () => {
      await fc.assert(
        fc.asyncProperty(scenarioArbitrary, async (scenario) => {
          const store = new GeneratedDiscoveryStore(scenario.candidates);
          const service = new DiscoveryService(store, signingKey, undefined, () => now);
          const result = await service.search(
            farmer,
            searchInput(scenario.recipientLocation, scenario),
          );
          const query = store.queries[0]!;
          const candidatesById = new Map(scenario.candidates.map((candidate) => [candidate.id, candidate]));

          expect(result.items.length).toBeGreaterThan(0);
          expect(result.radiusKilometers).toBe(scenario.radiusKilometers);
          expect(result.defaultRadiusApplied).toBe(scenario.useDefaultRadius);
          expect(result.canExpandRadius).toBe(scenario.radiusKilometers < 100);

          for (const item of result.items) {
            const candidate = candidatesById.get(item.id);
            expect(candidate).toBeDefined();
            const independentDistance = haversineDistanceMeters(
              scenario.recipientLocation,
              candidate!.point,
            );

            expect(independentDistance).toBeLessThanOrEqual(
              scenario.radiusKilometers * 1_000 + spatialToleranceMeters,
            );
            expect(candidatePassesFilters(candidate!, query)).toBe(true);
          }
        }),
        { seed, numRuns: propertyRuns, verbose: 2 },
      );
    });
  });
});
