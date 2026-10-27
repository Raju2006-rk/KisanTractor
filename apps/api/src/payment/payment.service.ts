import { createHash } from "node:crypto";

import {
  authorizePaymentViewer,
  PaymentAccessDeniedError,
  PaymentRuleError,
  projectPaymentReceipt,
  projectPaymentRecord,
  summarizeInvoiceSettlement,
  type AuthPrincipal,
  type PayableInvoice,
  type PaymentRecordSource,
  type PaymentViewerRole,
} from "@kisantractor/domain";
import { noopIndicators, type OperationalIndicators } from "@kisantractor/observability";
import {
  CapabilityRegistry,
  OnlinePaymentProviderError,
  ProviderWebhookRejectedError,
  type OnlinePaymentProviderAdapter,
  type ProviderWebhookHeaders,
} from "@kisantractor/providers";

import type { BookingStatus } from "../booking/booking.contracts.js";
import type {
  BookingPaymentsSource,
  BookingSettlementProjection,
  CreateOnlineIntentCommand,
  OnlinePaymentAvailability,
  OnlinePaymentConfirmation,
  OnlinePaymentIntentResult,
  OnlinePaymentStatusView,
  PaymentApplicationResult,
  PaymentInvoiceRecord,
  PaymentReceiptResponse,
  PaymentRequestContext,
  PaymentStore,
  RecordCashCommand,
  ValidatedPaymentApplication,
} from "./payment.contracts.js";

/** Missing and unrelated payment records are indistinguishable to the caller. */
export class PaymentNotFoundError extends Error {
  readonly code = "PAYMENT_NOT_FOUND";
  constructor(message = "The payment record is unavailable for this account") {
    super(message);
    this.name = "PaymentNotFoundError";
  }
}

export class PaymentValidationError extends Error {
  readonly code = "PAYMENT_VALIDATION_FAILED";
  constructor(readonly field: string, message: string) {
    super(message);
    this.name = "PaymentValidationError";
  }
}

export class PaymentConflictError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "PaymentConflictError";
  }
}

/** Raised instead of fabricating a provider result when no verified provider evidence can exist. */
export class PaymentCapabilityUnavailableError extends Error {
  readonly code = "PAYMENT_CAPABILITY_UNAVAILABLE";
  constructor(message: string, readonly retryable = false) {
    super(message);
    this.name = "PaymentCapabilityUnavailableError";
  }
}

/** The provider refused or failed to create an intent; nothing was recorded. */
export class PaymentProviderFailedError extends Error {
  constructor(readonly code: string, readonly retryable: boolean) {
    super(retryable
      ? "The payment provider is not responding. Nothing was charged; retry safely with the same key."
      : "The payment provider refused the request. Nothing was charged.");
    this.name = "PaymentProviderFailedError";
  }
}

/** Result of one provider webhook delivery, mapped to the provider-callback telemetry outcome. */
export interface ProviderWebhookResult {
  readonly outcome: "ACCEPTED" | "DUPLICATE" | "REJECTED_SIGNATURE" | "REJECTED_PAYLOAD";
  /** HTTP status for the provider: 2xx stops its retries; anything else asks it to retry. */
  readonly httpStatus: 200 | 400 | 401;
  readonly reasonCode?: string;
  /** SHA-256 of the raw body; the only trace kept of an unverifiable request. */
  readonly payloadDigest?: string;
}

const PROVIDER_WEBHOOK_INDICATOR_REASON: Readonly<Record<string, string>> = {
  SIGNATURE_MISSING: "SIGNATURE_INVALID",
  SIGNATURE_INVALID: "SIGNATURE_INVALID",
  PAYLOAD_INVALID: "PAYMENT_EVIDENCE_REQUIRED",
};

const confirmationFor = (status: PaymentRecordSource["status"]): OnlinePaymentConfirmation =>
  status === "PAID_ONLINE" ? "CONFIRMED"
    : status === "PAYMENT_FAILED" ? "NOT_COMPLETED"
      : status === "REFUND_PENDING" ? "REFUND_IN_PROGRESS"
        : status === "REFUNDED" ? "REFUNDED" : "AWAITING_PROVIDER_CONFIRMATION";

/** Booking statuses in which a payment may be applied to the current final bill. */
export const PAYABLE_BOOKING_STATUSES: ReadonlySet<BookingStatus> = new Set([
  "FINAL_BILL_GENERATED",
  "PAYMENT_RECORDED",
]);

export const toPayableInvoice = (invoice: PaymentInvoiceRecord, superseded: boolean): PayableInvoice => ({
  id: invoice.id,
  totalPaise: invoice.totalPaise,
  currency: invoice.currency,
  status: invoice.status,
  superseded,
});

