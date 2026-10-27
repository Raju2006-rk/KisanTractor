import type {
  ActivePricingRuleProjection,
  AuthPrincipal,
  CatalogEligibilityPolicy,
  EquipmentInput,
  EquipmentUpdateInput,
  EstimatedPricingQuantity,
  OwnerEquipmentProjection,
  OwnerPricingRuleProjection,
  OwnerProfileInput,
  OwnerProfileProjection,
  OwnerServiceOfferingProjection,
  OwnerTractorProjection,
  PricingRuleInput,
  QuoteSnapshot,
  ServiceOfferingInput,
  TractorAvailabilityProjection,
  TractorEligibilityEvaluation,
  TractorInput,
  TractorOperationalStatus,
  TractorUpdateInput,
} from "@kisantractor/domain";
import {
  createQuoteSnapshot,
  defaultCatalogEligibilityPolicy,
  validateEligibilityPolicy,
  validateEquipment,
  validateEquipmentUpdate,
  validateOwnerProfile,
  validatePricingRule,
  validateServiceOffering,
  validateTractor,
  validateTractorUpdate,
} from "@kisantractor/domain";

import { CatalogCrypto } from "./catalog-crypto.js";
import type {
  CatalogRequestContext,
  CatalogSecrets,
  CatalogStore,
  StoredTractorInput,
  StoredTractorUpdateInput,
} from "./catalog.contracts.js";

export class CatalogAuthorizationError extends Error {
  readonly code = "CATALOG_AUTHORIZATION_DENIED";

  constructor() {
    super("You are not authorized to access this catalog resource");
    this.name = "CatalogAuthorizationError";
  }
}

export class CatalogNotFoundError extends Error {
  readonly code = "CATALOG_NOT_FOUND";

  constructor() {
    super("The requested catalog resource was not found");
    this.name = "CatalogNotFoundError";
  }
}

export class CatalogConflictError extends Error {
  readonly code = "CATALOG_CONFLICT";

  constructor(message = "The catalog record changed; refresh and try again") {
    super(message);
    this.name = "CatalogConflictError";
  }
}

export class CatalogAvailabilityRejectedError extends Error {
  readonly code = "TRACTOR_AVAILABILITY_REJECTED";
  readonly reasonCodes: readonly string[];

  constructor(
    readonly evaluation: TractorEligibilityEvaluation,
    readonly scheduleConflict: boolean,
  ) {
    const reasonCodes = [
      ...evaluation.reasons.map((reason) => reason.code),
      ...(scheduleConflict ? ["SCHEDULE_CONFLICT"] : []),
    ];
    super(`Tractor cannot go online: ${reasonCodes.join(", ")}`);
    this.name = "CatalogAvailabilityRejectedError";
    this.reasonCodes = Object.freeze(reasonCodes);
  }
}

export class OwnerCatalogService {
  readonly #crypto: CatalogCrypto;
  readonly #eligibilityPolicy: CatalogEligibilityPolicy;

  constructor(
    private readonly store: CatalogStore,
    secrets: CatalogSecrets,
    private readonly now: () => Date = () => new Date(),
    eligibilityPolicy: CatalogEligibilityPolicy = defaultCatalogEligibilityPolicy,
  ) {
    this.#crypto = new CatalogCrypto(secrets);
    this.#eligibilityPolicy = validateEligibilityPolicy(eligibilityPolicy);
  }

  async registerOrUpdateOwnerProfile(
    principal: AuthPrincipal,
    input: OwnerProfileInput,
    context: CatalogRequestContext,
    expectedVersion?: number,
  ): Promise<OwnerProfileProjection> {
    this.#assertOwner(principal);
    this.#assertContext(context);
    if (expectedVersion !== undefined && (!Number.isInteger(expectedVersion) || expectedVersion <= 0)) {
      throw new CatalogConflictError();
    }
    const profile = await this.store.upsertOwnerProfile(
      principal.userId,
      validateOwnerProfile(input),
      expectedVersion,
      context,
    );
    if (profile === undefined) throw new CatalogConflictError();
    return profile;
  }

  async getOwnerProfile(principal: AuthPrincipal): Promise<OwnerProfileProjection> {
    this.#assertOwner(principal);
    const profile = await this.store.findOwnerProfile(principal.userId);
    if (profile === undefined) throw new CatalogNotFoundError();
    return profile;
  }

