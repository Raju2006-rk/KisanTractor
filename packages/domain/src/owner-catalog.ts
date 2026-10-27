import {
  defaultLocationFreshnessPolicy,
  locationSources,
  LocationValidationError,
  normalizeLocation,
} from "./location.js";
import type { LocationCollectionPurpose, LocationSource } from "./location.js";

export { locationSources };
export type { LocationSource };

export interface OwnerLocationInput {
  readonly state: string;
  readonly district: string;
  readonly mandalOrTaluk: string;
  readonly village: string;
  readonly postalCode?: string;
  readonly landmark?: string;
  readonly source: LocationSource;
  readonly latitude?: number;
  readonly longitude?: number;
  readonly accuracyMeters?: number;
  readonly capturedAt: Date;
  readonly consentedAt?: Date;
  readonly collectionPurpose?: LocationCollectionPurpose;
}

export interface OwnerProfileInput {
  readonly fullName: string;
  readonly preferredLocale: string;
  readonly contactSharingConsent: boolean;
  readonly operatingLocation: OwnerLocationInput;
}

export interface TractorPhotoInput {
  /** Private object key returned by an authorized upload flow. Never projected. */
  readonly privateObjectKey: string;
  readonly mimeType: "image/jpeg" | "image/png" | "image/webp";
  readonly altText: string;
}

export interface TractorInput {
  readonly brand: string;
  readonly model: string;
  readonly registrationNumber: string;
  readonly manufacturingYear: number;
  readonly horsepower?: number;
  readonly operatingLocation: OwnerLocationInput;
  readonly photos: readonly TractorPhotoInput[];
}

export type TractorUpdateInput = Omit<TractorInput, "photos"> & {
  /** Omit to preserve the current photo set. */
  readonly photos?: readonly TractorPhotoInput[];
};

export interface OwnerLocationProjection {
  readonly id: string;
  readonly state: string;
  readonly district: string;
  readonly mandalOrTaluk: string;
  readonly village: string;
  readonly postalCode?: string;
  readonly landmark?: string;
  readonly source: LocationSource;
  readonly latitude?: number;
  readonly longitude?: number;
  readonly accuracyMeters?: number;
  readonly capturedAt: Date;
  readonly consentedAt?: Date;
  readonly collectionPurpose?: LocationCollectionPurpose;
}

export interface OwnerProfileProjection {
  readonly userId: string;
  readonly fullName: string;
  readonly preferredLocale: string;
  readonly contactSharingConsent: boolean;
  readonly mobileVerified: true;
  readonly verificationStatus: "UNVERIFIED" | "PENDING" | "VERIFIED" | "REJECTED";
  readonly operatingLocation: OwnerLocationProjection;
  readonly version: number;
}

export interface OwnerTractorPhotoProjection {
  readonly id: string;
  readonly mimeType: TractorPhotoInput["mimeType"];
  readonly altText: string;
  readonly sortOrder: number;
}

export const tractorOperationalStatuses = ["ONLINE", "OFFLINE"] as const;
export type TractorOperationalStatus = (typeof tractorOperationalStatuses)[number];

export interface OwnerTractorProjection {
  readonly id: string;
  readonly ownerId: string;
  readonly brand: string;
  readonly model: string;
  readonly registrationNumber: string;
  readonly manufacturingYear: number;
  readonly horsepower?: number;
  readonly operationalStatus: TractorOperationalStatus;
  readonly eligibilityStatus: "INCOMPLETE" | "ELIGIBLE" | "INELIGIBLE";
  readonly operatingLocation: OwnerLocationProjection;
  readonly photos: readonly OwnerTractorPhotoProjection[];
  readonly version: number;
}

/** Authoritative per-Tractor state returned to every Owner client. */
export interface TractorAvailabilityProjection {
  readonly tractorId: string;
  readonly operationalStatus: TractorOperationalStatus;
  readonly eligibilityStatus: OwnerTractorProjection["eligibilityStatus"];
  /** New discovery and booking flows must require this value to be true. */
  readonly acceptingNewDemand: boolean;
  /** Going offline never disables controls for already-confirmed bookings. */
  readonly existingConfirmedBookingsManageable: true;
  readonly effectiveAt: Date;
  /** The Tractor aggregate version used for optimistic status commands. */
  readonly version: number;
}

