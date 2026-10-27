import type { PricingMethod } from "@kisantractor/domain";

import { sanitizeSafeDraft } from "./authoritative-action";
import type { SearchParameters } from "./farmer-discovery";

export type BookingTarget = "MYSELF" | "SOMEONE_ELSE";
export type BookingStep = "target" | "location" | "work" | "schedule" | "pricing" | "review";

export const bookingSteps: readonly BookingStep[] = Object.freeze([
  "target", "location", "work", "schedule", "pricing", "review",
]);

export interface FarmerBookingDraft {
  readonly bookingTarget: BookingTarget;
  readonly recipientName: string;
  readonly coordinationPhone: string;
  readonly coordinationConsent: boolean;
  readonly landmarkOrDirections: string;
  readonly state: string;
  readonly district: string;
  readonly mandalOrTaluk: string;
  readonly village: string;
  readonly landmark: string;
  readonly latitude: string;
  readonly longitude: string;
  readonly serviceId: string;
  readonly equipmentTypeId: string;
  readonly start: string;
  readonly end: string;
  readonly pricingMethod: "" | PricingMethod;
  readonly pricingRuleId: string;
  readonly expectedQuantity: string;
  readonly tractorId: string;
  readonly serviceOfferingId: string;
}

const firstText = (parameters: SearchParameters, key: string): string => {
  const value = parameters[key];
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? "";
};

export function createBookingDraft(parameters: SearchParameters = {}): FarmerBookingDraft {
  const pricingMethod = firstText(parameters, "pricingMethod");
  return Object.freeze({
    bookingTarget: firstText(parameters, "target") === "SOMEONE_ELSE" ? "SOMEONE_ELSE" : "MYSELF",
    recipientName: "",
    coordinationPhone: "",
    coordinationConsent: false,
    landmarkOrDirections: "",
    state: firstText(parameters, "state"),
    district: firstText(parameters, "district"),
    mandalOrTaluk: firstText(parameters, "mandalOrTaluk"),
    village: firstText(parameters, "village"),
    landmark: firstText(parameters, "landmark"),
    latitude: firstText(parameters, "latitude"),
    longitude: firstText(parameters, "longitude"),
    serviceId: firstText(parameters, "serviceId"),
    equipmentTypeId: firstText(parameters, "equipmentTypeId"),
    start: firstText(parameters, "start"),
    end: firstText(parameters, "end"),
    pricingMethod: ["HOURLY", "PER_ACRE", "PER_TRIP"].includes(pricingMethod)
      ? pricingMethod as PricingMethod
      : "",
    pricingRuleId: firstText(parameters, "pricingRuleId"),
    expectedQuantity: firstText(parameters, "quantity"),
    tractorId: firstText(parameters, "tractorId"),
    serviceOfferingId: firstText(parameters, "offeringId"),
  });
}

/**
 * Draft fields that are never written to storage. The Recipient's coordination phone is a third
 * party's personal contact, so it stays in memory only; its consent is tied to it.
 */
const unsavedDraftFields: ReadonlySet<keyof FarmerBookingDraft> = new Set(["coordinationPhone", "coordinationConsent"]);
const savedDraftFields = (Object.keys(createBookingDraft()) as (keyof FarmerBookingDraft)[])
  .filter((key) => !unsavedDraftFields.has(key));

/**
 * Serializes the safe part of a booking draft for tab-scoped storage. Tokens, OTP, payment data,
 * and the Recipient's phone are never included; a flag records that a phone must be re-entered.
 */
export function serializeSafeBookingDraft(draft: FarmerBookingDraft): string {
  return JSON.stringify({
    ...sanitizeSafeDraft(draft as unknown as Record<string, unknown>, savedDraftFields),
    ...(draft.coordinationPhone.trim() ? { coordinationPhoneOmitted: true } : {}),
  });
}

/** True when a stored draft had a coordination phone that was deliberately not saved. */
export function bookingDraftOmittedPhone(value: string | null): boolean {
  if (!value) return false;
  try {
    return (JSON.parse(value) as { coordinationPhoneOmitted?: unknown }).coordinationPhoneOmitted === true;
  } catch {
    return false;
  }
}

export function restoreBookingDraft(value: string | null, fallback: FarmerBookingDraft): FarmerBookingDraft {
  if (!value) return fallback;
  try {
    const source = JSON.parse(value) as Partial<FarmerBookingDraft>;
    if (source.bookingTarget !== "MYSELF" && source.bookingTarget !== "SOMEONE_ELSE") return fallback;
    const restored = { ...fallback } as Record<string, unknown>;
    for (const key of Object.keys(fallback) as (keyof FarmerBookingDraft)[]) {
      // Older drafts may still hold a phone; it is never restored from storage.
      if (unsavedDraftFields.has(key)) continue;
      const candidate = source[key];
      if (typeof fallback[key] === "boolean") {
        if (typeof candidate === "boolean") restored[key] = candidate;
      } else if (typeof candidate === "string") {
        restored[key] = candidate;
      }
    }
    // A newly selected result always wins over an older resumed selection.
    for (const key of ["tractorId", "serviceOfferingId", "serviceId", "equipmentTypeId", "pricingMethod", "pricingRuleId", "start", "end", "state", "district", "mandalOrTaluk", "village", "latitude", "longitude"] as const) {
      if (fallback[key]) restored[key] = fallback[key];
    }
    return Object.freeze(restored) as unknown as FarmerBookingDraft;
  } catch {
    return fallback;
  }
}

