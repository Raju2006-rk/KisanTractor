import { Controller, Get, Headers, Inject, Query, Req } from "@nestjs/common";

import { PAYMENT_AUTHENTICATOR, toPaymentHttpError } from "../payment/index.js";
import { bearerCredential, requestContext, type HttpRequestLike } from "../payment/payment.controller.js";
import { PaymentNotFoundError } from "../payment/payment.service.js";
import type { EarningsReportSessionAuthenticator } from "./earnings-report.contracts.js";
import type { OwnerEarningsReportService } from "./earnings-report.service.js";

export const OWNER_EARNINGS_REPORT_SERVICE = Symbol("OWNER_EARNINGS_REPORT_SERVICE");

@Controller("owner/reports")
export class OwnerEarningsReportController {
  constructor(
    @Inject(PAYMENT_AUTHENTICATOR) private readonly authenticator: EarningsReportSessionAuthenticator,
    @Inject(OWNER_EARNINGS_REPORT_SERVICE) private readonly reports: OwnerEarningsReportService,
  ) {}

  @Get("earnings")
  async earnings(
    @Req() request: HttpRequestLike,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("groupBy") groupBy?: string,
    @Headers("x-correlation-id") correlationId?: string,
  ) {
    try {
      const principal = await this.authenticator.authenticateAccessCredential(bearerCredential(request));
      if (!principal.roles.includes("OWNER")) throw new PaymentNotFoundError();
      return await this.reports.get(
        { ...principal, roles: ["OWNER"] },
        { ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }), ...(groupBy === undefined ? {} : { groupBy }) },
        requestContext(request, correlationId),
      );
    } catch (error) {
      throw toPaymentHttpError(error);
    }
  }
}
