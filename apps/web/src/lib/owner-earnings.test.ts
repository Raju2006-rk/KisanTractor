import { describe, expect, it } from "vitest";

import { normalizeOwnerEarningsReport } from "./owner-earnings";

const valid = () => ({
  from: "2026-03-01", to: "2026-03-02", groupBy: "DAY", timezone: "Asia/Kolkata", currency: "INR",
  source: "AUTHORITATIVE_INVOICE_PAYMENT_RECORDS", privacy: "AGGREGATED_NO_PII", generatedAt: "2026-03-03T00:00:00.000Z",
  totals: { invoiceCount: 1, settledInvoiceCount: 1, invoicedPaise: 50000, outstandingPaise: 0, cashCollectedPaise: 50000,
    onlineCollectedPaise: 0, refundedPaise: 0, collectedPaise: 50000, netEarningsPaise: 50000 },
  periods: [{ period: "2026-03-01", invoiceCount: 1, settledInvoiceCount: 1, invoicedPaise: 50000, outstandingPaise: 0,
    cashCollectedPaise: 50000, onlineCollectedPaise: 0, refundedPaise: 0, collectedPaise: 50000, netEarningsPaise: 50000 }],
});

/** Validates: Requirements 11.7, 12.2 */
describe("Owner earnings response normalization", () => {
  it("accepts a consistent aggregate-only report", () => expect(normalizeOwnerEarningsReport(valid())).toMatchObject({ totals: { netEarningsPaise: 50000 } }));
  it("rejects inconsistent totals, excess rows, and record-level fields", () => {
    expect(normalizeOwnerEarningsReport({ ...valid(), totals: { ...valid().totals, collectedPaise: 1 } })).toBeUndefined();
    expect(normalizeOwnerEarningsReport({ ...valid(), periods: Array.from({ length: 367 }, () => valid().periods[0]) })).toBeUndefined();
    expect(normalizeOwnerEarningsReport({ ...valid(), periods: [{ ...valid().periods[0], collectedPaise: 1 }] })).toBeUndefined();
  });
});
