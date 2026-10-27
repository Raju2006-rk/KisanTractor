import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { migrations } from "./migrations.js";

/** Validates: Requirements 9.2, 9.7 */
describe("0010 job tracking indexes migration", () => {
  const migration = migrations.find(({ id }) => id === "0010_job_tracking_indexes");
  if (migration === undefined) throw new Error("Job tracking migration is not registered");
  const up = readFileSync(migration.up, "utf8");
  const down = readFileSync(migration.down, "utf8");

  it("is transactional and reversible", () => {
    expect(up.trimStart()).toMatch(/^BEGIN;/u);
    expect(up.trimEnd()).toMatch(/COMMIT;$/u);
    expect(down.trimStart()).toMatch(/^BEGIN;/u);
    expect(down.trimEnd()).toMatch(/COMMIT;$/u);
    for (const index of [
      "work_events_booking_actor_key_uniq",
      "work_events_booking_order_idx",
      "work_measurements_one_original_completion_uniq",
      "work_measurements_booking_order_idx",
    ]) {
      expect(up).toContain(index);
      expect(down).toContain(index);
    }
  });

  it("enforces command idempotency and one original completion measurement", () => {
    expect(up).toMatch(/CREATE UNIQUE INDEX work_events_booking_actor_key_uniq[\s\S]*?booking_id, actor_id, idempotency_key/u);
    expect(up).toMatch(/CREATE UNIQUE INDEX work_measurements_one_original_completion_uniq[\s\S]*?WHERE correction_of_id IS NULL/u);
  });
});
