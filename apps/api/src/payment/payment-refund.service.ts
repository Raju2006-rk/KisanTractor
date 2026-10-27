import { createHash } from "node:crypto";

import { authorize, PaymentRuleError, type AuthPrincipal } from "@kisantractor/domain";
import { noopIndicators, type OperationalIndicators } from "@kisantractor/observability";
import { CapabilityRegistry, supportsPaymentRecovery, type OnlinePaymentProviderAdapter } from "@kisantractor/providers";

import type { SupportAccessPolicy } from "../authorization/authorization.contracts.js";
import { DenyAllSupportAccessPolicy } from "../authorization/authorization.contracts.js";
import type {
  PaymentRefundStore,
  PaymentRequestContext,
  PaymentStore,
  RefundRequestResult,
} from "./payment.contracts.js";
import type { PaymentRecoveryService } from "./payment-recovery.service.js";
import {
  PaymentCapabilityUnavailableError,
  PaymentConflictError,
  PaymentNotFoundError,
  PaymentValidationError,
} from "./payment.service.js";

/** Support's request to refund one online payment in full. */
export interface RequestRefundCommand {
  readonly paymentId: string;
  /** One of `refundReasonCodes`; refunds never store free text. */
  readonly reasonCode: string;
  /** Optional; when present it must equal the payment amount (full refunds only). */
  readonly amountPaise?: number;
  /** Stable key reused for an explicit retry, so a retried request records one refund. */
  readonly idempotencyKey: string;
}

const normalizedId = (value: string, field: string): string => {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 200) {
    throw new PaymentValidationError(field, `${field} must contain 1 to 200 characters`);
  }
  return normalized;
};

/**
 * Refund initiation (task 16.2). Per the payment transition table, an online refund is requested by
 * support, never by the Farmer or Owner: a FUTURE_OPERATOR principal that the server-side support
 * access policy grants `booking:command` on the payment's booking. The default policy denies
 * everyone, so no refund can be requested until support access is configured (task 16.5).
 *
 * The request is recorded atomically (refund-pending payment, refund row, booking moved from
 * disputed to refund-pending, audit, outbox), then sent to the provider with a stable idempotency
 * key. The money counts as refunded only after verified provider evidence.
 */
export class PaymentRefundService {
  constructor(
    private readonly store: PaymentRefundStore & Pick<PaymentStore, "loadReceiptSource">,
    private readonly recovery: Pick<PaymentRecoveryService, "submitRefund">,
    private readonly supportAccess: SupportAccessPolicy = new DenyAllSupportAccessPolicy(),
    private readonly now: () => Date = () => new Date(),
    private readonly indicators: OperationalIndicators = noopIndicators,
    private readonly capabilities: CapabilityRegistry = new CapabilityRegistry(),
  ) {}

  async requestRefund(principal: AuthPrincipal, command: RequestRefundCommand, context: PaymentRequestContext): Promise<RefundRequestResult> {
    if (!principal.roles.includes("FUTURE_OPERATOR")) throw new PaymentNotFoundError();
    const paymentId = normalizedId(command.paymentId, "paymentId");
    const idempotencyKey = normalizedId(command.idempotencyKey, "idempotencyKey");
    normalizedId(context.correlationId, "correlationId");
    if (typeof command.reasonCode !== "string" || command.reasonCode.trim().length === 0 || command.reasonCode.length > 40) {
      throw new PaymentValidationError("reasonCode", "Choose a refund reason");
    }
    if (command.amountPaise !== undefined && (!Number.isSafeInteger(command.amountPaise) || command.amountPaise <= 0)) {
      throw new PaymentValidationError("amountPaise", "Refund amount must be a positive whole number of paise");
    }

    const source = await this.store.loadReceiptSource(paymentId, context);
    if (source === undefined) throw new PaymentNotFoundError();
    const operator: AuthPrincipal = { ...principal, roles: ["FUTURE_OPERATOR"] };
    const resource = {
      kind: "BOOKING" as const, id: source.booking.id, customerId: source.booking.customerId, ownerId: source.booking.ownerId,
    };
    const granted = await this.supportAccess.hasExplicitAccess({
      principal: operator, action: "booking:command", resource, correlationId: context.correlationId,
    });
    // Unrelated callers learn nothing about the payment, not even whether it exists.
    if (!authorize(operator, "booking:command", resource, granted).allowed) throw new PaymentNotFoundError();

    const adapter = this.capabilities.requireConfigured<OnlinePaymentProviderAdapter>("ONLINE_PAYMENT");
    if (!supportsPaymentRecovery(adapter)) {
      throw new PaymentCapabilityUnavailableError("The configured payment provider does not support refunds");
    }
    const reasonCode = command.reasonCode.trim();
    const result = await this.store.requestRefund({
      paymentId,
      reasonCode,
      ...(command.amountPaise === undefined ? {} : { amountPaise: command.amountPaise }),
      actorId: principal.userId,
      actorRole: "SUPPORT",
      provider: adapter.provider,
      idempotencyKey,
      requestDigest: createHash("sha256").update(JSON.stringify({
        paymentId, reasonCode, amountPaise: command.amountPaise ?? null, provider: adapter.provider,
      })).digest("hex"),
      occurredAt: this.now(),
    }, context).catch((error: unknown) => {
      if (error instanceof PaymentConflictError || error instanceof PaymentRuleError) {
        this.indicators.paymentVerificationFailed("ONLINE", error.code);
      }
      throw error;
    });

    // Submit after the request committed. A failure leaves the refund requested; the
    // reconciliation job retries it with the same idempotency key.
    await this.recovery.submitRefund(result.refund.id, context).catch(() => undefined);
    const latest = await this.store.loadRefundSubmission(result.refund.id, context);
    return latest === undefined || latest.status === result.refund.status
      ? result
      : Object.freeze({ ...result, refund: Object.freeze({ ...result.refund, status: latest.status }) });
  }
}