export const toLedgerEntry = (payment: PaymentRecordSource) => ({
  id: payment.id,
  method: payment.method,
  status: payment.status,
  amountPaise: payment.amountPaise,
  currency: payment.currency,
  createdAt: payment.createdAt,
});

/** Builds the party-safe settlement view from the current invoice and its payment records. */
export function toSettlementProjection(source: BookingPaymentsSource): BookingSettlementProjection {
  const { booking, invoice } = source;
  const settlement = summarizeInvoiceSettlement(
    invoice === undefined ? undefined : toPayableInvoice(invoice, false),
    source.payments.map(toLedgerEntry),
    { disputed: booking.status === "DISPUTED" },
  );
  return Object.freeze({
    bookingId: booking.id,
    bookingReference: booking.reference,
    bookingStatus: booking.status,
    ...(invoice === undefined ? {} : { invoiceId: invoice.id, invoiceVersion: invoice.invoiceVersion }),
    currency: "INR",
    settlement,
    payments: Object.freeze(source.payments.map((payment) => projectPaymentRecord(payment, booking))),
  });
}

const normalizedId = (value: string, field: string): string => {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 200) {
    throw new PaymentValidationError(field, `${field} must contain 1 to 200 characters`);
  }
  return normalized;
};

const validateContext = (context: PaymentRequestContext): void => {
  normalizedId(context.correlationId, "correlationId");
};

const requestDigest = (value: Readonly<Record<string, unknown>>): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** A stable 40-character provider receipt id per (Farmer, invoice, idempotency key). */
const intentKeyFor = (actorId: string, invoiceId: string, idempotencyKey: string): string =>
  `kt${createHash("sha256").update(`${actorId}\u0000${invoiceId}\u0000${idempotencyKey}`).digest("hex").slice(0, 38)}`;

/**
 * Payment service: settlement views and receipts for the booking's two parties, the assigned
 * Owner's audited cash confirmation, and capability-gated online payments whose money counts only
 * after a verified provider event.
 */
export class PaymentService {
  constructor(
    private readonly store: PaymentStore,
    private readonly now: () => Date = () => new Date(),
    private readonly indicators: OperationalIndicators = noopIndicators,
    private readonly capabilities: CapabilityRegistry = new CapabilityRegistry(),
  ) {}

  /** Online payment availability and test labelling for client projections (Requirements 14.1, 14.3). */
  onlinePaymentAvailability(): OnlinePaymentAvailability {
    const presentation = this.capabilities.getClientProjection("ONLINE_PAYMENT");
    return Object.freeze({
      state: presentation.state,
      statusLabel: presentation.statusLabel,
      available: presentation.isOperational,
      testMode: this.#onlineTestMode(),
      canRetry: presentation.canRetry,
    });
  }