export class CatalogValidationError extends Error {
  readonly code = "CATALOG_VALIDATION_FAILED";

  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = "CatalogValidationError";
  }
}

const requiredText = (value: string, field: string, maxLength: number): string => {
  const normalized = value.trim().replace(/\s+/gu, " ");
  if (normalized.length === 0) {
    throw new CatalogValidationError(field, `${field} is required`);
  }
  if (normalized.length > maxLength) {
    throw new CatalogValidationError(field, `${field} is too long`);
  }
  return normalized;
};

const optionalText = (
  value: string | undefined,
  field: string,
  maxLength: number,
): string | undefined => {
  if (value === undefined || value.trim().length === 0) return undefined;
  return requiredText(value, field, maxLength);
};

const validDate = (value: Date, field: string): Date => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new CatalogValidationError(field, `${field} must be a valid date`);
  }
  return date;
};

export function normalizeRegistrationNumber(value: string): string {
  const normalized = value.toUpperCase().replace(/[\s-]/gu, "");
  if (
    !/^[A-Z0-9]{6,12}$/u.test(normalized) ||
    !/[A-Z]/u.test(normalized) ||
    !/\d/u.test(normalized)
  ) {
    throw new CatalogValidationError(
      "registrationNumber",
      "Enter a valid vehicle registration number",
    );
  }
  return normalized;
}

export function validateOwnerLocation(input: OwnerLocationInput): OwnerLocationInput {
  try {
    return normalizeLocation(input, "TRACTOR_OPERATING_LOCATION");
  } catch (error) {
    if (error instanceof LocationValidationError) {
      throw new CatalogValidationError(error.field, error.message);
    }
    throw error;
  }
}

export function validateOwnerProfile(input: OwnerProfileInput): OwnerProfileInput {
  const preferredLocale = input.preferredLocale.trim().toLowerCase();
  if (!/^[a-z]{2}(?:-[a-z]{2})?$/u.test(preferredLocale)) {
    throw new CatalogValidationError("preferredLocale", "Select a valid language");
  }
  return Object.freeze({
    fullName: requiredText(input.fullName, "fullName", 150),
    preferredLocale,
    contactSharingConsent: input.contactSharingConsent,
    operatingLocation: validateOwnerLocation(input.operatingLocation),
  });
}

export function validateTractor(input: TractorInput, now = new Date()): TractorInput {
  if (!Number.isInteger(input.manufacturingYear) || input.manufacturingYear < 1900 || input.manufacturingYear > now.getUTCFullYear() + 1) {
    throw new CatalogValidationError(
      "manufacturingYear",
      `Manufacturing year must be from 1900 to ${now.getUTCFullYear() + 1}`,
    );
  }
  if (input.horsepower !== undefined && (!Number.isFinite(input.horsepower) || input.horsepower <= 0 || input.horsepower > 1000)) {
    throw new CatalogValidationError("horsepower", "Horsepower must be from 0 to 1000");
  }
  if (input.photos.length > 8) {
    throw new CatalogValidationError("photos", "A tractor can have at most 8 photos");
  }

  return Object.freeze({
    brand: requiredText(input.brand, "brand", 100),
    model: requiredText(input.model, "model", 100),
    registrationNumber: normalizeRegistrationNumber(input.registrationNumber),
    manufacturingYear: input.manufacturingYear,
    ...(input.horsepower === undefined ? {} : { horsepower: input.horsepower }),
    operatingLocation: validateOwnerLocation(input.operatingLocation),
    photos: Object.freeze(input.photos.map((photo, index) => {
      const privateObjectKey = requiredText(photo.privateObjectKey, `photos.${index}.privateObjectKey`, 1000);
      if (!(["image/jpeg", "image/png", "image/webp"] as const).includes(photo.mimeType)) {
        throw new CatalogValidationError(`photos.${index}.mimeType`, "Select a supported tractor photo");
      }
      return Object.freeze({
        privateObjectKey,
        mimeType: photo.mimeType,
        altText: requiredText(photo.altText, `photos.${index}.altText`, 250),
      });
    })),
  });
}

