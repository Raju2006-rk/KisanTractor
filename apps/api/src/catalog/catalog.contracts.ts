import type {
  ActivePricingRuleProjection,
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
  TractorInput,
  TractorOperationalStatus,
} from "@kisantractor/domain";
import type { AuditActorChannel } from "@kisantractor/database";

export interface CatalogRequestContext {
  readonly correlationId: string;
  readonly actorChannel: AuditActorChannel;
}

export interface CatalogSecrets {
  /** A 32-byte key loaded from secret storage. */
  readonly fieldEncryptionKey: Uint8Array;
  /** A separate HMAC key loaded from secret storage. */
  readonly lookupHashKey: Uint8Array;
}

export interface EncryptedTractorPhoto {
  readonly objectKeyCiphertext: Uint8Array;
  readonly mimeType: "image/jpeg" | "image/png" | "image/webp";
  readonly altText: string;
  readonly sortOrder: number;
}

export interface StoredTractorInput extends Omit<TractorInput, "registrationNumber" | "photos"> {
  readonly registrationNumberCiphertext: Uint8Array;
  readonly registrationLookupHash: string;
  readonly photos: readonly EncryptedTractorPhoto[];
}

export type StoredTractorUpdateInput = Omit<StoredTractorInput, "photos"> & {
  readonly photos?: readonly EncryptedTractorPhoto[];
};

export type SetOperationalStatusResult =
  | Readonly<{
      kind: "UPDATED";
      availability: TractorAvailabilityProjection;
    }>
  | Readonly<{
      kind: "INELIGIBLE";
      evaluation: TractorEligibilityEvaluation;
      scheduleConflict: boolean;
    }>;

export interface CatalogStore {
  upsertOwnerProfile(
    ownerId: string,
    input: OwnerProfileInput,
    expectedVersion: number | undefined,
    context: CatalogRequestContext,
  ): Promise<OwnerProfileProjection | undefined>;
  findOwnerProfile(ownerId: string): Promise<OwnerProfileProjection | undefined>;
  createTractor(
    ownerId: string,
    input: StoredTractorInput,
    context: CatalogRequestContext,
  ): Promise<OwnerTractorProjection>;
  updateTractor(
    ownerId: string,
    tractorId: string,
    input: StoredTractorUpdateInput,
    expectedVersion: number,
    context: CatalogRequestContext,
  ): Promise<OwnerTractorProjection | undefined>;
  findTractor(tractorId: string): Promise<OwnerTractorProjection | undefined>;
  listOwnerTractors(ownerId: string): Promise<readonly OwnerTractorProjection[]>;
  getTractorAvailability(
    ownerId: string,
    tractorId: string,
  ): Promise<TractorAvailabilityProjection | undefined>;
  setTractorOperationalStatus(
    ownerId: string,
    tractorId: string,
    status: TractorOperationalStatus,
    expectedVersion: number,
    reason: string | undefined,
    policy: CatalogEligibilityPolicy,
    changedAt: Date,
    context: CatalogRequestContext,
  ): Promise<SetOperationalStatusResult | undefined>;
  createEquipment(
    ownerId: string,
    input: EquipmentInput,
    context: CatalogRequestContext,
  ): Promise<OwnerEquipmentProjection | undefined>;
  updateEquipment(
    ownerId: string,
    equipmentId: string,
    input: EquipmentUpdateInput,
    expectedVersion: number,
    context: CatalogRequestContext,
  ): Promise<OwnerEquipmentProjection | undefined>;
  assignEquipment(
    ownerId: string,
    equipmentId: string,
    tractorId: string | undefined,
    expectedVersion: number,
    context: CatalogRequestContext,
  ): Promise<OwnerEquipmentProjection | undefined>;
  findEquipment(equipmentId: string): Promise<OwnerEquipmentProjection | undefined>;
  listOwnerEquipment(ownerId: string): Promise<readonly OwnerEquipmentProjection[]>;
  upsertServiceOffering(
    ownerId: string,
    tractorId: string,
    input: ServiceOfferingInput,
    expectedVersion: number | undefined,
    context: CatalogRequestContext,
  ): Promise<OwnerServiceOfferingProjection | undefined>;
  listTractorServiceOfferings(
    ownerId: string,
    tractorId: string,
  ): Promise<readonly OwnerServiceOfferingProjection[]>;
  findServiceOffering(serviceOfferingId: string): Promise<OwnerServiceOfferingProjection | undefined>;
  upsertPricingRule(
    ownerId: string,
    serviceOfferingId: string,
    input: PricingRuleInput,
    expectedVersion: number | undefined,
    context: CatalogRequestContext,
  ): Promise<OwnerPricingRuleProjection | undefined>;
  listServiceOfferingPricingRules(
    ownerId: string,
    serviceOfferingId: string,
  ): Promise<readonly OwnerPricingRuleProjection[]>;
  listActivePricingRules(
    serviceOfferingId: string,
    activeAt: Date,
  ): Promise<readonly ActivePricingRuleProjection[]>;
  findActivePricingRule(
    serviceOfferingId: string,
    pricingRuleId: string,
    activeAt: Date,
  ): Promise<ActivePricingRuleProjection | undefined>;
  evaluateTractorEligibility(
    ownerId: string,
    tractorId: string,
    policy: CatalogEligibilityPolicy,
    evaluatedAt: Date,
    context: CatalogRequestContext,
  ): Promise<TractorEligibilityEvaluation | undefined>;
}