export function bookingStepErrors(step: BookingStep, draft: FarmerBookingDraft): readonly string[] {
  const missing = (value: string) => value.trim().length === 0;
  if (step === "target" && draft.bookingTarget === "SOMEONE_ELSE") {
    if (missing(draft.recipientName)) return ["Recipient name is required."];
    if (draft.coordinationPhone && !draft.coordinationConsent) return ["Consent is required to store the coordination phone."];
    if (draft.coordinationPhone && !/^\+?[0-9][0-9\s-]{8,14}$/u.test(draft.coordinationPhone)) return ["Enter a valid coordination phone."];
  }
  if (step === "location") {
    if ([draft.state, draft.district, draft.mandalOrTaluk, draft.village, draft.latitude, draft.longitude].some(missing)) {
      return ["Enter the complete service location and coordinates."];
    }
    const latitude = Number(draft.latitude);
    const longitude = Number(draft.longitude);
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      return ["Enter valid latitude and longitude values."];
    }
  }
  if (step === "work" && (missing(draft.serviceId) || missing(draft.tractorId) || missing(draft.serviceOfferingId))) {
    return ["Choose farming work and a tractor near this service location."];
  }
  if (step === "schedule") {
    const start = new Date(draft.start);
    const end = new Date(draft.end);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start >= end) return ["Choose a valid start and end time."];
  }
  if (step === "pricing") {
    const quantity = Number(draft.expectedQuantity);
    if (!draft.pricingMethod || missing(draft.pricingRuleId) || !Number.isFinite(quantity) || quantity <= 0) {
      return ["Choose a pricing method and enter a positive estimated quantity."];
    }
  }
  return [];
}

/** Builds discovery criteria exclusively from the draft's service location. For someone-else bookings this is the Recipient location. */
export function bookingDiscoveryParameters(draft: FarmerBookingDraft): URLSearchParams {
  const parameters = new URLSearchParams({
    search: "1",
    target: draft.bookingTarget,
    state: draft.state,
    district: draft.district,
    mandalOrTaluk: draft.mandalOrTaluk,
    village: draft.village,
    latitude: draft.latitude,
    longitude: draft.longitude,
    serviceId: draft.serviceId,
    start: draft.start,
    end: draft.end,
    radius: "5",
  });
  if (draft.equipmentTypeId) parameters.set("equipmentTypeId", draft.equipmentTypeId);
  if (draft.pricingMethod) parameters.set("pricingMethod", draft.pricingMethod);
  return parameters;
}

/**
 * Builds the create-booking command. `capturedAt` is fixed per attempt so an explicit retry with the
 * same idempotency key sends the same command; a changed command under that key is refused.
 */
export function bookingRequestBody(draft: FarmerBookingDraft, capturedAt: string = new Date().toISOString()): Readonly<Record<string, unknown>> {
  const recipient = draft.bookingTarget === "SOMEONE_ELSE" ? {
    name: draft.recipientName.trim(),
    ...(draft.coordinationPhone.trim() ? { coordinationPhone: draft.coordinationPhone.trim(), coordinationConsent: draft.coordinationConsent } : {}),
    ...(draft.landmarkOrDirections.trim() ? { landmarkOrDirections: draft.landmarkOrDirections.trim() } : {}),
  } : undefined;
  return Object.freeze({
    bookingTarget: draft.bookingTarget,
    tractorId: draft.tractorId,
    serviceOfferingId: draft.serviceOfferingId,
    pricingRuleId: draft.pricingRuleId,
    pricingMethod: draft.pricingMethod,
    expectedQuantity: draft.expectedQuantity,
    requestedInterval: { start: new Date(draft.start).toISOString(), end: new Date(draft.end).toISOString() },
    serviceLocation: {
      state: draft.state.trim(), district: draft.district.trim(), mandalOrTaluk: draft.mandalOrTaluk.trim(), village: draft.village.trim(),
      ...(draft.landmark.trim() ? { landmark: draft.landmark.trim() } : {}),
      source: "MANUAL_ADDRESS", latitude: Number(draft.latitude), longitude: Number(draft.longitude),
      capturedAt, collectionPurpose: "SERVICE_LOCATION",
    },
    ...(recipient ? { recipient } : {}),
  });
}
