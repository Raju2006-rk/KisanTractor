import { authorize } from "./authorization.js";
import type { AuthPrincipal } from "./identity.js";

export const paymentMethods = ["CASH", "ONLINE"] as const;
export type PaymentMethod = (typeof paymentMethods)[number];

/** Every payment state the Platform distinguishes (Requirement 11.1); mirrors the `payment_status` enum. */
export const paymentStatuses = [
  "PENDING",
  "AWAITING_FINAL_BILL",
  "PAYMENT_DUE",
  "PAID_ONLINE",
  "PAID_CASH",
  "PAYMENT_FAILED",
  "REFUND_PENDING",
  "REFUNDED",
] as const;
export type PaymentStatus = (typeof paymentStatuses)[number];

/**
 * Statuses a stored payment record may hold. `AWAITING_FINAL_BILL` and `PAYMENT_DUE`
 * describe a booking's invoice settlement, never an individual payment.
 */
export const paymentRecordStatuses = [
  "PENDING",
  "PAID_ONLINE",
  "PAID_CASH",
  "PAYMENT_FAILED",
  "REFUND_PENDING",
  "REFUNDED",
] as const;
export type PaymentRecordStatus = (typeof paymentRecordStatuses)[number];

/**
 * Invoice-level settlement state. `PAID_MIXED` marks a settlement made with both cash and
 * online payments, so neither method label is applied to money it did not cover.
 * `NOTHING_DUE` marks a zero-total invoice that needs no payment.
 */
export type SettlementStatus = PaymentStatus | "PAID_MIXED" | "NOTHING_DUE";

export type PaymentActorRole = "FARMER" | "OWNER" | "SUPPORT" | "SYSTEM" | "PROVIDER";

export type PaymentRuleCode =
  | "PAYMENT_INVALID_AMOUNT"
  | "PAYMENT_CURRENCY_MISMATCH"
  | "PAYMENT_INVOICE_REQUIRED"
  | "PAYMENT_INVOICE_NOT_PAYABLE"
  | "PAYMENT_SETTLEMENT_BLOCKED"
  | "PAYMENT_OVERPAYMENT"
  | "PAYMENT_LIMIT_REACHED"
  | "PAYMENT_ACTOR_NOT_PERMITTED"
  | "PAYMENT_TRANSITION_NOT_ALLOWED"
  | "PAYMENT_REASON_REQUIRED"
  | "PAYMENT_EVIDENCE_REQUIRED"
  | "PAYMENT_LEDGER_INCONSISTENT"
  | "PAYMENT_RECEIPT_UNAVAILABLE"
  | "PAYMENT_REFUND_UNSUPPORTED"
  | "PAYMENT_REFUND_EXCEEDS_PAYMENT"
  | "PAYMENT_PARTIAL_REFUND_UNSUPPORTED"
  | "PAYMENT_REFUND_NOT_ALLOWED";

export class PaymentRuleError extends Error {
  constructor(readonly code: PaymentRuleCode, message: string) {
    super(message);
    this.name = "PaymentRuleError";
  }
}

export class PaymentAccessDeniedError extends Error {
  readonly code = "PAYMENT_FORBIDDEN";
  constructor(message = "The payment record is unavailable for this account") {
    super(message);
    this.name = "PaymentAccessDeniedError";
  }
}

/** Payment statuses whose money currently counts toward the invoice (successful and not refunded). */
export const appliedPaymentStatuses: readonly PaymentRecordStatus[] = Object.freeze([
  "PAID_CASH",
  "PAID_ONLINE",
  "REFUND_PENDING",
]);
/** Payment statuses that reserve part of the invoice total while a provider result is outstanding. */
export const reservedPaymentStatuses: readonly PaymentRecordStatus[] = Object.freeze(["PENDING"]);

const isApplied = (status: PaymentRecordStatus): boolean => appliedPaymentStatuses.includes(status);
const isReserved = (status: PaymentRecordStatus): boolean => reservedPaymentStatuses.includes(status);

