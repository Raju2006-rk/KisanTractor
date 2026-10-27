import { describe, expect, it } from "vitest";

import {
  applyDisclosedRounding,
  type BillingAgreementTerms,
  calculateFinalBill,
  FinalBillCalculationError,
  reproduceSubtotalFromTrace,
} from "./billing.js";

const MINUTE = 60_000;

const terms = (overrides: Partial<BillingAgreementTerms> = {}): BillingAgreementTerms => ({
  agreementId: "agreement-1",
  agreementVersion: 1,
  pricingRuleId: "rule-1",
  pricingRuleVersion: 4,
  method: "HOURLY",
  ratePaise: 80_000,
  currency: "INR",
  roundingPolicy: "PROPORTIONAL_MINUTE",
  ...overrides,
});

const perAcre = (ratePaise: number): BillingAgreementTerms => {
  const { roundingPolicy: _policy, ...base } = terms({ method: "PER_ACRE", ratePaise });
  return base;
};
const perTrip = (ratePaise: number): BillingAgreementTerms => {
  const { roundingPolicy: _policy, ...base } = terms({ method: "PER_TRIP", ratePaise });
  return base;
};

/** Validates: Requirements 10.7 */
describe("PRD example totals", () => {
  it("bills 90 proportional minutes at ₹800/hour as ₹1,200", () => {
    const bill = calculateFinalBill(terms(), {
      method: "HOURLY", activeMilliseconds: 90 * MINUTE, evidenceReferences: ["work_event:start", "work_event:complete"],
    });
    expect(bill).toMatchObject({
      ratePaise: 80_000, billableQuantity: "1.5", billableUnit: "HOUR",
      subtotalPaise: 120_000, adjustmentsPaise: 0, totalPaise: 120_000,
    });
  });

  it("bills 3 acres at ₹1,200/acre as ₹3,600", () => {
    const bill = calculateFinalBill(perAcre(120_000), {
      method: "PER_ACRE", completedAcres: "3", evidenceReferences: ["work_measurement:m1"],
    });
    expect(bill).toMatchObject({ billableQuantity: "3", billableUnit: "ACRE", totalPaise: 360_000 });
  });

  it("bills 2 trips at ₹1,500/trip as ₹3,000", () => {
    const bill = calculateFinalBill(perTrip(150_000), {
      method: "PER_TRIP", completedTrips: 2, evidenceReferences: ["work_measurement:m1"],
    });
    expect(bill).toMatchObject({ billableQuantity: "2", billableUnit: "TRIP", totalPaise: 300_000 });
  });
});

/** Validates: Requirements 10.1, 10.2 */
describe("hourly rounding policies", () => {
  it("returns proportional minutes unchanged and rounds blocks up to the least multiple", () => {
    expect(applyDisclosedRounding(0, "THIRTY_MINUTE_BLOCK")).toBe(0);
    expect(applyDisclosedRounding(61, "PROPORTIONAL_MINUTE")).toBe(61);
    expect(applyDisclosedRounding(61, "THIRTY_MINUTE_BLOCK")).toBe(90);
    expect(applyDisclosedRounding(90, "THIRTY_MINUTE_BLOCK")).toBe(90);
    expect(applyDisclosedRounding(61, "ONE_HOUR_BLOCK")).toBe(120);
    expect(applyDisclosedRounding(60, "ONE_HOUR_BLOCK")).toBe(60);
  });

  it("never rounds proportional active time upward", () => {
    const bill = calculateFinalBill(terms(), {
      method: "HOURLY", activeMilliseconds: 61 * MINUTE + 30_000, evidenceReferences: [],
    });
    // ₹800/hour × 61.5 minutes = 82,000 paise exactly.
    expect(bill.totalPaise).toBe(82_000);
    expect(bill.roundingTrace).toMatchObject({ activeMilliseconds: 3_690_000, billableMilliseconds: 3_690_000 });
  });

  it("applies the disclosed block policy from the agreement", () => {
    const thirty = calculateFinalBill(terms({ roundingPolicy: "THIRTY_MINUTE_BLOCK" }), {
      method: "HOURLY", activeMilliseconds: 61 * MINUTE, evidenceReferences: [],
    });
    const hour = calculateFinalBill(terms({ roundingPolicy: "ONE_HOUR_BLOCK" }), {
      method: "HOURLY", activeMilliseconds: 61 * MINUTE, evidenceReferences: [],
    });
    expect(thirty).toMatchObject({ billableQuantity: "1.5", totalPaise: 120_000 });
    expect(thirty.roundingTrace).toMatchObject({ blockMinutes: 30, billableMilliseconds: 90 * MINUTE });
    expect(hour).toMatchObject({ billableQuantity: "2", totalPaise: 160_000 });
  });
});

