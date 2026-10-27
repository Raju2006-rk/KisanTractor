import type {
  AuthPrincipal,
  InvoiceRecordStatus,
  InvoiceSettlement,
  PaymentActorRole,
  PaymentMethod,
  PaymentReceipt,
  PaymentRecordProjection,
  PaymentRecordSource,
  PaymentRecordStatus,
  PaymentRefundStatus,
  PaymentViewerRole,
  ProviderEventRejectionCode,
  ProviderPaymentEventKind,
  VerifiedProviderEventEvidence,
} from "@kisantractor/domain";
import type { AuditActorChannel } from "@kisantractor/database";
import type { CapabilityState, OnlinePaymentCheckout } from "@kisantractor/providers";

import type { BookingStatus } from "../booking/booking.contracts.js";

export interface PaymentRequestContext {
  readonly correlationId: string;
  readonly actorChannel: AuditActorChannel;
}

export interface PaymentBookingRecord {
  readonly id: string;
  readonly reference: string;
  readonly customerId: string;
  readonly ownerId: string;
  readonly status: BookingStatus;
  readonly version: number;
}

export interface PaymentInvoiceRecord {
  readonly id: string;
  readonly bookingId: string;
  readonly invoiceVersion: number;
  readonly status: InvoiceRecordStatus;
  readonly totalPaise: number;
  readonly currency: string;
}

/** Everything a viewer needs to see a booking's settlement; authorization happens before projection. */
export interface BookingPaymentsSource {
  readonly booking: PaymentBookingRecord;
  /** The current (highest-version) invoice, when the booking has been billed. */
  readonly invoice?: PaymentInvoiceRecord;
  readonly payments: readonly PaymentRecordSource[];
}

export interface PaymentReceiptRecordSource {
  readonly booking: PaymentBookingRecord;
  readonly invoice: PaymentInvoiceRecord;
  /** True when a later invoice version replaced the invoice this payment was applied to. */
  readonly invoiceSuperseded: boolean;
  readonly payment: PaymentRecordSource;
  /** All payments on the payment's invoice, used to derive settlement. */
  readonly invoicePayments: readonly PaymentRecordSource[];
}

/**
 * Whether online payment can be started now, read from the capability registry at request time.
 * `testMode` is true whenever online payments in this environment run against a provider sandbox,
 * so every online record and receipt can be labelled as test money (Requirement 14.3).
 */
export interface OnlinePaymentAvailability {
  readonly state: CapabilityState;
  readonly statusLabel: string;
  readonly available: boolean;
  readonly testMode: boolean;
  readonly canRetry: boolean;
}

/** Party-safe settlement view returned to the booking Farmer or the assigned Owner. */
export interface BookingSettlementProjection {
  readonly bookingId: string;
  readonly bookingReference: string;
  readonly bookingStatus: BookingStatus;
  readonly invoiceId?: string;
  readonly invoiceVersion?: number;
  readonly currency: "INR";
  readonly settlement: InvoiceSettlement;
  readonly payments: readonly PaymentRecordProjection[];
  /** Present on settlement reads; never stored with idempotent command results. */
  readonly onlinePayment?: OnlinePaymentAvailability;
}

/**
 * Validated input for adding a payment record to the current invoice. Command layers
 * (cash recording, online intents) validate and authorize the request before calling this.
 */
export interface ValidatedPaymentApplication {
  readonly bookingId: string;
  readonly invoiceId: string;
  readonly method: PaymentMethod;
  readonly amountPaise: number;
  readonly currency: "INR";
  readonly actorId: string;
  readonly actorRole: PaymentActorRole;
  /** Cash only: when the recorder confirmed receipt. */
  readonly receivedAt?: Date;
  /** Online only: the configured provider and its intent reference. */
  readonly provider?: string;
  readonly providerReference?: string;
  /** Online only: whether the provider ran in sandbox or live mode for this intent. */
  readonly providerMode?: "SANDBOX" | "LIVE";
  readonly idempotencyKey: string;
  readonly requestDigest: string;
  readonly occurredAt: Date;
}

/** The assigned Owner's confirmation that cash for the current final bill was received. */
export interface RecordCashCommand {
  readonly bookingId: string;
  readonly invoiceId: string;
  /** Integer paise received; must fit within the bill's remaining payable amount. */
  readonly amountPaise: number;
  /** When the cash was received. Defaults to the server time; never in the future. */
  readonly receivedAt?: Date;
  /** Stable key reused for an explicit retry, so a retried confirmation records cash once. */
  readonly idempotencyKey: string;
}

