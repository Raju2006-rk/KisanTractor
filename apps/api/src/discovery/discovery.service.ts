import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import {
  normalizeLocation,
  presentEstimatedDistance,
  pricingMethods,
  type AuthPrincipal,
  type PricingMethod,
} from "@kisantractor/domain";
import { noopIndicators, type OperationalIndicators } from "@kisantractor/observability";

import {
  defaultDiscoveryPolicy,
  type DiscoveryCursorPosition,
  type DiscoveryPage,
  type DiscoveryPolicy,
  type DiscoverySearchInput,
  type DiscoveryStore,
  type DiscoveryStoreRow,
  type DiscoveryTractorCard,
  type NormalizedDiscoveryQuery,
} from "./discovery.contracts.js";

export class DiscoveryAuthorizationError extends Error {
  readonly code = "DISCOVERY_NOT_AUTHORIZED";

  constructor() {
    super("The authenticated account cannot search tractors");
    this.name = "DiscoveryAuthorizationError";
  }
}

export class DiscoveryValidationError extends Error {
  readonly code = "DISCOVERY_VALIDATION_FAILED";

  constructor(readonly field: string, message: string) {
    super(message);
    this.name = "DiscoveryValidationError";
  }
}

interface CursorPayload {
  readonly v: 1;
  readonly q: string;
  readonly a: number;
  readonly d: number;
  readonly t: string;
}

const validDate = (value: Date, field: string): Date => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new DiscoveryValidationError(field, `${field} must be a valid date`);
  }
  return date;
};

const nonEmpty = (value: string, field: string): string => {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 200) {
    throw new DiscoveryValidationError(field, `${field} must be between 1 and 200 characters`);
  }
  return normalized;
};

const validatePolicy = (policy: DiscoveryPolicy): Readonly<DiscoveryPolicy> => {
  if (
    !Number.isFinite(policy.defaultRadiusKilometers) ||
    !Number.isFinite(policy.maximumRadiusKilometers) ||
    policy.defaultRadiusKilometers <= 0 ||
    policy.defaultRadiusKilometers > policy.maximumRadiusKilometers
  ) {
    throw new TypeError("Discovery radius policy is invalid");
  }
  if (
    !Number.isInteger(policy.defaultPageSize) ||
    !Number.isInteger(policy.maximumPageSize) ||
    policy.defaultPageSize <= 0 ||
    policy.defaultPageSize > policy.maximumPageSize ||
    policy.maximumPageSize > 100
  ) {
    throw new TypeError("Discovery page-size policy is invalid");
  }
  if (!Number.isFinite(policy.maximumLocationAgeMs) || policy.maximumLocationAgeMs <= 0) {
    throw new TypeError("Discovery location-freshness policy is invalid");
  }
  return Object.freeze({ ...policy });
};

const queryFingerprint = (query: Omit<NormalizedDiscoveryQuery, "cursor" | "evaluatedAt" | "staleBefore">): string =>
  createHash("sha256").update(JSON.stringify({
    latitude: query.serviceLocation.latitude,
    longitude: query.serviceLocation.longitude,
    serviceId: query.serviceId,
    start: query.requestedInterval.start.toISOString(),
    end: query.requestedInterval.end.toISOString(),
    radiusKilometers: query.radiusKilometers,
    equipmentTypeId: query.equipmentTypeId ?? null,
    pricingMethod: query.pricingMethod ?? null,
    pageSize: query.pageSize,
  })).digest("base64url");

export class DiscoveryService {
  readonly #policy: Readonly<DiscoveryPolicy>;
  readonly #cursorSigningKey: Uint8Array;

  constructor(
    private readonly store: DiscoveryStore,
    cursorSigningKey: Uint8Array,
    policy: DiscoveryPolicy = defaultDiscoveryPolicy,
    private readonly now: () => Date = () => new Date(),
    private readonly indicators: OperationalIndicators = noopIndicators,
  ) {
    if (cursorSigningKey.byteLength < 32) {
      throw new TypeError("Discovery cursor signing key must contain at least 32 bytes");
    }
    this.#cursorSigningKey = new Uint8Array(cursorSigningKey);
    this.#policy = validatePolicy(policy);
  }