/** Validates: Requirements 10.5, 10.6 */
describe("single-boundary rounding and invoice trace", () => {
  it("rounds once at the final paise boundary rather than per intermediate step", () => {
    // 7 minutes at 1,001 paise/hour = 116.783… paise → 117 (not 7 × round(16.68) = 119).
    const bill = calculateFinalBill(terms({ ratePaise: 1_001 }), {
      method: "HOURLY", activeMilliseconds: 7 * MINUTE, evidenceReferences: [],
    });
    expect(bill.totalPaise).toBe(117);
    expect(bill.billableQuantity).toBe("0.117");
    expect(bill.roundingTrace.billableQuantityDisplayRounded).toBe(true);

    const acres = calculateFinalBill(perAcre(333), {
      method: "PER_ACRE", completedAcres: "1.505", evidenceReferences: [],
    });
    // 333 × 1.505 = 501.165 → 501 paise.
    expect(acres.totalPaise).toBe(501);
  });

  it("records agreement linkage, evidence, formula, adjustments, and a reproducible trace", () => {
    const bill = calculateFinalBill(terms({ agreementId: "agreement-7", agreementVersion: 2 }), {
      method: "HOURLY", activeMilliseconds: 90 * MINUTE, evidenceReferences: ["work_event:a", "work_event:b"],
    }, -5_000);
    expect(bill).toMatchObject({
      agreementId: "agreement-7", agreementVersion: 2, pricingRuleId: "rule-1", pricingRuleVersion: 4,
      subtotalPaise: 120_000, adjustmentsPaise: -5_000, totalPaise: 115_000,
      evidenceReferences: ["work_event:a", "work_event:b"],
    });
    expect(bill.formula).toContain("80000 paise/hour");
    expect(bill.roundingTrace).toMatchObject({
      method: "HOURLY", roundingPolicy: "PROPORTIONAL_MINUTE",
      minorUnitRounding: "HALF_UP_ONCE_AT_FINAL_PAISE", roundedSubtotalPaise: 120_000,
    });
    expect(reproduceSubtotalFromTrace(bill.roundingTrace)).toBe(bill.subtotalPaise);
    expect(Object.isFrozen(bill)).toBe(true);
  });
});

describe("billing validation", () => {
  it("rejects mismatched evidence, fractional trips, missing disclosure, and negative totals", () => {
    expect(() => calculateFinalBill(terms(), {
      method: "PER_ACRE", completedAcres: 1, evidenceReferences: [],
    })).toThrow(FinalBillCalculationError);
    expect(() => calculateFinalBill(perTrip(100), {
      method: "PER_TRIP", completedTrips: "1.5", evidenceReferences: [],
    })).toThrow(/integer/u);
    const { roundingPolicy: _policy, ...undisclosed } = terms();
    expect(() => calculateFinalBill(undisclosed, {
      method: "HOURLY", activeMilliseconds: MINUTE, evidenceReferences: [],
    })).toThrow(/rounding policy/u);
    expect(() => calculateFinalBill(perAcre(100), {
      method: "PER_ACRE", completedAcres: "-1", evidenceReferences: [],
    })).toThrow(FinalBillCalculationError);
    expect(() => calculateFinalBill(perTrip(100), {
      method: "PER_TRIP", completedTrips: 1, evidenceReferences: [],
    }, -101)).toThrow(/negative/u);
  });
});