  async addTractor(
    principal: AuthPrincipal,
    input: TractorInput,
    context: CatalogRequestContext,
  ): Promise<OwnerTractorProjection> {
    this.#assertOwner(principal);
    this.#assertContext(context);
    const profile = await this.store.findOwnerProfile(principal.userId);
    if (profile === undefined) {
      throw new CatalogConflictError("Complete the Owner profile before adding a tractor");
    }
    return this.store.createTractor(
      principal.userId,
      this.#encryptTractor(validateTractor(input, this.now())),
      context,
    );
  }

  async updateTractor(
    principal: AuthPrincipal,
    tractorId: string,
    input: TractorUpdateInput,
    expectedVersion: number,
    context: CatalogRequestContext,
  ): Promise<OwnerTractorProjection> {
    this.#assertOwner(principal);
    this.#assertContext(context);
    if (!Number.isInteger(expectedVersion) || expectedVersion <= 0) {
      throw new CatalogConflictError();
    }
    const existing = await this.store.findTractor(tractorId);
    this.#assertOwnedTractor(principal, existing);
    const updated = await this.store.updateTractor(
      principal.userId,
      tractorId,
      this.#encryptTractorUpdate(validateTractorUpdate(input, this.now())),
      expectedVersion,
      context,
    );
    if (updated === undefined) throw new CatalogConflictError();
    return updated;
  }

  async getTractor(
    principal: AuthPrincipal,
    tractorId: string,
  ): Promise<OwnerTractorProjection> {
    this.#assertOwner(principal);
    const tractor = await this.store.findTractor(tractorId);
    this.#assertOwnedTractor(principal, tractor);
    return tractor;
  }

  listTractors(principal: AuthPrincipal): Promise<readonly OwnerTractorProjection[]> {
    this.#assertOwner(principal);
    return this.store.listOwnerTractors(principal.userId);
  }

  async getTractorAvailability(
    principal: AuthPrincipal,
    tractorId: string,
  ): Promise<TractorAvailabilityProjection> {
    this.#assertOwner(principal);
    this.#assertOwnedTractor(principal, await this.store.findTractor(tractorId));
    const availability = await this.store.getTractorAvailability(principal.userId, tractorId);
    if (availability === undefined) throw new CatalogNotFoundError();
    return availability;
  }

  async setTractorOperationalStatus(
    principal: AuthPrincipal,
    tractorId: string,
    status: TractorOperationalStatus,
    expectedVersion: number,
    context: CatalogRequestContext,
    reason?: string,
  ): Promise<TractorAvailabilityProjection> {
    this.#assertOwner(principal);
    this.#assertContext(context);
    this.#assertExpectedVersion(expectedVersion);
    if (status !== "ONLINE" && status !== "OFFLINE") {
      throw new TypeError("status must be ONLINE or OFFLINE");
    }
    const normalizedReason = reason?.trim();
    if (normalizedReason !== undefined && normalizedReason.length > 500) {
      throw new TypeError("reason must not exceed 500 characters");
    }
    this.#assertOwnedTractor(principal, await this.store.findTractor(tractorId));
    const result = await this.store.setTractorOperationalStatus(
      principal.userId,
      tractorId,
      status,
      expectedVersion,
      normalizedReason || undefined,
      this.#eligibilityPolicy,
      this.now(),
      context,
    );
    if (result === undefined) throw new CatalogConflictError();
    if (result.kind === "INELIGIBLE") {
      throw new CatalogAvailabilityRejectedError(result.evaluation, result.scheduleConflict);
    }
    return result.availability;
  }

  async addEquipment(
    principal: AuthPrincipal,
    input: EquipmentInput,
    context: CatalogRequestContext,
  ): Promise<OwnerEquipmentProjection> {
    this.#assertOwner(principal);
    this.#assertContext(context);
    const validated = validateEquipment(input);
    if (validated.tractorId !== undefined) {
      this.#assertOwnedTractor(principal, await this.store.findTractor(validated.tractorId));
    }
    const equipment = await this.store.createEquipment(principal.userId, validated, context);
    if (equipment === undefined) {
      throw new CatalogConflictError("The Equipment type or Tractor is unavailable");
    }
    return equipment;
  }