  async search(principal: AuthPrincipal, input: DiscoverySearchInput): Promise<DiscoveryPage> {
    if (!principal.roles.includes("FARMER")) throw new DiscoveryAuthorizationError();

    const serviceLocation = normalizeLocation(
      { ...input.serviceLocation, collectionPurpose: "SERVICE_LOCATION" },
      "SERVICE_LOCATION",
    );
    if (serviceLocation.latitude === undefined || serviceLocation.longitude === undefined) {
      throw new DiscoveryValidationError(
        "serviceLocation.coordinates",
        "Radius search requires approved service-location coordinates",
      );
    }

    const radiusKilometers = input.radiusKilometers ?? this.#policy.defaultRadiusKilometers;
    if (
      !Number.isFinite(radiusKilometers) ||
      radiusKilometers <= 0 ||
      radiusKilometers > this.#policy.maximumRadiusKilometers
    ) {
      throw new DiscoveryValidationError(
        "radiusKilometers",
        `radiusKilometers must be greater than 0 and at most ${this.#policy.maximumRadiusKilometers}`,
      );
    }

    const pageSize = input.pageSize ?? this.#policy.defaultPageSize;
    if (!Number.isInteger(pageSize) || pageSize <= 0 || pageSize > this.#policy.maximumPageSize) {
      throw new DiscoveryValidationError(
        "pageSize",
        `pageSize must be an integer from 1 to ${this.#policy.maximumPageSize}`,
      );
    }

    const start = validDate(input.requestedInterval.start, "requestedInterval.start");
    const end = validDate(input.requestedInterval.end, "requestedInterval.end");
    if (start.getTime() >= end.getTime()) {
      throw new DiscoveryValidationError(
        "requestedInterval",
        "requestedInterval must be a non-empty half-open interval",
      );
    }
    if (input.pricingMethod !== undefined && !pricingMethods.includes(input.pricingMethod)) {
      throw new DiscoveryValidationError("pricingMethod", "pricingMethod is not supported");
    }

    const evaluatedAt = validDate(this.now(), "evaluatedAt");
    const baseQuery = {
      serviceLocation: serviceLocation as NormalizedDiscoveryQuery["serviceLocation"],
      serviceId: nonEmpty(input.serviceId, "serviceId"),
      requestedInterval: Object.freeze({ start, end }),
      radiusKilometers,
      ...(input.equipmentTypeId === undefined
        ? {}
        : { equipmentTypeId: nonEmpty(input.equipmentTypeId, "equipmentTypeId") }),
      ...(input.pricingMethod === undefined ? {} : { pricingMethod: input.pricingMethod as PricingMethod }),
      pageSize,
    } as const;
    const fingerprint = queryFingerprint(baseQuery);
    const query: NormalizedDiscoveryQuery = Object.freeze({
      ...baseQuery,
      evaluatedAt,
      staleBefore: new Date(evaluatedAt.getTime() - this.#policy.maximumLocationAgeMs),
      ...(input.cursor === undefined ? {} : { cursor: this.#decodeCursor(input.cursor, fingerprint) }),
    });

    const rows = await this.store.search(query);
    const visibleRows = rows.slice(0, pageSize);
    const items = Object.freeze(visibleRows.map((row) => this.#projectCard(row)));
    const last = visibleRows.at(-1);
    const nextCursor = rows.length > pageSize && last !== undefined
      ? this.#encodeCursor({
          availabilityRank: last.availabilityRank,
          distanceMeters: last.distanceMeters,
          tractorId: last.tractorId,
        }, fingerprint)
      : undefined;

    // Only first pages count toward the zero-result rate; paging is not a new search.
    if (input.cursor === undefined) this.indicators.discoverySearched(items.length, input.pricingMethod);

    return Object.freeze({
      items,
      ...(nextCursor === undefined ? {} : { nextCursor }),
      radiusKilometers,
      defaultRadiusApplied: input.radiusKilometers === undefined,
      canExpandRadius: radiusKilometers < this.#policy.maximumRadiusKilometers,
      maximumRadiusKilometers: this.#policy.maximumRadiusKilometers,
      origin: Object.freeze({ state: serviceLocation.state, district: serviceLocation.district }),
      evaluatedAt,
    });
  }

  #projectCard(row: DiscoveryStoreRow): DiscoveryTractorCard {
    const distance = presentEstimatedDistance(row.distanceMeters / 1_000);
    return Object.freeze({
      id: row.tractorId,
      brand: row.brand,
      model: row.model,
      ...(row.photoAltText === undefined
        ? {}
        : { photo: Object.freeze({ altText: row.photoAltText }) }),
      approximateLocation: Object.freeze({ state: row.state, district: row.district }),
      approximateDistance: distance,
      ...(row.ownerDisplayName === undefined ? {} : { ownerDisplayName: row.ownerDisplayName }),
      service: Object.freeze({
        offeringId: row.serviceOfferingId,
        id: row.serviceId,
        name: row.serviceName,
      }),
      ...(row.equipmentId === undefined || row.equipmentTypeId === undefined || row.equipmentName === undefined
        ? {}
        : { equipment: Object.freeze({
            id: row.equipmentId,
            typeId: row.equipmentTypeId,
            name: row.equipmentName,
          }) }),
      pricingRules: Object.freeze(row.pricingRules.map((rule) => Object.freeze({ ...rule }))),
      availability: Object.freeze({ available: true, rank: row.availabilityRank }),
    });
  }

  #encodeCursor(position: DiscoveryCursorPosition, fingerprint: string): string {
    const encodedPayload = Buffer.from(JSON.stringify({
      v: 1,
      q: fingerprint,
      a: position.availabilityRank,
      d: position.distanceMeters,
      t: position.tractorId,
    } satisfies CursorPayload)).toString("base64url");
    const signature = createHmac("sha256", this.#cursorSigningKey)
      .update(encodedPayload)
      .digest("base64url");
    return `${encodedPayload}.${signature}`;
  }

  #decodeCursor(cursor: string, fingerprint: string): DiscoveryCursorPosition {
    const parts = cursor.split(".");
    if (parts.length !== 2 || parts[0] === undefined || parts[1] === undefined) {
      throw new DiscoveryValidationError("cursor", "cursor is invalid or expired");
    }
    const expected = createHmac("sha256", this.#cursorSigningKey).update(parts[0]).digest();
    let supplied: Buffer;
    try {
      supplied = Buffer.from(parts[1], "base64url");
    } catch {
      throw new DiscoveryValidationError("cursor", "cursor is invalid or expired");
    }
    if (supplied.byteLength !== expected.byteLength || !timingSafeEqual(supplied, expected)) {
      throw new DiscoveryValidationError("cursor", "cursor is invalid or expired");
    }

    let payload: CursorPayload;
    try {
      payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as CursorPayload;
    } catch {
      throw new DiscoveryValidationError("cursor", "cursor is invalid or expired");
    }
    if (
      payload.v !== 1 ||
      payload.q !== fingerprint ||
      !Number.isInteger(payload.a) ||
      payload.a < 0 ||
      !Number.isFinite(payload.d) ||
      payload.d < 0 ||
      typeof payload.t !== "string" ||
      payload.t.length === 0
    ) {
      throw new DiscoveryValidationError("cursor", "cursor does not match this search");
    }
    return Object.freeze({
      availabilityRank: payload.a,
      distanceMeters: payload.d,
      tractorId: payload.t,
    });
  }
}
