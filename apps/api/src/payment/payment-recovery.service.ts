import {
  authorizePaymentViewer,
  defaultPendingIntentRecoveryPolicy,
  PaymentAccessDeniedError,
  planPendingIntentRecovery,
  planRefundReconciliation,
  projectPaymentRecord,
  validatePendingIntentRecoveryPolicy,
  type AuthPrincipal,
  type PendingIntentRecoveryPolicy,
  type PendingIntentTrigger,
  type ProviderIntentSnapshot,
  type ProviderRefundSnapshot,
} from "@kisantractor/domain";
import { noopIndicators, type OperationalIndicators, type PaymentRecoveryOutcome } from "@kisantractor/observability";
import {
  CapabilityRegistry,
  OnlinePaymentProviderError,
  supportsPaymentRecovery,
  type OnlinePaymentProviderAdapter,
  type OnlinePaymentRecoveryAdapter,
  type ProviderStatusRead,
} from "@kisantractor/providers";

import type {
  OnlineCheckoutView,
  OnlineIntentRecord,
  OnlinePaymentStatusView,
  PaymentRecoveryStore,
  PaymentRefundStore,
  PaymentRequestContext,
  ProviderEventOutcome,
  RefundSubmissionSource,
  VerifiedProviderEventRecord,
} from "./payment.contracts.js";
import {
  PaymentCapabilityUnavailableError,
  PaymentConflictError,
  PaymentNotFoundError,
  PaymentProviderFailedError,
  PaymentValidationError,
} from "./payment.service.js";

/** PII-safe log entry: identifiers, outcomes, and codes only. */
export interface PaymentRecoveryLogEntry {
  readonly event:
    | "payment.reconciliation.intent"
    | "payment.reconciliation.refund"
    | "payment.reconciliation.provider_error"
    | "payment.reconciliation.mismatch";
  readonly paymentId?: string;
  readonly refundId?: string;
  readonly outcome?: PaymentRecoveryOutcome;
  readonly code?: string;
}

export type PaymentRecoveryLogger = (entry: PaymentRecoveryLogEntry) => void;

export interface RecoveryRunResult {
  readonly checked: number;
  readonly outcomes: Readonly<Partial<Record<PaymentRecoveryOutcome, number>>>;
}

export interface OnlinePaymentActionResult extends OnlinePaymentStatusView {
  /** True when this request closed the intent and released the bill reservation. */
  readonly released: boolean;
}

const confirmationFor = (status: OnlinePaymentStatusView["payment"]["status"]): OnlinePaymentStatusView["confirmation"] =>
  status === "PAID_ONLINE" ? "CONFIRMED"
    : status === "PAYMENT_FAILED" ? "NOT_COMPLETED"
      : status === "REFUND_PENDING" ? "REFUND_IN_PROGRESS"
        : status === "REFUNDED" ? "REFUNDED" : "AWAITING_PROVIDER_CONFIRMATION";

const normalizedId = (value: string, field: string): string => {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 200) {
    throw new PaymentValidationError(field, `${field} must contain 1 to 200 characters`);
  }
  return normalized;
};

const providerErrorCode = (error: unknown): string =>
  error instanceof OnlinePaymentProviderError ? error.code : error instanceof TypeError ? "PROVIDER_REQUEST_INVALID" : "PROVIDER_CALL_FAILED";

/** Recovery reads must never hold a request open for long; reconciliation retries next cycle. */
const STATUS_READ_TIMEOUT_MS = 8_000;
const MAX_BATCH = 200;

/** The verified provider evidence a captured payment read from the provider's API amounts to. */
export function captureEvidence(
  intent: Pick<OnlineIntentRecord, "provider" | "providerReference">,
  capture: Readonly<{ providerPaymentId: string; amountPaise: number; currency: string }>,
  read: ProviderStatusRead<ProviderIntentSnapshot>,
  receivedAt: Date,
): VerifiedProviderEventRecord {
  return Object.freeze({
    provider: intent.provider,
    // One API evidence record per captured provider payment, however often it is read.
    providerEventId: `api:payment.captured:${capture.providerPaymentId}`,
    eventType: "api.payment.captured",
    kind: "PAYMENT_CONFIRMED",
    providerReference: intent.providerReference,
    providerPaymentId: capture.providerPaymentId,
    amountPaise: capture.amountPaise,
    currency: capture.currency,
    payloadDigest: read.digest,
    receivedAt,
    evidenceSource: "PROVIDER_API",
  });
}

