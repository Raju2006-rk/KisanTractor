/**
 * Consent-aware Owner contact sharing (Requirements 3.4, 12.1, 12.2; Property 18).
 *
 * An Owner's phone number is revealed only to the Farmer of one of that Owner's bookings, only
 * while the Owner has consented to contact sharing, and only while the booking is in a state
 * where the two parties need to coordinate work or a bill. Public and discovery projections never
 * carry it, and neither do the Owner's own views of the Farmer.
 */

/**
 * Booking states in which the parties coordinate: accepted or scheduled work, work in progress,
 * an open bill, or a dispute. Requests not yet accepted and closed bookings share nothing.
 */
export const ownerContactSharingStatuses: readonly string[] = Object.freeze([
  "ACCEPTED",
  "SCHEDULED",
  "IN_PROGRESS",
  "WORK_COMPLETED",
  "FINAL_BILL_GENERATED",
  "PAYMENT_RECORDED",
  "DISPUTED",
  "REFUND_PENDING",
]);

export interface OwnerContactSharingCandidate {
  /** Who reads the booking. Only the booking's Farmer may receive the Owner's contact. */
  readonly viewerRole: "FARMER" | "OWNER" | "PUBLIC";
  readonly ownerConsented: boolean;
  readonly bookingStatus: string | undefined;
  /** False until contact sharing is launched (Requirement 1.4 gates it behind readiness). */
  readonly sharingEnabled: boolean;
}

/** True when the Owner's phone may be shown to, or sent to, the booking's Farmer right now. */
export function canShareOwnerContact(candidate: OwnerContactSharingCandidate): boolean {
  return candidate.sharingEnabled
    && candidate.viewerRole === "FARMER"
    && candidate.ownerConsented
    && candidate.bookingStatus !== undefined
    && ownerContactSharingStatuses.includes(candidate.bookingStatus);
}

/** E.164 Indian mobile, the only shape a shared contact may take. */
export const SHAREABLE_PHONE_PATTERN = /^\+91[6-9]\d{9}$/u;