export interface PaymentLedgerEntry {
  readonly id: string;
  readonly method: PaymentMethod;
  readonly status: PaymentRecordStatus;
  readonly amountPaise: number;
  readonly currency: string;
  readonly createdAt: Date;
}

export type InvoiceRecordStatus = "ISSUED" | "DISPUTED" | "SETTLED" | "VOID";

export interface PayableInvoice {
  readonly id: string;
  readonly totalPaise: number;
  readonly currency: string;
  readonly status: InvoiceRecordStatus;
  /** True when a later invoice version replaced this one. */
  readonly superseded: boolean;
}

export interface SettlementContext {
  /** True while the booking is disputed; unreviewed settlement must not be finalized. */
  readonly disputed: boolean;
}

export interface InvoiceSettlement {
  readonly invoiceId?: string;
  readonly totalPaise: number;
  readonly appliedPaise: number;
  readonly pendingPaise: number;
  readonly outstandingPaise: number;
  readonly settled: boolean;
  readonly status: SettlementStatus;
  readonly settlementMethods: readonly PaymentMethod[];
  readonly settlementBlocked: boolean;
  readonly blockedReason?: "DISPUTED";
}

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

const toSafe = (value: bigint, field: string): number => {
  if (value > MAX_SAFE || value < -MAX_SAFE) {
    throw new PaymentRuleError("PAYMENT_LEDGER_INCONSISTENT", `${field} is outside the supported paise range`);
  }
  return Number(value);
};

const requirePositivePaise = (value: number, field: string, code: PaymentRuleCode): void => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new PaymentRuleError(code, `${field} must be a positive whole number of paise`);
  }
};

const byRecordOrder = (left: PaymentLedgerEntry, right: PaymentLedgerEntry): number =>
  left.createdAt.getTime() - right.createdAt.getTime() || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);

/**
 * Derives an invoice's settlement from its payment records with exact integer arithmetic.
 * The invoice is settled if and only if applied payments equal the invoice total.
 */
export function summarizeInvoiceSettlement(
  invoice: PayableInvoice | undefined,
  payments: readonly PaymentLedgerEntry[],
  context: SettlementContext,
): InvoiceSettlement {
  const blocked = context.disputed
    ? { settlementBlocked: true, blockedReason: "DISPUTED" as const }
    : { settlementBlocked: false };
  if (invoice === undefined) {
    if (payments.length > 0) {
      throw new PaymentRuleError("PAYMENT_LEDGER_INCONSISTENT", "Payments cannot exist before a final bill");
    }
    return Object.freeze({
      totalPaise: 0, appliedPaise: 0, pendingPaise: 0, outstandingPaise: 0, settled: false,
      status: "AWAITING_FINAL_BILL", settlementMethods: Object.freeze([]), ...blocked,
    });
  }
  if (!Number.isSafeInteger(invoice.totalPaise) || invoice.totalPaise < 0) {
    throw new PaymentRuleError("PAYMENT_LEDGER_INCONSISTENT", "Invoice total must be a nonnegative whole number of paise");
  }

  let applied = 0n;
  let pending = 0n;
  const methods = new Set<PaymentMethod>();
  for (const payment of payments) {
    requirePositivePaise(payment.amountPaise, "Payment amount", "PAYMENT_LEDGER_INCONSISTENT");
    if (payment.currency !== invoice.currency) {
      throw new PaymentRuleError("PAYMENT_LEDGER_INCONSISTENT", "Payment currency differs from the invoice currency");
    }
    if (payment.method === "CASH" && (payment.status === "PAID_ONLINE" || payment.status === "PENDING"
      || payment.status === "PAYMENT_FAILED")) {
      throw new PaymentRuleError("PAYMENT_LEDGER_INCONSISTENT", "A cash payment cannot hold an online payment status");
    }
    if (payment.method === "ONLINE" && payment.status === "PAID_CASH") {
      throw new PaymentRuleError("PAYMENT_LEDGER_INCONSISTENT", "An online payment cannot hold the paid-cash status");
    }
    if (isApplied(payment.status)) {
      applied += BigInt(payment.amountPaise);
      methods.add(payment.method);
    } else if (isReserved(payment.status)) {
      pending += BigInt(payment.amountPaise);
    }
  }
  const total = BigInt(invoice.totalPaise);
  if (applied > total) {
    throw new PaymentRuleError("PAYMENT_LEDGER_INCONSISTENT", "Applied payments exceed the invoice total");
  }

  const settled = applied === total;
  const settlementMethods = Object.freeze(paymentMethods.filter((method) => methods.has(method)));
  const ordered = [...payments].sort(byRecordOrder);
  let status: SettlementStatus;
  if (payments.some((payment) => payment.status === "REFUND_PENDING")) {
    status = "REFUND_PENDING";
  } else if (settled) {
    status = total === 0n ? "NOTHING_DUE"
      : settlementMethods.length > 1 ? "PAID_MIXED"
        : settlementMethods[0] === "CASH" ? "PAID_CASH" : "PAID_ONLINE";
  } else if (pending > 0n) {
    status = "PENDING";
  } else if (applied === 0n && payments.some((payment) => payment.status === "REFUNDED")) {
    status = "REFUNDED";
  } else if (ordered.at(-1)?.status === "PAYMENT_FAILED") {
    status = "PAYMENT_FAILED";
  } else {
    status = "PAYMENT_DUE";
  }

  return Object.freeze({
    invoiceId: invoice.id,
    totalPaise: invoice.totalPaise,
    appliedPaise: toSafe(applied, "Applied payments"),
    pendingPaise: toSafe(pending, "Pending payments"),
    outstandingPaise: toSafe(total - applied, "Outstanding amount"),
    settled,
    status,
    settlementMethods,
    ...blocked,
  });
}