/** The verified provider evidence a final refund state read from the provider's API amounts to. */
export function refundEvidence(
  refund: Pick<RefundSubmissionSource, "refundId" | "provider" | "providerPaymentId" | "refundKey">,
  snapshot: ProviderRefundSnapshot,
  digest: string,
  receivedAt: Date,
): VerifiedProviderEventRecord {
  const processed = snapshot.state === "PROCESSED";
  return Object.freeze({
    provider: refund.provider,
    providerEventId: `api:refund.${processed ? "processed" : "failed"}:${snapshot.providerRefundId}`,
    eventType: processed ? "api.refund.processed" : "api.refund.failed",
    kind: processed ? "REFUND_CONFIRMED" : "REFUND_FAILED",
    providerPaymentId: snapshot.providerPaymentId,
    providerRefundId: snapshot.providerRefundId,
    refundKey: refund.refundKey,
    paymentRefundId: refund.refundId,
    amountPaise: snapshot.amountPaise,
    currency: snapshot.currency,
    payloadDigest: digest,
    receivedAt,
    evidenceSource: "PROVIDER_API",
  });
}

/**
 * Online checkout, pending-intent recovery, refund submission, and reconciliation (task 16.2).
 *
 * The provider's authenticated API is read server to server; a capture it reports is recorded as
 * verified provider evidence through the same `recordProviderEvent` path as a signed webhook, so the
 * same fact seen twice applies once. An intent is released only after the provider reports no
 * successful or in-flight payment for it, and a refund finishes only from provider evidence.
 */
export class PaymentRecoveryService {
  readonly #policy: PendingIntentRecoveryPolicy;

  constructor(
    private readonly store: PaymentRecoveryStore & Pick<PaymentRefundStore, "loadRefundSubmission">,
    private readonly now: () => Date = () => new Date(),
    private readonly indicators: OperationalIndicators = noopIndicators,
    private readonly capabilities: CapabilityRegistry = new CapabilityRegistry(),
    policy: PendingIntentRecoveryPolicy = defaultPendingIntentRecoveryPolicy,
    private readonly log: PaymentRecoveryLogger = () => undefined,
  ) {
    this.#policy = validatePendingIntentRecoveryPolicy(policy);
  }

  get policy(): PendingIntentRecoveryPolicy {
    return this.#policy;
  }

