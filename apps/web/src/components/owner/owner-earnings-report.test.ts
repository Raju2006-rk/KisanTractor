import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { OwnerEarningsReportView } from "../../lib/owner-earnings";
import { OwnerEarningsReport } from "./owner-earnings-report";

const report: OwnerEarningsReportView = {
  from: "2026-03-01", to: "2026-03-31", groupBy: "MONTH", timezone: "Asia/Kolkata", currency: "INR",
  source: "AUTHORITATIVE_INVOICE_PAYMENT_RECORDS", privacy: "AGGREGATED_NO_PII", generatedAt: new Date("2026-04-01T00:00:00Z"),
  totals: { invoiceCount: 2, settledInvoiceCount: 1, invoicedPaise: 180000, outstandingPaise: 60000, cashCollectedPaise: 80000,
    onlineCollectedPaise: 40000, refundedPaise: 10000, collectedPaise: 120000, netEarningsPaise: 110000 },
  periods: [{ period: "2026-03-01", invoiceCount: 2, settledInvoiceCount: 1, invoicedPaise: 180000, outstandingPaise: 60000,
    cashCollectedPaise: 80000, onlineCollectedPaise: 40000, refundedPaise: 10000, collectedPaise: 120000, netEarningsPaise: 110000 }],
};

/** Validates: Requirements 1.6, 11.7, 12.2, 13.1 */
describe("OwnerEarningsReport", () => {
  it("renders localized filters, financial summaries, and a source-of-truth notice", () => {
    const markup = renderToStaticMarkup(createElement(OwnerEarningsReport, { locale: "en", report }));
    expect(markup).toContain("Authoritative invoices and verified payment records");
    expect(markup).toContain("₹1,800");
    expect(markup).toContain("₹1,100");
    expect(markup).toContain('name="from"');
    expect(markup).toContain('name="groupBy"');
    expect(markup).not.toMatch(/9876543210|70000000-0000-4000-8000-000000000001|providerReference|bookingId|recipientName|latitude|longitude/u);
  });
});