export interface BookingPaymentParties {
  readonly customerId: string;
  readonly ownerId: string;
}

export interface PaymentApplicationCandidate {
  readonly method: PaymentMethod;
  readonly amountPaise: number;
  readonly currency: string;
  readonly actorId: string;
  readonly actorRole: PaymentActorRole;
}

export interface PaymentApplicationDecision {
  readonly initialStatus: PaymentRecordStatus;
  readonly eventType: "CASH_PAYMENT_RECORDED" | "ONLINE_PAYMENT_INITIATED";
  readonly settlementAfter: InvoiceSettlement;
}

/**
 * Roles allowed to add a payment record for each method. The Owner confirms cash it received;
 * only the booking Farmer may initiate an online payment intent. A pending online intent never
 * becomes paid without a verified provider event (see `PAYMENT_TRANSITION_TABLE`).
 */
/** Bounds each invoice's payment history so settlement reads stay bounded (Requirement 18.3). */
export const MAX_PAYMENT_RECORDS_PER_INVOICE = 50;

export const paymentApplicationRoles: Readonly<Record<PaymentMethod, readonly PaymentActorRole[]>> = Object.freeze({
  CASH: Object.freeze(["OWNER"] as const),
  ONLINE: Object.freeze(["FARMER"] as const),
});

/**
 * Validates adding a payment record to an invoice and returns its initial status.
 * Applied plus pending payments may never exceed the invoice total.
 */