export function validateTractorUpdate(input: TractorUpdateInput, now = new Date()): TractorUpdateInput {
  const validated = validateTractor({ ...input, photos: input.photos ?? [] }, now);
  return Object.freeze({
    brand: validated.brand,
    model: validated.model,
    registrationNumber: validated.registrationNumber,
    manufacturingYear: validated.manufacturingYear,
    ...(validated.horsepower === undefined ? {} : { horsepower: validated.horsepower }),
    operatingLocation: validated.operatingLocation,
    ...(input.photos === undefined ? {} : { photos: validated.photos }),
  });
}


export const equipmentAvailabilityStatuses = [
  "AVAILABLE",
  "UNAVAILABLE",
  "MAINTENANCE",
] as const;

export type EquipmentAvailabilityStatus = (typeof equipmentAvailabilityStatuses)[number];

export interface EquipmentInput {
  readonly equipmentTypeId: string;
  readonly displayName: string;
  readonly availabilityStatus?: EquipmentAvailabilityStatus;
  /** Omit to keep the item in general Owner inventory. */
  readonly tractorId?: string;
}

export interface EquipmentUpdateInput {
  readonly displayName: string;
  readonly availabilityStatus: EquipmentAvailabilityStatus;
}

export interface OwnerEquipmentProjection {
  readonly id: string;
  readonly ownerId: string;
  readonly tractorId?: string;
  readonly equipmentTypeId: string;
  readonly equipmentTypeCode: string;
  readonly equipmentTypeName: string;
  readonly displayName: string;
  readonly availabilityStatus: EquipmentAvailabilityStatus;
  readonly version: number;
}

export interface ServiceOfferingInput {
  readonly serviceId: string;
  readonly equipmentId?: string;
  readonly enabled: boolean;
}

export interface OwnerServiceOfferingProjection {
  readonly id: string;
  readonly tractorId: string;
  readonly serviceId: string;
  readonly serviceCode: string;
  readonly serviceName: string;
  readonly equipmentId?: string;
  readonly equipmentName?: string;
  readonly enabled: boolean;
  readonly version: number;
}

export const pricingMethods = ["HOURLY", "PER_ACRE", "PER_TRIP"] as const;
export type PricingMethod = (typeof pricingMethods)[number];

export const hourlyRoundingPolicies = [
  "PROPORTIONAL_MINUTE",
  "THIRTY_MINUTE_BLOCK",
  "ONE_HOUR_BLOCK",
] as const;
export type HourlyRoundingPolicy = (typeof hourlyRoundingPolicies)[number];

export type PricingRuleInput =
  | Readonly<{
      method: "HOURLY";
      ratePaise: number;
      roundingPolicy: HourlyRoundingPolicy;
      enabled: boolean;
    }>
  | Readonly<{
      method: "PER_ACRE" | "PER_TRIP";
      ratePaise: number;
      roundingPolicy?: never;
      enabled: boolean;
    }>;

export interface OwnerPricingRuleProjection {
  readonly id: string;
  readonly serviceOfferingId: string;
  readonly method: PricingMethod;
  readonly ratePaise: number;
  readonly currency: "INR";
  readonly roundingPolicy?: HourlyRoundingPolicy;
  readonly enabled: boolean;
  readonly version: number;
}

export const tractorEligibilityReasonCodes = [
  "REQUIRED_TRACTOR_INFORMATION_MISSING",
  "REQUIRED_DOCUMENTS_MISSING",
  "ENABLED_SERVICE_OFFERING_MISSING",
  "ACTIVE_SERVICE_PRICING_MISSING",
  "LOCATION_STALE",
] as const;

