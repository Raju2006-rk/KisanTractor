import type {
  ActivePricingRuleProjection,
  AuthPrincipal,
  CatalogEligibilityPolicy,
  EquipmentInput,
  EquipmentUpdateInput,
  OwnerEquipmentProjection,
  OwnerPricingRuleProjection,
  OwnerProfileInput,
  OwnerProfileProjection,
  OwnerServiceOfferingProjection,
  OwnerTractorProjection,
  PricingRuleInput,
  ServiceOfferingInput,
  TractorAvailabilityProjection,
  TractorEligibilityEvaluation,
  TractorOperationalStatus,
} from "@kisantractor/domain";
import { evaluateTractorEligibility } from "@kisantractor/domain";
import { describe, expect, it } from "vitest";

import type {
  CatalogRequestContext,
  CatalogStore,
  StoredTractorInput,
  StoredTractorUpdateInput,
} from "./catalog.contracts.js";
import {
  CatalogAuthorizationError,
  CatalogConflictError,
  OwnerCatalogService,
} from "./catalog.service.js";

const owner = (userId: string): AuthPrincipal => ({ userId, sessionId: `session-${userId}`, roles: ["OWNER"] });
const farmer = (userId: string): AuthPrincipal => ({ userId, sessionId: `session-${userId}`, roles: ["FARMER"] });
const context: CatalogRequestContext = { correlationId: "corr-5-1", actorChannel: "WEB" };
const profileInput: OwnerProfileInput = {
  fullName: "Raju Naik",
  preferredLocale: "te",
  contactSharingConsent: false,
  operatingLocation: {
    state: "Telangana",
    district: "Warangal",
    mandalOrTaluk: "Geesugonda",
    village: "Vanchanagiri",
    source: "MANUAL_ADDRESS",
    capturedAt: new Date("2025-01-01T00:00:00.000Z"),
  },
};

class MemoryCatalogStore implements CatalogStore {
  readonly profiles = new Map<string, OwnerProfileProjection>();
  readonly tractors = new Map<string, OwnerTractorProjection>();
  readonly equipment = new Map<string, OwnerEquipmentProjection>();
  readonly offerings = new Map<string, OwnerServiceOfferingProjection>();
  readonly pricingRules = new Map<string, OwnerPricingRuleProjection>();
  readonly pricingRuleHistory: OwnerPricingRuleProjection[] = [];
  readonly eligibilityFacts = new Map<string, Parameters<typeof evaluateTractorEligibility>[1]>();
  readonly availabilityTimes = new Map<string, Date>();
  lastStoredTractor?: StoredTractorInput;
  sequence = 0;

  async upsertOwnerProfile(ownerId: string, input: OwnerProfileInput, expectedVersion?: number) {
    const existing = this.profiles.get(ownerId);
    if (existing && expectedVersion !== undefined && existing.version !== expectedVersion) return undefined;
    const projection: OwnerProfileProjection = {
      userId: ownerId,
      fullName: input.fullName,
      preferredLocale: input.preferredLocale,
      contactSharingConsent: input.contactSharingConsent,
      mobileVerified: true,
      verificationStatus: "UNVERIFIED",
      operatingLocation: { id: `location-${ownerId}`, ...input.operatingLocation },
      version: (existing?.version ?? 0) + 1,
    };
    this.profiles.set(ownerId, projection);
    return projection;
  }

  async findOwnerProfile(ownerId: string) { return this.profiles.get(ownerId); }

  async createTractor(ownerId: string, input: StoredTractorInput) {
    this.lastStoredTractor = input;
    const id = `tractor-${++this.sequence}`;
    const projection: OwnerTractorProjection = {
      id,
      ownerId,
      brand: input.brand,
      model: input.model,
      registrationNumber: "TS08AB1234",
      manufacturingYear: input.manufacturingYear,
      ...(input.horsepower === undefined ? {} : { horsepower: input.horsepower }),
      operationalStatus: "OFFLINE",
      eligibilityStatus: "INCOMPLETE",
      operatingLocation: { id: `location-${id}`, ...input.operatingLocation },
      photos: input.photos.map((photo, index) => ({
        id: `photo-${index}`,
        mimeType: photo.mimeType,
        altText: photo.altText,
        sortOrder: photo.sortOrder,
      })),
      version: 1,
    };
    this.tractors.set(id, projection);
    this.availabilityTimes.set(id, input.operatingLocation.capturedAt);
    return projection;
  }

