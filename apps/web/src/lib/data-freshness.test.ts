import { describe, expect, it } from "vitest";

import { evaluateFreshness, freshnessWindowsMs, millisecondsUntilStale, type FreshnessKind } from "./data-freshness";

const checkedAt = new Date("2027-01-01T05:00:00.000Z");
const after = (milliseconds: number) => checkedAt.getTime() + milliseconds;
const kinds: readonly FreshnessKind[] = ["availability", "quote", "invoice", "payment"];

/** Validates: Requirements 17.3 */
describe("data freshness", () => {
  it("presents data as fresh only inside its window and stale after it", () => {
    for (const kind of kinds) {
      const window = freshnessWindowsMs[kind];
      expect(evaluateFreshness({ kind, checkedAt, now: after(window), online: true })).toBe("FRESH");
      expect(evaluateFreshness({ kind, checkedAt, now: after(window + 1), online: true })).toBe("STALE");
      expect(millisecondsUntilStale(kind, checkedAt, after(1_000))).toBe(window - 1_000);
      expect(millisecondsUntilStale(kind, checkedAt, after(window + 5))).toBe(0);
    }
    // Availability changes fastest; a bill is reissued least often.
    expect(freshnessWindowsMs.availability).toBeLessThan(freshnessWindowsMs.quote);
    expect(freshnessWindowsMs.quote).toBeLessThan(freshnessWindowsMs.invoice);
  });

  it("marks everything offline while the device is offline, even just-loaded data", () => {
    for (const kind of kinds) {
      expect(evaluateFreshness({ kind, checkedAt, now: checkedAt, online: false, pending: true })).toBe("OFFLINE");
    }
  });

  it("shows pending payment confirmations until they become stale", () => {
    expect(evaluateFreshness({ kind: "payment", checkedAt, now: after(1_000), online: true, pending: true })).toBe("PENDING");
    expect(evaluateFreshness({ kind: "payment", checkedAt, now: after(freshnessWindowsMs.payment + 1), online: true, pending: true })).toBe("STALE");
  });

  it("treats back-forward-cache restores, invalid timestamps, and far-future timestamps as stale", () => {
    expect(evaluateFreshness({ kind: "availability", checkedAt, now: checkedAt, online: true, restoredFromCache: true })).toBe("STALE");
    expect(evaluateFreshness({ kind: "invoice", checkedAt: "not-a-date", now: checkedAt, online: true })).toBe("STALE");
    expect(evaluateFreshness({ kind: "quote", checkedAt: after(10 * 60 * 1_000), now: checkedAt, online: true })).toBe("STALE");
    expect(evaluateFreshness({ kind: "quote", checkedAt: after(60 * 1_000), now: checkedAt, online: true })).toBe("FRESH");
  });
});