/** The provider intent an online payment record is linked to. Server-side only. */
export interface OnlineIntentReference {
  readonly provider: string;
  readonly providerReference: string;
}

export interface PaymentApplicationResult {
  readonly payment: PaymentRecordProjection;
  readonly settlement: BookingSettlementProjection;
  /** Online intents only; lets an idempotent retry reopen the same provider checkout. */
  readonly onlineIntent?: OnlineIntentReference;
}

/** The booking Farmer's request to pay the current final bill online. */
export interface CreateOnlineIntentCommand {
  readonly bookingId: string;
  readonly invoiceId: string;
  /** Integer paise to pay; must fit within the bill's remaining payable amount. */
  readonly amountPaise: number;
  /** Stable key reused for an explicit retry, so a retry reopens the same intent. */
  readonly idempotencyKey: string;
}

export interface OnlinePaymentIntentResult {
  readonly payment: PaymentRecordProjection;
  readonly settlement: BookingSettlementProjection;
  /** Client-safe checkout values; the payment stays pending until a verified provider event. */
  readonly checkout: OnlinePaymentCheckout;
}

/** Read-only check run before any provider call, so invalid or replayed requests never reach it. */
export type PaymentApplicationPreview =
  | Readonly<{ kind: "REPLAY"; result: PaymentApplicationResult }>
  | Readonly<{ kind: "PROCEED" }>;

/**
 * Verified provider evidence, normalized by the adapter, ready to record: a webhook whose signature
 * matched, or (`evidenceSource: "PROVIDER_API"`) a status the server read from the provider's
 * authenticated API.
 */
export interface VerifiedProviderEventRecord {
  readonly provider: string;
  readonly providerEventId: string;
  /** The provider's own event name, for example `payment.captured`, or `api.*` for API reads. */
  readonly eventType: string;
  readonly kind: ProviderPaymentEventKind;
  readonly providerReference?: string;
  readonly providerPaymentId?: string;
  readonly providerRefundId?: string;
  /** The platform's refund key the provider echoes back (its refund receipt). */
  readonly refundKey?: string;
  /** API evidence about a known refund request names it directly. */
  readonly paymentRefundId?: string;
  readonly amountPaise?: number;
  readonly currency?: string;
  readonly occurredAt?: Date;
  readonly payloadDigest: string;
  readonly receivedAt: Date;
  /** Defaults to WEBHOOK. */
  readonly evidenceSource?: ProviderEvidenceSource;
}

export type ProviderEvidenceSource = "WEBHOOK" | "PROVIDER_API";

export type ProviderEventDisposition = "APPLIED" | "RECORDED" | "REJECTED" | "DUPLICATE";

export interface ProviderEventOutcome {
  readonly disposition: ProviderEventDisposition;
  readonly rejectionCode?: ProviderEventRejectionCode;
  /** A duplicate found by body digest under a different event id: a replay, not a provider retry. */
  readonly replayedUnderNewEventId?: boolean;
  readonly paymentId?: string;
  readonly paymentStatus?: PaymentRecordStatus;
  /** Refund events: the refund request the event resolved to and its status afterwards. */
  readonly refundId?: string;
  readonly refundStatus?: PaymentRefundStatus;
}

/** What a browser return from checkout may learn: the authoritative state, never the redirect's claim. */
export type OnlinePaymentConfirmation =
  | "AWAITING_PROVIDER_CONFIRMATION"
  | "CONFIRMED"
  | "NOT_COMPLETED"
  | "REFUND_IN_PROGRESS"
  | "REFUNDED";

export interface OnlinePaymentStatusView {
  readonly payment: PaymentRecordProjection;
  readonly confirmation: OnlinePaymentConfirmation;
  readonly testMode: boolean;
}

/** A receipt, labelled when the online money it records moved through a provider sandbox. */
export type PaymentReceiptResponse = PaymentReceipt & { readonly testMode?: true };

export interface ValidatedPaymentTransition {
  readonly paymentId: string;
  readonly toStatus: PaymentRecordStatus;
  readonly expectedVersion: number;
  readonly actorId?: string;
  readonly actorRole: PaymentActorRole;
  readonly reason?: string;
  readonly evidence?: VerifiedProviderEventEvidence;
  readonly occurredAt: Date;
}