  async updateTractor(ownerId: string, tractorId: string, input: StoredTractorUpdateInput, expectedVersion: number) {
    const existing = this.tractors.get(tractorId);
    if (!existing || existing.ownerId !== ownerId || existing.version !== expectedVersion) return undefined;
    const projection = { ...existing, brand: input.brand, model: input.model, version: existing.version + 1 };
    this.tractors.set(tractorId, projection);
    return projection;
  }

  async findTractor(tractorId: string) { return this.tractors.get(tractorId); }
  async listOwnerTractors(ownerId: string) {
    return [...this.tractors.values()].filter((tractor) => tractor.ownerId === ownerId);
  }

  async getTractorAvailability(ownerId: string, tractorId: string) {
    const tractor = this.tractors.get(tractorId);
    if (!tractor || tractor.ownerId !== ownerId) return undefined;
    return {
      tractorId,
      operationalStatus: tractor.operationalStatus,
      eligibilityStatus: tractor.eligibilityStatus,
      acceptingNewDemand:
        tractor.operationalStatus === "ONLINE" && tractor.eligibilityStatus === "ELIGIBLE",
      existingConfirmedBookingsManageable: true as const,
      effectiveAt: this.availabilityTimes.get(tractorId) ?? tractor.operatingLocation.capturedAt,
      version: tractor.version,
    } satisfies TractorAvailabilityProjection;
  }

  async setTractorOperationalStatus(
    ownerId: string,
    tractorId: string,
    status: TractorOperationalStatus,
    expectedVersion: number,
    _reason: string | undefined,
    policy: CatalogEligibilityPolicy,
    changedAt: Date,
  ) {
    const tractor = this.tractors.get(tractorId);
    if (!tractor || tractor.ownerId !== ownerId || tractor.version !== expectedVersion) return undefined;
    const configuredFacts = this.eligibilityFacts.get(tractorId) ?? {
      hasRequiredTractorInformation: true,
      missingRequiredDocumentKinds: policy.requiredDocumentKinds,
      hasEnabledServiceOffering: false,
      hasActiveServicePricing: false,
      locationUpdatedAt: tractor.operatingLocation.capturedAt,
      operationalStatus: status,
    };
    const evaluation = evaluateTractorEligibility(
      tractorId,
      { ...configuredFacts, operationalStatus: status },
      policy,
      changedAt,
    );
    this.tractors.set(tractorId, { ...tractor, eligibilityStatus: evaluation.status });
    if (status === "ONLINE" && evaluation.status !== "ELIGIBLE") {
      return { kind: "INELIGIBLE" as const, evaluation, scheduleConflict: false };
    }
    if (tractor.operationalStatus !== status) {
      this.tractors.set(tractorId, {
        ...tractor,
        operationalStatus: status,
        eligibilityStatus: evaluation.status,
        version: tractor.version + 1,
      });
      this.availabilityTimes.set(tractorId, changedAt);
    }
    return {
      kind: "UPDATED" as const,
      availability: await this.getTractorAvailability(ownerId, tractorId) as TractorAvailabilityProjection,
    };
  }

  async createEquipment(ownerId: string, input: EquipmentInput) {
    if (input.tractorId !== undefined && this.tractors.get(input.tractorId)?.ownerId !== ownerId) return undefined;
    const id = `equipment-${++this.sequence}`;
    const projection: OwnerEquipmentProjection = {
      id,
      ownerId,
      ...(input.tractorId === undefined ? {} : { tractorId: input.tractorId }),
      equipmentTypeId: input.equipmentTypeId,
      equipmentTypeCode: "PLOUGH",
      equipmentTypeName: "Plough",
      displayName: input.displayName,
      availabilityStatus: input.availabilityStatus ?? "AVAILABLE",
      version: 1,
    };
    this.equipment.set(id, projection);
    return projection;
  }