export type TractorEligibilityReasonCode = (typeof tractorEligibilityReasonCodes)[number];

export interface TractorEligibilityReason {
  readonly code: TractorEligibilityReasonCode;
  readonly message: string;
  readonly missingDocumentKinds?: readonly string[];
}

export interface TractorEligibilityFacts {
  readonly hasRequiredTractorInformation: boolean;
  readonly missingRequiredDocumentKinds: readonly string[];
  readonly hasEnabledServiceOffering: boolean;
  readonly hasActiveServicePricing: boolean;
  readonly locationUpdatedAt: Date;
  readonly operationalStatus: OwnerTractorProjection["operationalStatus"];
}

export interface TractorEligibilityEvaluation {
  readonly tractorId: string;
  readonly status: OwnerTractorProjection["eligibilityStatus"];
  /** Discovery may publish a tractor only when this authoritative value is true. */
  readonly discoverable: boolean;
  readonly reasons: readonly TractorEligibilityReason[];
  readonly evaluatedAt: Date;
}

export interface CatalogEligibilityPolicy {
  readonly requiredDocumentKinds: readonly string[];
  readonly maximumLocationAgeMs: number;
}

export const defaultCatalogEligibilityPolicy: CatalogEligibilityPolicy = Object.freeze({
  requiredDocumentKinds: Object.freeze(["REGISTRATION_CERTIFICATE", "INSURANCE"]),
  maximumLocationAgeMs: defaultLocationFreshnessPolicy.maximumAgeMs,
});

export function validateEquipment(input: EquipmentInput): EquipmentInput {
  const availabilityStatus = input.availabilityStatus ?? "AVAILABLE";
  if (!equipmentAvailabilityStatuses.includes(availabilityStatus)) {
    throw new CatalogValidationError("availabilityStatus", "Select a valid Equipment availability status");
  }
  return Object.freeze({
    equipmentTypeId: requiredText(input.equipmentTypeId, "equipmentTypeId", 100),
    displayName: requiredText(input.displayName, "displayName", 150),
    availabilityStatus,
    ...(input.tractorId === undefined
      ? {}
      : { tractorId: requiredText(input.tractorId, "tractorId", 100) }),
  });
}

export function validateEquipmentUpdate(input: EquipmentUpdateInput): EquipmentUpdateInput {
  if (!equipmentAvailabilityStatuses.includes(input.availabilityStatus)) {
    throw new CatalogValidationError("availabilityStatus", "Select a valid Equipment availability status");
  }
  return Object.freeze({
    displayName: requiredText(input.displayName, "displayName", 150),
    availabilityStatus: input.availabilityStatus,
  });
}

export function validateServiceOffering(input: ServiceOfferingInput): ServiceOfferingInput {
  return Object.freeze({
    serviceId: requiredText(input.serviceId, "serviceId", 100),
    ...(input.equipmentId === undefined
      ? {}
      : { equipmentId: requiredText(input.equipmentId, "equipmentId", 100) }),
    enabled: input.enabled,
  });
}

export function validatePricingRule(input: PricingRuleInput): PricingRuleInput {
  if (!pricingMethods.includes(input.method)) {
    throw new CatalogValidationError("method", "Select hourly, per-acre, or per-trip pricing");
  }
  if (!Number.isSafeInteger(input.ratePaise) || input.ratePaise <= 0) {
    throw new CatalogValidationError("ratePaise", "Rate must be a positive whole number of paise");
  }
  if (typeof input.enabled !== "boolean") {
    throw new CatalogValidationError("enabled", "Pricing Rule enabled state is required");
  }
  if (input.method === "HOURLY") {
    if (!hourlyRoundingPolicies.includes(input.roundingPolicy)) {
      throw new CatalogValidationError(
        "roundingPolicy",
        "Hourly pricing requires a disclosed rounding policy",
      );
    }
    return Object.freeze({
      method: input.method,
      ratePaise: input.ratePaise,
      roundingPolicy: input.roundingPolicy,
      enabled: input.enabled,
    });
  }
  if ("roundingPolicy" in input && input.roundingPolicy !== undefined) {
    throw new CatalogValidationError(
      "roundingPolicy",
      "Rounding policy applies only to hourly pricing",
    );
  }
  return Object.freeze({
    method: input.method,
    ratePaise: input.ratePaise,
    enabled: input.enabled,
  });
}