export function evaluatePaymentApplication(
  invoice: PayableInvoice | undefined,
  payments: readonly PaymentLedgerEntry[],
  candidate: PaymentApplicationCandidate,
  parties: BookingPaymentParties,
  context: SettlementContext,
): PaymentApplicationDecision {
  const relatedActor = candidate.actorRole === "OWNER" ? parties.ownerId
    : candidate.actorRole === "FARMER" ? parties.customerId : undefined;
  if (!paymentApplicationRoles[candidate.method].includes(candidate.actorRole) || relatedActor !== candidate.actorId) {
    throw new PaymentRuleError("PAYMENT_ACTOR_NOT_PERMITTED",
      candidate.method === "CASH"
        ? "Only the assigned Owner can confirm a cash payment"
        : "Only the booking Farmer can initiate an online payment");
  }
  if (invoice === undefined) {
    throw new PaymentRuleError("PAYMENT_INVOICE_REQUIRED", "A final bill is required before payment");
  }
  if (invoice.superseded || invoice.status !== "ISSUED") {
    throw new PaymentRuleError("PAYMENT_INVOICE_NOT_PAYABLE", "Only the current issued final bill can receive payment");
  }
  if (context.disputed) {
    throw new PaymentRuleError("PAYMENT_SETTLEMENT_BLOCKED", "The bill is disputed; settlement waits for review");
  }
  requirePositivePaise(candidate.amountPaise, "Payment amount", "PAYMENT_INVALID_AMOUNT");
  if (candidate.currency !== invoice.currency) {
    throw new PaymentRuleError("PAYMENT_CURRENCY_MISMATCH", "Payment currency must match the invoice currency");
  }

  if (payments.length >= MAX_PAYMENT_RECORDS_PER_INVOICE) {
    throw new PaymentRuleError("PAYMENT_LIMIT_REACHED",
      `A bill can hold at most ${MAX_PAYMENT_RECORDS_PER_INVOICE} payment records`);
  }

  const before = summarizeInvoiceSettlement(invoice, payments, context);
  if (before.status === "REFUND_PENDING") {
    throw new PaymentRuleError("PAYMENT_INVOICE_NOT_PAYABLE", "The bill has a refund in progress");
  }
  const capacity = BigInt(before.outstandingPaise) - BigInt(before.pendingPaise);
  if (BigInt(candidate.amountPaise) > capacity) {
    throw new PaymentRuleError("PAYMENT_OVERPAYMENT",
      `Payment exceeds the ${capacity > 0n ? capacity : 0n} paise that remain payable on this bill`);
  }

  const initialStatus: PaymentRecordStatus = candidate.method === "CASH" ? "PAID_CASH" : "PENDING";
  const latest = payments.reduce((max, payment) => Math.max(max, payment.createdAt.getTime()), 0);
  const settlementAfter = summarizeInvoiceSettlement(invoice, [...payments, {
    id: "\uffffcandidate",
    method: candidate.method,
    status: initialStatus,
    amountPaise: candidate.amountPaise,
    currency: candidate.currency,
    createdAt: new Date(latest),
  }], context);
  return Object.freeze({
    initialStatus,
    eventType: candidate.method === "CASH" ? "CASH_PAYMENT_RECORDED" : "ONLINE_PAYMENT_INITIATED",
    settlementAfter,
  });
}

export interface VerifiedProviderEventEvidence {
  readonly kind: "VERIFIED_PROVIDER_EVENT";
  readonly providerEventId: string;
}

export interface PaymentTransitionRule {
  readonly from: PaymentRecordStatus;
  readonly to: PaymentRecordStatus;
  readonly methods: readonly PaymentMethod[];
  readonly roles: readonly PaymentActorRole[];
  readonly eventType: string;
  readonly reasonRequired?: boolean;
  /** Transitions that represent money moving through a provider require a verified provider event. */
  readonly evidence?: "VERIFIED_PROVIDER_EVENT";
  /**
   * The money re-enters the bill, so the caller must show the bill still has room for it
   * (see `lateConfirmationCapacity`). Without that proof the transition is refused.
   */
  readonly capacityRequired?: boolean;
}

/**
 * Payment record transitions after creation.
 *
 * - A pending online intent becomes paid only from a verified provider event. The platform (SYSTEM)
 *   closes an intent only after the provider reports no successful payment for it.
 * - Money captured after the platform closed an intent is accepted late only from a verified provider
 *   event and only while the bill still has room for it; otherwise it is an integrity alert.
 * - An online refund is requested by support (or the platform) and finishes only from a verified
 *   provider event: processed (`REFUNDED`) or failed (back to `PAID_ONLINE`, the money stays applied).
 * - Cash refunds are recorded by support (dispute workflows, task 16.5).
 */
