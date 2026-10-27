import {
  planPaymentTransition,
  type PaymentMethod,
  type PaymentRecordStatus,
} from "./payments.js";

/**
 * Provider-neutral meaning of a provider event whose authenticity has already been verified:
 * a webhook whose signature matched, or a server-to-server status read from the provider's
 * authenticated API (never a browser claim).
 *
 * - `PAYMENT_CONFIRMED`: the provider captured the money for the intent.
 * - `PAYMENT_FAILED`: the provider closed the intent as failed; it can no longer be paid.
 * - `PAYMENT_ATTEMPT_FAILED`: one attempt failed but the intent stays payable (for example a
 *   declined card followed by a successful UPI retry on the same order). No financial effect.
 * - `REFUND_CONFIRMED`: the provider processed a refund the platform requested.
 * - `REFUND_FAILED`: the provider could not process a refund the platform requested.
 * - `INFORMATIONAL`: any other verified event (authorizations, refund creation). No effect.
 */
export const providerPaymentEventKinds = [
  "PAYMENT_CONFIRMED",
  "PAYMENT_FAILED",
  "PAYMENT_ATTEMPT_FAILED",
  "REFUND_CONFIRMED",
  "REFUND_FAILED",
  "INFORMATIONAL",
] as const;
export type ProviderPaymentEventKind = (typeof providerPaymentEventKinds)[number];

export const isRefundEventKind = (kind: ProviderPaymentEventKind): kind is "REFUND_CONFIRMED" | "REFUND_FAILED" =>
  kind === "REFUND_CONFIRMED" || kind === "REFUND_FAILED";

/** The facts a verified provider event claims, already normalized by the provider adapter. */
export interface ProviderPaymentEventFacts {
  readonly kind: ProviderPaymentEventKind;
  readonly providerEventId: string;
  /** The intent reference the event names (for example a Razorpay order id). */
  readonly providerReference?: string;
  /** The provider's id for the captured payment (for example a Razorpay payment id). */
  readonly providerPaymentId?: string;
  /** Refund events: the provider's refund id. */
  readonly providerRefundId?: string;
  /** Integer paise the provider reports for the payment (or, for refund events, the refund). */
  readonly amountPaise?: number;
  readonly currency?: string;
}

/** The stored payment record the event's reference resolved to. */
export interface ProviderEventPaymentTarget {
  readonly method: PaymentMethod;
  readonly status: PaymentRecordStatus;
  readonly amountPaise: number;
  readonly currency: string;
  readonly providerReference?: string;
  /** The captured provider payment already recorded for this intent, when known. */
  readonly providerPaymentId?: string;
}

/** Optional ledger context for a confirmation of an intent the platform already closed. */
export interface ProviderEventLedgerContext {
  /** From `lateConfirmationCapacity`: paise the closed intent could still apply to its bill. */
  readonly lateConfirmationCapacityPaise?: number;
}

/**
 * Stable rejection codes. They match the `kt_payment_verification_failures_total` reason labels,
 * so a rejection pages through the `PaymentIntegrityFailure` alert.
 */
export type ProviderEventRejectionCode =
  | "REFERENCE_MISMATCH"
  | "AMOUNT_MISMATCH"
  | "CURRENCY_MISMATCH"
  | "PAYMENT_LEDGER_INCONSISTENT";

export type ProviderEventRecordNote =
  | "ALREADY_APPLIED"
  | "ALREADY_FINAL"
  | "ATTEMPT_FAILED"
  | "INFORMATIONAL"
  | "UNMATCHED";

export type ProviderEventDecision =
  | Readonly<{
      outcome: "APPLY";
      toStatus: "PAID_ONLINE" | "PAYMENT_FAILED";
      /** Payment-event type from `PAYMENT_TRANSITION_TABLE`. */
      eventType: string;
      reason?: string;
    }>
  | Readonly<{ outcome: "RECORD_ONLY"; note: ProviderEventRecordNote }>
  | Readonly<{ outcome: "REJECT"; code: ProviderEventRejectionCode; message: string }>;

const reject = (code: ProviderEventRejectionCode, message: string) =>
  Object.freeze({ outcome: "REJECT" as const, code, message });
const recordOnly = (note: ProviderEventRecordNote) => Object.freeze({ outcome: "RECORD_ONLY" as const, note });

const FAILED_REASON = "The payment provider reported that the payment failed";

