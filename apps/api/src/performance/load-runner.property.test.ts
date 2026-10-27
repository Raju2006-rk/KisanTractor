import fc from "fast-check";
import { describe, it } from "vitest";

import { createRandom, summarizeLatencies } from "./load-runner.js";
import { scatter } from "./load-seed.js";

/** Validates: Requirement 18.4 (the measurement and the documented data placement are sound). */
describe("load harness properties", () => {
  it("reports ordered percentiles that are values from the sample", () => {
    fc.assert(fc.property(fc.array(fc.double({ min: 0, max: 10_000, noNaN: true }), { minLength: 1, maxLength: 200 }), (values) => {
      const summary = summarizeLatencies(values);
      const rounded = values.map((value) => Math.round(value * 10) / 10);
      return summary.p50Ms <= summary.p95Ms && summary.p95Ms <= summary.p99Ms && summary.p99Ms <= summary.maxMs
        && summary.maxMs === Math.max(...rounded) && rounded.includes(summary.p95Ms) && summary.count === values.length;
    }));
  });

  it("places seeded points no farther from their origin than the requested radius", () => {
    fc.assert(fc.property(
      fc.integer({ min: 0, max: 2 ** 31 - 1 }),
      fc.double({ min: 8, max: 30, noNaN: true }),
      fc.double({ min: 70, max: 90, noNaN: true }),
      fc.double({ min: 0.1, max: 100, noNaN: true }),
      (seed, latitude, longitude, kilometers) => {
        const [lat, lon] = scatter(createRandom(seed), latitude, longitude, kilometers);
        const radians = (degrees: number) => (degrees * Math.PI) / 180;
        const a = Math.sin(radians(lat - latitude) / 2) ** 2
          + Math.cos(radians(latitude)) * Math.cos(radians(lat)) * Math.sin(radians(lon - longitude) / 2) ** 2;
        // Haversine on a 6,371 km sphere; 1% covers the flat-earth approximation used to scatter.
        return 2 * 6_371 * Math.asin(Math.sqrt(a)) <= kilometers * 1.01 + 0.001;
      },
    ));
  });
});