  async updateEquipment(
    ownerId: string,
    equipmentId: string,
    input: EquipmentUpdateInput,
    expectedVersion: number,
  ) {
    const existing = this.equipment.get(equipmentId);
    if (!existing || existing.ownerId !== ownerId || existing.version !== expectedVersion) return undefined;
    const projection = { ...existing, ...input, version: existing.version + 1 };
    this.equipment.set(equipmentId, projection);
    return projection;
  }

  async assignEquipment(
    ownerId: string,
    equipmentId: string,
    tractorId: string | undefined,
    expectedVersion: number,
  ) {
    const existing = this.equipment.get(equipmentId);
    if (!existing || existing.ownerId !== ownerId || existing.version !== expectedVersion) return undefined;
    if (tractorId !== undefined && this.tractors.get(tractorId)?.ownerId !== ownerId) return undefined;
    const { tractorId: _currentTractorId, ...base } = existing;
    const projection: OwnerEquipmentProjection = {
      ...base,
      ...(tractorId === undefined ? {} : { tractorId }),
      version: existing.version + 1,
    };
    this.equipment.set(equipmentId, projection);
    return projection;
  }

  async findEquipment(equipmentId: string) { return this.equipment.get(equipmentId); }
  async listOwnerEquipment(ownerId: string) {
    return [...this.equipment.values()].filter((item) => item.ownerId === ownerId);
  }

  async upsertServiceOffering(
    ownerId: string,
    tractorId: string,
    input: ServiceOfferingInput,
    expectedVersion: number | undefined,
  ) {
    if (this.tractors.get(tractorId)?.ownerId !== ownerId) return undefined;
    if (input.equipmentId !== undefined) {
      const item = this.equipment.get(input.equipmentId);
      if (!item || item.ownerId !== ownerId || (item.tractorId !== undefined && item.tractorId !== tractorId)) {
        return undefined;
      }
    }
    const existing = [...this.offerings.values()].find((offering) =>
      offering.tractorId === tractorId && offering.serviceId === input.serviceId &&
      offering.equipmentId === input.equipmentId,
    );
    if (existing) {
      if (expectedVersion !== existing.version) return undefined;
      const projection = { ...existing, enabled: input.enabled, version: existing.version + 1 };
      this.offerings.set(existing.id, projection);
      return projection;
    }
    if (expectedVersion !== undefined) return undefined;
    const id = `offering-${++this.sequence}`;
    const projection: OwnerServiceOfferingProjection = {
      id,
      tractorId,
      serviceId: input.serviceId,
      serviceCode: "PLOUGHING",
      serviceName: "Ploughing",
      ...(input.equipmentId === undefined ? {} : {
        equipmentId: input.equipmentId,
        equipmentName: this.equipment.get(input.equipmentId)?.displayName ?? "Equipment",
      }),
      enabled: input.enabled,
      version: 1,
    };
    this.offerings.set(id, projection);
    return projection;
  }

  async listTractorServiceOfferings(ownerId: string, tractorId: string) {
    if (this.tractors.get(tractorId)?.ownerId !== ownerId) return [];
    return [...this.offerings.values()].filter((offering) => offering.tractorId === tractorId);
  }

  async findServiceOffering(serviceOfferingId: string) {
    return this.offerings.get(serviceOfferingId);
  }

