import type {
  HourlyRoundingPolicy,
  OwnerEquipmentProjection,
  OwnerTractorProjection,
  PricingMethod,
} from "@kisantractor/domain";
import { cookies } from "next/headers";

import { accessCookieName, runtimeConfig } from "./server-context";

export const ownerBookingStatuses = [
  "CREATED", "PENDING_OWNER_RESPONSE", "ACCEPTED", "SCHEDULED", "IN_PROGRESS",
  "WORK_COMPLETED", "FINAL_BILL_GENERATED", "PAYMENT_RECORDED", "COMPLETED",
  "REJECTED", "CANCELLED", "EXPIRED", "DISPUTED", "REFUND_PENDING", "REFUNDED",
] as const;
export type OwnerBookingStatus = (typeof ownerBookingStatuses)[number];

export interface OwnerBookingProjection {
  readonly id: string;
  readonly publicReference: string;
  readonly status: OwnerBookingStatus;
  readonly version: number;
  readonly customer: Readonly<{ displayName: string }>;
  readonly recipient?: Readonly<{ name: string; landmarkOrDirections?: string }>;
  readonly tractor: Readonly<{ id: string; brand: string; model: string }>;
  readonly serviceName: string;
  readonly equipmentName?: string;
  readonly requestedInterval: Readonly<{ start: Date; end: Date }>;
  readonly serviceLocation: Readonly<{
    state: string;
    district: string;
    mandalOrTaluk?: string;
    village: string;
    landmark?: string;
  }>;
  readonly quote: Readonly<{
    pricingRuleVersion: number;
    method: PricingMethod;
    ratePaise: number;
    roundingPolicy?: HourlyRoundingPolicy;
    estimatedQuantity: string;
    estimatedTotalPaise: number;
    disclosedAt?: Date;
  }>;
  readonly paymentExpectation: string;
  readonly updatedAt: Date;
}

export type OwnerBookingsLoadResult =
  | Readonly<{ state: "READY"; items: readonly OwnerBookingProjection[] }>
  | Readonly<{ state: "ERROR"; message: string }>;
export type OwnerBookingDetailLoadResult =
  | Readonly<{ state: "READY"; booking: OwnerBookingProjection }>
  | Readonly<{ state: "NOT_FOUND" }>
  | Readonly<{ state: "ERROR"; message: string }>;

