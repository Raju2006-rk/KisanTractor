export const locationSources = [
  "DEVICE_GPS",
  "MAP_PIN",
  "MAP_SEARCH",
  "MANUAL_ADDRESS",
  "SAVED_LOCATION",
] as const;

export type LocationSource = (typeof locationSources)[number];

export const locationCollectionPurposes = [
  "SERVICE_LOCATION",
  "TRACTOR_OPERATING_LOCATION",
  "SAVED_LOCATION",
] as const;

export type LocationCollectionPurpose = (typeof locationCollectionPurposes)[number];

export interface LocationInput {
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
  /** Required for device GPS and retained as evidence of the disclosed collection purpose. */
  readonly consentedAt?: Date;
  readonly collectionPurpose?: LocationCollectionPurpose;
}

export interface NormalizedLocation extends LocationInput {
  readonly collectionPurpose: LocationCollectionPurpose;
}

export interface LocationRecord extends NormalizedLocation {
  readonly id: string;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface LocationFreshnessPolicy {
  readonly warningAgeMs: number;
  readonly maximumAgeMs: number;
}

export const defaultLocationFreshnessPolicy: LocationFreshnessPolicy = Object.freeze({
  warningAgeMs: 12 * 60 * 60 * 1_000,
  maximumAgeMs: 24 * 60 * 60 * 1_000,
});

export type LocationFreshnessStatus = "FRESH" | "AGING" | "STALE";

export interface LocationFreshness {
  readonly status: LocationFreshnessStatus;
  readonly ageMs: number;
  readonly usableForDiscovery: boolean;
  readonly capturedAt: Date;
  readonly staleAt: Date;
  readonly message: string;
}

export type CoordinateAccuracyQuality = "HIGH" | "MODERATE" | "LOW" | "UNKNOWN";

export interface CoordinateAccuracyPresentation {
  readonly quality: CoordinateAccuracyQuality;
  readonly accuracyMeters?: number;
  readonly message: string;
}

export interface DistanceEstimatePresentation {
  readonly kilometers: number;
  readonly label: string;
  readonly isEstimate: true;
  readonly exactCoordinatesExposed: false;
}

export class LocationValidationError extends Error {
  readonly code = "LOCATION_VALIDATION_FAILED";

  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = "LocationValidationError";
  }
}

const normalizedText = (value: string, field: string, maximumLength: number): string => {
  const normalized = value.normalize("NFC").trim().replace(/\s+/gu, " ");
  if (normalized.length === 0) {
    throw new LocationValidationError(field, `${field} is required`);
  }
  if (normalized.length > maximumLength) {
    throw new LocationValidationError(field, `${field} is too long`);
  }
  return normalized;
};

const optionalNormalizedText = (
  value: string | undefined,
  field: string,
  maximumLength: number,
): string | undefined => {
  if (value === undefined || value.trim().length === 0) return undefined;
  return normalizedText(value, field, maximumLength);
};

const normalizedDate = (value: Date, field: string): Date => {
  const normalized = new Date(value);
  if (Number.isNaN(normalized.getTime())) {
    throw new LocationValidationError(field, `${field} must be a valid date`);
  }
  return normalized;
};

const assertCoordinate = (
  value: number | undefined,
  field: "latitude" | "longitude",
  minimum: number,
  maximum: number,
): void => {
  if (value !== undefined && (!Number.isFinite(value) || value < minimum || value > maximum)) {
    throw new LocationValidationError(field, `${field} must be from ${minimum} to ${maximum}`);
  }
};

