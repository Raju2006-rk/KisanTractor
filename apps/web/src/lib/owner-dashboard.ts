import type { OwnerEquipmentProjection, OwnerTractorProjection, TractorAvailabilityProjection } from "@kisantractor/domain";
import { cookies } from "next/headers";

import { accessCookieName, runtimeConfig } from "./server-context";
import { normalizeOwnerEarningsReport } from "./owner-earnings";
import {
  normalizeOwnerDashboardBooking,
  summarizeOwnerDashboardBookings,
  type OwnerDashboardAvailability,
  type OwnerDashboardBooking,
  type OwnerDashboardSummary,
} from "./owner-dashboard-model";

export interface OwnerDashboardData {
  readonly availabilities: readonly OwnerDashboardAvailability[];
  readonly summary: OwnerDashboardSummary;
}

async function ownerRequest(path: string, credential: string): Promise<Response> {
  return fetch(`${runtimeConfig().publicApiOrigin}/owner/${path}`, {
    headers: { authorization: `Bearer ${credential}`, accept: "application/json" },
    cache: "no-store",
  });
}

async function responseArray(response: Response): Promise<readonly unknown[] | undefined> {
  if (!response.ok) return undefined;
  const body = await response.json() as unknown;
  if (Array.isArray(body)) return body;
  if (body !== null && typeof body === "object") {
    const items = (body as Record<string, unknown>).items;
    return Array.isArray(items) ? items : undefined;
  }
  return undefined;
}

async function loadAvailability(
  tractor: OwnerTractorProjection,
  credential: string,
): Promise<OwnerDashboardAvailability> {
  try {
    const response = await ownerRequest(`tractors/${encodeURIComponent(tractor.id)}/availability`, credential);
    if (response.ok) {
      const value = await response.json() as TractorAvailabilityProjection;
      const effectiveAt = new Date(value.effectiveAt);
      if (value.tractorId === tractor.id && !Number.isNaN(effectiveAt.getTime())) {
        return Object.freeze({
          ...value,
          effectiveAt,
          tractorName: `${tractor.brand} ${tractor.model}`,
          registrationNumber: tractor.registrationNumber,
        });
      }
    }
  } catch {
    // The Tractor list remains an authoritative fallback when the focused projection is unavailable.
  }

  return Object.freeze({
    tractorId: tractor.id,
    tractorName: `${tractor.brand} ${tractor.model}`,
    registrationNumber: tractor.registrationNumber,
    operationalStatus: tractor.operationalStatus,
    eligibilityStatus: tractor.eligibilityStatus,
    acceptingNewDemand: tractor.operationalStatus === "ONLINE" && tractor.eligibilityStatus === "ELIGIBLE",
    existingConfirmedBookingsManageable: true,
    effectiveAt: new Date(tractor.operatingLocation.capturedAt),
    version: tractor.version,
  });
}

export async function loadOwnerDashboard(): Promise<OwnerDashboardData> {
  const credential = (await cookies()).get(accessCookieName)?.value;
  if (!credential) return Object.freeze({ availabilities: Object.freeze([]), summary: summarizeOwnerDashboardBookings(0, 0, undefined) });

  try {
    const [tractorResponse, equipmentResponse, bookingResponse, earningsResponse] = await Promise.all([
      ownerRequest("tractors", credential),
      ownerRequest("equipment", credential),
      ownerRequest("bookings", credential),
      ownerRequest("reports/earnings", credential),
    ]);
    const tractorItems = await responseArray(tractorResponse) ?? [];
    const equipmentItems = await responseArray(equipmentResponse) ?? [];
    const tractors = tractorItems as readonly OwnerTractorProjection[];
    const equipment = equipmentItems as readonly OwnerEquipmentProjection[];
    const bookingItems = await responseArray(bookingResponse);
    const bookings: readonly OwnerDashboardBooking[] | undefined = bookingItems === undefined
      ? undefined
      : Object.freeze(bookingItems.map(normalizeOwnerDashboardBooking).filter((item): item is OwnerDashboardBooking => item !== undefined));
    const earnings = earningsResponse.ok ? normalizeOwnerEarningsReport(await earningsResponse.json()) : undefined;
    const availabilities = Object.freeze(await Promise.all(tractors.map((tractor) => loadAvailability(tractor, credential))));

    return Object.freeze({
      availabilities,
      summary: summarizeOwnerDashboardBookings(tractors.length, equipment.length, bookings, earnings?.totals.netEarningsPaise),
    });
  } catch {
    return Object.freeze({ availabilities: Object.freeze([]), summary: summarizeOwnerDashboardBookings(0, 0, undefined) });
  }
}
