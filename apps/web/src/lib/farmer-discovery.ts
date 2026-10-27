import type { LocationSource, PricingMethod } from "@kisantractor/domain";
import { cookies } from "next/headers";

import { accessCookieName, runtimeConfig } from "./server-context";

export interface FarmerPricingRule {
  readonly id: string;
  readonly method: PricingMethod;
  readonly ratePaise: number;
  readonly currency: string;
  readonly roundingPolicy?: "PROPORTIONAL_MINUTE" | "THIRTY_MINUTE_BLOCK" | "ONE_HOUR_BLOCK";
}

export interface FarmerTractorCardProjection {
  readonly id: string;
  readonly brand: string;
  readonly model: string;
  readonly photoAltText?: string;
  readonly approximateLocation: Readonly<{ state: string; district: string }>;
  readonly approximateDistance: Readonly<{ kilometers: number; label: string; isEstimate: true }>;
  readonly ownerDisplayName?: string;
  readonly service: Readonly<{ offeringId: string; id: string; name: string }>;
  readonly equipment?: Readonly<{ id: string; typeId: string; name: string }>;
  readonly pricingRules: readonly FarmerPricingRule[];
  readonly available: true;
}

export interface FarmerDiscoveryPage {
  readonly items: readonly FarmerTractorCardProjection[];
  readonly nextCursor?: string;
  readonly radiusKilometers: number;
  readonly canExpandRadius: boolean;
  readonly maximumRadiusKilometers: number;
  readonly origin: Readonly<{ state: string; district: string }>;
  readonly evaluatedAt: Date;
}

export interface FarmerSearchCriteria {
  readonly state: string;
  readonly district: string;
  readonly mandalOrTaluk: string;
  readonly village: string;
  readonly postalCode: string;
  readonly landmark: string;
  readonly source: LocationSource;
  readonly latitude: string;
  readonly longitude: string;
  readonly accuracyMeters: string;
  readonly capturedAt: string;
  readonly consentedAt: string;
  readonly serviceId: string;
  readonly equipmentTypeId: string;
  readonly pricingMethod: "" | PricingMethod;
  readonly start: string;
  readonly end: string;
  readonly radiusKilometers: number;
}

export type SearchParameters = Readonly<Record<string, string | readonly string[] | undefined>>;
export type DiscoveryLoadResult =
  | Readonly<{ state: "IDLE"; criteria: FarmerSearchCriteria }>
  | Readonly<{ state: "INVALID"; criteria: FarmerSearchCriteria; message: string }>
  | Readonly<{ state: "ERROR"; criteria: FarmerSearchCriteria; message: string }>
  | Readonly<{ state: "READY"; criteria: FarmerSearchCriteria; page: FarmerDiscoveryPage }>;

const text = (parameters: SearchParameters, key: string): string => {
  const value = parameters[key];
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? "";
};

const finiteNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;
const safeText = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

export function parseFarmerSearchCriteria(parameters: SearchParameters): FarmerSearchCriteria {
  const requestedRadius = Number(text(parameters, "radius"));
  const pricingMethod = text(parameters, "pricingMethod");
  const requestedSource = text(parameters, "source");
  const source: LocationSource = ["DEVICE_GPS", "MAP_PIN", "MAP_SEARCH", "MANUAL_ADDRESS", "SAVED_LOCATION"].includes(requestedSource)
    ? requestedSource as LocationSource
    : "MANUAL_ADDRESS";
  return Object.freeze({
    state: text(parameters, "state"),
    district: text(parameters, "district"),
    mandalOrTaluk: text(parameters, "mandalOrTaluk"),
    village: text(parameters, "village"),
    postalCode: text(parameters, "postalCode"),
    landmark: text(parameters, "landmark"),
    source,
    latitude: text(parameters, "latitude"),
    longitude: text(parameters, "longitude"),
    accuracyMeters: text(parameters, "accuracyMeters"),
    capturedAt: text(parameters, "capturedAt"),
    consentedAt: text(parameters, "consentedAt"),
    serviceId: text(parameters, "serviceId"),
    equipmentTypeId: text(parameters, "equipmentTypeId"),
    pricingMethod: ["HOURLY", "PER_ACRE", "PER_TRIP"].includes(pricingMethod)
      ? pricingMethod as PricingMethod
      : "",
    start: text(parameters, "start"),
    end: text(parameters, "end"),
    radiusKilometers: Number.isFinite(requestedRadius) && requestedRadius > 0
      ? Math.min(requestedRadius, 100)
      : 5,
  });
}