export function normalizeLocation(
  input: LocationInput,
  defaultPurpose: LocationCollectionPurpose = "SERVICE_LOCATION",
): NormalizedLocation {
  if (!locationSources.includes(input.source)) {
    throw new LocationValidationError("source", "Select a valid location source");
  }

  const purpose = input.collectionPurpose ?? defaultPurpose;
  if (!locationCollectionPurposes.includes(purpose)) {
    throw new LocationValidationError("collectionPurpose", "Select a valid location collection purpose");
  }

  const hasLatitude = input.latitude !== undefined;
  const hasLongitude = input.longitude !== undefined;
  if (hasLatitude !== hasLongitude) {
    throw new LocationValidationError("coordinates", "Latitude and longitude must be supplied together");
  }
  assertCoordinate(input.latitude, "latitude", -90, 90);
  assertCoordinate(input.longitude, "longitude", -180, 180);

  if (
    input.accuracyMeters !== undefined &&
    (!Number.isFinite(input.accuracyMeters) || input.accuracyMeters < 0)
  ) {
    throw new LocationValidationError("accuracyMeters", "Accuracy must not be negative");
  }
  if (input.accuracyMeters !== undefined && !hasLatitude) {
    throw new LocationValidationError("accuracyMeters", "Accuracy requires coordinates");
  }

  const capturedAt = normalizedDate(input.capturedAt, "capturedAt");
  const consentedAt = input.consentedAt === undefined
    ? undefined
    : normalizedDate(input.consentedAt, "consentedAt");

  if (input.source === "DEVICE_GPS") {
    if (!hasLatitude) {
      throw new LocationValidationError("coordinates", "Device GPS requires coordinates");
    }
    if (input.accuracyMeters === undefined) {
      throw new LocationValidationError("accuracyMeters", "Device GPS requires coordinate accuracy");
    }
    if (consentedAt === undefined) {
      throw new LocationValidationError("consentedAt", "Device GPS requires explicit location consent");
    }
  }

  if ((input.source === "MAP_PIN" || input.source === "MAP_SEARCH") && !hasLatitude) {
    throw new LocationValidationError("coordinates", "A resolved map location requires coordinates");
  }

  if (consentedAt !== undefined && consentedAt.getTime() > capturedAt.getTime()) {
    throw new LocationValidationError("consentedAt", "Location consent must be recorded before capture");
  }

  const postalCode = optionalNormalizedText(input.postalCode, "postalCode", 6);
  if (postalCode !== undefined && !/^\d{6}$/u.test(postalCode)) {
    throw new LocationValidationError("postalCode", "Enter a valid 6-digit PIN code");
  }
  const landmark = optionalNormalizedText(input.landmark, "landmark", 250);

  return Object.freeze({
    state: normalizedText(input.state, "state", 100),
    district: normalizedText(input.district, "district", 100),
    mandalOrTaluk: normalizedText(input.mandalOrTaluk, "mandalOrTaluk", 100),
    village: normalizedText(input.village, "village", 150),
    ...(postalCode === undefined ? {} : { postalCode }),
    ...(landmark === undefined ? {} : { landmark }),
    source: input.source,
    ...(input.latitude === undefined ? {} : { latitude: input.latitude }),
    ...(input.longitude === undefined ? {} : { longitude: input.longitude }),
    ...(input.accuracyMeters === undefined ? {} : { accuracyMeters: input.accuracyMeters }),
    capturedAt,
    ...(consentedAt === undefined ? {} : { consentedAt }),
    collectionPurpose: purpose,
  });
}

export function evaluateLocationFreshness(
  capturedAtValue: Date,
  policy: LocationFreshnessPolicy = defaultLocationFreshnessPolicy,
  nowValue = new Date(),
): LocationFreshness {
  if (
    !Number.isFinite(policy.warningAgeMs) ||
    !Number.isFinite(policy.maximumAgeMs) ||
    policy.warningAgeMs < 0 ||
    policy.maximumAgeMs <= 0 ||
    policy.warningAgeMs >= policy.maximumAgeMs
  ) {
    throw new LocationValidationError(
      "freshnessPolicy",
      "Location warning age must be nonnegative and less than maximum age",
    );
  }

  const capturedAt = normalizedDate(capturedAtValue, "capturedAt");
  const now = normalizedDate(nowValue, "now");
  const ageMs = now.getTime() - capturedAt.getTime();
  const staleAt = new Date(capturedAt.getTime() + policy.maximumAgeMs);
  const status: LocationFreshnessStatus =
    ageMs < 0 || ageMs > policy.maximumAgeMs
      ? "STALE"
      : ageMs > policy.warningAgeMs
        ? "AGING"
        : "FRESH";

  const message = ageMs < 0
    ? "Location capture time is invalid. Capture it again."
    : status === "STALE"
      ? "Location data is stale. Refresh it before discovery."
      : status === "AGING"
        ? "Location data will expire soon. Refresh it when possible."
        : "Location data is fresh.";

  return Object.freeze({
    status,
    ageMs: Math.max(0, ageMs),
    usableForDiscovery: status !== "STALE",
    capturedAt,
    staleAt,
    message,
  });
}

export function describeCoordinateAccuracy(
  accuracyMeters: number | undefined,
): CoordinateAccuracyPresentation {
  if (accuracyMeters === undefined) {
    return Object.freeze({ quality: "UNKNOWN", message: "Coordinate accuracy is unavailable." });
  }
  if (!Number.isFinite(accuracyMeters) || accuracyMeters < 0) {
    throw new LocationValidationError("accuracyMeters", "Accuracy must not be negative");
  }

  const rounded = Math.ceil(accuracyMeters);
  const quality: CoordinateAccuracyQuality = rounded <= 25
    ? "HIGH"
    : rounded <= 100
      ? "MODERATE"
      : "LOW";
  return Object.freeze({
    quality,
    accuracyMeters,
    message: `Estimated coordinate accuracy: within about ${rounded} metres.`,
  });
}

export function presentEstimatedDistance(kilometers: number): DistanceEstimatePresentation {
  if (!Number.isFinite(kilometers) || kilometers < 0) {
    throw new LocationValidationError("kilometers", "Distance must not be negative");
  }
  const rounded = Math.round(kilometers * 10) / 10;
  return Object.freeze({
    kilometers: rounded,
    label: `Approximately ${rounded.toFixed(1)} km away`,
    isEstimate: true,
    exactCoordinatesExposed: false,
  });
}