  async upsertPricingRule(
    ownerId: string,
    serviceOfferingId: string,
    input: PricingRuleInput,
    expectedVersion: number | undefined,
  ) {
    const offering = this.offerings.get(serviceOfferingId);
    if (!offering || this.tractors.get(offering.tractorId)?.ownerId !== ownerId) return undefined;
    const key = `${serviceOfferingId}:${input.method}`;
    const existing = this.pricingRules.get(key);
    if (existing) {
      if (existing.version !== expectedVersion) return undefined;
      const updated: OwnerPricingRuleProjection = {
        id: `pricing-${++this.sequence}`,
        serviceOfferingId,
        method: input.method,
        ratePaise: input.ratePaise,
        currency: "INR",
        ...(input.method === "HOURLY" ? { roundingPolicy: input.roundingPolicy } : {}),
        enabled: input.enabled,
        version: existing.version + 1,
      };
      this.pricingRuleHistory.push(existing);
      this.pricingRules.set(key, updated);
      return updated;
    }
    if (expectedVersion !== undefined) return undefined;
    const rule: OwnerPricingRuleProjection = {
      id: `pricing-${++this.sequence}`,
      serviceOfferingId,
      method: input.method,
      ratePaise: input.ratePaise,
      currency: "INR",
      ...(input.method === "HOURLY" ? { roundingPolicy: input.roundingPolicy } : {}),
      enabled: input.enabled,
      version: 1,
    };
    this.pricingRules.set(key, rule);
    return rule;
  }

  async listServiceOfferingPricingRules(ownerId: string, serviceOfferingId: string) {
    const offering = this.offerings.get(serviceOfferingId);
    if (!offering || this.tractors.get(offering.tractorId)?.ownerId !== ownerId) return [];
    return [...this.pricingRules.values()].filter((rule) => rule.serviceOfferingId === serviceOfferingId);
  }

  async listActivePricingRules(serviceOfferingId: string) {
    const offering = this.offerings.get(serviceOfferingId);
    if (!offering?.enabled) return [];
    return [...this.pricingRules.values()]
      .filter((rule) => rule.serviceOfferingId === serviceOfferingId && rule.enabled)
      .map((rule): ActivePricingRuleProjection => {
        const { enabled: _enabled, ...activeRule } = rule;
        return activeRule;
      });
  }

  async findActivePricingRule(serviceOfferingId: string, pricingRuleId: string) {
    return (await this.listActivePricingRules(serviceOfferingId))
      .find((rule) => rule.id === pricingRuleId);
  }

  async evaluateTractorEligibility(
    ownerId: string,
    tractorId: string,
    policy: CatalogEligibilityPolicy,
    evaluatedAt: Date,
  ): Promise<TractorEligibilityEvaluation | undefined> {
    const tractor = this.tractors.get(tractorId);
    if (!tractor || tractor.ownerId !== ownerId) return undefined;
    const facts = this.eligibilityFacts.get(tractorId) ?? {
      hasRequiredTractorInformation: true,
      missingRequiredDocumentKinds: policy.requiredDocumentKinds,
      hasEnabledServiceOffering: false,
      hasActiveServicePricing: false,
      locationUpdatedAt: tractor.operatingLocation.capturedAt,
      operationalStatus: tractor.operationalStatus,
    };
    const evaluation = evaluateTractorEligibility(tractorId, facts, policy, evaluatedAt);
    this.tractors.set(tractorId, { ...tractor, eligibilityStatus: evaluation.status });
    return evaluation;
  }
}

const secrets = {
  fieldEncryptionKey: new Uint8Array(32).fill(5),
  lookupHashKey: new Uint8Array(32).fill(7),
};

const tractorInput = {
  brand: "Mahindra",
  model: "575 DI",
  registrationNumber: "TS08AB1234",
  manufacturingYear: 2022,
  horsepower: 47,
  operatingLocation: profileInput.operatingLocation,
  photos: [{
    privateObjectKey: "owners/owner-1/tractor.webp",
    mimeType: "image/webp" as const,
    altText: "Red tractor",
  }],
};