/**
 * Decides the financial effect of a verified provider payment event (Requirements 11.4-11.6).
 *
 * A financial effect needs the event's provider reference, currency, and integer-paise amount to
 * match the server-created intent exactly. Only a confirmation of a pending intent marks money paid
 * online, and only a terminal failure of a pending intent marks it failed, so duplicate and
 * out-of-order events (a failure after a success, a second confirmation) never change settled money.
 * A confirmation for an intent the platform already closed is applied late only when the ledger
 * context shows the bill still has room for it; otherwise it is an integrity rejection. A second
 * captured payment on an intent that is already paid is never ignored. The transition itself is
 * checked against the shared payment transition table.
 */
export function evaluateProviderPaymentEvent(
  payment: ProviderEventPaymentTarget | undefined,
  event: ProviderPaymentEventFacts,
  ledger: ProviderEventLedgerContext = {},
): ProviderEventDecision {
  if (isRefundEventKind(event.kind)) {
    // Refund events are decided by evaluateProviderRefundEvent against the refund record.
    return recordOnly("INFORMATIONAL");
  }
  const financial = event.kind === "PAYMENT_CONFIRMED" || event.kind === "PAYMENT_FAILED";
  if (payment === undefined) {
    // Money the platform cannot attribute is an integrity problem; other unmatched events are noise.
    return financial
      ? reject("REFERENCE_MISMATCH", "The provider event names no payment intent created by this platform")
      : recordOnly("UNMATCHED");
  }
  if (payment.method !== "ONLINE" || payment.providerReference === undefined
    || event.providerReference !== payment.providerReference) {
    return reject("REFERENCE_MISMATCH", "The provider reference does not match the payment intent");
  }
  if (event.kind === "PAYMENT_ATTEMPT_FAILED") return recordOnly("ATTEMPT_FAILED");
  if (event.kind === "INFORMATIONAL") return recordOnly("INFORMATIONAL");

  if (event.currency === undefined || event.currency !== payment.currency) {
    return reject("CURRENCY_MISMATCH", "The provider currency does not match the payment intent");
  }
  if (event.amountPaise === undefined || !Number.isSafeInteger(event.amountPaise)
    || event.amountPaise !== payment.amountPaise) {
    return reject("AMOUNT_MISMATCH", "The provider amount does not match the payment intent");
  }

  if (event.kind === "PAYMENT_CONFIRMED") {
    if (payment.status === "PAID_ONLINE" || payment.status === "REFUND_PENDING" || payment.status === "REFUNDED") {
      if (payment.providerPaymentId !== undefined && event.providerPaymentId !== undefined
        && payment.providerPaymentId !== event.providerPaymentId) {
        // A second capture on one intent is money the bill cannot hold; it must be refunded by hand.
        return reject("PAYMENT_LEDGER_INCONSISTENT", "The provider captured a second payment for an intent that is already paid");
      }
      return recordOnly("ALREADY_APPLIED");
    }
    if (payment.status === "PAYMENT_FAILED") {
      const capacityPaise = ledger.lateConfirmationCapacityPaise ?? 0;
      if (capacityPaise < payment.amountPaise) {
        // Captured money for an intent the platform closed, with no room left on the bill.
        return reject("PAYMENT_LEDGER_INCONSISTENT", "The provider confirmed a payment intent that is already closed");
      }
      const rule = planPaymentTransition(payment, "PAID_ONLINE", "PROVIDER", {
        evidence: { kind: "VERIFIED_PROVIDER_EVENT", providerEventId: event.providerEventId },
        lateConfirmation: { amountPaise: payment.amountPaise, capacityPaise },
      });
      return Object.freeze({ outcome: "APPLY", toStatus: "PAID_ONLINE", eventType: rule.eventType });
    }
    if (payment.status !== "PENDING") {
      return reject("PAYMENT_LEDGER_INCONSISTENT", "The provider confirmed a payment intent that is already closed");
    }
    const rule = planPaymentTransition(payment, "PAID_ONLINE", "PROVIDER", {
      evidence: { kind: "VERIFIED_PROVIDER_EVENT", providerEventId: event.providerEventId },
    });
    return Object.freeze({ outcome: "APPLY", toStatus: "PAID_ONLINE", eventType: rule.eventType });
  }

  // Terminal failure: only a pending intent can fail; a late failure never undoes a success.
  if (payment.status !== "PENDING") return recordOnly("ALREADY_FINAL");
  const rule = planPaymentTransition(payment, "PAYMENT_FAILED", "PROVIDER", { reason: FAILED_REASON });
  return Object.freeze({ outcome: "APPLY", toStatus: "PAYMENT_FAILED", eventType: rule.eventType, reason: FAILED_REASON });
}

