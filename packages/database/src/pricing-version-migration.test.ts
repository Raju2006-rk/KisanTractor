import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { migrations } from "./migrations.js";

/** Validates: Requirements 6.6, 6.7 */
describe("0008 versioned Pricing Rules migration", () => {
  it("allows historical versions while enforcing one current method per offering", () => {
    const migration = migrations.find((candidate) => candidate.id === "0008_versioned_pricing_rules");
    expect(migration).toBeDefined();
    const upSql = readFileSync(migration!.up, "utf8");
    const downSql = readFileSync(migration!.down, "utf8");

    expect(upSql).toMatch(/DROP INDEX IF EXISTS public\.pricing_rules_offering_method_unique_idx/iu);
    expect(upSql).toMatch(
      /CREATE UNIQUE INDEX pricing_rules_current_offering_method_unique_idx[\s\S]*WHERE valid_to IS NULL/iu,
    );
    expect(downSql).toMatch(/CREATE UNIQUE INDEX pricing_rules_offering_method_unique_idx/iu);
  });
});
