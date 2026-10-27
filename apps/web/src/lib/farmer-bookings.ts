import type { PricingMethod } from "@kisantractor/domain";
import { cookies } from "next/headers";

import type { SettlementStatusView } from "./payments";
import { accessCookieName, runtimeConfig } from "./server-context";

export const farmerBookingStatuses = [
  "CREATED", "PENDING_OWNER_RESPONSE", "ACCEPTED", "SCHEDULED", "IN_PROGRESS",
  "WORK_COMPLETED", "FINAL_BILL_GENERATED", "PAYMENT_RECORDED", "COMPLETED",
  "REJECTED", "CANCELLED", "EXPIRED", "DISPUTED", "REFUND_PENDING", "REFUNDED",
] as const;
export type FarmerBookingStatus = (typeof farmerBookingStatuses)[number];
/** Settlement states shown to the Farmer, including cash-and-online and zero-total bills. */
export const farmerPaymentStatuses = [
  "PENDING", "AWAITING_FINAL_BILL", "PAYMENT_DUE", "PAID_ONLINE", "PAID_CASH",
  "PAYMENT_FAILED", "REFUND_PENDING", "REFUNDED", "PAID_MIXED", "NOTHING_DUE",
] as const satisfies readonly SettlementStatusView[];
export type FarmerPaymentStatus = (typeof farmerPaymentStatuses)[number];

export interface FarmerBookingProjection {
  readonly id: string;
  readonly publicReference: string;
  readonly status: FarmerBookingStatus;
  readonly tractor: Readonly<{ brand: string; model: string }>;
  readonly owner: Readonly<{ displayName: string; contactPhone?: string }>;
  readonly serviceName: string;
  readonly requestedInterval: Readonly<{ start: Date; end: Date }>;
  readonly serviceLocation: Readonly<{ state: string; district: string; village: string; landmark?: string }>;
  readonly recipient?: Readonly<{ name: string }>;
  readonly quote: Readonly<{ method: PricingMethod; ratePaise: number; estimatedTotalPaise: number }>;
  readonly invoice?: Readonly<{ totalPaise: number; status: string; formula?: string; evidenceSummary?: string }>;
  readonly payment?: Readonly<{ status: FarmerPaymentStatus; amountPaise?: number; method?: "CASH" | "ONLINE"; recordedAt?: Date }>;
  readonly dispute?: Readonly<{ status: string; note?: string }>;
  readonly updatedAt: Date;
}

export type FarmerBookingsLoadResult =
  | Readonly<{ state: "READY"; items: readonly FarmerBookingProjection[] }>
  | Readonly<{ state: "ERROR"; message: string }>;
export type FarmerBookingDetailLoadResult =
  | Readonly<{ state: "READY"; booking: FarmerBookingProjection }>
  | Readonly<{ state: "NOT_FOUND" }>
  | Readonly<{ state: "ERROR"; message: string }>;

const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === "object" ? value as Record<string, unknown> : undefined;
const safeText = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value.trim() : undefined;
const safeMoney = (value: unknown): number | undefined => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const safeDate = (value: unknown): Date | undefined => {
  const date = new Date(String(value ?? ""));
  return Number.isNaN(date.getTime()) ? undefined : date;
};