export function criteriaToSearchParameters(criteria: FarmerSearchCriteria): URLSearchParams {
  const parameters = new URLSearchParams();
  for (const [key, value] of Object.entries(criteria)) {
    const parameterKey = key === "radiusKilometers" ? "radius" : key;
    if (value !== "") parameters.set(parameterKey, String(value));
  }
  return parameters;
}

function normalizedPricingRule(value: unknown): FarmerPricingRule | undefined {
  if (!value || typeof value !== "object") return undefined;
  const source = value as Record<string, unknown>;
  const id = safeText(source.id);
  const method = safeText(source.method);
  const ratePaise = finiteNumber(source.ratePaise);
  const currency = safeText(source.currency);
  if (!id || !currency || !method || !["HOURLY", "PER_ACRE", "PER_TRIP"].includes(method) ||
      ratePaise === undefined || !Number.isSafeInteger(ratePaise) || ratePaise <= 0) return undefined;
  const rounding = safeText(source.roundingPolicy);
  const baseRule: FarmerPricingRule = Object.freeze({
    id,
    method: method as PricingMethod,
    ratePaise,
    currency,
  });
  if (rounding === "PROPORTIONAL_MINUTE" || rounding === "THIRTY_MINUTE_BLOCK" || rounding === "ONE_HOUR_BLOCK") {
    return Object.freeze({ ...baseRule, roundingPolicy: rounding });
  }
  return baseRule;
}

/** Picks only fields permitted by the redacted Farmer discovery contract. */
export function normalizeFarmerTractorCard(value: unknown): FarmerTractorCardProjection | undefined {
  if (!value || typeof value !== "object") return undefined;
  const source = value as Record<string, unknown>;
  const location = source.approximateLocation as Record<string, unknown> | undefined;
  const distance = source.approximateDistance as Record<string, unknown> | undefined;
  const service = source.service as Record<string, unknown> | undefined;
  const equipment = source.equipment as Record<string, unknown> | undefined;
  const photo = source.photo as Record<string, unknown> | undefined;
  const id = safeText(source.id);
  const brand = safeText(source.brand);
  const model = safeText(source.model);
  const state = safeText(location?.state);
  const district = safeText(location?.district);
  const kilometers = finiteNumber(distance?.kilometers);
  const label = safeText(distance?.label);
  const offeringId = safeText(service?.offeringId);
  const serviceId = safeText(service?.id);
  const serviceName = safeText(service?.name);
  const pricingRules = Array.isArray(source.pricingRules)
    ? source.pricingRules.map(normalizedPricingRule).filter((rule): rule is FarmerPricingRule => Boolean(rule))
    : [];
  if (!id || !brand || !model || !state || !district || kilometers === undefined || kilometers < 0 ||
      !label || !offeringId || !serviceId || !serviceName || pricingRules.length === 0 ||
      source.availability === undefined) return undefined;

  const equipmentId = safeText(equipment?.id);
  const equipmentTypeId = safeText(equipment?.typeId);
  const equipmentName = safeText(equipment?.name);
  const photoAltText = safeText(photo?.altText);
  const ownerDisplayName = safeText(source.ownerDisplayName);
  const card: FarmerTractorCardProjection = {
    id,
    brand,
    model,
    approximateLocation: Object.freeze({ state, district }),
    approximateDistance: Object.freeze({ kilometers, label, isEstimate: true as const }),
    service: Object.freeze({ offeringId, id: serviceId, name: serviceName }),
    pricingRules: Object.freeze(pricingRules),
    available: true as const,
    ...(photoAltText ? { photoAltText } : {}),
    ...(ownerDisplayName ? { ownerDisplayName } : {}),
    ...(equipmentId && equipmentTypeId && equipmentName
      ? { equipment: Object.freeze({ id: equipmentId, typeId: equipmentTypeId, name: equipmentName }) }
      : {}),
  };
  return Object.freeze(card);
}