export interface PaymentTransitionResult {
  readonly payment: PaymentRecordProjection;
  readonly version: number;
}

export interface PaymentStore {
  /** Read-only: the booking with its current invoice and that invoice's payments. */
  loadBookingPayments(bookingId: string, context: PaymentRequestContext): Promise<BookingPaymentsSource | undefined>;
  /** Read-only: one payment with its booking, invoice, and sibling payments. */
  loadReceiptSource(paymentId: string, context: PaymentRequestContext): Promise<PaymentReceiptRecordSource | undefined>;
  /** Atomically applies a payment record to the current invoice under the invoice application rules. */
  applyPayment(input: ValidatedPaymentApplication, context: PaymentRequestContext): Promise<PaymentApplicationResult>;
  /**
   * Read-only: returns a completed idempotent result, or checks the application rules applyPayment
   * will enforce, throwing the same errors. Nothing is written.
   */
  previewPaymentApplication(input: ValidatedPaymentApplication, context: PaymentRequestContext): Promise<PaymentApplicationPreview>;
  /**
   * Records one verified provider event exactly once per (provider, event id) or body digest and,
   * when the domain allows it, applies its financial effect in the same transaction.
   */
  recordProviderEvent(input: VerifiedProviderEventRecord, context: PaymentRequestContext): Promise<ProviderEventOutcome>;
  /** Moves a payment record along a permitted transition and appends its payment event. */
  transitionPayment(input: ValidatedPaymentTransition, context: PaymentRequestContext): Promise<PaymentTransitionResult>;
}

export interface PaymentSessionAuthenticator {
  authenticateAccessCredential(accessCredential: string): Promise<AuthPrincipal>;
}

// ---- Task 16.2: online checkout, pending-intent recovery, refunds, reconciliation, history ----

/** An online intent with its provider reference and booking parties. Server-side only. */
export interface OnlineIntentRecord {
  readonly paymentId: string;
  readonly invoiceId: string;
  readonly booking: PaymentBookingRecord;
  readonly provider: string;
  readonly providerReference: string;
  readonly providerPaymentId?: string;
  readonly status: PaymentRecordStatus;
  readonly amountPaise: number;
  readonly currency: string;
  readonly createdAt: Date;
  readonly payment: PaymentRecordSource;
}

/** Client-safe values to open (or reopen) the provider checkout for a pending intent. */
export interface OnlineCheckoutView {
  readonly payment: PaymentRecordProjection;
  readonly bookingId: string;
  readonly bookingReference: string;
  readonly checkout: OnlinePaymentCheckout;
  /** The checkout must be completed before this instant; afterwards the intent awaits release. */
  readonly checkoutExpiresAt: Date;
}

export type PendingIntentReleaseReason = "EXPIRED" | "CANCELLED";

export interface ReleasePendingIntentInput {
  readonly paymentId: string;
  readonly reason: PendingIntentReleaseReason;
  /** The Farmer who cancelled, when the release was their request. */
  readonly actorId?: string;
  readonly provider: string;
  /** Digest of the provider status read that showed no successful payment. */
  readonly providerEvidenceDigest: string;
  readonly occurredAt: Date;
}

export interface ReleasePendingIntentResult {
  readonly released: boolean;
  readonly status: PaymentRecordStatus;
  readonly payment?: PaymentRecordProjection;
}

export interface ValidatedRefundRequest {
  readonly paymentId: string;
  readonly reasonCode: string;
  readonly amountPaise?: number;
  readonly actorId: string;
  readonly actorRole: "SUPPORT" | "SYSTEM";
  readonly provider: string;
  readonly idempotencyKey: string;
  readonly requestDigest: string;
  readonly occurredAt: Date;
}

/** Party- and support-safe view of one refund request. */
export interface PaymentRefundProjection {
  readonly id: string;
  readonly paymentId: string;
  readonly bookingId: string;
  readonly status: PaymentRefundStatus;
  readonly amountPaise: number;
  readonly currency: "INR";
  readonly reasonCode: string;
  readonly requestedAt: Date;
  readonly resolvedAt?: Date;
}

export interface RefundRequestResult {
  readonly refund: PaymentRefundProjection;
  readonly payment: PaymentRecordProjection;
  readonly bookingStatus: BookingStatus;
}