  /**
   * Creates a provider-linked intent for the booking Farmer (Requirement 11.3). Only a SANDBOX or
   * LIVE capability reaches the provider. The request is checked read-only first, so invalid and
   * replayed requests never create a provider intent; the store then re-validates and records the
   * pending payment atomically. The payment stays PENDING until a verified provider event.
   */
  async createOnlineIntent(
    principal: AuthPrincipal,
    command: CreateOnlineIntentCommand,
    context: PaymentRequestContext,
  ): Promise<OnlinePaymentIntentResult> {
    if (!principal.roles.includes("FARMER")) throw new PaymentNotFoundError();
    const bookingId = normalizedId(command.bookingId, "bookingId");
    const invoiceId = normalizedId(command.invoiceId, "invoiceId");
    const idempotencyKey = normalizedId(command.idempotencyKey, "idempotencyKey");
    validateContext(context);
    if (typeof command.amountPaise !== "number" || !Number.isSafeInteger(command.amountPaise) || command.amountPaise <= 0) {
      throw new PaymentValidationError("amountPaise", "Payment amount must be a positive whole number of paise");
    }
    // Throws CapabilityUnavailableError (UNCONFIGURED, or DEGRADED and retryable) with no side effect.
    const adapter = this.capabilities.requireConfigured<OnlinePaymentProviderAdapter>("ONLINE_PAYMENT");

    const application: ValidatedPaymentApplication = {
      bookingId,
      invoiceId,
      method: "ONLINE",
      amountPaise: command.amountPaise,
      currency: "INR",
      actorId: principal.userId,
      actorRole: "FARMER",
      provider: adapter.provider,
      providerMode: adapter.mode,
      idempotencyKey,
      requestDigest: requestDigest({
        bookingId, invoiceId, method: "ONLINE", amountPaise: command.amountPaise, currency: "INR", provider: adapter.provider,
      }),
      occurredAt: this.now(),
    };
    const refused = (error: unknown): never => {
      if (error instanceof PaymentConflictError || error instanceof PaymentRuleError) {
        this.indicators.paymentVerificationFailed("ONLINE", error.code);
      }
      throw error;
    };

    const preview = await this.store.previewPaymentApplication(application, context).catch(refused);
    if (preview.kind === "REPLAY") return this.#withCheckout(adapter, preview.result);

    let intent;
    try {
      intent = await adapter.createIntent({
        intentKey: intentKeyFor(principal.userId, invoiceId, idempotencyKey),
        amountPaise: command.amountPaise,
        currency: "INR",
        metadata: { booking_id: bookingId, invoice_id: invoiceId },
      });
    } catch (error) {
      if (error instanceof OnlinePaymentProviderError) {
        if (error.code === "PROVIDER_AMOUNT_BELOW_MINIMUM") {
          throw new PaymentValidationError("amountPaise", "Online payments must be at least ₹1");
        }
        throw new PaymentProviderFailedError(error.code, error.retryable);
      }
      throw error;
    }
    if (intent.provider !== adapter.provider || intent.amountPaise !== command.amountPaise || intent.currency !== "INR") {
      throw new PaymentProviderFailedError("PROVIDER_RESPONSE_INVALID", false);
    }
    // A losing concurrent retry with the same key replays the winner's intent; its own provider
    // intent was never shown to anyone and can never be paid.
    const applied = await this.store.applyPayment({ ...application, providerReference: intent.providerReference }, context)
      .catch(refused);
    return this.#withCheckout(adapter, applied);
  }

  /**
   * Handles one provider webhook delivery (Requirements 11.4-11.6, 14.5). The signature is verified
   * over the exact raw body before anything is parsed; there is no unsigned path in any
   * environment. Verified events are recorded once and applied only when the domain allows.
   */
  async handleProviderWebhook(
    provider: string,
    rawBody: Uint8Array | undefined,
    headers: ProviderWebhookHeaders,
    context: PaymentRequestContext,
  ): Promise<ProviderWebhookResult> {
    validateContext(context);
    // DEGRADED keeps the adapter so callbacks for intents created before a rollback still land.
    const adapter = this.capabilities.getInFlightProvider<OnlinePaymentProviderAdapter>("ONLINE_PAYMENT");
    if (adapter === undefined) {
      throw new PaymentCapabilityUnavailableError("Online payment is not configured; the provider should retry later", true);
    }
    if (adapter.provider !== provider) throw new PaymentNotFoundError();
    if (rawBody === undefined || rawBody.byteLength === 0) {
      // Never verify a re-serialized body: only the exact bytes the provider signed are trusted.
      this.indicators.paymentVerificationFailed("ONLINE", "PAYMENT_EVIDENCE_REQUIRED");
      return Object.freeze({ outcome: "REJECTED_PAYLOAD", httpStatus: 400, reasonCode: "RAW_BODY_UNAVAILABLE" });
    }

    let verified;
    try {
      verified = adapter.verifyWebhook(rawBody, headers);
    } catch (error) {
      if (!(error instanceof ProviderWebhookRejectedError)) throw error;
      this.indicators.paymentVerificationFailed("ONLINE", PROVIDER_WEBHOOK_INDICATOR_REASON[error.code] ?? "OTHER");
      const signature = error.code !== "PAYLOAD_INVALID";
      return Object.freeze({
        outcome: signature ? "REJECTED_SIGNATURE" : "REJECTED_PAYLOAD",
        httpStatus: signature ? 401 : 400,
        reasonCode: error.code,
        payloadDigest: error.payloadDigest,
      });
    }

    const outcome = await this.store.recordProviderEvent({
      provider: verified.provider,
      providerEventId: verified.providerEventId,
      eventType: verified.eventType,
      kind: verified.kind,
      ...(verified.providerReference === undefined ? {} : { providerReference: verified.providerReference }),
      ...(verified.providerPaymentId === undefined ? {} : { providerPaymentId: verified.providerPaymentId }),
      ...(verified.providerRefundId === undefined ? {} : { providerRefundId: verified.providerRefundId }),
      ...(verified.refundKey === undefined ? {} : { refundKey: verified.refundKey }),
      ...(verified.amountPaise === undefined ? {} : { amountPaise: verified.amountPaise }),
      ...(verified.currency === undefined ? {} : { currency: verified.currency }),
      ...(verified.occurredAt === undefined ? {} : { occurredAt: verified.occurredAt }),
      payloadDigest: verified.payloadDigest,
      receivedAt: this.now(),
    }, context);

    if (outcome.disposition === "DUPLICATE") {
      if (outcome.replayedUnderNewEventId === true) this.indicators.paymentVerificationFailed("ONLINE", "REPLAYED_EVENT");
      return Object.freeze({ outcome: "DUPLICATE", httpStatus: 200, payloadDigest: verified.payloadDigest });
    }
    if (outcome.disposition === "REJECTED") {
      // Recorded and alerted; a provider retry cannot change the evidence, so acknowledge it.
      this.indicators.paymentVerificationFailed("ONLINE", outcome.rejectionCode ?? "OTHER");
      return Object.freeze({
        outcome: "REJECTED_PAYLOAD", httpStatus: 200, payloadDigest: verified.payloadDigest,
        ...(outcome.rejectionCode === undefined ? {} : { reasonCode: outcome.rejectionCode }),
      });
    }
    if (outcome.disposition === "APPLIED" && outcome.refundStatus !== undefined) {
      // Refund outcomes from webhooks feed the same refund telemetry as reconciliation.
      this.indicators.paymentRecovery("REFUND", outcome.refundStatus === "FAILED" ? "REFUND_FAILED" : "REFUNDED");
    }
    return Object.freeze({ outcome: "ACCEPTED", httpStatus: 200, payloadDigest: verified.payloadDigest });
  }

