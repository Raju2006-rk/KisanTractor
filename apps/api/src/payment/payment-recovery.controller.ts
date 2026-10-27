import type { AuthPrincipal, PaymentViewerRole } from "@kisantractor/domain";
import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Query, Req } from "@nestjs/common";

import type { PaymentSessionAuthenticator } from "./payment.contracts.js";
import {
  bearerCredential,
  header,
  pathId,
  requestContext,
  toPaymentHttpError,
  wholePaise,
  PAYMENT_AUTHENTICATOR,
  type HttpRequestLike,
} from "./payment.controller.js";
import type { PaymentHistoryService } from "./payment-history.service.js";
import type { PaymentRecoveryService } from "./payment-recovery.service.js";
import type { PaymentRefundService } from "./payment-refund.service.js";
import { PaymentNotFoundError, PaymentValidationError } from "./payment.service.js";

export const PAYMENT_RECOVERY_SERVICE = Symbol("PAYMENT_RECOVERY_SERVICE");
export const PAYMENT_REFUND_SERVICE = Symbol("PAYMENT_REFUND_SERVICE");
export const PAYMENT_HISTORY_SERVICE = Symbol("PAYMENT_HISTORY_SERVICE");

const scoped = async (
  authenticator: PaymentSessionAuthenticator,
  request: HttpRequestLike,
  role: PaymentViewerRole | "FUTURE_OPERATOR",
): Promise<AuthPrincipal> => {
  const principal = await authenticator.authenticateAccessCredential(bearerCredential(request));
  if (!principal.roles.includes(role)) throw new PaymentNotFoundError();
  // Act strictly in this role even when the account also holds another one.
  return { ...principal, roles: [role] };
};

const historyOptions = (cursor: unknown, limit: unknown) => {
  const parsedLimit = limit === undefined ? undefined : typeof limit === "string" && /^\d{1,3}$/u.test(limit) ? Number(limit) : Number.NaN;
  if (cursor !== undefined && (typeof cursor !== "string" || cursor.length === 0 || cursor.length > 400)) {
    throw new PaymentValidationError("cursor", "The page cursor is invalid; reload the first page");
  }
  return {
    ...(typeof cursor === "string" ? { cursor } : {}),
    ...(parsedLimit === undefined ? {} : { limit: parsedLimit }),
  };
};

/**
 * The booking Farmer's online checkout, status check, cancel, and payment history (task 16.2).
 * Opening the checkout and checking status never mark money paid: only verified provider
 * evidence does. A cancel releases the bill only after the provider shows no successful payment.
 */
@Controller("farmer")
export class FarmerOnlinePaymentController {
  constructor(
    @Inject(PAYMENT_AUTHENTICATOR) private readonly authenticator: PaymentSessionAuthenticator,
    @Inject(PAYMENT_RECOVERY_SERVICE) private readonly recovery: PaymentRecoveryService,
    @Inject(PAYMENT_HISTORY_SERVICE) private readonly history: PaymentHistoryService,
  ) {}

  @Get("payments")
  async list(
    @Req() request: HttpRequestLike,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
    @Headers("x-correlation-id") correlationId?: string,
  ) {
    try {
      const principal = await scoped(this.authenticator, request, "FARMER");
      return await this.history.list(principal, "FARMER", historyOptions(cursor, limit), requestContext(request, correlationId));
    } catch (error) {
      throw toPaymentHttpError(error);
    }
  }

  @Get("payments/:paymentId/checkout")
  async checkout(
    @Req() request: HttpRequestLike,
    @Param("paymentId") paymentId: string,
    @Headers("x-correlation-id") correlationId?: string,
  ) {
    try {
      const principal = await scoped(this.authenticator, request, "FARMER");
      return await this.recovery.getCheckout(principal, pathId(paymentId), requestContext(request, correlationId));
    } catch (error) {
      throw toPaymentHttpError(error);
    }
  }

  @Post("payments/:paymentId/status-check")
  @HttpCode(200)
  async statusCheck(
    @Req() request: HttpRequestLike,
    @Param("paymentId") paymentId: string,
    @Headers("x-correlation-id") correlationId?: string,
  ) {
    try {
      const principal = await scoped(this.authenticator, request, "FARMER");
      return await this.recovery.checkStatus(principal, pathId(paymentId), requestContext(request, correlationId));
    } catch (error) {
      throw toPaymentHttpError(error);
    }
  }

  @Post("payments/:paymentId/cancel")
  @HttpCode(200)
  async cancel(
    @Req() request: HttpRequestLike,
    @Param("paymentId") paymentId: string,
    @Headers("x-correlation-id") correlationId?: string,
  ) {
    try {
      const principal = await scoped(this.authenticator, request, "FARMER");
      return await this.recovery.cancel(principal, pathId(paymentId), requestContext(request, correlationId));
    } catch (error) {
      throw toPaymentHttpError(error);
    }
  }
}

/** The assigned Owner's payment history across their bookings (task 16.2). */
@Controller("owner")
export class OwnerPaymentHistoryController {
  constructor(
    @Inject(PAYMENT_AUTHENTICATOR) private readonly authenticator: PaymentSessionAuthenticator,
    @Inject(PAYMENT_HISTORY_SERVICE) private readonly history: PaymentHistoryService,
  ) {}

  @Get("payments")
  async list(
    @Req() request: HttpRequestLike,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
    @Headers("x-correlation-id") correlationId?: string,
  ) {
    try {
      const principal = await scoped(this.authenticator, request, "OWNER");
      return await this.history.list(principal, "OWNER", historyOptions(cursor, limit), requestContext(request, correlationId));
    } catch (error) {
      throw toPaymentHttpError(error);
    }
  }
}

interface RefundBody {
  readonly reasonCode?: unknown;
  readonly amountPaise?: unknown;
  readonly idempotencyKey?: unknown;
}

/**
 * Support refunds (task 16.2). Default-deny: the caller must hold FUTURE_OPERATOR and match the
 * server-side support access policy for the payment's booking; everyone else sees 404.
 */
@Controller("support")
export class SupportPaymentController {
  constructor(
    @Inject(PAYMENT_AUTHENTICATOR) private readonly authenticator: PaymentSessionAuthenticator,
    @Inject(PAYMENT_REFUND_SERVICE) private readonly refunds: PaymentRefundService,
  ) {}

  @Post("payments/:paymentId/refunds")
  async requestRefund(
    @Req() request: HttpRequestLike,
    @Param("paymentId") paymentId: string,
    @Body() body: RefundBody = {},
    @Headers("x-correlation-id") correlationId?: string,
  ) {
    try {
      const principal = await scoped(this.authenticator, request, "FUTURE_OPERATOR");
      const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : header(request, "idempotency-key");
      if (idempotencyKey === undefined) {
        throw new PaymentValidationError("idempotencyKey", "A stable idempotency key is required to request a refund");
      }
      if (typeof body.reasonCode !== "string") throw new PaymentValidationError("reasonCode", "Choose a refund reason");
      return await this.refunds.requestRefund(principal, {
        paymentId: pathId(paymentId),
        reasonCode: body.reasonCode,
        ...(body.amountPaise === undefined || body.amountPaise === null ? {} : { amountPaise: wholePaise(body.amountPaise) }),
        idempotencyKey,
      }, { ...requestContext(request, correlationId), actorChannel: "OPERATOR" });
    } catch (error) {
      throw toPaymentHttpError(error);
    }
  }
}
