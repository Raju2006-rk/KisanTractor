import type { AuditActorChannel } from "@kisantractor/database";
import type { AuthPrincipal } from "@kisantractor/domain";

import type { BookingLifecycleAction, BookingStatus } from "../booking/booking.contracts.js";

/**
 * Version of the dispute-resolution rules below. Stored on every resolved case, so a later rule
 * change never reinterprets an earlier outcome. Bump it whenever `decideResolution` changes.
 */
export const SUPPORT_RESOLUTION_RULES_VERSION = 1;

export const supportResolutionOutcomes = ["UPHOLD", "ADJUST", "REFUND", "CANCEL"] as const;
export type SupportResolutionOutcome = (typeof supportResolutionOutcomes)[number];

/** Codes a Farmer or Owner may give with a statement; statements never require free text. */
export const partyStatementCodes = [
  "HOURS_INCORRECT", "QUANTITY_INCORRECT", "RATE_NOT_AGREED", "WORK_INCOMPLETE",
  "PAYMENT_ALREADY_MADE", "WORK_RECORD_CORRECT", "OTHER",
] as const;

/** Codes support uses for review notes and resolution reasons. */
export const supportReasonCodes = [
  "EVIDENCE_SUPPORTS_BILL", "EVIDENCE_CORRECTED", "SERVICE_NOT_DELIVERED", "DUPLICATE_PAYMENT", "PARTIES_AGREED", "OTHER",
] as const;
export type SupportReasonCode = (typeof supportReasonCodes)[number];

export const supportEvidenceKinds = ["INVOICE", "WORK_EVENT", "WORK_MEASUREMENT", "PAYMENT"] as const;
export type SupportEvidenceKind = (typeof supportEvidenceKinds)[number];

export type SupportCaseStatus = "OPEN" | "RESOLVED";
export type SupportEntryType = "OPENED" | "PARTY_STATEMENT" | "EVIDENCE_REFERENCE" | "SUPPORT_NOTE" | "RESOLVED";
export type SupportAuthorRole = "FARMER" | "OWNER" | "SUPPORT" | "SYSTEM";
export type DisputePartyRole = "FARMER" | "OWNER";
/** READ lets an operator view one case; RESOLVE also lets them add notes and resolve it. */
export type SupportGrantScope = "READ" | "RESOLVE";

/** Longest a single grant may last; enforced here and by a database check. */
export const MAX_SUPPORT_GRANT_MS = 7 * 24 * 60 * 60 * 1_000;

export interface SupportRequestContext {
  readonly correlationId: string;
  readonly actorChannel: AuditActorChannel;
}

export interface SupportSessionAuthenticator {
  authenticateAccessCredential(accessCredential: string): Promise<AuthPrincipal>;
}

export interface SupportEvidenceReference {
  readonly kind: SupportEvidenceKind;
  readonly id: string;
}

export interface SupportCaseEntryProjection {
  readonly id: string;
  readonly entryType: SupportEntryType;
  readonly authorRole: SupportAuthorRole;
  readonly statementCode: string;
  /** Present only for the entry's author and for support; never logged. */
  readonly statementText?: string;
  /** True once account deletion erased the statement text. */
  readonly statementRedacted: boolean;
  readonly evidence?: SupportEvidenceReference;
  readonly occurredAt: Date;
}

export interface SupportCaseResolution {
  readonly outcome: SupportResolutionOutcome;
  readonly rulesVersion: number;
  readonly reasonCode: string;
  readonly resolvedAt: Date;
  readonly resolvedInvoiceId?: string;
  readonly paymentRefundId?: string;
}

/** A refundable confirmed online payment, offered to support for the REFUND outcome. */
export interface RefundablePayment {
  readonly id: string;
  readonly amountPaise: number;
}

export interface SupportCaseProjection {
  readonly id: string;
  readonly bookingId: string;
  readonly bookingReference: string;
  readonly bookingStatus: BookingStatus;
  readonly bookingVersion: number;
  readonly status: SupportCaseStatus;
  readonly version: number;
  readonly openedAt: Date;
  readonly disputedInvoiceId: string;
  readonly disputedInvoiceVersion: number;
  readonly currentInvoiceId: string;
  readonly currentInvoiceVersion: number;
  readonly currentInvoiceTotalPaise: number;
  /** Money applied to the current invoice (cash, confirmed online, refund pending). */
  readonly appliedPaise: number;
  readonly resolution?: SupportCaseResolution;
  readonly entries: readonly SupportCaseEntryProjection[];
  /** Support views only. */
  readonly refundablePayments?: readonly RefundablePayment[];
  readonly grantExpiresAt?: Date;
}

export interface SupportCaseSummary {
  readonly id: string;
  readonly bookingId: string;
  readonly bookingReference: string;
  readonly bookingStatus: BookingStatus;
  readonly status: SupportCaseStatus;
  readonly openedAt: Date;
  readonly grantScope: SupportGrantScope;
  readonly grantExpiresAt: Date;
}

/** Money facts the resolution rules decide on, read inside the resolving transaction. */
export interface ResolutionFacts {
  readonly bookingStatus: BookingStatus;
  readonly disputedInvoiceId: string;
  readonly currentInvoiceId: string;
  readonly currentInvoiceTotalPaise: number;
  readonly appliedOnCurrentPaise: number;
  readonly appliedOnSupersededPaise: number;
  readonly pendingPaise: number;
  readonly refundablePaymentIds: readonly string[];
}