export const PAYMENT_TRANSITION_TABLE: readonly PaymentTransitionRule[] = Object.freeze([
  { from: "PENDING", to: "PAID_ONLINE", methods: ["ONLINE"], roles: ["PROVIDER"],
    eventType: "ONLINE_PAYMENT_CONFIRMED", evidence: "VERIFIED_PROVIDER_EVENT" },
  { from: "PENDING", to: "PAYMENT_FAILED", methods: ["ONLINE"], roles: ["PROVIDER", "SYSTEM"],
    eventType: "ONLINE_PAYMENT_FAILED", reasonRequired: true },
  { from: "PAYMENT_FAILED", to: "PAID_ONLINE", methods: ["ONLINE"], roles: ["PROVIDER"],
    eventType: "ONLINE_PAYMENT_LATE_CONFIRMED", evidence: "VERIFIED_PROVIDER_EVENT", capacityRequired: true },
  { from: "PAID_ONLINE", to: "REFUND_PENDING", methods: ["ONLINE"], roles: ["SUPPORT", "SYSTEM"],
    eventType: "REFUND_REQUESTED", reasonRequired: true },
  { from: "PAID_CASH", to: "REFUND_PENDING", methods: ["CASH"], roles: ["SUPPORT", "SYSTEM"],
    eventType: "REFUND_REQUESTED", reasonRequired: true },
  { from: "REFUND_PENDING", to: "REFUNDED", methods: ["ONLINE"], roles: ["PROVIDER"],
    eventType: "REFUND_CONFIRMED", evidence: "VERIFIED_PROVIDER_EVENT" },
  { from: "REFUND_PENDING", to: "PAID_ONLINE", methods: ["ONLINE"], roles: ["PROVIDER"],
    eventType: "REFUND_FAILED", evidence: "VERIFIED_PROVIDER_EVENT" },
  { from: "REFUND_PENDING", to: "REFUNDED", methods: ["CASH"], roles: ["SUPPORT"],
    eventType: "CASH_REFUND_RECORDED", reasonRequired: true },
]);

/** Proof that a late provider confirmation fits the bill, from `lateConfirmationCapacity`. */
export interface LateConfirmationProof {
  readonly amountPaise: number;
  readonly capacityPaise: number;
}

export interface PaymentTransitionDetails {
  readonly reason?: string;
  readonly evidence?: VerifiedProviderEventEvidence;
  readonly lateConfirmation?: LateConfirmationProof;
}

/** Returns the permitted transition rule or rejects the transition without side effects. */
export function planPaymentTransition(
  payment: Pick<PaymentLedgerEntry, "method" | "status">,
  to: PaymentRecordStatus,
  actorRole: PaymentActorRole,
  details: PaymentTransitionDetails = {},
): PaymentTransitionRule {
  const rule = PAYMENT_TRANSITION_TABLE.find((candidate) =>
    candidate.from === payment.status && candidate.to === to && candidate.methods.includes(payment.method));
  if (rule === undefined) {
    throw new PaymentRuleError("PAYMENT_TRANSITION_NOT_ALLOWED",
      `A ${payment.method.toLowerCase()} payment cannot move from ${payment.status} to ${to}`);
  }
  if (!rule.roles.includes(actorRole)) {
    throw new PaymentRuleError("PAYMENT_ACTOR_NOT_PERMITTED", `${actorRole} cannot move a payment to ${to}`);
  }
  if (rule.reasonRequired === true && (details.reason === undefined || details.reason.trim().length === 0)) {
    throw new PaymentRuleError("PAYMENT_REASON_REQUIRED", `A reason is required to move a payment to ${to}`);
  }
  if (rule.evidence === "VERIFIED_PROVIDER_EVENT"
    && (details.evidence?.kind !== "VERIFIED_PROVIDER_EVENT" || details.evidence.providerEventId.trim().length === 0)) {
    throw new PaymentRuleError("PAYMENT_EVIDENCE_REQUIRED", `${to} requires a verified provider event`);
  }
  if (rule.capacityRequired === true) {
    const proof = details.lateConfirmation;
    if (proof === undefined || !Number.isSafeInteger(proof.amountPaise) || !Number.isSafeInteger(proof.capacityPaise)) {
      throw new PaymentRuleError("PAYMENT_EVIDENCE_REQUIRED", `${to} requires proof that the bill still has room for the payment`);
    }
    if (proof.amountPaise <= 0 || proof.amountPaise > proof.capacityPaise) {
      throw new PaymentRuleError("PAYMENT_OVERPAYMENT", "The late payment no longer fits the bill");
    }
  }
  return rule;
}