  /**
   * Client-safe values to open (or reopen) the provider checkout for the Farmer's pending intent.
   * Only a SANDBOX or LIVE provider opens a checkout, and only within the checkout window.
   */
  async getCheckout(principal: AuthPrincipal, paymentId: string, context: PaymentRequestContext): Promise<OnlineCheckoutView> {
    const intent = await this.#farmerIntent(principal, paymentId, context);
    if (intent.status !== "PENDING") {
      throw new PaymentConflictError("PAYMENT_NOT_PENDING", "This online payment is no longer waiting to be paid");
    }
    const adapter = this.capabilities.requireConfigured<OnlinePaymentProviderAdapter>("ONLINE_PAYMENT");
    if (adapter.provider !== intent.provider) {
      throw new PaymentCapabilityUnavailableError("This payment was started with a provider that is no longer configured");
    }
    const checkoutExpiresAt = new Date(intent.createdAt.getTime() + this.#policy.checkoutWindowMs);
    if (this.now().getTime() >= checkoutExpiresAt.getTime()) {
      throw new PaymentConflictError("PAYMENT_CHECKOUT_EXPIRED",
        "The time to complete this payment has passed. Check its status, or cancel it and start again.");
    }
    return Object.freeze({
      payment: projectPaymentRecord(intent.payment, intent.booking),
      bookingId: intent.booking.id,
      bookingReference: intent.booking.reference,
      checkout: adapter.checkoutFor({ providerReference: intent.providerReference, amountPaise: intent.amountPaise, currency: "INR" }),
      checkoutExpiresAt,
    });
  }

  /** Asks the provider now; a capture it reports confirms the payment. Never releases anything. */
  checkStatus(principal: AuthPrincipal, paymentId: string, context: PaymentRequestContext): Promise<OnlinePaymentActionResult> {
    return this.#farmerAction(principal, paymentId, "STATUS_CHECK", context);
  }

  /**
   * The Farmer gives up on a pending online payment (for example to pay in cash). The provider is
   * asked first: a capture confirms the payment, an attempt in progress refuses the cancel, and
   * only an intent with no successful or in-flight payment is released.
   */
  cancel(principal: AuthPrincipal, paymentId: string, context: PaymentRequestContext): Promise<OnlinePaymentActionResult> {
    return this.#farmerAction(principal, paymentId, "FARMER_CANCEL", context);
  }

  /**
   * One reconciliation pass over pending intents older than the checkout window, least recently
   * checked first. Reads use the in-flight provider, so intents created before a rollback to
   * DEGRADED are still resolved.
   */
  async recoverPendingIntents(context: PaymentRequestContext, limit = 25): Promise<RecoveryRunResult> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_BATCH) throw new RangeError(`limit must be 1..${MAX_BATCH}`);
    const adapter = this.#recoveryAdapter(false);
    if (adapter === undefined) return Object.freeze({ checked: 0, outcomes: Object.freeze({}) });
    const now = this.now();
    const intents = await this.store.listPendingIntentsForRecovery({
      createdBefore: new Date(now.getTime() - this.#policy.checkoutWindowMs), limit,
    }, context);
    const outcomes: Partial<Record<PaymentRecoveryOutcome, number>> = {};
    for (const intent of intents) {
      const outcome = intent.provider === adapter.provider
        ? await this.#resolveIntent(adapter, intent, "RECONCILIATION", context).then((resolved) => resolved.outcome)
        : "STILL_PENDING";
      if (outcome === "STILL_PENDING" || outcome === "MISMATCH" || outcome === "PROVIDER_ERROR") {
        await this.store.markIntentChecked(intent.paymentId, this.now(), context);
      }
      outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
      this.indicators.paymentRecovery("INTENT", outcome);
      this.log({ event: "payment.reconciliation.intent", paymentId: intent.paymentId, outcome });
    }
    return Object.freeze({ checked: intents.length, outcomes: Object.freeze(outcomes) });
  }

  /**
   * Sends a requested refund to the provider with its stable refund key as idempotency key, so a
   * retry after an unknown outcome never refunds twice. Records the provider's refund id, and a
   * final state the provider already reports, as verified provider evidence.
   */
  async submitRefund(refundId: string, context: PaymentRequestContext): Promise<PaymentRecoveryOutcome | "SKIPPED"> {
    const refund = await this.store.loadRefundSubmission(refundId, context);
    if (refund === undefined || refund.status !== "REQUESTED") return "SKIPPED";
    const adapter = this.#recoveryAdapter(true);
    if (adapter === undefined || adapter.provider !== refund.provider) return "SKIPPED";
    const outcome = await this.#submit(adapter, refund, context);
    this.indicators.paymentRecovery("REFUND", outcome);
    this.log({ event: "payment.reconciliation.refund", refundId: refund.refundId, paymentId: refund.paymentId, outcome });
    return outcome;
  }

