import { randomUUID } from "node:crypto";

import { PaymentRuleError, type AuthPrincipal, type PaymentViewerRole } from "@kisantractor/domain";
import { instrumentProviderCallback, type Telemetry } from "@kisantractor/observability";
import { CapabilityUnavailableError } from "@kisantractor/providers";
import { Body, Controller, Get, Headers, HttpCode, HttpException, Inject, Param, Post, Req } from "@nestjs/common";

import { isIdentifier } from "../http-identifiers.js";
import { AuthenticationRejectedError } from "../identity/identity.service.js";
import type { PaymentRequestContext, PaymentSessionAuthenticator } from "./payment.contracts.js";
import {
  PaymentCapabilityUnavailableError,
  PaymentConflictError,
  PaymentNotFoundError,
  PaymentProviderFailedError,
  PaymentService,
  PaymentValidationError,
} from "./payment.service.js";

export const PAYMENT_AUTHENTICATOR = Symbol("PAYMENT_AUTHENTICATOR");
export const PAYMENT_SERVICE = Symbol("PAYMENT_SERVICE");
export const PAYMENT_WEBHOOK_TELEMETRY = Symbol("PAYMENT_WEBHOOK_TELEMETRY");

export interface HttpRequestLike {
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  /** Exact request bytes, present when the application was created with `rawBody: true`. */
  readonly rawBody?: Uint8Array;
}

export const header = (request: HttpRequestLike, name: string): string | undefined => {
  const value = request.headers[name];
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === "string" && first.trim().length > 0 ? first.trim() : undefined;
};

export const requestContext = (request: HttpRequestLike, correlationId: string | undefined): PaymentRequestContext => {
  const channel = header(request, "x-client-channel");
  return {
    correlationId: correlationId?.trim() || randomUUID(),
    actorChannel: channel === "PWA" || channel === "MOBILE" ? channel : "WEB",
  };
};

export const bearerCredential = (request: HttpRequestLike): string => {
  const match = /^Bearer\s+(.+)$/iu.exec(header(request, "authorization") ?? "");
  if (!match?.[1]) throw new HttpException({ code: "UNAUTHENTICATED" }, 401);
  return match[1];
};

interface RecordCashBody {
  readonly invoiceId?: unknown;
  readonly amountPaise?: unknown;
  readonly receivedAt?: unknown;
  readonly idempotencyKey?: unknown;
}

/** Accepts integer paise as a JSON number or a digits-only string; anything else fails validation. */
export const wholePaise = (value: unknown): number => {
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^\d{1,15}$/u.test(value.trim())) return Number(value.trim());
  return Number.NaN;
};

/** A malformed booking or payment identifier names no record the caller can see. */
export const pathId = (value: string): string => {
  if (!isIdentifier(value)) throw new PaymentNotFoundError();
  return value.trim();
};

const VALIDATION_RULE_CODES = new Set([
  "PAYMENT_INVALID_AMOUNT",
  "PAYMENT_CURRENCY_MISMATCH",
  "PAYMENT_REASON_REQUIRED",
  "PAYMENT_EVIDENCE_REQUIRED",
  "PAYMENT_REFUND_EXCEEDS_PAYMENT",
  "PAYMENT_PARTIAL_REFUND_UNSUPPORTED",
]);

/** Maps payment failures to stable machine codes without exposing internal details. */
export function toPaymentHttpError(error: unknown): unknown {
  if (error instanceof HttpException) return error;
  if (error instanceof AuthenticationRejectedError) return new HttpException({ code: "UNAUTHENTICATED" }, 401);
  if (error instanceof PaymentValidationError) {
    return new HttpException({ code: error.code, field: error.field, message: error.message }, 422);
  }
  if (error instanceof PaymentNotFoundError) return new HttpException({ code: "NOT_FOUND" }, 404);
  if (error instanceof PaymentConflictError) return new HttpException({ code: error.code, message: error.message }, 409);
  if (error instanceof PaymentCapabilityUnavailableError) {
    return new HttpException({ code: error.code, message: error.message, retryable: error.retryable }, 503);
  }
  if (error instanceof CapabilityUnavailableError) {
    // Online payment is UNCONFIGURED or DEGRADED: nothing was sent to a provider.
    return new HttpException({
      code: error.code, capability: error.capability, state: error.state, retryable: error.retryable,
      manualAlternativeAvailable: error.manualAlternativeAvailable,
    }, 503);
  }
  if (error instanceof PaymentProviderFailedError) {
    return new HttpException({ code: error.code, message: error.message, retryable: error.retryable }, error.retryable ? 503 : 502);
  }
  if (error instanceof PaymentRuleError) {
    if (error.code === "PAYMENT_ACTOR_NOT_PERMITTED") return new HttpException({ code: "NOT_FOUND" }, 404);
    if (error.code === "PAYMENT_LEDGER_INCONSISTENT") return error;
    return new HttpException({ code: error.code, message: error.message },
      VALIDATION_RULE_CODES.has(error.code) ? 422 : 409);
  }
  return error;
}

