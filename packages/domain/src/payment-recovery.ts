import type { PaymentRecordStatus } from "./payments.js";
import type { PaymentRefundStatus } from "./provider-payment-events.js";

/**
 * Pending-intent recovery and refund reconciliation (task 16.2).
 *
 * The provider's authenticated API is read server to server; its answers are verified provider
 * evidence in the same way a signed webhook is. These planners only decide what the evidence
 * means. Every financial effect still goes through the provider-event evaluators and the
 * payment transition table, so a webhook and a reconciliation read of the same fact apply once.
 */

/** One payment attempt the provider lists for an intent, normalized by the adapter. */
export interface ProviderIntentPaymentSnapshot {
  readonly providerPaymentId: string;
  readonly state: "CREATED" | "AUTHORIZED" | "CAPTURED" | "REFUNDED" | "FAILED";
  /** True when the provider captured the money (a refunded payment may or may not have been). */
  readonly captured: boolean;
  readonly amountPaise: number;
  readonly currency: string;
}

/** The provider's view of one intent (for example a Razorpay order and its payments). */
export interface ProviderIntentSnapshot {
  readonly providerReference: string;
  readonly amountPaise: number;
  readonly currency: string;
  readonly orderState: "OPEN" | "ATTEMPTED" | "PAID";
  readonly payments: readonly ProviderIntentPaymentSnapshot[];
}

export interface PendingIntentRecoveryPolicy {
  /** How long the browser checkout stays open for an intent; checkout is refused afterwards. */
  readonly checkoutWindowMs: number;
  /** A pending intent with no successful or in-flight payment is released after this age. */
  readonly releaseAfterMs: number;
  /** An intent whose only attempts never progressed past `CREATED` is released after this age. */
  readonly abandonInFlightAfterMs: number;
}

export const defaultPendingIntentRecoveryPolicy: PendingIntentRecoveryPolicy = Object.freeze({
  checkoutWindowMs: 15 * 60_000,
  releaseAfterMs: 45 * 60_000,
  abandonInFlightAfterMs: 24 * 60 * 60_000,
});

