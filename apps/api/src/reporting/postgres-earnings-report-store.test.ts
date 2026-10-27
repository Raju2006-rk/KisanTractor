import type { SqlConnection, SqlPool, SqlQueryResult } from "@kisantractor/database";
import { describe, expect, it } from "vitest";

import { PostgresEarningsReportStore } from "./postgres-earnings-report-store.js";

class FakePool implements SqlPool, SqlConnection {
  statement = "";
  values: readonly unknown[] = [];
  async connect(): Promise<SqlConnection> { return this; }
  release(): void {}
  async query<Row extends object = Record<string, unknown>>(text: string, values: readonly unknown[] = []): Promise<SqlQueryResult<Row>> {
    if (/^(BEGIN|COMMIT|ROLLBACK)/u.test(text)) return { rows: [], rowCount: 0 };
    this.statement = text; this.values = values;
    return { rows: [{ period: "2026-03-01", invoice_count: "1", settled_invoice_count: "1", invoiced_paise: "50000",
      outstanding_paise: "0", cash_collected_paise: "50000", online_collected_paise: "0", refunded_paise: "0" }] as Row[], rowCount: 1 };
  }
}

/** Validates: Requirements 11.7, 12.2, 12.5, 18.2 */
describe("PostgresEarningsReportStore", () => {
  it("uses one owner-scoped read-only aggregate over authoritative records", async () => {
    const pool = new FakePool();
    const rows = await new PostgresEarningsReportStore(pool).queryEarnings(
      { ownerId: "00000000-0000-4000-8000-000000000001", from: "2026-03-01", to: "2026-03-31", groupBy: "MONTH" },
      { correlationId: "correlation-1", actorChannel: "WEB" },
    );
    expect(rows).toEqual([{ period: "2026-03-01", invoiceCount: 1, settledInvoiceCount: 1, invoicedPaise: 50_000,
      outstandingPaise: 0, cashCollectedPaise: 50_000, onlineCollectedPaise: 0, refundedPaise: 0 }]);
    expect(pool.values).toEqual(["00000000-0000-4000-8000-000000000001", "2026-03-01", "2026-03-31", "month"]);
    for (const table of ["public.invoices", "public.payments", "public.payment_refunds"]) expect(pool.statement).toContain(table);
    expect(pool.statement).not.toMatch(/earnings_total|analytics_total|customer_id|recipient|phone|provider_reference/u);
  });
});