export type ResolutionDecision =
  | { readonly kind: "BOOKING_TRANSITION"; readonly action: Extract<BookingLifecycleAction, "RESOLVE_DISPUTE" | "COMPLETE" | "CANCEL">; readonly to: BookingStatus }
  | { readonly kind: "REFUND"; readonly paymentId: string };

export type SupportRuleCode =
  | "CASE_NOT_OPEN"
  | "BOOKING_NOT_DISPUTED"
  | "PAYMENT_PENDING"
  | "INVOICE_CHANGED"
  | "ADJUSTED_INVOICE_REQUIRED"
  | "SUPERSEDED_PAYMENT_APPLIED"
  | "PAYMENT_APPLIED"
  | "REFUND_NOT_AVAILABLE";

export class SupportRuleError extends Error {
  constructor(readonly code: SupportRuleCode, message: string) {
    super(message);
    this.name = "SupportRuleError";
  }
}

export class SupportNotFoundError extends Error {
  readonly code = "NOT_FOUND";
  constructor() {
    super("The case is not available to this account");
    this.name = "SupportNotFoundError";
  }
}

export class SupportValidationError extends Error {
  readonly code = "VALIDATION_FAILED";
  constructor(readonly field: string, message: string) {
    super(message);
    this.name = "SupportValidationError";
  }
}

export class SupportConflictError extends Error {
  constructor(readonly code: "VERSION_CONFLICT" | "IDEMPOTENCY_KEY_REUSED" | "CASE_CLOSED", message: string) {
    super(message);
    this.name = "SupportConflictError";
  }
}

/**
 * The dispute-resolution rules (version SUPPORT_RESOLUTION_RULES_VERSION). Each outcome maps to one
 * explicit edge of the booking transition table, or to the existing refund path:
 *
 * - UPHOLD: the disputed invoice is still current. Fully paid → COMPLETE; otherwise settlement
 *   reopens (RESOLVE_DISPUTE → FINAL_BILL_GENERATED).
 * - ADJUST: a newer invoice version was issued through the existing evidence-correction or
 *   agreement-versioning rules; support never writes an amount. Money applied to a superseded
 *   version must be refunded first. Then as UPHOLD on the new version.
 * - REFUND: one confirmed online payment of the booking is refunded through PaymentRefundService,
 *   which moves the booking DISPUTED → REFUND_PENDING.
 * - CANCEL: only an unpaid bill (no applied money) is cancelled (DISPUTED → CANCELLED).
 *
 * A pending online payment blocks every outcome except REFUND until the provider settles it.
 */
export function decideResolution(
  outcome: SupportResolutionOutcome,
  facts: ResolutionFacts,
  paymentId?: string,
): ResolutionDecision {
  if (facts.bookingStatus !== "DISPUTED") {
    throw new SupportRuleError("BOOKING_NOT_DISPUTED", "Only a disputed booking can be resolved");
  }
  if (outcome === "REFUND") {
    if (paymentId === undefined || !facts.refundablePaymentIds.includes(paymentId)) {
      throw new SupportRuleError("REFUND_NOT_AVAILABLE", "Choose a confirmed online payment of this booking to refund");
    }
    return { kind: "REFUND", paymentId };
  }
  if (facts.pendingPaise > 0) {
    throw new SupportRuleError("PAYMENT_PENDING", "An online payment is still pending; wait for the provider result");
  }
  if (outcome === "CANCEL") {
    if (facts.appliedOnCurrentPaise > 0 || facts.appliedOnSupersededPaise > 0) {
      throw new SupportRuleError("PAYMENT_APPLIED", "Paid money must be refunded; a paid bill cannot be cancelled");
    }
    return { kind: "BOOKING_TRANSITION", action: "CANCEL", to: "CANCELLED" };
  }
  if (outcome === "UPHOLD" && facts.currentInvoiceId !== facts.disputedInvoiceId) {
    throw new SupportRuleError("INVOICE_CHANGED", "A corrected bill version was issued; resolve with the adjusted bill");
  }
  if (outcome === "ADJUST") {
    if (facts.currentInvoiceId === facts.disputedInvoiceId) {
      throw new SupportRuleError("ADJUSTED_INVOICE_REQUIRED", "No corrected bill version exists; the Owner must correct the work evidence first");
    }
    if (facts.appliedOnSupersededPaise > 0) {
      throw new SupportRuleError("SUPERSEDED_PAYMENT_APPLIED", "Money paid against the earlier bill must be refunded first");
    }
  }
  return facts.appliedOnCurrentPaise === facts.currentInvoiceTotalPaise
    ? { kind: "BOOKING_TRANSITION", action: "COMPLETE", to: "COMPLETED" }
    : { kind: "BOOKING_TRANSITION", action: "RESOLVE_DISPUTE", to: "FINAL_BILL_GENERATED" };
}

/** Refund reason recorded by PaymentRefundService for a support resolution reason. */
export const refundReasonFor = (reasonCode: SupportReasonCode): string =>
  reasonCode === "DUPLICATE_PAYMENT" || reasonCode === "SERVICE_NOT_DELIVERED" ? reasonCode : "DISPUTE_RESOLVED";