  async updateEquipment(
    principal: AuthPrincipal,
    equipmentId: string,
    input: EquipmentUpdateInput,
    expectedVersion: number,
    context: CatalogRequestContext,
  ): Promise<OwnerEquipmentProjection> {
    this.#assertOwner(principal);
    this.#assertContext(context);
    this.#assertExpectedVersion(expectedVersion);
    this.#assertOwnedEquipment(principal, await this.store.findEquipment(equipmentId));
    const equipment = await this.store.updateEquipment(
      principal.userId,
      equipmentId,
      validateEquipmentUpdate(input),
      expectedVersion,
      context,
    );
    if (equipment === undefined) throw new CatalogConflictError();
    return equipment;
  }

  async assignEquipment(
    principal: AuthPrincipal,
    equipmentId: string,
    tractorId: string | undefined,
    expectedVersion: number,
    context: CatalogRequestContext,
  ): Promise<OwnerEquipmentProjection> {
    this.#assertOwner(principal);
    this.#assertContext(context);
    this.#assertExpectedVersion(expectedVersion);
    this.#assertOwnedEquipment(principal, await this.store.findEquipment(equipmentId));
    if (tractorId !== undefined) {
      this.#assertOwnedTractor(principal, await this.store.findTractor(tractorId));
    }
    const equipment = await this.store.assignEquipment(
      principal.userId,
      equipmentId,
      tractorId,
      expectedVersion,
      context,
    );
    if (equipment === undefined) {
      throw new CatalogConflictError(
        "Equipment assigned to another Tractor's enabled offering cannot be reassigned",
      );
    }
    return equipment;
  }

  async listEquipment(principal: AuthPrincipal): Promise<readonly OwnerEquipmentProjection[]> {
    this.#assertOwner(principal);
    return this.store.listOwnerEquipment(principal.userId);
  }

  async configureServiceOffering(
    principal: AuthPrincipal,
    tractorId: string,
    input: ServiceOfferingInput,
    context: CatalogRequestContext,
    expectedVersion?: number,
  ): Promise<OwnerServiceOfferingProjection> {
    this.#assertOwner(principal);
    this.#assertContext(context);
    if (expectedVersion !== undefined) this.#assertExpectedVersion(expectedVersion);
    this.#assertOwnedTractor(principal, await this.store.findTractor(tractorId));
    const validated = validateServiceOffering(input);
    if (validated.equipmentId !== undefined) {
      const equipment = await this.store.findEquipment(validated.equipmentId);
      this.#assertOwnedEquipment(principal, equipment);
      if (equipment.tractorId !== undefined && equipment.tractorId !== tractorId) {
        throw new CatalogConflictError("Equipment is assigned to a different Tractor");
      }
    }
    const offering = await this.store.upsertServiceOffering(
      principal.userId,
      tractorId,
      validated,
      expectedVersion,
      context,
    );
    if (offering === undefined) {
      throw new CatalogConflictError("The Service, Equipment, or offering version is unavailable");
    }
    return offering;
  }

  async listServiceOfferings(
    principal: AuthPrincipal,
    tractorId: string,
  ): Promise<readonly OwnerServiceOfferingProjection[]> {
    this.#assertOwner(principal);
    this.#assertOwnedTractor(principal, await this.store.findTractor(tractorId));
    return this.store.listTractorServiceOfferings(principal.userId, tractorId);
  }

  async configurePricingRule(
    principal: AuthPrincipal,
    serviceOfferingId: string,
    input: PricingRuleInput,
    context: CatalogRequestContext,
    expectedVersion?: number,
  ): Promise<OwnerPricingRuleProjection> {
    this.#assertOwner(principal);
    this.#assertContext(context);
    if (expectedVersion !== undefined) this.#assertExpectedVersion(expectedVersion);
    const offering = await this.store.findServiceOffering(serviceOfferingId);
    if (offering === undefined) throw new CatalogAuthorizationError();
    this.#assertOwnedTractor(principal, await this.store.findTractor(offering.tractorId));
    const rule = await this.store.upsertPricingRule(
      principal.userId,
      serviceOfferingId,
      validatePricingRule(input),
      expectedVersion,
      context,
    );
    if (rule === undefined) {
      throw new CatalogConflictError("The Service Offering or Pricing Rule version is unavailable");
    }
    return rule;
  }

  async listPricingRules(
    principal: AuthPrincipal,
    serviceOfferingId: string,
  ): Promise<readonly OwnerPricingRuleProjection[]> {
    this.#assertOwner(principal);
    const offering = await this.store.findServiceOffering(serviceOfferingId);
    if (offering === undefined) throw new CatalogAuthorizationError();
    this.#assertOwnedTractor(principal, await this.store.findTractor(offering.tractorId));
    return this.store.listServiceOfferingPricingRules(principal.userId, serviceOfferingId);
  }