/** Lifecycle of one platform refund request at the provider. */
export const paymentRefundStatuses = ["REQUESTED", "SUBMITTED", "PROCESSED", "FAILED"] as const;
export type PaymentRefundStatus = (typeof paymentRefundStatuses)[number];

/** The stored refund request a refund event resolved to, with its payment. */
export interface ProviderEventRefundTarget {
  readonly status: PaymentRefundStatus;
  readonly amountPaise: number;
  readonly currency: string;
  readonly providerPaymentId: string;
  readonly providerRefundId?: string;
  readonly payment: Pick<ProviderEventPaymentTarget, "method" | "status">;
}

export type ProviderRefundEventDecision =
  | Readonly<{
      outcome: "APPLY";
      refundStatus: "PROCESSED" | "FAILED";
      paymentStatus: "REFUNDED" | "PAID_ONLINE";
      /** Payment-event type from `PAYMENT_TRANSITION_TABLE`. */
      eventType: string;
    }>
  | Readonly<{ outcome: "RECORD_ONLY"; note: ProviderEventRecordNote }>
  | Readonly<{ outcome: "REJECT"; code: ProviderEventRejectionCode; message: string }>;

/**
 * Decides the effect of a verified refund event. A refund finishes only for a refund the platform
 * requested, with the same provider payment, amount, and currency. A processed refund moves the
 * payment to refunded; a failed refund returns it to paid-online, so the money stays applied.
 * Repeated and out-of-order events change nothing, and a refund the platform never requested
 * (for example one made in the provider's dashboard) is an integrity rejection.
 */
export function evaluateProviderRefundEvent(
  refund: ProviderEventRefundTarget | undefined,
  event: ProviderPaymentEventFacts,
): ProviderRefundEventDecision {
  if (!isRefundEventKind(event.kind)) return recordOnly("INFORMATIONAL");
  if (refund === undefined) {
    return reject("PAYMENT_LEDGER_INCONSISTENT", "The provider reports a refund this platform did not request");
  }
  if (event.providerPaymentId === undefined || event.providerPaymentId !== refund.providerPaymentId
    || (refund.providerRefundId !== undefined && event.providerRefundId !== undefined
      && event.providerRefundId !== refund.providerRefundId)) {
    return reject("REFERENCE_MISMATCH", "The refund event does not match the requested refund");
  }
  if (event.currency === undefined || event.currency !== refund.currency) {
    return reject("CURRENCY_MISMATCH", "The refund currency does not match the requested refund");
  }
  if (event.amountPaise === undefined || !Number.isSafeInteger(event.amountPaise) || event.amountPaise !== refund.amountPaise) {
    return reject("AMOUNT_MISMATCH", "The refund amount does not match the requested refund");
  }
  const processed = event.kind === "REFUND_CONFIRMED";
  if (refund.status === "PROCESSED") {
    // A processed refund is final; a later failure report never re-applies the money.
    return recordOnly(processed ? "ALREADY_APPLIED" : "ALREADY_FINAL");
  }
  if (refund.status === "FAILED") {
    if (!processed) return recordOnly("ALREADY_APPLIED");
    return reject("PAYMENT_LEDGER_INCONSISTENT", "The provider processed a refund the platform recorded as failed");
  }
  if (refund.payment.method !== "ONLINE" || refund.payment.status !== "REFUND_PENDING") {
    return reject("PAYMENT_LEDGER_INCONSISTENT", "The refunded payment is not awaiting a refund");
  }
  const evidence = { kind: "VERIFIED_PROVIDER_EVENT" as const, providerEventId: event.providerEventId };
  const rule = planPaymentTransition(refund.payment, processed ? "REFUNDED" : "PAID_ONLINE", "PROVIDER", { evidence });
  return Object.freeze({
    outcome: "APPLY",
    refundStatus: processed ? "PROCESSED" : "FAILED",
    paymentStatus: processed ? "REFUNDED" : "PAID_ONLINE",
    eventType: rule.eventType,
  });
}