export function validatePendingIntentRecoveryPolicy(policy: PendingIntentRecoveryPolicy): PendingIntentRecoveryPolicy {
  const { checkoutWindowMs, releaseAfterMs, abandonInFlightAfterMs } = policy;
  for (const [name, value] of Object.entries({ checkoutWindowMs, releaseAfterMs, abandonInFlightAfterMs })) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive whole number of milliseconds`);
  }
  // A release must never race an open checkout: the window closes well before the intent is released.
  if (releaseAfterMs < checkoutWindowMs * 2) throw new RangeError("releaseAfterMs must be at least twice checkoutWindowMs");
  if (abandonInFlightAfterMs < releaseAfterMs) throw new RangeError("abandonInFlightAfterMs must not be shorter than releaseAfterMs");
  return Object.freeze({ ...policy });
}

/** Why the intent is being checked. Only reconciliation and an explicit cancel can release it. */
export type PendingIntentTrigger = "RECONCILIATION" | "FARMER_CANCEL" | "STATUS_CHECK";

export type RecoveryMismatchCode =
  | "REFERENCE_MISMATCH"
  | "AMOUNT_MISMATCH"
  | "CURRENCY_MISMATCH"
  | "RECONCILIATION_MISMATCH";

export interface PendingIntentForRecovery {
  readonly status: PaymentRecordStatus;
  readonly amountPaise: number;
  readonly currency: string;
  readonly providerReference: string;
  readonly createdAt: Date;
}

export type PendingIntentRecoveryDecision =
  | Readonly<{ action: "CONFIRM"; providerPaymentId: string; amountPaise: number; currency: string }>
  | Readonly<{ action: "RELEASE"; reason: "EXPIRED" | "CANCELLED" }>
  | Readonly<{ action: "WAIT"; reason: "IN_PROGRESS" | "NOT_STALE" | "NOT_PENDING" }>
  | Readonly<{ action: "MISMATCH"; code: RecoveryMismatchCode; message: string }>;

const mismatch = (code: RecoveryMismatchCode, message: string): PendingIntentRecoveryDecision =>
  Object.freeze({ action: "MISMATCH", code, message });
const wait = (reason: "IN_PROGRESS" | "NOT_STALE" | "NOT_PENDING"): PendingIntentRecoveryDecision =>
  Object.freeze({ action: "WAIT", reason });

/**
 * Decides what to do with a pending online intent from the provider's current view of it.
 *
 * - One captured payment matching the intent: confirm it (as verified provider evidence).
 * - A payment still being authorized or captured: wait; nothing is released under it.
 * - No successful or in-flight payment: release the intent (the bill reservation ends) when the
 *   Farmer cancels it, or when reconciliation finds it older than the release age.
 * - Anything contradictory (a second capture, a refund nobody requested, a paid order without a
 *   capture, a different amount): flag it for operators and change nothing.
 */
export function planPendingIntentRecovery(
  intent: PendingIntentForRecovery,
  snapshot: ProviderIntentSnapshot,
  trigger: PendingIntentTrigger,
  now: Date,
  policy: PendingIntentRecoveryPolicy = defaultPendingIntentRecoveryPolicy,
): PendingIntentRecoveryDecision {
  if (intent.status !== "PENDING") return wait("NOT_PENDING");
  if (snapshot.providerReference !== intent.providerReference) {
    return mismatch("REFERENCE_MISMATCH", "The provider returned a different intent");
  }
  if (snapshot.currency !== intent.currency) return mismatch("CURRENCY_MISMATCH", "The provider intent currency differs");
  if (snapshot.amountPaise !== intent.amountPaise) return mismatch("AMOUNT_MISMATCH", "The provider intent amount differs");

  const captured = snapshot.payments.filter((payment) => payment.captured);
  if (captured.length > 1) {
    return mismatch("RECONCILIATION_MISMATCH", "The provider captured more than one payment for one intent");
  }
  const capture = captured[0];
  if (capture !== undefined) {
    if (capture.state === "REFUNDED") {
      return mismatch("RECONCILIATION_MISMATCH", "The provider refunded a capture the platform never recorded");
    }
    if (capture.currency !== intent.currency) return mismatch("CURRENCY_MISMATCH", "The captured currency differs");
    if (capture.amountPaise !== intent.amountPaise) return mismatch("AMOUNT_MISMATCH", "The captured amount differs");
    return Object.freeze({
      action: "CONFIRM", providerPaymentId: capture.providerPaymentId, amountPaise: capture.amountPaise, currency: capture.currency,
    });
  }
  if (snapshot.orderState === "PAID") {
    return mismatch("RECONCILIATION_MISMATCH", "The provider marks the intent paid but lists no captured payment");
  }

  const ageMs = now.getTime() - intent.createdAt.getTime();
  if (snapshot.payments.some((payment) => payment.state === "AUTHORIZED")) return wait("IN_PROGRESS");
  if (snapshot.payments.some((payment) => payment.state === "CREATED")) {
    // A started attempt (for example a UPI collect request) may still complete; never cut it short
    // on a cancel, and give up on it only long after any checkout could be open.
    if (trigger !== "RECONCILIATION" || ageMs < policy.abandonInFlightAfterMs) return wait("IN_PROGRESS");
    return Object.freeze({ action: "RELEASE", reason: "EXPIRED" });
  }
  if (trigger === "FARMER_CANCEL") return Object.freeze({ action: "RELEASE", reason: "CANCELLED" });
  if (trigger === "RECONCILIATION" && ageMs >= policy.releaseAfterMs) return Object.freeze({ action: "RELEASE", reason: "EXPIRED" });
  return wait("NOT_STALE");
}

/** The provider's view of one refund, normalized by the adapter. */
export interface ProviderRefundSnapshot {
  readonly providerRefundId: string;
  readonly providerPaymentId: string;
  readonly amountPaise: number;
  readonly currency: string;
  readonly state: "PENDING" | "PROCESSED" | "FAILED";
}

export interface RefundForReconciliation {
  readonly status: PaymentRefundStatus;
  readonly amountPaise: number;
  readonly currency: string;
  readonly providerPaymentId: string;
  readonly providerRefundId?: string;
}

export type RefundReconciliationDecision =
  | Readonly<{ action: "SUBMIT" }>
  | Readonly<{ action: "LINK"; providerRefundId: string }>
  | Readonly<{ action: "APPLY"; kind: "REFUND_CONFIRMED" | "REFUND_FAILED"; providerRefundId: string }>
  | Readonly<{ action: "WAIT" }>
  | Readonly<{ action: "MISMATCH"; code: RecoveryMismatchCode; message: string }>;

/**
 * Compares a refund in flight with the provider's view of it. A requested refund the provider does
 * not know is (re)submitted with its stable idempotency key; a known refund is linked and, once the
 * provider reports a final state, finished through the refund-event evaluator.
 */
export function planRefundReconciliation(
  refund: RefundForReconciliation,
  snapshot: ProviderRefundSnapshot | undefined,
): RefundReconciliationDecision {
  if (refund.status === "PROCESSED" || refund.status === "FAILED") return Object.freeze({ action: "WAIT" });
  if (snapshot === undefined) {
    return refund.status === "REQUESTED" && refund.providerRefundId === undefined
      ? Object.freeze({ action: "SUBMIT" })
      : Object.freeze({
          action: "MISMATCH", code: "RECONCILIATION_MISMATCH",
          message: "The provider no longer lists a refund the platform submitted",
        });
  }
  if (snapshot.providerPaymentId !== refund.providerPaymentId
    || (refund.providerRefundId !== undefined && snapshot.providerRefundId !== refund.providerRefundId)) {
    return Object.freeze({ action: "MISMATCH", code: "REFERENCE_MISMATCH", message: "The provider refund names another payment" });
  }
  if (snapshot.currency !== refund.currency) {
    return Object.freeze({ action: "MISMATCH", code: "CURRENCY_MISMATCH", message: "The provider refund currency differs" });
  }
  if (snapshot.amountPaise !== refund.amountPaise) {
    return Object.freeze({ action: "MISMATCH", code: "AMOUNT_MISMATCH", message: "The provider refund amount differs" });
  }
  if (snapshot.state === "PENDING") {
    return refund.providerRefundId === undefined
      ? Object.freeze({ action: "LINK", providerRefundId: snapshot.providerRefundId })
      : Object.freeze({ action: "WAIT" });
  }
  return Object.freeze({
    action: "APPLY",
    kind: snapshot.state === "PROCESSED" ? "REFUND_CONFIRMED" : "REFUND_FAILED",
    providerRefundId: snapshot.providerRefundId,
  });
}
