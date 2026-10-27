import type { AuthPrincipal } from "@kisantractor/domain";
import { describe, expect, it } from "vitest";

import type { PaymentRequestContext } from "../payment/index.js";
import { OwnerEarningsReportController } from "./earnings-report.controller.js";
import type { EarningsReportOptions, EarningsReportSessionAuthenticator, OwnerEarningsReport } from "./earnings-report.contracts.js";
import type { OwnerEarningsReportService } from "./earnings-report.service.js";

const report: OwnerEarningsReport = {
  from: "2026-03-01", to: "2026-03-02", groupBy: "DAY", timezone: "Asia/Kolkata", currency: "INR",
  source: "AUTHORITATIVE_INVOICE_PAYMENT_RECORDS", privacy: "AGGREGATED_NO_PII", generatedAt: new Date("2026-03-03T00:00:00Z"),
  totals: { invoiceCount: 0, settledInvoiceCount: 0, invoicedPaise: 0, outstandingPaise: 0, cashCollectedPaise: 0,
    onlineCollectedPaise: 0, refundedPaise: 0, collectedPaise: 0, netEarningsPaise: 0 }, periods: [],
};

class Authenticator implements EarningsReportSessionAuthenticator {
  constructor(private readonly principal: AuthPrincipal) {}
  async authenticateAccessCredential(): Promise<AuthPrincipal> { return this.principal; }
}

/** Validates: Requirements 12.2, 18.2 */
describe("OwnerEarningsReportController", () => {
  it("authenticates as Owner and forwards only bounded report dimensions", async () => {
    let call: { principal: AuthPrincipal; options: EarningsReportOptions; context: PaymentRequestContext } | undefined;
    const service = { get: async (principal: AuthPrincipal, options: EarningsReportOptions, context: PaymentRequestContext) => {
      call = { principal, options, context }; return report;
    } } as OwnerEarningsReportService;
    const controller = new OwnerEarningsReportController(
      new Authenticator({ userId: "owner-1", roles: ["OWNER", "FARMER"], sessionId: "session-1" }), service,
    );
    await expect(controller.earnings({ headers: { authorization: "Bearer token", "user-agent": "test" } },
      "2026-03-01", "2026-03-02", "MONTH", "correlation-1")).resolves.toBe(report);
    expect(call).toEqual({
      principal: { userId: "owner-1", roles: ["OWNER"], sessionId: "session-1" },
      options: { from: "2026-03-01", to: "2026-03-02", groupBy: "MONTH" },
      context: { correlationId: "correlation-1", actorChannel: "WEB" },
    });
  });

  it("returns not found semantics to a non-Owner", async () => {
    const controller = new OwnerEarningsReportController(new Authenticator({ userId: "farmer-1", roles: ["FARMER"], sessionId: "s" }),
      { get: async () => report } as OwnerEarningsReportService);
    await expect(controller.earnings({ headers: { authorization: "Bearer token" } })).rejects.toMatchObject({ status: 404 });
  });
});
