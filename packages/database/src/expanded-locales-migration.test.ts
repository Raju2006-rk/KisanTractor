import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { migrations } from "./migrations.js";

/** Validates: Requirements 13.1, 13.2, 18.5 */
describe("0023 expanded notification locales migration", () => {
  const migration = migrations.find(({ id }) => id === "0023_expand_notification_locales");
  if (migration === undefined) throw new Error("Expanded notification locales migration is not registered");
  const up = readFileSync(migration.up, "utf8");
  const down = readFileSync(migration.down, "utf8");

  it("widens the existing locale check without rewriting notification history", () => {
    expect(up).toMatch(/BEGIN;[\s\S]*COMMIT;/u);
    expect(up).toMatch(/template_locale IN \('en', 'hi', 'te', 'kn', 'ta', 'mr', 'bn'\)/u);
    expect(up).not.toMatch(/\b(?:UPDATE|DELETE\s+FROM)\s+public\.notifications\b/iu);
  });

  it("refuses a lossy rollback when expanded-locale records exist", () => {
    expect(down).toMatch(/template_locale IN \('mr', 'bn'\)/u);
    expect(down).toMatch(/RAISE EXCEPTION/u);
    expect(down).toMatch(/template_locale IN \('en', 'hi', 'te', 'kn', 'ta'\)/u);
  });
});
