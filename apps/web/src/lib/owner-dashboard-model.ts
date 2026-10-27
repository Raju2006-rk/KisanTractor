import type { TractorAvailabilityProjection } from "@kisantractor/domain";

export const ownerDashboardBookingStatuses = [
  "CREATED", "PENDING_OWNER_RESPONSE", "ACCEPTED", "SCHEDULED", "IN_PROGRESS",
  "WORK_COMPLETED", "FINAL_BILL_GENERATED", "PAYMENT_RECORDED", "COMPLETED",
  "REJECTED", "CANCELLED", "EXPIRED", "DISPUTED", "REFUND_PENDING", "REFUNDED",
] as const;

export type OwnerDashboardBookingStatus = (typeof ownerDashboardBookingStatuses)[number];

export interface OwnerDashboardBooking {
  readonly id: string;
  readonly status: OwnerDashboardBookingStatus;
}

export interface OwnerDashboardSummary {
  readonly totalTractors: number;
  readonly equipmentCount: number;
  readonly pendingRequests?: number;
  readonly acceptedJobs?: number;
  readonly activeJobs?: number;
  readonly completedJobs?: number;
  readonly recordedEarningsPaise?: number;
}

export interface OwnerDashboardAvailability extends Omit<TractorAvailabilityProjection, "effectiveAt"> {
  readonly effectiveAt: Date;
  readonly tractorName: string;
  readonly registrationNumber: string;
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;

const safeText = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

/** Allowlists only fields needed for non-financial Owner dashboard counts. */
export function normalizeOwnerDashboardBooking(value: unknown): OwnerDashboardBooking | undefined {
  const source = record(value);
  const id = safeText(source?.id);
  const status = safeText(source?.status);
  if (!id || !status || !ownerDashboardBookingStatuses.includes(status as OwnerDashboardBookingStatus)) {
    return undefined;
  }

  return Object.freeze({ id, status: status as OwnerDashboardBookingStatus });
}

export function summarizeOwnerDashboardBookings(
  totalTractors: number,
  equipmentCount: number,
  bookings: readonly OwnerDashboardBooking[] | undefined,
  authoritativeEarningsPaise?: number,
): OwnerDashboardSummary {
  if (bookings === undefined) return Object.freeze({ totalTractors, equipmentCount,
    ...(authoritativeEarningsPaise === undefined ? {} : { recordedEarningsPaise: authoritativeEarningsPaise }) });

  return Object.freeze({
    totalTractors,
    equipmentCount,
    pendingRequests: bookings.filter((booking) =>
      booking.status === "CREATED" || booking.status === "PENDING_OWNER_RESPONSE").length,
    acceptedJobs: bookings.filter((booking) => booking.status === "ACCEPTED" || booking.status === "SCHEDULED").length,
    activeJobs: bookings.filter((booking) => booking.status === "IN_PROGRESS").length,
    completedJobs: bookings.filter((booking) => booking.status === "COMPLETED").length,
    ...(authoritativeEarningsPaise === undefined ? {} : { recordedEarningsPaise: authoritativeEarningsPaise }),
  });
}
