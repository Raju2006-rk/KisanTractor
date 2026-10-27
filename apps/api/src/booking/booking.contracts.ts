import type {
  AuthPrincipal,
  EstimatedPricingQuantity,
  LocationInput,
  NormalizedLocation,
  PricingMethod,
  QuoteSnapshot,
} from "@kisantractor/domain";
import type { AuditActorChannel } from "@kisantractor/database";

export type BookingTarget = "MYSELF" | "SOMEONE_ELSE";
export type BookingStatus =
  | "CREATED"
  | "PENDING_OWNER_RESPONSE"
  | "ACCEPTED"
  | "SCHEDULED"
  | "IN_PROGRESS"
  | "WORK_COMPLETED"
  | "FINAL_BILL_GENERATED"
  | "PAYMENT_RECORDED"
  | "COMPLETED"
  | "REJECTED"
  | "CANCELLED"
  | "EXPIRED"
  | "DISPUTED"
  | "REFUND_PENDING"
  | "REFUNDED";

export type BookingLifecycleAction =
  | "SUBMIT"
  | "ACCEPT"
  | "REJECT"
  | "CANCEL"
  | "EXPIRE"
  | "SCHEDULE"
  | "START_WORK"
  | "COMPLETE_WORK"
  | "GENERATE_FINAL_BILL"
  | "RECORD_PAYMENT"
  | "COMPLETE"
  | "DISPUTE"
  | "REQUEST_REFUND"
  | "REFUND"
  | "RESOLVE_DISPUTE";
export type BookingLifecycleActorRole = "FARMER" | "OWNER" | "SYSTEM" | "SUPPORT";

export interface BookingLifecycleCommand {
  readonly bookingId: string;
  readonly expectedVersion: number;
  readonly reason?: string;
}

export interface ValidatedBookingTransition extends BookingLifecycleCommand {
  readonly actorId: string;
  readonly actorRole: BookingLifecycleActorRole;
  readonly action: BookingLifecycleAction;
  readonly occurredAt: Date;
}

export interface RecipientInput {
  readonly name: string;
  readonly coordinationPhone?: string;
  readonly coordinationConsent?: boolean;
  readonly landmarkOrDirections?: string;
}

export interface CreateBookingCommand {
  readonly bookingTarget: BookingTarget;
  readonly tractorId: string;
  readonly serviceOfferingId: string;
  readonly pricingRuleId: string;
  readonly pricingMethod: PricingMethod;
  readonly expectedQuantity: EstimatedPricingQuantity;
  readonly requestedInterval: Readonly<{ start: Date; end: Date }>;
  readonly serviceLocation: LocationInput;
  readonly recipient?: RecipientInput;
}

export interface BookingRequestContext {
  readonly correlationId: string;
  readonly actorChannel: AuditActorChannel;
}

export interface RecipientSnapshot {
  readonly name: string;
  readonly coordinationPhoneCiphertext?: Uint8Array;
  readonly coordinationPhoneLookupHash?: string;
  readonly coordinationConsent: boolean;
  readonly landmarkOrDirections?: string;
}

export interface BookingProjection {
  readonly id: string;
  readonly publicReference: string;
  readonly customerId: string;
  readonly ownerId: string;
  readonly tractorId: string;
  readonly serviceOfferingId: string;
  readonly status: BookingStatus;
  readonly requestedInterval: Readonly<{ start: Date; end: Date }>;
  readonly serviceLocationSnapshot: NormalizedLocation;
  readonly recipient?: Readonly<{ name: string; coordinationConsent: boolean; landmarkOrDirections?: string }>;
  readonly quoteSnapshot: QuoteSnapshot;
  readonly version: number;
  readonly createdAt: Date;
}

export interface ValidatedBookingCreation {
  readonly customerId: string;
  readonly command: Omit<CreateBookingCommand, "recipient" | "serviceLocation"> & {
    readonly serviceLocation: NormalizedLocation;
  };
  readonly recipient?: RecipientSnapshot;
  readonly idempotencyKey: string;
  readonly requestDigest: string;
  readonly disclosedAt: Date;
}

export interface AgreementChangeCommand {
  readonly bookingId: string;
  readonly expectedVersion: number;
  readonly quoteSnapshot: QuoteSnapshot;
  readonly serviceLocationSnapshot: NormalizedLocation;
  readonly reason: string;
  readonly customerApprovedAt: Date;
  readonly ownerApprovedAt: Date;
}

export interface ExpirePendingBookingsCommand {
  readonly pendingBefore: Date;
  readonly occurredAt: Date;
  readonly limit?: number;
}

export interface BookingStore {
  createBooking(
    input: ValidatedBookingCreation,
    context: BookingRequestContext,
  ): Promise<BookingProjection>;
  transitionBooking(
    input: ValidatedBookingTransition,
    context: BookingRequestContext,
  ): Promise<BookingProjection>;
  changeAgreement(
    input: AgreementChangeCommand & Readonly<{ actorId: string }>,
    context: BookingRequestContext,
  ): Promise<BookingProjection>;
  expirePendingBookings(
    input: ExpirePendingBookingsCommand,
    context: BookingRequestContext,
  ): Promise<number>;
}

export interface BookingSecrets {
  readonly fieldEncryptionKey: Uint8Array;
  readonly lookupHashKey: Uint8Array;
}

export interface BookingSessionAuthenticator {
  authenticateAccessCredential(accessCredential: string): Promise<AuthPrincipal>;
}
