import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { normalizeRegistrationNumber } from "./owner-catalog.js";

/** Validates: Requirements 4.2, 12.1, 12.2 */
describe("Owner catalog registration property", () => {
  it("canonicalizes equivalent registration formatting without retaining separators", () => {
    fc.assert(fc.property(
      fc.tuple(
        fc.string({ unit: fc.constantFrom(..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"), minLength: 2, maxLength: 2 }),
        fc.string({ unit: fc.constantFrom(..."0123456789"), minLength: 1, maxLength: 2 }),
        fc.string({ unit: fc.constantFrom(..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"), minLength: 1, maxLength: 3 }),
        fc.string({ unit: fc.constantFrom(..."0123456789"), minLength: 2, maxLength: 4 }),
      ),
      ([state, district, series, number]) => {
        const canonical = `${state}${district}${series}${number}`;
        expect(normalizeRegistrationNumber(`${state}-${district} ${series}-${number}`)).toBe(canonical);
        expect(normalizeRegistrationNumber(canonical.toLowerCase())).toBe(canonical);
      },
    ), { seed: 5101, numRuns: 100 });
  });
});
