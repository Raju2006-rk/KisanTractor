import type { AuthPrincipal } from "@kisantractor/domain";
import { describe, expect, it } from "vitest";

import type { PaymentRequestContext } from "../payment/index.js";
import type { EarningsReportQuery, EarningsReportRow, EarningsReportStore } from "./earnings-report.contracts.js";
import { MAXIMUM_EARNINGS_REPORT_DAYS, OwnerEarningsReportService, normalizeEarningsReportRange } from "./earnings-report.service.js";

const owner: AuthPrincipal = Object.freeze({ userId: "owner-1", roles: ["OWNER"], sessionId: "session-1" });
const context: PaymentRequestContext = Object.freeze({ correlationId: "correlation-1", actorChannel: "WEB" });

class MemoryStore implements EarningsReportStore {
  query?: EarningsReportQuery;
  constructor(readonly rows: readonly EarningsReportRow[]) {}
  async queryEarnings(query: EarningsReportQuery): Promise<readonly EarningsReportRow[]> {
    this.query = query;
    return this.rows;
  }
}

/** Validates: Requirements 1.6, 11.7, 12.2, 18.2 */
describe("OwnerEarningsReportService", () => {
  it("derives report totals from bounded invoice, payment, and refund projection rows", async () => {
    const store = new MemoryStore([
      { period: "2026-03-01", invoiceCount: 2, settledInvoiceCount: 1, invoicedPaise: 180_000, outstandingPaise: 60_000,
        cashCollectedPaise: 80_000, onlineCollectedPaise: 40_000, refundedPaise: 0 },
      { period: "2026-03-02", invoiceCount: 1, settledInvoiceCount: 1, invoicedPaise: 50_000, outstandingPaise: 0,
        cashCollectedPaise: 0, onlineCollectedPaise: 50_000, refundedPaise: 10_000 },
    ]);
    const report = await new OwnerEarningsReportService(store, () => new Date("2026-03-10T12:00:00.000Z"))
      .get(owner, { from: "2026-03-01", to: "2026-03-02", groupBy: "DAY" }, context);

    expect(store.query).toEqual({ ownerId: "owner-1", from: "2026-03-01", to: "2026-03-02", groupBy: "DAY" });
    expect(report).toMatchObject({
      source: "AUTHORITATIVE_INVOICE_PAYMENT_RECORDS", privacy: "AGGREGATED_NO_PII", currency: "INR", timezone: "Asia/Kolkata",
      totals: { invoiceCount: 3, settledInvoiceCount: 2, invoicedPaise: 230_000, outstandingPaise: 60_000,
        cashCollectedPaise: 80_000, onlineCollectedPaise: 90_000, collectedPaise: 170_000, refundedPaise: 10_000,
        netEarningsPaise: 160_000 },
    });
    expect(report.periods[1]).toMatchObject({ collectedPaise: 50_000, netEarningsPaise: 40_000 });
    expect(JSON.stringify(report)).not.toMatch(/customer|recipient|phone|location|providerReference|bookingId/u);
  });

  it("defaults to the last 30 India-calendar days and rejects unbounded or future ranges", () => {
    const now = new Date("2026-03-10T20:00:00.000Z"); // 2026-03-11 in India
    expect(normalizeEarningsReportRange({}, now)).toEqual({ from: "2026-02-10", to: "2026-03-11", groupBy: "DAY" });
    expect(() => normalizeEarningsReportRange({ from: "2025-01-01", to: "2026-03-11" }, now))
      .toThrow(`${MAXIMUM_EARNINGS_REPORT_DAYS} days`);
    expect(() => normalizeEarningsReportRange({ from: "2026-03-12", to: "2026-03-12" }, now)).toThrow("future");
    expect(() => normalizeEarningsReportRange({ from: "2026-02-30", to: "2026-03-01" }, now)).toThrow("valid calendar date");
  });

  it("denies non-Owners before querying financial records", async () => {
    const store = new MemoryStore([]);
    await expect(new OwnerEarningsReportService(store).get({ ...owner, roles: ["FARMER"] }, {}, context)).rejects.toMatchObject({ code: "PAYMENT_NOT_FOUND" });
    expect(store.query).toBeUndefined();
  });

  it("refuses malformed or excessive aggregate results", async () => {
    const invalid = new MemoryStore([{ period: "2026-03-01", invoiceCount: 0, settledInvoiceCount: 0, invoicedPaise: 0,
      outstandingPaise: 0, cashCollectedPaise: Number.MAX_SAFE_INTEGER, onlineCollectedPaise: 1, refundedPaise: 0 }]);
    await expect(new OwnerEarningsReportService(invalid, () => new Date("2026-03-10T00:00:00Z"))
      .get(owner, { from: "2026-03-01", to: "2026-03-01" }, context)).rejects.toThrow("invalid collection");
  });
});