describe("OwnerCatalogService", () => {
  it("registers a verified-mobile Owner profile and manages multiple tractors", async () => {
    const store = new MemoryCatalogStore();
    const service = new OwnerCatalogService(store, secrets, () => new Date("2025-01-01T00:00:00.000Z"));
    await service.registerOrUpdateOwnerProfile(owner("owner-1"), profileInput, context);
    const first = await service.addTractor(owner("owner-1"), tractorInput, context);
    const second = await service.addTractor(owner("owner-1"), { ...tractorInput, registrationNumber: "TS08AB5678" }, context);

    expect(await service.listTractors(owner("owner-1"))).toHaveLength(2);
    expect(first.id).not.toBe(second.id);
    expect(store.lastStoredTractor?.registrationLookupHash).toHaveLength(64);
    expect(Buffer.from(store.lastStoredTractor!.registrationNumberCiphertext).includes(Buffer.from("TS08AB5678"))).toBe(false);
    expect(Buffer.from(store.lastStoredTractor!.photos[0]!.objectKeyCiphertext).includes(Buffer.from("tractor.webp"))).toBe(false);
  });

  it("denies non-Owners and cross-Owner reads without returning existence details", async () => {
    const store = new MemoryCatalogStore();
    const service = new OwnerCatalogService(store, secrets);
    await service.registerOrUpdateOwnerProfile(owner("owner-1"), profileInput, context);
    const tractor = await service.addTractor(owner("owner-1"), tractorInput, context);

    await expect(service.getTractor(owner("owner-2"), tractor.id)).rejects.toBeInstanceOf(CatalogAuthorizationError);
    await expect(service.getTractor({ userId: "farmer-1", sessionId: "s", roles: ["FARMER"] }, tractor.id)).rejects.toBeInstanceOf(CatalogAuthorizationError);
  });

  it("requires profile completion and optimistic versions", async () => {
    const store = new MemoryCatalogStore();
    const service = new OwnerCatalogService(store, secrets);
    await expect(service.addTractor(owner("owner-1"), tractorInput, context)).rejects.toBeInstanceOf(CatalogConflictError);

    const profile = await service.registerOrUpdateOwnerProfile(owner("owner-1"), profileInput, context);
    await expect(service.registerOrUpdateOwnerProfile(owner("owner-1"), profileInput, context, profile.version + 1)).rejects.toBeInstanceOf(CatalogConflictError);
  });

  it("manages Owner inventory, Tractor assignments, and Service Offerings", async () => {
    const store = new MemoryCatalogStore();
    const service = new OwnerCatalogService(store, secrets, () => new Date("2025-01-01T00:00:00.000Z"));
    await service.registerOrUpdateOwnerProfile(owner("owner-1"), profileInput, context);
    const tractor = await service.addTractor(owner("owner-1"), tractorInput, context);

    const equipment = await service.addEquipment(owner("owner-1"), {
      equipmentTypeId: "type-plough",
      displayName: "Heavy Plough",
    }, context);
    const assigned = await service.assignEquipment(
      owner("owner-1"), equipment.id, tractor.id, equipment.version, context,
    );
    const offering = await service.configureServiceOffering(owner("owner-1"), tractor.id, {
      serviceId: "service-ploughing",
      equipmentId: assigned.id,
      enabled: true,
    }, context);

    expect(await service.listEquipment(owner("owner-1"))).toEqual([assigned]);
    expect(await service.listServiceOfferings(owner("owner-1"), tractor.id)).toEqual([offering]);
    await expect(service.assignEquipment(
      owner("owner-2"), equipment.id, undefined, assigned.version, context,
    )).rejects.toBeInstanceOf(CatalogAuthorizationError);
  });

  /** Validates: Requirements 6.1, 6.2, 6.3 */
  it("configures independent hourly, per-acre, and per-trip rules for an owned offering", async () => {
    const store = new MemoryCatalogStore();
    const service = new OwnerCatalogService(store, secrets, () => new Date("2025-01-01T00:00:00.000Z"));
    await service.registerOrUpdateOwnerProfile(owner("owner-1"), profileInput, context);
    const tractor = await service.addTractor(owner("owner-1"), tractorInput, context);
    const equipment = await service.addEquipment(owner("owner-1"), {
      equipmentTypeId: "type-plough",
      displayName: "Heavy Plough",
      tractorId: tractor.id,
    }, context);
    const offering = await service.configureServiceOffering(owner("owner-1"), tractor.id, {
      serviceId: "service-ploughing",
      equipmentId: equipment.id,
      enabled: true,
    }, context);

    const hourly = await service.configurePricingRule(owner("owner-1"), offering.id, {
      method: "HOURLY",
      ratePaise: 80_000,
      roundingPolicy: "PROPORTIONAL_MINUTE",
      enabled: true,
    }, context);
    const perAcre = await service.configurePricingRule(owner("owner-1"), offering.id, {
      method: "PER_ACRE",
      ratePaise: 120_000,
      enabled: true,
    }, context);
    const perTrip = await service.configurePricingRule(owner("owner-1"), offering.id, {
      method: "PER_TRIP",
      ratePaise: 150_000,
      enabled: true,
    }, context);

    expect(await service.listPricingRules(owner("owner-1"), offering.id))
      .toEqual([hourly, perAcre, perTrip]);
    expect(hourly).toMatchObject({
      serviceOfferingId: offering.id,
      method: "HOURLY",
      roundingPolicy: "PROPORTIONAL_MINUTE",
      ratePaise: 80_000,
      currency: "INR",
    });

    const updated = await service.configurePricingRule(owner("owner-1"), offering.id, {
      method: "HOURLY",
      ratePaise: 90_000,
      roundingPolicy: "ONE_HOUR_BLOCK",
      enabled: true,
    }, context, hourly.version);
    expect(updated).toMatchObject({ ratePaise: 90_000, roundingPolicy: "ONE_HOUR_BLOCK", version: 2 });
    await expect(service.configurePricingRule(owner("owner-1"), offering.id, {
      method: "HOURLY",
      ratePaise: 95_000,
      roundingPolicy: "THIRTY_MINUTE_BLOCK",
      enabled: true,
    }, context, hourly.version)).rejects.toBeInstanceOf(CatalogConflictError);
    await expect(service.listPricingRules(owner("owner-2"), offering.id))
      .rejects.toBeInstanceOf(CatalogAuthorizationError);
  });

  /** Validates: Requirements 6.4, 6.5, 6.6, 6.7 */
  it("exposes only active Farmer methods and preserves a Quote Snapshot across catalog versions", async () => {
    const now = new Date("2025-03-01T10:00:00.000Z");
    const store = new MemoryCatalogStore();
    const service = new OwnerCatalogService(store, secrets, () => now);
    await service.registerOrUpdateOwnerProfile(owner("owner-1"), profileInput, context);
    const tractor = await service.addTractor(owner("owner-1"), tractorInput, context);
    const offering = await service.configureServiceOffering(owner("owner-1"), tractor.id, {
      serviceId: "service-ploughing",
      enabled: true,
    }, context);
    const hourlyV1 = await service.configurePricingRule(owner("owner-1"), offering.id, {
      method: "HOURLY",
      ratePaise: 80_000,
      roundingPolicy: "PROPORTIONAL_MINUTE",
      enabled: true,
    }, context);
    await service.configurePricingRule(owner("owner-1"), offering.id, {
      method: "PER_TRIP",
      ratePaise: 150_000,
      enabled: false,
    }, context);

    expect(await service.listActivePricingRules(farmer("farmer-1"), offering.id))
      .toEqual([expect.objectContaining({ id: hourlyV1.id, method: "HOURLY" })]);
    const agreedQuote = await service.createFarmerQuoteSnapshot(
      farmer("farmer-1"), offering.id, hourlyV1.id, "1.5",
    );

    const hourlyV2 = await service.configurePricingRule(owner("owner-1"), offering.id, {
      method: "HOURLY",
      ratePaise: 95_000,
      roundingPolicy: "ONE_HOUR_BLOCK",
      enabled: true,
    }, context, hourlyV1.version);

    expect(hourlyV2).toMatchObject({ version: 2, ratePaise: 95_000 });
    expect(hourlyV2.id).not.toBe(hourlyV1.id);
    expect(store.pricingRuleHistory).toContainEqual(hourlyV1);
    expect(agreedQuote).toEqual({
      pricingRuleId: hourlyV1.id,
      pricingRuleVersion: 1,
      method: "HOURLY",
      ratePaise: 80_000,
      currency: "INR",
      roundingPolicy: "PROPORTIONAL_MINUTE",
      estimatedQuantity: "1.5",
      estimatedTotalPaise: 120_000,
      disclosedAt: now.toISOString(),
    });
    await expect(service.createFarmerQuoteSnapshot(
      farmer("farmer-1"), offering.id, hourlyV1.id, 1,
    )).rejects.toBeInstanceOf(CatalogConflictError);
    await expect(service.listActivePricingRules(owner("owner-1"), offering.id))
      .rejects.toBeInstanceOf(CatalogAuthorizationError);
  });

  /** Validates: Requirements 5.2, 5.3, 5.4, 5.5 */
  it("rechecks eligibility when going online and preserves confirmed-booking management offline", async () => {
    const now = new Date("2025-01-01T00:00:00.000Z");
    const store = new MemoryCatalogStore();
    const service = new OwnerCatalogService(store, secrets, () => now);
    await service.registerOrUpdateOwnerProfile(owner("owner-1"), profileInput, context);
    const tractor = await service.addTractor(owner("owner-1"), tractorInput, context);

    await expect(service.setTractorOperationalStatus(
      owner("owner-1"), tractor.id, "ONLINE", tractor.version, context,
    )).rejects.toMatchObject({
      code: "TRACTOR_AVAILABILITY_REJECTED",
      reasonCodes: expect.arrayContaining(["REQUIRED_DOCUMENTS_MISSING"]),
    });
    expect((await service.getTractorAvailability(owner("owner-1"), tractor.id)).operationalStatus)
      .toBe("OFFLINE");

    store.eligibilityFacts.set(tractor.id, {
      hasRequiredTractorInformation: true,
      missingRequiredDocumentKinds: [],
      hasEnabledServiceOffering: true,
      hasActiveServicePricing: true,
      locationUpdatedAt: now,
      operationalStatus: "OFFLINE",
    });
    const online = await service.setTractorOperationalStatus(
      owner("owner-1"), tractor.id, "ONLINE", tractor.version, context,
    );
    expect(online).toMatchObject({
      operationalStatus: "ONLINE",
      eligibilityStatus: "ELIGIBLE",
      acceptingNewDemand: true,
      existingConfirmedBookingsManageable: true,
      version: 2,
    });

    const offline = await service.setTractorOperationalStatus(
      owner("owner-1"), tractor.id, "OFFLINE", online.version, context, "Owner break",
    );
    expect(offline).toMatchObject({
      operationalStatus: "OFFLINE",
      acceptingNewDemand: false,
      existingConfirmedBookingsManageable: true,
      version: 3,
    });
    await expect(service.setTractorOperationalStatus(
      owner("owner-1"), tractor.id, "ONLINE", online.version, context,
    )).rejects.toBeInstanceOf(CatalogConflictError);
    await expect(service.getTractorAvailability(owner("owner-2"), tractor.id))
      .rejects.toBeInstanceOf(CatalogAuthorizationError);
  });

  it("returns explicit eligibility failures and never publishes incomplete Tractors", async () => {
    const now = new Date("2025-01-01T00:00:00.000Z");
    const store = new MemoryCatalogStore();
    const service = new OwnerCatalogService(store, secrets, () => now);
    await service.registerOrUpdateOwnerProfile(owner("owner-1"), profileInput, context);
    const tractor = await service.addTractor(owner("owner-1"), tractorInput, context);

    const incomplete = await service.evaluateEligibility(owner("owner-1"), tractor.id, context);
    expect(incomplete.discoverable).toBe(false);
    expect(incomplete.reasons.map((reason) => reason.code)).toEqual([
      "REQUIRED_DOCUMENTS_MISSING",
      "ENABLED_SERVICE_OFFERING_MISSING",
      "ACTIVE_SERVICE_PRICING_MISSING",
    ]);

    store.eligibilityFacts.set(tractor.id, {
      hasRequiredTractorInformation: true,
      missingRequiredDocumentKinds: [],
      hasEnabledServiceOffering: true,
      hasActiveServicePricing: true,
      locationUpdatedAt: now,
      operationalStatus: "ONLINE",
    });
    const eligible = await service.evaluateEligibility(owner("owner-1"), tractor.id, context);
    expect(eligible).toMatchObject({ status: "ELIGIBLE", discoverable: true, reasons: [] });
  });
});