export function validateEligibilityPolicy(policy: CatalogEligibilityPolicy): CatalogEligibilityPolicy {
  if (!Number.isFinite(policy.maximumLocationAgeMs) || policy.maximumLocationAgeMs <= 0) {
    throw new CatalogValidationError(
      "maximumLocationAgeMs",
      "Maximum location age must be a positive duration",
    );
  }
  const requiredDocumentKinds = [...new Set(policy.requiredDocumentKinds.map((kind, index) =>
    requiredText(kind, `requiredDocumentKinds.${index}`, 100).toUpperCase(),
  ))];
  return Object.freeze({
    requiredDocumentKinds: Object.freeze(requiredDocumentKinds),
    maximumLocationAgeMs: policy.maximumLocationAgeMs,
  });
}

export function evaluateTractorEligibility(
  tractorId: string,
  facts: TractorEligibilityFacts,
  policy: CatalogEligibilityPolicy,
  evaluatedAt = new Date(),
): TractorEligibilityEvaluation {
  const normalizedPolicy = validateEligibilityPolicy(policy);
  const evaluationTime = validDate(evaluatedAt, "evaluatedAt");
  const locationUpdatedAt = validDate(facts.locationUpdatedAt, "locationUpdatedAt");
  const reasons: TractorEligibilityReason[] = [];

  if (!facts.hasRequiredTractorInformation) {
    reasons.push(Object.freeze({
      code: "REQUIRED_TRACTOR_INFORMATION_MISSING",
      message: "Complete all required Tractor information before publishing",
    }));
  }

  const requiredKinds = new Set(normalizedPolicy.requiredDocumentKinds);
  const missingKinds = [...new Set(facts.missingRequiredDocumentKinds
    .map((kind) => kind.trim().toUpperCase())
    .filter((kind) => requiredKinds.has(kind)))].sort();
  if (missingKinds.length > 0) {
    reasons.push(Object.freeze({
      code: "REQUIRED_DOCUMENTS_MISSING",
      message: `Accepted documents are required: ${missingKinds.join(", ")}`,
      missingDocumentKinds: Object.freeze(missingKinds),
    }));
  }
  if (!facts.hasEnabledServiceOffering) {
    reasons.push(Object.freeze({
      code: "ENABLED_SERVICE_OFFERING_MISSING",
      message: "Enable at least one Service Offering before publishing",
    }));
  }
  if (!facts.hasActiveServicePricing) {
    reasons.push(Object.freeze({
      code: "ACTIVE_SERVICE_PRICING_MISSING",
      message: "Add active pricing to an enabled Service Offering before publishing",
    }));
  }
  if (
    locationUpdatedAt.getTime() > evaluationTime.getTime() ||
    evaluationTime.getTime() - locationUpdatedAt.getTime() > normalizedPolicy.maximumLocationAgeMs
  ) {
    reasons.push(Object.freeze({
      code: "LOCATION_STALE",
      message: "Refresh the Tractor operating location before publishing",
    }));
  }

  const hasIncompleteSetup = reasons.some((reason) => reason.code !== "LOCATION_STALE");
  const status: OwnerTractorProjection["eligibilityStatus"] = reasons.length === 0
    ? "ELIGIBLE"
    : hasIncompleteSetup
      ? "INCOMPLETE"
      : "INELIGIBLE";

  return Object.freeze({
    tractorId: requiredText(tractorId, "tractorId", 100),
    status,
    discoverable: status === "ELIGIBLE" && facts.operationalStatus === "ONLINE",
    reasons: Object.freeze(reasons),
    evaluatedAt: evaluationTime,
  });
}
