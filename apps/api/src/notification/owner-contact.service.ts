import type { AuditActorChannel, AuditEventInput } from "@kisantractor/database";
import type { AuthPrincipal } from "@kisantractor/domain";
import { canShareOwnerContact, SHAREABLE_PHONE_PATTERN } from "@kisantractor/domain";

import type { OwnerContactDirectory } from "./messaging-directory.js";
import type { NotificationStore } from "./notification.contracts.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** Missing, malformed, and other people's bookings are indistinguishable (404). */
export class OwnerContactNotFoundError extends Error {
  readonly code = "NOT_FOUND";

  constructor() {
    super("Booking not found");
    this.name = "OwnerContactNotFoundError";
  }
}

/** Why the Owner's number is not shown; stable codes for the client. */
export type OwnerContactWithheldReason =
  | "SHARING_NOT_ENABLED"
  | "OWNER_NOT_CONSENTED"
  | "BOOKING_STATE"
  | "CONTACT_UNAVAILABLE";

export type OwnerContactView =
  | Readonly<{ shared: true; phone: string }>
  | Readonly<{ shared: false; reason: OwnerContactWithheldReason }>;

export interface OwnerContactRequestContext {
  readonly correlationId: string;
  readonly actorChannel: AuditActorChannel;
}

export type OwnerContactAuditWriter = (event: AuditEventInput) => Promise<unknown>;

export interface OwnerContactServiceOptions {
  /** ENABLE_OWNER_CONTACT_SHARING: the Phase 2 launch switch (Requirement 1.4). */
  readonly enabled: boolean;
  readonly bookings: Pick<NotificationStore, "loadBookingContext">;
  readonly directory: OwnerContactDirectory;
  /** Appends the PII-safe audit record of each reveal (Requirement 2.7). */
  readonly audit: OwnerContactAuditWriter;
}

/**
 * Consent-aware Owner contact sharing (Requirements 3.4, 12.1, 12.2). The server decides, on every
 * read, whether the booking's Farmer may see the Owner's number: the launch switch is on, the
 * Owner consents now, and the booking is in a coordinating state (`canShareOwnerContact`). Only
 * the booking's own Farmer can ask; anyone else gets the same 404 as a missing booking. The number
 * is decrypted only for a permitted reveal, never cached, logged, or written to telemetry, and the
 * audit record of the reveal carries identifiers only.
 */
export class OwnerContactService {
  constructor(private readonly options: OwnerContactServiceOptions) {}

  async farmerView(
    principal: AuthPrincipal,
    bookingId: string,
    context: OwnerContactRequestContext,
  ): Promise<OwnerContactView> {
    if (!principal.roles.includes("FARMER") || !UUID.test(bookingId)) throw new OwnerContactNotFoundError();
    const booking = await this.options.bookings.loadBookingContext(bookingId);
    if (booking === undefined || booking.customerId !== principal.userId) throw new OwnerContactNotFoundError();

    const withheld = (reason: OwnerContactWithheldReason): OwnerContactView => Object.freeze({ shared: false, reason });
    if (!this.options.enabled) return withheld("SHARING_NOT_ENABLED");
    if (booking.ownerContactSharingConsent !== true) return withheld("OWNER_NOT_CONSENTED");
    if (!canShareOwnerContact({
      viewerRole: "FARMER",
      ownerConsented: true,
      bookingStatus: booking.status,
      sharingEnabled: true,
    })) return withheld("BOOKING_STATE");

    const phone = await this.options.directory.ownerPhone(booking.ownerId);
    if (phone === undefined || !SHAREABLE_PHONE_PATTERN.test(phone)) return withheld("CONTACT_UNAVAILABLE");
    await this.options.audit({
      actorId: principal.userId,
      actorChannel: context.actorChannel,
      action: "booking.owner_contact.revealed",
      resourceType: "Booking",
      resourceId: booking.bookingId,
      outcome: "SUCCESS",
      correlationId: context.correlationId,
      metadata: { bookingStatus: booking.status ?? "UNKNOWN" },
    });
    return Object.freeze({ shared: true, phone });
  }
}