export function normalizeFarmerDiscoveryPage(value: unknown): FarmerDiscoveryPage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const source = value as Record<string, unknown>;
  const origin = source.origin as Record<string, unknown> | undefined;
  const radiusKilometers = finiteNumber(source.radiusKilometers);
  const maximumRadiusKilometers = finiteNumber(source.maximumRadiusKilometers);
  const state = safeText(origin?.state);
  const district = safeText(origin?.district);
  const evaluatedAt = new Date(String(source.evaluatedAt ?? ""));
  if (!Array.isArray(source.items) || radiusKilometers === undefined || maximumRadiusKilometers === undefined ||
      !state || !district || Number.isNaN(evaluatedAt.getTime())) return undefined;
  const nextCursor = safeText(source.nextCursor);
  const page: FarmerDiscoveryPage = {
    items: Object.freeze(source.items.map(normalizeFarmerTractorCard).filter((item): item is FarmerTractorCardProjection => Boolean(item))),
    radiusKilometers,
    canExpandRadius: source.canExpandRadius === true,
    maximumRadiusKilometers,
    origin: Object.freeze({ state, district }),
    evaluatedAt,
    ...(nextCursor ? { nextCursor } : {}),
  };
  return Object.freeze(page);
}

export async function loadFarmerDiscovery(parameters: SearchParameters): Promise<DiscoveryLoadResult> {
  const criteria = parseFarmerSearchCriteria(parameters);
  const submitted = text(parameters, "search") === "1";
  if (!submitted) return { state: "IDLE", criteria };

  const latitude = Number(criteria.latitude);
  const longitude = Number(criteria.longitude);
  const accuracyMeters = criteria.accuracyMeters === "" ? undefined : Number(criteria.accuracyMeters);
  const capturedAt = criteria.capturedAt === "" ? new Date() : new Date(criteria.capturedAt);
  const consentedAt = criteria.consentedAt === "" ? undefined : new Date(criteria.consentedAt);
  const start = new Date(criteria.start);
  const end = new Date(criteria.end);
  const gpsInvalid = criteria.source === "DEVICE_GPS" &&
    (accuracyMeters === undefined || !Number.isFinite(accuracyMeters) || consentedAt === undefined || Number.isNaN(consentedAt.getTime()));
  if (!criteria.state || !criteria.district || !criteria.mandalOrTaluk || !criteria.village ||
      !criteria.serviceId || !Number.isFinite(latitude) || !Number.isFinite(longitude) ||
      Number.isNaN(capturedAt.getTime()) || gpsInvalid ||
      Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start >= end) {
    return { state: "INVALID", criteria, message: "Enter a complete service location, work, and valid time interval." };
  }

  try {
    const cookieStore = await cookies();
    const accessCredential = cookieStore.get(accessCookieName)?.value;
    if (!accessCredential) return { state: "ERROR", criteria, message: "Your session has expired. Log in and try again." };
    const response = await fetch(`${runtimeConfig().publicApiOrigin}/farmer/discovery/search`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessCredential}`,
        accept: "application/json",
        "content-type": "application/json",
      },
      cache: "no-store",
      body: JSON.stringify({
        serviceLocation: {
          state: criteria.state,
          district: criteria.district,
          mandalOrTaluk: criteria.mandalOrTaluk,
          village: criteria.village,
          ...(criteria.postalCode ? { postalCode: criteria.postalCode } : {}),
          ...(criteria.landmark ? { landmark: criteria.landmark } : {}),
          source: criteria.source,
          latitude,
          longitude,
          ...(accuracyMeters === undefined ? {} : { accuracyMeters }),
          capturedAt: capturedAt.toISOString(),
          ...(consentedAt === undefined ? {} : { consentedAt: consentedAt.toISOString() }),
          collectionPurpose: "SERVICE_LOCATION",
        },
        serviceId: criteria.serviceId,
        requestedInterval: { start: start.toISOString(), end: end.toISOString() },
        radiusKilometers: criteria.radiusKilometers,
        ...(criteria.equipmentTypeId ? { equipmentTypeId: criteria.equipmentTypeId } : {}),
        ...(criteria.pricingMethod ? { pricingMethod: criteria.pricingMethod } : {}),
      }),
    });
    if (!response.ok) return { state: "ERROR", criteria, message: "Search is unavailable right now. Check the details and retry safely." };
    const page = normalizeFarmerDiscoveryPage(await response.json());
    return page
      ? { state: "READY", criteria, page }
      : { state: "ERROR", criteria, message: "Search returned an invalid response. No private data was displayed." };
  } catch {
    return { state: "ERROR", criteria, message: "Search is unavailable right now. Reconnect and retry safely." };
  }
}