  /** One reconciliation pass over refunds still requested or submitted, least recently checked first. */
  async reconcileRefunds(context: PaymentRequestContext, limit = 25): Promise<RecoveryRunResult> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_BATCH) throw new RangeError(`limit must be 1..${MAX_BATCH}`);
    const reader = this.#recoveryAdapter(false);
    if (reader === undefined) return Object.freeze({ checked: 0, outcomes: Object.freeze({}) });
    const now = this.now();
    // Give the request that created a refund time to submit it before reconciliation retries.
    const refunds = await this.store.listRefundsForReconciliation({ requestedBefore: new Date(now.getTime() - 60_000), limit }, context);
    const outcomes: Partial<Record<PaymentRecoveryOutcome, number>> = {};
    for (const refund of refunds) {
      let outcome: PaymentRecoveryOutcome;
      if (refund.provider !== reader.provider) {
        outcome = "STILL_PENDING";
      } else if (refund.providerRefundId === undefined) {
        const submitter = this.#recoveryAdapter(true);
        outcome = submitter === undefined ? "STILL_PENDING" : await this.#submit(submitter, refund, context);
      } else {
        outcome = await this.#reconcileSubmitted(reader, refund, context);
      }
      if (outcome === "STILL_PENDING" || outcome === "MISMATCH" || outcome === "PROVIDER_ERROR" || outcome === "SUBMITTED") {
        await this.store.markRefundChecked(refund.refundId, this.now(), context);
      }
      outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
      this.indicators.paymentRecovery("REFUND", outcome);
      this.log({ event: "payment.reconciliation.refund", refundId: refund.refundId, paymentId: refund.paymentId, outcome });
    }
    return Object.freeze({ checked: refunds.length, outcomes: Object.freeze(outcomes) });
  }

  async #farmerIntent(principal: AuthPrincipal, paymentId: string, context: PaymentRequestContext): Promise<OnlineIntentRecord> {
    if (!principal.roles.includes("FARMER")) throw new PaymentNotFoundError();
    const intent = await this.store.loadOnlineIntent(normalizedId(paymentId, "paymentId"), context);
    if (intent === undefined) throw new PaymentNotFoundError();
    try {
      authorizePaymentViewer(principal, "FARMER", intent.booking);
    } catch (error) {
      if (error instanceof PaymentAccessDeniedError) throw new PaymentNotFoundError();
      throw error;
    }
    return intent;
  }

  async #farmerAction(
    principal: AuthPrincipal,
    paymentId: string,
    trigger: Extract<PendingIntentTrigger, "STATUS_CHECK" | "FARMER_CANCEL">,
    context: PaymentRequestContext,
  ): Promise<OnlinePaymentActionResult> {
    const intent = await this.#farmerIntent(principal, paymentId, context);
    const view = (payment: OnlineIntentRecord["payment"], released: boolean): OnlinePaymentActionResult => Object.freeze({
      payment: projectPaymentRecord(payment, intent.booking),
      confirmation: confirmationFor(payment.status),
      testMode: payment.providerMode === "SANDBOX",
      released,
    });
    if (intent.status !== "PENDING") return view(intent.payment, false);
    // Reading status finishes work the provider already started, so DEGRADED still allows it.
    const adapter = this.#recoveryAdapter(false);
    if (adapter === undefined || adapter.provider !== intent.provider) {
      throw new PaymentCapabilityUnavailableError("The payment provider cannot be checked right now; retry later", true);
    }
    const resolved = await this.#resolveIntent(adapter, intent, trigger, context, principal.userId);
    this.indicators.paymentRecovery("INTENT", resolved.outcome);
    if (resolved.outcome === "PROVIDER_ERROR") throw new PaymentProviderFailedError(resolved.code ?? "PROVIDER_UNAVAILABLE", true);
    if (trigger === "FARMER_CANCEL" && resolved.outcome === "STILL_PENDING" && resolved.inProgress) {
      throw new PaymentConflictError("PAYMENT_IN_PROGRESS",
        "The payment provider is still processing this payment. Wait for it to finish, then check again.");
    }
    if (resolved.outcome === "MISMATCH") {
      throw new PaymentConflictError("PAYMENT_UNDER_REVIEW", "This payment needs a check by support. Nothing was changed.");
    }
    const current = await this.store.loadOnlineIntent(intent.paymentId, context);
    return view(current?.payment ?? intent.payment, resolved.outcome === "RELEASED");
  }

  /** Reads the provider's view of one pending intent and applies what it proves. */
  async #resolveIntent(
    adapter: OnlinePaymentRecoveryAdapter,
    intent: OnlineIntentRecord,
    trigger: PendingIntentTrigger,
    context: PaymentRequestContext,
    actorId?: string,
  ): Promise<{ readonly outcome: PaymentRecoveryOutcome; readonly code?: string; readonly inProgress?: boolean }> {
    let read: ProviderStatusRead<ProviderIntentSnapshot>;
    try {
      read = await adapter.fetchIntentStatus(intent.providerReference, AbortSignal.timeout(STATUS_READ_TIMEOUT_MS));
    } catch (error) {
      const code = providerErrorCode(error);
      this.log({ event: "payment.reconciliation.provider_error", paymentId: intent.paymentId, code });
      return { outcome: "PROVIDER_ERROR", code };
    }
    const now = this.now();
    const decision = planPendingIntentRecovery(intent, read.snapshot, trigger, now, this.#policy);
    if (decision.action === "CONFIRM") {
      const recorded = await this.store.recordProviderEvent(captureEvidence(intent, decision, read, now), context);
      return { outcome: this.#confirmationOutcome(recorded) };
    }
    if (decision.action === "RELEASE") {
      const released = await this.store.releasePendingIntent({
        paymentId: intent.paymentId,
        reason: decision.reason,
        ...(trigger === "FARMER_CANCEL" && actorId !== undefined ? { actorId } : {}),
        provider: intent.provider,
        providerEvidenceDigest: read.digest,
        occurredAt: now,
      }, context);
      return { outcome: released.released ? "RELEASED" : "STILL_PENDING" };
    }
    if (decision.action === "MISMATCH") {
      this.indicators.paymentVerificationFailed("ONLINE", decision.code === "RECONCILIATION_MISMATCH" ? "RECONCILIATION_MISMATCH" : decision.code);
      this.log({ event: "payment.reconciliation.mismatch", paymentId: intent.paymentId, code: decision.code });
      return { outcome: "MISMATCH", code: decision.code };
    }
    return { outcome: "STILL_PENDING", inProgress: decision.reason === "IN_PROGRESS" };
  }

  #confirmationOutcome(recorded: ProviderEventOutcome): PaymentRecoveryOutcome {
    if (recorded.disposition === "APPLIED") return "CONFIRMED";
    if (recorded.disposition === "REJECTED") {
      this.indicators.paymentVerificationFailed("ONLINE", recorded.rejectionCode ?? "OTHER");
      return "MISMATCH";
    }
    // Already recorded (for example a webhook won the race): confirmed if the payment moved.
    return recorded.paymentStatus === "PAID_ONLINE" ? "CONFIRMED" : "STILL_PENDING";
  }

  async #submit(adapter: OnlinePaymentRecoveryAdapter, refund: RefundSubmissionSource, context: PaymentRequestContext): Promise<PaymentRecoveryOutcome> {
    let read: ProviderStatusRead<ProviderRefundSnapshot> | undefined;
    try {
      read = await adapter.createRefund({
        providerPaymentId: refund.providerPaymentId,
        amountPaise: refund.amountPaise,
        currency: "INR",
        refundKey: refund.refundKey,
        metadata: { refund_id: refund.refundId, payment_id: refund.paymentId },
      }, AbortSignal.timeout(STATUS_READ_TIMEOUT_MS));
    } catch (error) {
      const code = providerErrorCode(error);
      const definite = error instanceof OnlinePaymentProviderError && error.code === "PROVIDER_REJECTED_REQUEST";
      if (definite) {
        // A refusal is final only if the provider holds no refund under this key.
        const found = await adapter.findRefund(refund.providerPaymentId, refund.refundKey).then(
          (value) => ({ known: true as const, value }),
          () => ({ known: false as const }),
        );
        if (found.known && found.value === undefined) return this.#recordRejection(refund, context);
        if (found.known) read = found.value;
      }
      if (read === undefined) {
        await this.store.recordRefundSubmission({ refundId: refund.refundId, errorCode: code, occurredAt: this.now() }, context);
        this.log({ event: "payment.reconciliation.provider_error", refundId: refund.refundId, code });
        return "PROVIDER_ERROR";
      }
    }
    return this.#applyRefundRead(refund, read, context);
  }

  async #reconcileSubmitted(adapter: OnlinePaymentRecoveryAdapter, refund: RefundSubmissionSource, context: PaymentRequestContext): Promise<PaymentRecoveryOutcome> {
    let read: ProviderStatusRead<ProviderRefundSnapshot>;
    try {
      read = await adapter.fetchRefund(refund.providerPaymentId, refund.providerRefundId!, AbortSignal.timeout(STATUS_READ_TIMEOUT_MS));
    } catch (error) {
      const code = providerErrorCode(error);
      if (code === "PROVIDER_NOT_FOUND") {
        this.indicators.paymentVerificationFailed("ONLINE", "RECONCILIATION_MISMATCH");
        this.log({ event: "payment.reconciliation.mismatch", refundId: refund.refundId, code: "RECONCILIATION_MISMATCH" });
        return "MISMATCH";
      }
      this.log({ event: "payment.reconciliation.provider_error", refundId: refund.refundId, code });
      return "PROVIDER_ERROR";
    }
    return this.#applyRefundRead(refund, read, context);
  }

  async #applyRefundRead(
    refund: RefundSubmissionSource,
    read: ProviderStatusRead<ProviderRefundSnapshot>,
    context: PaymentRequestContext,
  ): Promise<PaymentRecoveryOutcome> {
    const decision = planRefundReconciliation(refund, read.snapshot);
    if (decision.action === "MISMATCH") {
      this.indicators.paymentVerificationFailed("ONLINE", decision.code);
      this.log({ event: "payment.reconciliation.mismatch", refundId: refund.refundId, code: decision.code });
      return "MISMATCH";
    }
    if (decision.action === "LINK") {
      await this.store.recordRefundSubmission({
        refundId: refund.refundId, providerRefundId: decision.providerRefundId, occurredAt: this.now(),
      }, context);
      return "SUBMITTED";
    }
    if (decision.action === "APPLY") {
      if (refund.providerRefundId === undefined) {
        await this.store.recordRefundSubmission({
          refundId: refund.refundId, providerRefundId: decision.providerRefundId, occurredAt: this.now(),
        }, context);
      }
      const recorded = await this.store.recordProviderEvent(refundEvidence(refund, read.snapshot, read.digest, this.now()), context);
      if (recorded.disposition === "REJECTED") {
        this.indicators.paymentVerificationFailed("ONLINE", recorded.rejectionCode ?? "OTHER");
        return "MISMATCH";
      }
      const status = recorded.refundStatus;
      return status === "PROCESSED" ? "REFUNDED" : status === "FAILED" ? "REFUND_FAILED"
        : decision.kind === "REFUND_CONFIRMED" ? "REFUNDED" : "REFUND_FAILED";
    }
    return "STILL_PENDING";
  }

  /** The provider definitively refused the refund and holds none under its key: the refund failed. */
  async #recordRejection(refund: RefundSubmissionSource, context: PaymentRequestContext): Promise<PaymentRecoveryOutcome> {
    const recorded = await this.store.recordProviderEvent(Object.freeze({
      provider: refund.provider,
      providerEventId: `api:refund.rejected:${refund.refundId}`,
      eventType: "api.refund.rejected",
      kind: "REFUND_FAILED",
      providerPaymentId: refund.providerPaymentId,
      refundKey: refund.refundKey,
      paymentRefundId: refund.refundId,
      amountPaise: refund.amountPaise,
      currency: refund.currency,
      payloadDigest: `api:refund.rejected:${refund.refundKey}`,
      receivedAt: this.now(),
      evidenceSource: "PROVIDER_API",
    }), context);
    if (recorded.disposition === "REJECTED") {
      this.indicators.paymentVerificationFailed("ONLINE", recorded.rejectionCode ?? "OTHER");
      return "MISMATCH";
    }
    return "REFUND_FAILED";
  }

  /** The configured adapter for new provider actions, or the in-flight one for reads. */
  #recoveryAdapter(newAction: boolean): OnlinePaymentRecoveryAdapter | undefined {
    let adapter: OnlinePaymentProviderAdapter | undefined;
    if (newAction) {
      const state = this.capabilities.getState("ONLINE_PAYMENT");
      adapter = state === "SANDBOX" || state === "LIVE"
        ? this.capabilities.requireConfigured<OnlinePaymentProviderAdapter>("ONLINE_PAYMENT") : undefined;
    } else {
      adapter = this.capabilities.getInFlightProvider<OnlinePaymentProviderAdapter>("ONLINE_PAYMENT");
    }
    return adapter !== undefined && supportsPaymentRecovery(adapter) ? adapter : undefined;
  }
}