export interface LateConfirmationContext {
  /** The payment's invoice is still the booking's current bill. */
  readonly currentInvoice: boolean;
  /** The booking can still receive payment (final bill generated or payment recorded). */
  readonly bookingPayable: boolean;
  readonly disputed: boolean;
}

/**
 * How many paise a closed online intent could still apply to its bill if the provider confirms it
 * late, or 0 when it cannot: the bill must be current, issued, payable, undisputed, without a refund
 * in progress, and the money must fit next to everything already applied or reserved.
 */
export function lateConfirmationCapacity(
  invoice: PayableInvoice,
  payments: readonly PaymentLedgerEntry[],
  paymentId: string,
  context: LateConfirmationContext,
): number {
  if (!context.currentInvoice || !context.bookingPayable || context.disputed) return 0;
  if (invoice.superseded || invoice.status !== "ISSUED") return 0;
  const others = payments.filter((payment) => payment.id !== paymentId);
  const settlement = summarizeInvoiceSettlement(invoice, others, { disputed: false });
  if (settlement.status === "REFUND_PENDING") return 0;
  return Math.max(0, settlement.outstandingPaise - settlement.pendingPaise);
}

/** Why support (or the platform) refunds a payment. Stored as a code, never as free text. */
export const refundReasonCodes = ["DISPUTE_RESOLVED", "DUPLICATE_PAYMENT", "SERVICE_NOT_DELIVERED", "OTHER"] as const;
export type RefundReasonCode = (typeof refundReasonCodes)[number];

export const refundReasonDescriptions: Readonly<Record<RefundReasonCode, string>> = Object.freeze({
  DISPUTE_RESOLVED: "Refund approved after the bill dispute was reviewed",
  DUPLICATE_PAYMENT: "Refund of a duplicate payment",
  SERVICE_NOT_DELIVERED: "Refund because the service was not delivered as agreed",
  OTHER: "Refund approved by support",
});

/** Booking statuses in which a refund may be requested: refunds resolve a disputed bill. */
export const refundableBookingStatuses: readonly string[] = Object.freeze(["DISPUTED", "REFUND_PENDING"]);

export interface RefundRequestCandidate {
  readonly payment: Pick<PaymentRecordSource, "id" | "method" | "status" | "amountPaise" | "currency">;
  /** The provider's id for the captured payment the refund reverses. */
  readonly providerPaymentId?: string;
  readonly bookingStatus: string;
  readonly actorRole: PaymentActorRole;
  readonly reasonCode: string;
  /** Optional amount the requester expects; must equal the whole payment (full refunds only). */
  readonly amountPaise?: number;
}

export interface RefundRequestDecision {
  readonly refundPaise: number;
  readonly currency: string;
  readonly reasonCode: RefundReasonCode;
  readonly reason: string;
  readonly rule: PaymentTransitionRule;
  /** True when the booking moves from disputed to refund-pending with this request. */
  readonly bookingRefundRequested: boolean;
}

/**
 * Validates a refund request. Only a whole online payment that the provider confirmed can be
 * refunded, once, while its booking's bill is disputed or already being refunded. The refund
 * amount is the payment amount, so a refund can never return more than was paid.
 */
