import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { migrations } from "./migrations.js";

/** Validates: Requirements 11.1, 11.2, 11.4, 12.3 */
describe("0012 payment record integrity migration", () => {
  const migration = migrations.find(({ id }) => id === "0012_payment_record_integrity");
  if (migration === undefined) throw new Error("Payment record integrity migration is not registered");
  const up = readFileSync(migration.up, "utf8");
  const down = readFileSync(migration.down, "utf8");

  it("is registered after invoice billing, transactional, and reversible", () => {
    const ids = migrations.map(({ id }) => id);
    expect(ids.indexOf("0012_payment_record_integrity")).toBe(ids.indexOf("0011_invoice_billing_integrity") + 1);
    expect(up.trimStart()).toMatch(/^BEGIN;/u);
    expect(up.trimEnd()).toMatch(/COMMIT;$/u);
    expect(down.trimStart()).toMatch(/^BEGIN;/u);
    expect(down.trimEnd()).toMatch(/COMMIT;$/u);
    for (const name of [
      "payments_method_status_chk",
      "payments_online_verification_chk",
      "payments_currency_inr_chk",
      "payment_events_status_change_chk",
    ]) {
      expect(up).toContain(name);
      expect(down).toContain(name);
    }
  });

  it("keeps cash statuses disjoint from online statuses and requires verification for paid-online", () => {
    expect(up).toMatch(/method = 'CASH' AND status IN \('PAID_CASH', 'REFUND_PENDING', 'REFUNDED'\)/u);
    expect(up).not.toMatch(/method = 'CASH' AND status IN \([^)]*PAID_ONLINE/u);
    expect(up).toMatch(/verified_at IS NOT NULL AND provider_reference IS NOT NULL/u);
  });
});