  async listActivePricingRules(
    principal: AuthPrincipal,
    serviceOfferingId: string,
  ): Promise<readonly ActivePricingRuleProjection[]> {
    this.#assertFarmer(principal);
    return this.store.listActivePricingRules(serviceOfferingId, this.now());
  }

  async createFarmerQuoteSnapshot(
    principal: AuthPrincipal,
    serviceOfferingId: string,
    pricingRuleId: string,
    estimatedQuantity: EstimatedPricingQuantity,
  ): Promise<QuoteSnapshot> {
    this.#assertFarmer(principal);
    const disclosedAt = this.now();
    const rule = await this.store.findActivePricingRule(
      serviceOfferingId,
      pricingRuleId,
      disclosedAt,
    );
    if (rule === undefined) {
      throw new CatalogConflictError("The selected Pricing Rule is no longer active; refresh and choose again");
    }
    return createQuoteSnapshot(rule, estimatedQuantity, disclosedAt);
  }

  async evaluateEligibility(
    principal: AuthPrincipal,
    tractorId: string,
    context: CatalogRequestContext,
  ): Promise<TractorEligibilityEvaluation> {
    this.#assertOwner(principal);
    this.#assertContext(context);
    this.#assertOwnedTractor(principal, await this.store.findTractor(tractorId));
    const evaluation = await this.store.evaluateTractorEligibility(
      principal.userId,
      tractorId,
      this.#eligibilityPolicy,
      this.now(),
      context,
    );
    if (evaluation === undefined) throw new CatalogConflictError();
    return evaluation;
  }

  #encryptTractor(input: TractorInput): StoredTractorInput {
    return Object.freeze({
      brand: input.brand,
      model: input.model,
      registrationNumberCiphertext: this.#crypto.encrypt(input.registrationNumber, "registration"),
      registrationLookupHash: this.#crypto.registrationLookupHash(input.registrationNumber),
      manufacturingYear: input.manufacturingYear,
      ...(input.horsepower === undefined ? {} : { horsepower: input.horsepower }),
      operatingLocation: input.operatingLocation,
      photos: Object.freeze(input.photos.map((photo, sortOrder) => Object.freeze({
        objectKeyCiphertext: this.#crypto.encrypt(photo.privateObjectKey, "photo-object-key"),
        mimeType: photo.mimeType,
        altText: photo.altText,
        sortOrder,
      }))),
    });
  }

  #encryptTractorUpdate(input: TractorUpdateInput): StoredTractorUpdateInput {
    const base = this.#encryptTractor({ ...input, photos: input.photos ?? [] });
    if (input.photos !== undefined) return base;
    const { photos: _photos, ...withoutPhotos } = base;
    return Object.freeze(withoutPhotos);
  }

  #assertFarmer(principal: AuthPrincipal): void {
    if (!principal.roles.includes("FARMER")) throw new CatalogAuthorizationError();
  }

  #assertOwner(principal: AuthPrincipal): void {
    if (!principal.roles.includes("OWNER")) throw new CatalogAuthorizationError();
  }

  #assertOwnedTractor(
    principal: AuthPrincipal,
    tractor: OwnerTractorProjection | undefined,
  ): asserts tractor is OwnerTractorProjection {
    // Deliberately use one response for missing and unrelated records.
    if (tractor === undefined || tractor.ownerId !== principal.userId) {
      throw new CatalogAuthorizationError();
    }
  }

  #assertOwnedEquipment(
    principal: AuthPrincipal,
    equipment: OwnerEquipmentProjection | undefined,
  ): asserts equipment is OwnerEquipmentProjection {
    // Deliberately use one response for missing and unrelated records.
    if (equipment === undefined || equipment.ownerId !== principal.userId) {
      throw new CatalogAuthorizationError();
    }
  }

  #assertExpectedVersion(expectedVersion: number): void {
    if (!Number.isInteger(expectedVersion) || expectedVersion <= 0) {
      throw new CatalogConflictError();
    }
  }

  #assertContext(context: CatalogRequestContext): void {
    if (context.correlationId.trim().length === 0) {
      throw new TypeError("correlationId must not be empty");
    }
  }
}