export function evaluateRefundRequest(candidate: RefundRequestCandidate): RefundRequestDecision {
  const { payment } = candidate;
  if (payment.method !== "ONLINE") {
    throw new PaymentRuleError("PAYMENT_REFUND_UNSUPPORTED", "Only online payments are refunded through the payment provider");
  }
  if (!(refundReasonCodes as readonly string[]).includes(candidate.reasonCode)) {
    throw new PaymentRuleError("PAYMENT_REASON_REQUIRED", "Choose a refund reason");
  }
  const reasonCode = candidate.reasonCode as RefundReasonCode;
  const reason = refundReasonDescriptions[reasonCode];
  const rule = planPaymentTransition(payment, "REFUND_PENDING", candidate.actorRole, { reason });
  requirePositivePaise(payment.amountPaise, "Payment amount", "PAYMENT_LEDGER_INCONSISTENT");
  if (candidate.amountPaise !== undefined) {
    if (!Number.isSafeInteger(candidate.amountPaise) || candidate.amountPaise <= 0) {
      throw new PaymentRuleError("PAYMENT_INVALID_AMOUNT", "Refund amount must be a positive whole number of paise");
    }
    if (candidate.amountPaise > payment.amountPaise) {
      throw new PaymentRuleError("PAYMENT_REFUND_EXCEEDS_PAYMENT", "A refund cannot return more than the payment");
    }
    if (candidate.amountPaise < payment.amountPaise) {
      throw new PaymentRuleError("PAYMENT_PARTIAL_REFUND_UNSUPPORTED", "Only a full refund of the payment is supported");
    }
  }
  if (!refundableBookingStatuses.includes(candidate.bookingStatus)) {
    throw new PaymentRuleError("PAYMENT_REFUND_NOT_ALLOWED", "Refunds resolve a disputed bill; this booking is not disputed");
  }
  if (candidate.providerPaymentId === undefined || candidate.providerPaymentId.trim().length === 0) {
    throw new PaymentRuleError("PAYMENT_EVIDENCE_REQUIRED", "The provider's captured payment is not recorded for this payment");
  }
  return Object.freeze({
    refundPaise: payment.amountPaise,
    currency: payment.currency,
    reasonCode,
    reason,
    rule,
    bookingRefundRequested: candidate.bookingStatus === "DISPUTED",
  });
}

export type PaymentViewerRole = "FARMER" | "OWNER";

export interface PaymentBookingSource extends BookingPaymentParties {
  readonly id: string;
  readonly reference: string;
}

/** Default-deny: only the booking Farmer or the assigned Owner, acting in that role, may view payments. */
export function authorizePaymentViewer(
  principal: AuthPrincipal | undefined,
  viewerRole: PaymentViewerRole,
  booking: PaymentBookingSource,
): void {
  const scoped = principal === undefined || !principal.roles.includes(viewerRole)
    ? undefined
    : { ...principal, roles: [viewerRole] };
  const decision = authorize(scoped, "booking:read", {
    kind: "BOOKING", id: booking.id, customerId: booking.customerId, ownerId: booking.ownerId,
  });
  if (!decision.allowed) throw new PaymentAccessDeniedError();
}

export interface PaymentRecordSource {
  readonly id: string;
  readonly invoiceId: string;
  readonly method: PaymentMethod;
  readonly status: PaymentRecordStatus;
  readonly amountPaise: number;
  readonly currency: string;
  readonly recordedByUserId?: string;
  readonly receivedAt?: Date;
  readonly verifiedAt?: Date;
  readonly createdAt: Date;
  /** Online only: whether the provider ran in sandbox or live mode when the intent was created. */
  readonly providerMode?: "SANDBOX" | "LIVE";
}

export type PaymentConfirmer = "OWNER" | "FARMER" | "OTHER" | "PAYMENT_PROVIDER";

/** Party-safe payment record: no provider references, payloads, or internal recorder identifiers. */
export interface PaymentRecordProjection {
  readonly id: string;
  readonly invoiceId: string;
  readonly method: PaymentMethod;
  readonly status: PaymentRecordStatus;
  readonly amountPaise: number;
  readonly currency: string;
  readonly recordedAt: Date;
  readonly paidAt?: Date;
  readonly confirmedBy?: PaymentConfirmer;
  /** Present only for online money that moved through a provider sandbox (Requirement 14.3). */
  readonly testMode?: true;
}

const paidAtFor = (payment: PaymentRecordSource): Date | undefined =>
  payment.method === "CASH" ? payment.receivedAt : payment.verifiedAt;