abstract class PaymentReadController {
  protected abstract readonly viewerRole: PaymentViewerRole;

  constructor(
    private readonly authenticator: PaymentSessionAuthenticator,
    private readonly payments: PaymentService,
  ) {}

  /** Authenticates the caller and scopes it to this controller's role for commands. */
  protected async rolePrincipal(request: HttpRequestLike): Promise<AuthPrincipal> {
    const principal = await this.authenticator.authenticateAccessCredential(bearerCredential(request));
    if (!principal.roles.includes(this.viewerRole)) throw new PaymentNotFoundError();
    // Act strictly in this role even when the account also holds another one.
    return { ...principal, roles: [this.viewerRole] };
  }

  protected async readSettlement(request: HttpRequestLike, bookingId: string, correlationId: string | undefined) {
    try {
      const principal = await this.authenticator.authenticateAccessCredential(bearerCredential(request));
      return await this.payments.getBookingSettlement(principal, pathId(bookingId), this.viewerRole,
        requestContext(request, correlationId));
    } catch (error) {
      throw toPaymentHttpError(error);
    }
  }

  protected async readReceipt(request: HttpRequestLike, paymentId: string, correlationId: string | undefined) {
    try {
      const principal = await this.authenticator.authenticateAccessCredential(bearerCredential(request));
      return await this.payments.getReceipt(principal, pathId(paymentId), this.viewerRole, requestContext(request, correlationId));
    } catch (error) {
      throw toPaymentHttpError(error);
    }
  }
}

interface CreateOnlineIntentBody {
  readonly invoiceId?: unknown;
  readonly amountPaise?: unknown;
  readonly idempotencyKey?: unknown;
}

@Controller("farmer")
export class FarmerPaymentController extends PaymentReadController {
  protected readonly viewerRole = "FARMER" as const;

  constructor(
    @Inject(PAYMENT_AUTHENTICATOR) authenticator: PaymentSessionAuthenticator,
    @Inject(PAYMENT_SERVICE) private readonly onlinePayments: PaymentService,
  ) {
    super(authenticator, onlinePayments);
  }

  /**
   * The booking Farmer starts paying the current final bill online. Returns a pending payment and
   * client-safe checkout values; the bill counts the money only after a verified provider event.
   */
  @Post("bookings/:bookingId/payments/online")
  async createOnlineIntent(
    @Req() request: HttpRequestLike,
    @Param("bookingId") bookingId: string,
    @Body() body: CreateOnlineIntentBody = {},
    @Headers("x-correlation-id") correlationId?: string,
  ) {
    try {
      const principal = await this.rolePrincipal(request);
      const targetBookingId = pathId(bookingId);
      const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : header(request, "idempotency-key");
      if (idempotencyKey === undefined) {
        throw new PaymentValidationError("idempotencyKey", "A stable idempotency key is required to start a payment");
      }
      if (!isIdentifier(body.invoiceId)) throw new PaymentValidationError("invoiceId", "The final bill is required");
      return await this.onlinePayments.createOnlineIntent(principal, {
        bookingId: targetBookingId,
        invoiceId: body.invoiceId.trim(),
        amountPaise: wholePaise(body.amountPaise),
        idempotencyKey,
      }, requestContext(request, correlationId));
    } catch (error) {
      throw toPaymentHttpError(error);
    }
  }

  /**
   * The browser's return from the provider checkout. The body (for example a claimed payment id
   * and signature) is deliberately ignored: only the stored, provider-verified state is returned.
   */
  @Post("payments/:paymentId/checkout-return")
  @HttpCode(200)
  async checkoutReturn(
    @Req() request: HttpRequestLike,
    @Param("paymentId") paymentId: string,
    @Headers("x-correlation-id") correlationId?: string,
  ) {
    try {
      const principal = await this.rolePrincipal(request);
      return await this.onlinePayments.getOnlinePaymentStatus(principal, pathId(paymentId), requestContext(request, correlationId));
    } catch (error) {
      throw toPaymentHttpError(error);
    }
  }

  @Get("bookings/:bookingId/payments")
  settlement(
    @Req() request: HttpRequestLike,
    @Param("bookingId") bookingId: string,
    @Headers("x-correlation-id") correlationId?: string,
  ) {
    return this.readSettlement(request, bookingId, correlationId);
  }

