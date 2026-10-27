import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { migrations } from "./migrations.js";

/** Validates: Requirements 10.6 */
describe("0011 invoice billing integrity migration", () => {
  const migration = migrations.find(({ id }) => id === "0011_invoice_billing_integrity");
  if (migration === undefined) throw new Error("Invoice billing migration is not registered");
  const up = readFileSync(migration.up, "utf8");
  const down = readFileSync(migration.down, "utf8");

  it("is transactional and reversible", () => {
    expect(up.trimStart()).toMatch(/^BEGIN;/u);
    expect(up.trimEnd()).toMatch(/COMMIT;$/u);
    expect(down.trimStart()).toMatch(/^BEGIN;/u);
    expect(down.trimEnd()).toMatch(/COMMIT;$/u);
    for (const name of [
      "booking_agreements_id_booking_uniq",
      "invoices_agreement_same_booking_fk",
      "invoices_supersession_chk",
      "invoices_supersedes_once_uniq",
      "invoices_rounding_trace_reproducible_chk",
    ]) {
      expect(up).toContain(name);
      expect(down).toContain(name);
    }
  });

  it("links invoices to an agreement of the same booking and requires a reproducible trace", () => {
    expect(up).toMatch(/FOREIGN KEY \(agreement_id, booking_id\)\s+REFERENCES public\.booking_agreements \(id, booking_id\)/u);
    expect(up).toMatch(/invoice_version = 1 AND supersedes_invoice_id IS NULL/u);
    expect(up).toMatch(/rounding_trace \? 'rawSubtotalNumerator'/u);
  });
});