export type OwnerDocumentStatus = "PENDING_UPLOAD" | "PENDING_SCAN" | "ACCEPTED" | "REJECTED" | "EXPIRED";
export interface OwnerDocumentProjection {
  readonly id: string;
  readonly tractorId?: string;
  readonly equipmentId?: string;
  readonly documentKind: string;
  readonly fileName: string;
  readonly declaredMimeType: string;
  readonly declaredSizeBytes: number;
  readonly scanStatus: OwnerDocumentStatus;
  readonly rejectionCode?: string;
  readonly expiresAt?: Date;
  readonly version: number;
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
const safeText = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
const safeMoney = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const safePositiveInteger = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
const safeDate = (value: unknown): Date | undefined => {
  const result = new Date(String(value ?? ""));
  return Number.isNaN(result.getTime()) ? undefined : result;
};
const safeQuantity = (value: unknown): string | undefined => {
  const candidate = typeof value === "number" && Number.isFinite(value) ? String(value)
    : typeof value === "string" ? value.trim()
      : "";
  return /^(?:0|[1-9]\d{0,8})(?:\.\d{1,3})?$/u.test(candidate) ? candidate : undefined;
};

/** Allowlists the Owner booking fields needed to make an informed lifecycle decision. */
export function normalizeOwnerBooking(value: unknown): OwnerBookingProjection | undefined {
  const source = record(value);
  const customer = record(source?.customer);
  const tractor = record(source?.tractor);
  const interval = record(source?.requestedInterval);
  const location = record(source?.serviceLocation ?? source?.serviceLocationSnapshot);
  const quote = record(source?.quote ?? source?.quoteSnapshot);
  if (!source || !customer || !tractor || !interval || !location || !quote) return undefined;

  const id = safeText(source.id);
  const publicReference = safeText(source.publicReference);
  const status = safeText(source.status);
  const version = safePositiveInteger(source.version);
  const customerName = safeText(customer.displayName ?? customer.name);
  const tractorId = safeText(tractor.id ?? source.tractorId);
  const tractorBrand = safeText(tractor.brand);
  const tractorModel = safeText(tractor.model);
  const serviceName = safeText(source.serviceName ?? source.requestedWork);
  const start = safeDate(interval.start);
  const end = safeDate(interval.end);
  const state = safeText(location.state);
  const district = safeText(location.district);
  const village = safeText(location.village);
  const method = safeText(quote.method);
  const ratePaise = safeMoney(quote.ratePaise ?? quote.rateMinorUnits);
  const quantity = safeQuantity(quote.estimatedQuantity ?? source.expectedQuantity);
  const estimatedTotalPaise = safeMoney(quote.estimatedTotalPaise ?? quote.estimatedTotalMinorUnits);
  const pricingRuleVersion = safePositiveInteger(quote.pricingRuleVersion);
  const updatedAt = safeDate(source.updatedAt ?? source.createdAt);

  if (!id || !publicReference || !status || !ownerBookingStatuses.includes(status as OwnerBookingStatus) ||
      !version || !customerName || !tractorId || !tractorBrand || !tractorModel || !serviceName ||
      !start || !end || start >= end || !state || !district || !village ||
      !method || !["HOURLY", "PER_ACRE", "PER_TRIP"].includes(method) || ratePaise === undefined ||
      quantity === undefined || estimatedTotalPaise === undefined || !pricingRuleVersion || !updatedAt) return undefined;

  const roundingPolicy = safeText(quote.roundingPolicy);
  if (method === "HOURLY" && !["PROPORTIONAL_MINUTE", "THIRTY_MINUTE_BLOCK", "ONE_HOUR_BLOCK"].includes(roundingPolicy ?? "")) return undefined;
  if (method !== "HOURLY" && roundingPolicy !== undefined) return undefined;

  const recipient = record(source.recipient);
  const recipientName = safeText(recipient?.name);
  const recipientDirections = safeText(recipient?.landmarkOrDirections);
  const equipmentName = safeText(source.equipmentName ?? record(source.equipment)?.displayName);
  const mandalOrTaluk = safeText(location.mandalOrTaluk);
  const landmark = safeText(location.landmark);
  const disclosedAt = safeDate(quote.disclosedAt);
  const paymentExpectation = safeText(source.paymentExpectation) ?? "Payment after the final bill";

  return Object.freeze({
    id,
    publicReference,
    status: status as OwnerBookingStatus,
    version,
    customer: Object.freeze({ displayName: customerName }),
    ...(recipientName ? { recipient: Object.freeze({ name: recipientName, ...(recipientDirections ? { landmarkOrDirections: recipientDirections } : {}) }) } : {}),
    tractor: Object.freeze({ id: tractorId, brand: tractorBrand, model: tractorModel }),
    serviceName,
    ...(equipmentName ? { equipmentName } : {}),
    requestedInterval: Object.freeze({ start, end }),
    serviceLocation: Object.freeze({ state, district, ...(mandalOrTaluk ? { mandalOrTaluk } : {}), village, ...(landmark ? { landmark } : {}) }),
    quote: Object.freeze({
      pricingRuleVersion,
      method: method as PricingMethod,
      ratePaise,
      ...(roundingPolicy ? { roundingPolicy: roundingPolicy as HourlyRoundingPolicy } : {}),
      estimatedQuantity: quantity,
      estimatedTotalPaise,
      ...(disclosedAt ? { disclosedAt } : {}),
    }),
    paymentExpectation,
    updatedAt,
  });
}

async function ownerRequest(path: string): Promise<Response> {
  const credential = (await cookies()).get(accessCookieName)?.value;
  if (!credential) return new Response(null, { status: 401 });
  return fetch(`${runtimeConfig().publicApiOrigin}/owner/${path}`, {
    headers: { authorization: `Bearer ${credential}`, accept: "application/json" },
    cache: "no-store",
  });
}

export async function loadOwnerBookings(): Promise<OwnerBookingsLoadResult> {
  try {
    const response = await ownerRequest("bookings");
    if (!response.ok) return { state: "ERROR", message: "Booking requests are unavailable right now. Refresh and retry safely." };
    const body = await response.json() as unknown;
    const items = Array.isArray(body) ? body : record(body)?.items;
    if (!Array.isArray(items)) return { state: "ERROR", message: "Bookings returned an invalid response. No private data was displayed." };
    return { state: "READY", items: Object.freeze(items.map(normalizeOwnerBooking).filter((item): item is OwnerBookingProjection => item !== undefined)) };
  } catch {
    return { state: "ERROR", message: "Booking requests are unavailable right now. Refresh and retry safely." };
  }
}

export async function loadOwnerBooking(bookingId: string): Promise<OwnerBookingDetailLoadResult> {
  if (!bookingId.trim()) return { state: "NOT_FOUND" };
  try {
    const response = await ownerRequest(`bookings/${encodeURIComponent(bookingId)}`);
    if (response.status === 404) return { state: "NOT_FOUND" };
    if (!response.ok) return { state: "ERROR", message: "This booking is unavailable right now. Refresh and retry safely." };
    const booking = normalizeOwnerBooking(await response.json());
    return booking ? { state: "READY", booking } : { state: "ERROR", message: "The booking returned an invalid response. No private data was displayed." };
  } catch {
    return { state: "ERROR", message: "This booking is unavailable right now. Refresh and retry safely." };
  }
}

export async function loadOwnerEquipment(): Promise<readonly OwnerEquipmentProjection[]> {
  try {
    const response = await ownerRequest("equipment");
    return response.ok ? await response.json() as readonly OwnerEquipmentProjection[] : [];
  } catch {
    return [];
  }
}

export async function loadOwnerDocuments(): Promise<readonly OwnerDocumentProjection[]> {
  try {
    const response = await ownerRequest("documents");
    if (!response.ok) return [];
    const body = await response.json() as unknown;
    const items = Array.isArray(body) ? body : record(body)?.items;
    if (!Array.isArray(items)) return [];
    return Object.freeze(items.flatMap((value): OwnerDocumentProjection[] => {
      const source = record(value);
      const id = safeText(source?.id);
      const documentKind = safeText(source?.documentKind);
      const fileName = safeText(source?.fileName);
      const declaredMimeType = safeText(source?.declaredMimeType);
      const declaredSizeBytes = safeMoney(source?.declaredSizeBytes);
      const scanStatus = safeText(source?.scanStatus);
      const version = safePositiveInteger(source?.version);
      if (!id || !documentKind || !fileName || !declaredMimeType || declaredSizeBytes === undefined ||
          !scanStatus || !["PENDING_UPLOAD", "PENDING_SCAN", "ACCEPTED", "REJECTED", "EXPIRED"].includes(scanStatus) || !version) return [];
      const tractorId = safeText(source?.tractorId);
      const equipmentId = safeText(source?.equipmentId);
      const rejectionCode = safeText(source?.rejectionCode);
      const expiresAt = source?.expiresAt === undefined ? undefined : safeDate(source.expiresAt);
      return [Object.freeze({ id, ...(tractorId ? { tractorId } : {}), ...(equipmentId ? { equipmentId } : {}), documentKind, fileName, declaredMimeType, declaredSizeBytes, scanStatus: scanStatus as OwnerDocumentStatus, ...(rejectionCode ? { rejectionCode } : {}), ...(expiresAt ? { expiresAt } : {}), version })];
    }));
  } catch {
    return [];
  }
}

export interface OwnerManagementCatalog {
  readonly tractors: readonly OwnerTractorProjection[];
  readonly equipment: readonly OwnerEquipmentProjection[];
}