/** What refund submission and reconciliation need. Server-side only. */
export interface RefundSubmissionSource {
  readonly refundId: string;
  readonly paymentId: string;
  readonly bookingId: string;
  readonly provider: string;
  readonly providerPaymentId: string;
  readonly providerRefundId?: string;
  readonly refundKey: string;
  readonly amountPaise: number;
  readonly currency: string;
  readonly status: PaymentRefundStatus;
  readonly requestedAt: Date;
  readonly submitAttempts: number;
}

export interface RefundSubmissionUpdate {
  readonly refundId: string;
  /** Present when the provider accepted the refund; links it and marks it submitted. */
  readonly providerRefundId?: string;
  /** Present when the attempt failed with an unknown or retryable outcome. */
  readonly errorCode?: string;
  readonly occurredAt: Date;
}

export interface PaymentHistoryPosition {
  readonly createdAt: string;
  readonly id: string;
}

export interface PaymentHistoryQuery {
  readonly partyRole: PaymentViewerRole;
  readonly partyId: string;
  readonly after?: PaymentHistoryPosition;
  readonly limit: number;
}

export interface PaymentHistoryRow {
  readonly payment: PaymentRecordSource;
  readonly booking: PaymentBookingRecord;
  readonly invoiceVersion: number;
  readonly invoiceTotalPaise: number;
  /** Applied (successful, not refunded) paise on the payment's invoice. */
  readonly invoiceAppliedPaise: number;
  /** Exact created_at (microseconds) for the keyset cursor. */
  readonly cursorCreatedAt: string;
}

export interface PaymentHistoryItem extends PaymentRecordProjection {
  readonly bookingId: string;
  readonly bookingReference: string;
  readonly invoiceVersion: number;
  /** True once the bill is fully paid and this payment counts toward it. */
  readonly receiptAvailable: boolean;
}

export interface PaymentHistoryPage {
  readonly items: readonly PaymentHistoryItem[];
  readonly nextCursor?: string;
}

export interface PaymentHistoryStore {
  /** Party-scoped, newest first, keyset-paginated; the store always filters by the party. */
  listPaymentHistory(query: PaymentHistoryQuery, context: PaymentRequestContext): Promise<readonly PaymentHistoryRow[]>;
}

export interface PaymentRefundStore {
  /**
   * Atomically records a refund request: the refund row, the payment's move to refund-pending,
   * the booking's move from disputed to refund-pending, audit, and outbox. Idempotent per key.
   */
  requestRefund(input: ValidatedRefundRequest, context: PaymentRequestContext): Promise<RefundRequestResult>;
  loadRefundSubmission(refundId: string, context: PaymentRequestContext): Promise<RefundSubmissionSource | undefined>;
  /** Records a submission attempt (never a financial effect). */
  recordRefundSubmission(input: RefundSubmissionUpdate, context: PaymentRequestContext): Promise<void>;
}

export interface PaymentRecoveryStore {
  loadOnlineIntent(paymentId: string, context: PaymentRequestContext): Promise<OnlineIntentRecord | undefined>;
  /** Pending online intents created before the cutoff, least recently checked first. */
  listPendingIntentsForRecovery(
    input: Readonly<{ createdBefore: Date; limit: number }>, context: PaymentRequestContext,
  ): Promise<readonly OnlineIntentRecord[]>;
  markIntentChecked(paymentId: string, checkedAt: Date, context: PaymentRequestContext): Promise<void>;
  /** Closes a still-pending intent after the provider showed no successful payment for it. */
  releasePendingIntent(input: ReleasePendingIntentInput, context: PaymentRequestContext): Promise<ReleasePendingIntentResult>;
  /** Refunds still requested or submitted, least recently checked first. */
  listRefundsForReconciliation(
    input: Readonly<{ requestedBefore: Date; limit: number }>, context: PaymentRequestContext,
  ): Promise<readonly RefundSubmissionSource[]>;
  markRefundChecked(refundId: string, checkedAt: Date, context: PaymentRequestContext): Promise<void>;
  recordRefundSubmission(input: RefundSubmissionUpdate, context: PaymentRequestContext): Promise<void>;
  recordProviderEvent(input: VerifiedProviderEventRecord, context: PaymentRequestContext): Promise<ProviderEventOutcome>;
}

export type { OnlinePaymentCheckout, PaymentReceipt, PaymentViewerRole };
