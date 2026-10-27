import { describe, expect, it } from "vitest";

import {
  calculatePricingEstimate,
  createQuoteSnapshot,
  PricingEstimateError,
  type ActivePricingRuleProjection,
} from "./pricing.js";

const hourlyRule: ActivePricingRuleProjection = {
  id: "pricing-v3",
  serviceOfferingId: "offering-1",
  method: "HOURLY",
  ratePaise: 80_000,
  currency: "INR",
  roundingPolicy: "THIRTY_MINUTE_BLOCK",
  version: 3,
};

/** Validates: Requirements 6.5, 6.6 */
describe("pricing estimates and Quote Snapshots", () => {
  it("shows method, rate, rounding disclosure, quantity, and a final-boundary estimate", () => {
    expect(calculatePricingEstimate(hourlyRule, "1.5")).toEqual({
      pricingRuleId: "pricing-v3",
      pricingRuleVersion: 3,
      method: "HOURLY",
      ratePaise: 80_000,
      currency: "INR",
      roundingPolicy: "THIRTY_MINUTE_BLOCK",
      estimatedQuantity: "1.5",
      estimatedTotalPaise: 120_000,
    });

    expect(calculatePricingEstimate({
      id: "acre-v1",
      serviceOfferingId: "offering-1",
      method: "PER_ACRE",
      ratePaise: 120_000,
      currency: "INR",
      version: 1,
    }, "3.125").estimatedTotalPaise).toBe(375_000);
  });

  it("creates a frozen value snapshot that is independent of later catalog objects", () => {
    const mutableCatalogRule = { ...hourlyRule };
    const quote = createQuoteSnapshot(
      mutableCatalogRule,
      "2.000",
      new Date("2025-03-01T10:00:00.000Z"),
    );

    mutableCatalogRule.ratePaise = 95_000;
    mutableCatalogRule.version = 4;

    expect(Object.isFrozen(quote)).toBe(true);
    expect(quote).toMatchObject({
      pricingRuleId: "pricing-v3",
      pricingRuleVersion: 3,
      ratePaise: 80_000,
      estimatedQuantity: "2",
      estimatedTotalPaise: 160_000,
      disclosedAt: "2025-03-01T10:00:00.000Z",
    });
  });

  it("rejects unsupported precision, negative quantities, and malformed rule disclosures", () => {
    for (const quantity of ["-1", "1.0001", Number.POSITIVE_INFINITY]) {
      expect(() => calculatePricingEstimate(hourlyRule, quantity)).toThrow(PricingEstimateError);
    }
    const { roundingPolicy: _roundingPolicy, ...hourlyWithoutDisclosure } = hourlyRule;
    expect(() => calculatePricingEstimate(hourlyWithoutDisclosure, 1))
      .toThrowError(/rounding policy/iu);
  });
});
