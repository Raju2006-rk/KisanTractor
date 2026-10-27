import type {
  HourlyRoundingPolicy,
  InvoiceSettlement,
  NormalizedLocation,
  PaymentMethod,
  PaymentRecordSource,
  PricingMethod,
} from "@kisantractor/domain";

import type { InvoiceStatus } from "../job/job.contracts.js";
import type { PaymentInvoiceRecord } from "../payment/payment.contracts.js";
import type { BookingRequestContext, BookingStatus, BookingTarget } from "./booking.contracts.js";

/** The party reading a booking. Each party only ever sees bookings it is part of. */
export type BookingViewerRole = "FARMER" | "OWNER";

/** Who caused a status change, without exposing account identifiers to the other party. */
export type BookingHistoryActor = "FARMER" | "OWNER" | "SYSTEM" | "OTHER";

/** The agreed quote of the booking's current agreement version, read back from storage. */
export interface BookingQuoteSnapshotView {
  readonly agreementVersion: number;
  readonly pricingRuleId: string;
  readonly pricingRuleVersion: number;
  readonly method: PricingMethod;
  readonly ratePaise: number;
  readonly currency: "INR";
  readonly roundingPolicy?: HourlyRoundingPolicy;
  readonly estimatedQuantity: string;
  readonly estimatedTotalPaise: number;
  readonly disclosedAt: Date;
}

export interface BookingInvoiceSummary {
  readonly id: string;
  readonly invoiceVersion: number;
  readonly status: InvoiceStatus;
  readonly totalPaise: number;
  readonly currency: "INR";
  readonly formula: string;
}

/** Settlement state derived with the same rules as the payment settlement view. */
export interface BookingPaymentSummary {
  readonly status: InvoiceSettlement["status"];
  readonly totalPaise: number;
  readonly amountPaise: number;
  readonly outstandingPaise: number;
  readonly settled: boolean;
  readonly settlementBlocked: boolean;
  readonly methods: readonly PaymentMethod[];
  /** Present when every applied payment used one method. */
  readonly method?: PaymentMethod;
  /** When the latest payment record was created. */
  readonly recordedAt?: Date;
}

export interface BookingStatusHistoryEntry {
  readonly fromStatus?: BookingStatus;
  readonly toStatus: BookingStatus;
  readonly actor: BookingHistoryActor;
  readonly actorChannel: string;
  readonly reason?: string;
  readonly occurredAt: Date;
}

/** Fields that are identical for both parties of one booking (Requirement 1.2). */
export interface SharedBookingView {
  readonly id: string;
  readonly publicReference: string;
  readonly status: BookingStatus;
  readonly version: number;
  readonly bookingTarget: BookingTarget;
  readonly requestedInterval: Readonly<{ start: Date; end: Date }>;
  readonly serviceLocation: NormalizedLocation;
  readonly tractor: Readonly<{ id: string; brand: string; model: string }>;
  readonly serviceName: string;
  readonly equipmentName?: string;
  readonly recipient?: Readonly<{ name: string; landmarkOrDirections?: string }>;
  readonly quoteSnapshot: BookingQuoteSnapshotView;
  readonly invoice?: BookingInvoiceSummary;
  /** Detail reads only; list reads omit it to stay bounded. */
  readonly payment?: BookingPaymentSummary;
  /** Detail reads only. */
  readonly statusHistory?: readonly BookingStatusHistoryEntry[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** The booking Farmer's view. Owner contact details appear only under an explicit sharing grant. */
export interface FarmerBookingView extends SharedBookingView {
  readonly viewerRole: "FARMER";
  readonly owner: Readonly<{ displayName: string }>;
  /** Phase 1 never returns the Owner's phone; consent-aware sharing arrives with messaging (Phase 2). */
  readonly ownerContact: Readonly<{ sharingPermitted: boolean }>;
}

/** The assigned Owner's view. */
export interface OwnerBookingView extends SharedBookingView {
  readonly viewerRole: "OWNER";
  readonly customer: Readonly<{ displayName: string }>;
}

export type BookingPartyView = FarmerBookingView | OwnerBookingView;

export interface BookingPartyViewPage {
  readonly items: readonly BookingPartyView[];
  readonly nextCursor?: string;
}

export interface BookingListPosition {
  /**
   * The stored created_at as ISO-8601 with microseconds. A JavaScript Date keeps only
   * milliseconds, and a millisecond boundary would skip bookings committed in the same
   * millisecond as the last row of a page.
   */
  readonly createdAt: string;
  readonly id: string;
}

export interface BookingViewQuery {
  readonly viewerId: string;
  readonly viewerRole: BookingViewerRole;
}

/** One booking row as stored, before party-specific redaction. */
export interface BookingViewSource {
  readonly id: string;
  readonly publicReference: string;
  readonly customerId: string;
  readonly ownerId: string;
  readonly status: BookingStatus;
  readonly version: number;
  readonly hasRecipient: boolean;
  readonly requestedInterval: Readonly<{ start: Date; end: Date }>;
  readonly serviceLocation: NormalizedLocation;
  readonly tractor: Readonly<{ id: string; brand: string; model: string }>;
  readonly serviceName: string;
  readonly equipmentName?: string;
  readonly customerName?: string;
  readonly ownerName?: string;
  readonly ownerContactSharingConsent: boolean;
  readonly recipient?: Readonly<{ name: string; landmarkOrDirections?: string }>;
  readonly quoteSnapshot: BookingQuoteSnapshotView;
  readonly invoice?: PaymentInvoiceRecord & Readonly<{ formula: string }>;
  readonly createdAt: Date;
  /** Exact created_at (microseconds) for keyset cursors; see BookingListPosition. */
  readonly cursorCreatedAt?: string;
  readonly updatedAt: Date;
}

export interface BookingHistorySource {
  readonly fromStatus?: BookingStatus;
  readonly toStatus: BookingStatus;
  readonly actorId?: string;
  readonly actorChannel: string;
  readonly reason?: string;
  readonly occurredAt: Date;
}

export interface BookingDetailSource {
  readonly booking: BookingViewSource;
  /** Payment records on the current invoice. */
  readonly payments: readonly PaymentRecordSource[];
  readonly history: readonly BookingHistorySource[];
}

export interface BookingQueryStore {
  /** Returns the booking only when the viewer is its Farmer (FARMER) or assigned Owner (OWNER). */
  loadBookingDetail(
    query: BookingViewQuery & Readonly<{ bookingId: string }>,
    context: BookingRequestContext,
  ): Promise<BookingDetailSource | undefined>;
  /** Newest first, keyset-paginated, and limited to the viewer's own bookings. */
  listBookings(
    query: BookingViewQuery & Readonly<{ limit: number; after?: BookingListPosition }>,
    context: BookingRequestContext,
  ): Promise<readonly BookingViewSource[]>;
}
