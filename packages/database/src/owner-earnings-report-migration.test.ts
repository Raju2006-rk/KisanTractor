import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { migrations } from "./migrations.js";

/** Validates: Requirements 11.7, 12.2, 12.5, 18.2 */
describe("0022 Owner earnings report indexes migration", () => {
  const migration = migrations.find(({ id }) => id === "0022_owner_earnings_report_indexes");
  if (migration === undefined) throw new Error("Owner earnings report index migration is not registered");
  const up = readFileSync(migration.up, "utf8");
  const down = readFileSync(migration.down, "utf8");

  it("adds only reversible indexes over retained authoritative financial records", () => {
    expect(up).toMatch(/^BEGIN;/u);
    expect(up).toMatch(/COMMIT;\s*$/u);
    expect(up).toContain("ON public.invoices");
    expect(up).toContain("ON public.payments");
    expect(up).toContain("ON public.payment_refunds");
    expect(up).not.toMatch(/CREATE\s+TABLE|earnings_total|analytics_total|customer_id|phone|recipient/iu);
    for (const index of [
      "invoices_created_reporting_idx",
      "payments_paid_reporting_idx",
      "payment_refunds_resolved_reporting_idx",
    ]) {
      expect(down).toContain(`DROP INDEX IF EXISTS public.${index}`);
    }
  });
});