  @Get("payments/:paymentId/receipt")
  receipt(
    @Req() request: HttpRequestLike,
    @Param("paymentId") paymentId: string,
    @Headers("x-correlation-id") correlationId?: string,
  ) {
    return this.readReceipt(request, paymentId, correlationId);
  }
}

@Controller("owner")
export class OwnerPaymentController extends PaymentReadController {
  protected readonly viewerRole = "OWNER" as const;

  constructor(
    @Inject(PAYMENT_AUTHENTICATOR) authenticator: PaymentSessionAuthenticator,
    @Inject(PAYMENT_SERVICE) private readonly cashPayments: PaymentService,
  ) {
    super(authenticator, cashPayments);
  }

  /** The assigned Owner confirms cash received for the current final bill. */
  @Post("bookings/:bookingId/payments/cash")
  async recordCash(
    @Req() request: HttpRequestLike,
    @Param("bookingId") bookingId: string,
    @Body() body: RecordCashBody = {},
    @Headers("x-correlation-id") correlationId?: string,
  ) {
    try {
      const principal = await this.rolePrincipal(request);
      const targetBookingId = pathId(bookingId);
      const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : header(request, "idempotency-key");
      if (idempotencyKey === undefined) {
        throw new PaymentValidationError("idempotencyKey", "A stable idempotency key is required to record cash");
      }
      if (!isIdentifier(body.invoiceId)) throw new PaymentValidationError("invoiceId", "The final bill is required");
      const receivedAt = body.receivedAt === undefined || body.receivedAt === null ? undefined
        : typeof body.receivedAt === "string" && body.receivedAt.trim().length > 0 ? new Date(body.receivedAt)
          : new Date(Number.NaN);
      return await this.cashPayments.recordCash(principal, {
        bookingId: targetBookingId,
        invoiceId: body.invoiceId.trim(),
        amountPaise: wholePaise(body.amountPaise),
        ...(receivedAt === undefined ? {} : { receivedAt }),
        idempotencyKey,
      }, requestContext(request, correlationId));
    } catch (error) {
      throw toPaymentHttpError(error);
    }
  }

  @Get("bookings/:bookingId/payments")
  settlement(
    @Req() request: HttpRequestLike,
    @Param("bookingId") bookingId: string,
    @Headers("x-correlation-id") correlationId?: string,
  ) {
    return this.readSettlement(request, bookingId, correlationId);
  }

  @Get("payments/:paymentId/receipt")
  receipt(
    @Req() request: HttpRequestLike,
    @Param("paymentId") paymentId: string,
    @Headers("x-correlation-id") correlationId?: string,
  ) {
    return this.readReceipt(request, paymentId, correlationId);
  }
}

const PROVIDER_PATH = /^[a-z][a-z0-9-]{1,29}$/u;

/**
 * Provider webhooks (Requirements 11.4-11.6). Unauthenticated by design: authenticity comes only
 * from the provider signature, verified over the exact raw body. Responses carry stable codes and
 * never echo the payload. A 2xx tells the provider to stop retrying; signature failures get 401.
 */
@Controller("payments/webhooks")
export class PaymentWebhookController {
  constructor(
    @Inject(PAYMENT_SERVICE) private readonly payments: PaymentService,
    @Inject(PAYMENT_WEBHOOK_TELEMETRY) private readonly telemetry: Pick<Telemetry, "tracer" | "logger" | "indicators">,
  ) {}

  @Post(":provider")
  @HttpCode(200)
  async receive(@Req() request: HttpRequestLike, @Param("provider") provider: string) {
    if (!PROVIDER_PATH.test(provider)) throw new HttpException({ code: "NOT_FOUND" }, 404);
    let result;
    try {
      result = await instrumentProviderCallback(this.telemetry, "ONLINE_PAYMENT", request.headers, async (correlationId) => {
        const handled = await this.payments.handleProviderWebhook(provider, request.rawBody, request.headers, {
          correlationId, actorChannel: "PROVIDER",
        });
        return { outcome: handled.outcome, result: handled };
      });
    } catch (error) {
      throw toPaymentHttpError(error);
    }
    if (result.outcome === "REJECTED_SIGNATURE" || result.outcome === "REJECTED_PAYLOAD") {
      // The digest is the only trace of the request; it identifies the body without revealing it.
      this.telemetry.logger.warn("payment.webhook.rejected", {
        provider, reasonCode: result.reasonCode ?? "UNKNOWN", eventDigest: result.payloadDigest ?? "none",
      });
    }
    if (result.httpStatus !== 200) {
      throw new HttpException({ code: result.reasonCode ?? result.outcome }, result.httpStatus);
    }
    return { received: true, outcome: result.outcome };
  }
}