/** Allowlists Farmer-visible fields and reveals Owner contact only after an explicit server policy grant. */
export function normalizeFarmerBooking(value: unknown): FarmerBookingProjection | undefined {
  const source = record(value);
  const tractor = record(source?.tractor);
  const owner = record(source?.owner);
  const interval = record(source?.requestedInterval);
  const location = record(source?.serviceLocation ?? source?.serviceLocationSnapshot);
  const quote = record(source?.quote ?? source?.quoteSnapshot);
  if (!source || !tractor || !owner || !interval || !location || !quote) return undefined;

  const id = safeText(source.id);
  const publicReference = safeText(source.publicReference);
  const status = safeText(source.status);
  const brand = safeText(tractor.brand);
  const model = safeText(tractor.model);
  const ownerName = safeText(owner.displayName);
  const serviceName = safeText(source.serviceName);
  const start = safeDate(interval.start);
  const end = safeDate(interval.end);
  const state = safeText(location.state);
  const district = safeText(location.district);
  const village = safeText(location.village);
  const method = safeText(quote.method);
  const ratePaise = safeMoney(quote.ratePaise ?? quote.rateMinorUnits);
  const estimatedTotalPaise = safeMoney(quote.estimatedTotalPaise ?? quote.estimatedTotalMinorUnits);
  const updatedAt = safeDate(source.updatedAt ?? source.createdAt);
  if (!id || !publicReference || !status || !farmerBookingStatuses.includes(status as FarmerBookingStatus) ||
      !brand || !model || !ownerName || !serviceName || !start || !end || start >= end || !state || !district || !village ||
      !method || !["HOURLY", "PER_ACRE", "PER_TRIP"].includes(method) || ratePaise === undefined ||
      estimatedTotalPaise === undefined || !updatedAt) return undefined;

  const ownerContact = record(source.ownerContact);
  const contactPhone = ownerContact?.sharingPermitted === true ? safeText(ownerContact.phone) : undefined;
  const recipientSource = record(source.recipient);
  const recipientName = safeText(recipientSource?.name);
  const landmark = safeText(location.landmark);
  const invoiceSource = record(source.invoice);
  const invoiceTotal = safeMoney(invoiceSource?.totalPaise ?? invoiceSource?.totalMinorUnits);
  const invoiceStatus = safeText(invoiceSource?.status);
  const paymentSource = record(source.payment);
  const paymentStatus = safeText(paymentSource?.status);
  const paymentAmount = safeMoney(paymentSource?.amountPaise ?? paymentSource?.amountMinorUnits);
  const paymentMethod = safeText(paymentSource?.method);
  const paymentRecordedAt = safeDate(paymentSource?.recordedAt ?? paymentSource?.createdAt);
  const disputeSource = record(source.dispute);
  const disputeStatus = safeText(disputeSource?.status);
  const invoiceFormula = safeText(invoiceSource?.formula);
  const invoiceEvidenceSummary = safeText(invoiceSource?.evidenceSummary);
  const disputeNote = safeText(disputeSource?.note);

  return Object.freeze({
    id, publicReference, status: status as FarmerBookingStatus,
    tractor: Object.freeze({ brand, model }),
    owner: Object.freeze({ displayName: ownerName, ...(contactPhone ? { contactPhone } : {}) }),
    serviceName,
    requestedInterval: Object.freeze({ start, end }),
    serviceLocation: Object.freeze({ state, district, village, ...(landmark ? { landmark } : {}) }),
    ...(recipientName ? { recipient: Object.freeze({ name: recipientName }) } : {}),
    quote: Object.freeze({ method: method as PricingMethod, ratePaise, estimatedTotalPaise }),
    ...(invoiceTotal !== undefined && invoiceStatus ? { invoice: Object.freeze({
      totalPaise: invoiceTotal, status: invoiceStatus,
      ...(invoiceFormula ? { formula: invoiceFormula } : {}),
      ...(invoiceEvidenceSummary ? { evidenceSummary: invoiceEvidenceSummary } : {}),
    }) } : {}),
    ...(paymentStatus && (farmerPaymentStatuses as readonly string[]).includes(paymentStatus) ? {
      payment: Object.freeze({ status: paymentStatus as FarmerPaymentStatus, ...(paymentAmount !== undefined ? { amountPaise: paymentAmount } : {}), ...((paymentMethod === "CASH" || paymentMethod === "ONLINE") ? { method: paymentMethod } : {}), ...(paymentRecordedAt ? { recordedAt: paymentRecordedAt } : {}) }),
    } : {}),
    ...(disputeStatus ? { dispute: Object.freeze({ status: disputeStatus, ...(disputeNote ? { note: disputeNote } : {}) }) } : {}),
    updatedAt,
  });
}

async function accessCredential(): Promise<string | undefined> {
  return (await cookies()).get(accessCookieName)?.value;
}

export async function loadFarmerBookings(): Promise<FarmerBookingsLoadResult> {
  try {
    const credential = await accessCredential();
    if (!credential) return { state: "ERROR", message: "Your session has expired. Log in and try again." };
    const response = await fetch(`${runtimeConfig().publicApiOrigin}/farmer/bookings`, { headers: { authorization: `Bearer ${credential}`, accept: "application/json" }, cache: "no-store" });
    if (!response.ok) return { state: "ERROR", message: "Bookings are unavailable right now. Reconnect and retry safely." };
    const body = await response.json() as unknown;
    const items = Array.isArray(body) ? body : record(body)?.items;
    if (!Array.isArray(items)) return { state: "ERROR", message: "Bookings returned an invalid response. No private data was displayed." };
    return { state: "READY", items: Object.freeze(items.map(normalizeFarmerBooking).filter((item): item is FarmerBookingProjection => Boolean(item))) };
  } catch {
    return { state: "ERROR", message: "Bookings are unavailable right now. Reconnect and retry safely." };
  }
}

export async function loadFarmerBooking(bookingId: string): Promise<FarmerBookingDetailLoadResult> {
  if (!bookingId.trim()) return { state: "NOT_FOUND" };
  try {
    const credential = await accessCredential();
    if (!credential) return { state: "ERROR", message: "Your session has expired. Log in and try again." };
    const response = await fetch(`${runtimeConfig().publicApiOrigin}/farmer/bookings/${encodeURIComponent(bookingId)}`, { headers: { authorization: `Bearer ${credential}`, accept: "application/json" }, cache: "no-store" });
    if (response.status === 404) return { state: "NOT_FOUND" };
    if (!response.ok) return { state: "ERROR", message: "This booking is unavailable right now. Reconnect and retry safely." };
    const booking = normalizeFarmerBooking(await response.json());
    return booking ? { state: "READY", booking } : { state: "ERROR", message: "The booking returned an invalid response. No private data was displayed." };
  } catch {
    return { state: "ERROR", message: "This booking is unavailable right now. Reconnect and retry safely." };
  }
}