const confirmerFor = (payment: PaymentRecordSource, parties: BookingPaymentParties): PaymentConfirmer | undefined => {
  if (payment.method === "ONLINE") return payment.verifiedAt === undefined ? undefined : "PAYMENT_PROVIDER";
  if (payment.recordedByUserId === undefined) return undefined;
  return payment.recordedByUserId === parties.ownerId ? "OWNER"
    : payment.recordedByUserId === parties.customerId ? "FARMER" : "OTHER";
};

export function projectPaymentRecord(
  payment: PaymentRecordSource,
  parties: BookingPaymentParties,
): PaymentRecordProjection {
  const paidAt = paidAtFor(payment);
  const confirmedBy = confirmerFor(payment, parties);
  return Object.freeze({
    id: payment.id,
    invoiceId: payment.invoiceId,
    method: payment.method,
    status: payment.status,
    amountPaise: payment.amountPaise,
    currency: payment.currency,
    recordedAt: new Date(payment.createdAt),
    ...(paidAt === undefined ? {} : { paidAt: new Date(paidAt) }),
    ...(confirmedBy === undefined ? {} : { confirmedBy }),
    ...(payment.method === "ONLINE" && payment.providerMode === "SANDBOX" ? { testMode: true as const } : {}),
  });
}

export interface PaymentReceiptSource {
  readonly booking: PaymentBookingSource;
  readonly invoice: {
    readonly id: string;
    readonly invoiceVersion: number;
    readonly totalPaise: number;
    readonly currency: string;
  };
  readonly payment: PaymentRecordSource;
  readonly settlement: InvoiceSettlement;
}

export interface PaymentReceipt {
  readonly bookingId: string;
  readonly bookingReference: string;
  readonly invoiceId: string;
  readonly invoiceVersion: number;
  readonly invoiceTotalPaise: number;
  readonly paymentId: string;
  readonly method: PaymentMethod;
  readonly status: PaymentRecordStatus;
  readonly settlementStatus: SettlementStatus;
  readonly amountPaise: number;
  readonly currency: string;
  readonly paidAt: Date;
  readonly recordedAt: Date;
  readonly confirmedBy: PaymentConfirmer;
  /** Present only for online money that moved through a provider sandbox (Requirement 14.3). */
  readonly testMode?: true;
}

/**
 * Projects a receipt for the booking Farmer or assigned Owner. A receipt exists only for an
 * applied payment on a settled invoice (Requirement 11.8).
 */
export function projectPaymentReceipt(
  principal: AuthPrincipal | undefined,
  viewerRole: PaymentViewerRole,
  source: PaymentReceiptSource,
): PaymentReceipt {
  authorizePaymentViewer(principal, viewerRole, source.booking);
  const { payment, invoice, settlement } = source;
  if (payment.invoiceId !== invoice.id || settlement.invoiceId !== invoice.id) {
    throw new PaymentRuleError("PAYMENT_LEDGER_INCONSISTENT", "Receipt sources do not describe the same invoice");
  }
  if (!settlement.settled || !isApplied(payment.status)) {
    throw new PaymentRuleError("PAYMENT_RECEIPT_UNAVAILABLE", "A receipt is available once the bill is fully settled");
  }
  const record = projectPaymentRecord(payment, source.booking);
  if (record.paidAt === undefined || record.confirmedBy === undefined) {
    throw new PaymentRuleError("PAYMENT_LEDGER_INCONSISTENT", "An applied payment must record when and how it was confirmed");
  }
  return Object.freeze({
    bookingId: source.booking.id,
    bookingReference: source.booking.reference,
    invoiceId: invoice.id,
    invoiceVersion: invoice.invoiceVersion,
    invoiceTotalPaise: invoice.totalPaise,
    paymentId: payment.id,
    method: payment.method,
    status: payment.status,
    settlementStatus: settlement.status,
    amountPaise: payment.amountPaise,
    currency: payment.currency,
    paidAt: record.paidAt,
    recordedAt: record.recordedAt,
    confirmedBy: record.confirmedBy,
    ...(record.testMode === true ? { testMode: true as const } : {}),
  });
}