  /**
   * The browser's return from checkout (Requirement 11.4). Whatever the redirect claims, this only
   * reads the stored state: a payment is confirmed solely by a verified provider event.
   */
  async getOnlinePaymentStatus(
    principal: AuthPrincipal,
    paymentId: string,
    context: PaymentRequestContext,
  ): Promise<OnlinePaymentStatusView> {
    if (!principal.roles.includes("FARMER")) throw new PaymentNotFoundError();
    const id = normalizedId(paymentId, "paymentId");
    validateContext(context);
    const source = await this.store.loadReceiptSource(id, context);
    if (source === undefined || source.payment.method !== "ONLINE") throw new PaymentNotFoundError();
    try {
      authorizePaymentViewer(principal, "FARMER", source.booking);
    } catch (error) {
      if (error instanceof PaymentAccessDeniedError) throw new PaymentNotFoundError();
      throw error;
    }
    return Object.freeze({
      payment: projectPaymentRecord(source.payment, source.booking),
      confirmation: confirmationFor(source.payment.status),
      testMode: this.#recordTestMode(source.payment),
    });
  }

  /**
   * Whether one online record is test money: from the mode stored with the intent (task 16.2), or,
   * for intents recorded before the mode was stored, from the environment's current provider.
   */
  #recordTestMode(payment: PaymentRecordSource): boolean {
    if (payment.method !== "ONLINE") return false;
    return payment.providerMode === undefined ? this.#onlineTestMode() : payment.providerMode === "SANDBOX";
  }

  #onlineTestMode(): boolean {
    const adapter = this.capabilities.getInFlightProvider<OnlinePaymentProviderAdapter>("ONLINE_PAYMENT");
    return this.capabilities.getState("ONLINE_PAYMENT") === "SANDBOX" || adapter?.mode === "SANDBOX";
  }

  #withCheckout(adapter: OnlinePaymentProviderAdapter, result: PaymentApplicationResult): OnlinePaymentIntentResult {
    const intent = result.onlineIntent;
    if (intent === undefined || result.payment.method !== "ONLINE") {
      throw new PaymentConflictError("IDEMPOTENCY_KEY_REUSED", "The idempotency key was already used for a different payment");
    }
    if (intent.provider !== adapter.provider) {
      throw new PaymentCapabilityUnavailableError("This payment was started with a provider that is no longer configured");
    }
    return Object.freeze({
      payment: result.payment,
      settlement: result.settlement,
      checkout: adapter.checkoutFor({
        providerReference: intent.providerReference,
        amountPaise: result.payment.amountPaise,
        currency: "INR",
      }),
    });
  }

  /**
   * Records cash the assigned Owner received against the current final bill. The store applies
   * it atomically with its payment event, audit record, outbox event, and any booking
   * transitions (payment recorded, then completed once the bill is fully settled).
   */
  async recordCash(
    principal: AuthPrincipal,
    command: RecordCashCommand,
    context: PaymentRequestContext,
  ): Promise<PaymentApplicationResult> {
    // Only an Owner may confirm cash; any other account sees the booking as unavailable.
    if (!principal.roles.includes("OWNER")) throw new PaymentNotFoundError();
    const bookingId = normalizedId(command.bookingId, "bookingId");
    const invoiceId = normalizedId(command.invoiceId, "invoiceId");
    const idempotencyKey = normalizedId(command.idempotencyKey, "idempotencyKey");
    validateContext(context);
    if (typeof command.amountPaise !== "number" || !Number.isSafeInteger(command.amountPaise) || command.amountPaise <= 0) {
      throw new PaymentValidationError("amountPaise", "Cash amount must be a positive whole number of paise");
    }
    const occurredAt = this.now();
    let receivedAt: Date | undefined;
    if (command.receivedAt !== undefined) {
      if (!(command.receivedAt instanceof Date) || Number.isNaN(command.receivedAt.getTime())) {
        throw new PaymentValidationError("receivedAt", "Cash receipt time must be a valid date and time");
      }
      if (command.receivedAt.getTime() > occurredAt.getTime()) {
        throw new PaymentValidationError("receivedAt", "Cash receipt time cannot be in the future");
      }
      receivedAt = new Date(command.receivedAt);
    }
    const applied = this.store.applyPayment({
      bookingId,
      invoiceId,
      method: "CASH",
      amountPaise: command.amountPaise,
      currency: "INR",
      actorId: principal.userId,
      actorRole: "OWNER",
      ...(receivedAt === undefined ? {} : { receivedAt }),
      idempotencyKey,
      // The digest binds the key to exactly this confirmation, so a changed retry is refused.
      requestDigest: requestDigest({
        bookingId, invoiceId, method: "CASH", amountPaise: command.amountPaise, currency: "INR",
        receivedAt: receivedAt?.toISOString() ?? null,
      }),
      occurredAt,
    }, context);
    return applied.catch((error: unknown) => {
      // Ledger and settlement rule refusals are payment verification failures (Requirement 18.2).
      if (error instanceof PaymentConflictError || error instanceof PaymentRuleError) {
        this.indicators.paymentVerificationFailed("CASH", error.code);
      }
      throw error;
    });
  }

  async getBookingSettlement(
    principal: AuthPrincipal,
    bookingId: string,
    viewerRole: PaymentViewerRole,
    context: PaymentRequestContext,
  ): Promise<BookingSettlementProjection> {
    if (!principal.roles.includes(viewerRole)) throw new PaymentNotFoundError();
    const id = normalizedId(bookingId, "bookingId");
    validateContext(context);
    const source = await this.store.loadBookingPayments(id, context);
    if (source === undefined) throw new PaymentNotFoundError();
    try {
      authorizePaymentViewer(principal, viewerRole, source.booking);
    } catch (error) {
      if (error instanceof PaymentAccessDeniedError) throw new PaymentNotFoundError();
      throw error;
    }
    return Object.freeze({ ...toSettlementProjection(source), onlinePayment: this.onlinePaymentAvailability() });
  }

  async getReceipt(
    principal: AuthPrincipal,
    paymentId: string,
    viewerRole: PaymentViewerRole,
    context: PaymentRequestContext,
  ): Promise<PaymentReceiptResponse> {
    if (!principal.roles.includes(viewerRole)) throw new PaymentNotFoundError();
    const id = normalizedId(paymentId, "paymentId");
    validateContext(context);
    const source = await this.store.loadReceiptSource(id, context);
    if (source === undefined) throw new PaymentNotFoundError();
    try {
      // Authorize before deriving anything from the ledger so unrelated callers learn nothing.
      authorizePaymentViewer(principal, viewerRole, source.booking);
      const settlement = summarizeInvoiceSettlement(
        toPayableInvoice(source.invoice, source.invoiceSuperseded),
        source.invoicePayments.map(toLedgerEntry),
        { disputed: source.booking.status === "DISPUTED" },
      );
      const receipt = projectPaymentReceipt(principal, viewerRole, {
        booking: source.booking,
        invoice: source.invoice,
        payment: source.payment,
        settlement,
      });
      // Online money that moved through a provider sandbox is labelled as test money.
      return this.#recordTestMode(source.payment) ? Object.freeze({ ...receipt, testMode: true as const }) : receipt;
    } catch (error) {
      if (error instanceof PaymentAccessDeniedError) throw new PaymentNotFoundError();
      if (error instanceof PaymentRuleError && error.code === "PAYMENT_RECEIPT_UNAVAILABLE") {
        throw new PaymentConflictError(error.code, error.message);
      }
      throw error;
    }
  }
}
