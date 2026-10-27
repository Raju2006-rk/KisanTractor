import type { HourlyRoundingPolicy, PricingMethod } from "./owner-catalog.js";

/** The agreed booking terms an invoice is calculated from; never the current catalog rule. */
export interface BillingAgreementTerms {
  readonly agreementId: string;
  readonly agreementVersion: number;
  readonly pricingRuleId: string;
  readonly pricingRuleVersion: number;
  readonly method: PricingMethod;
  readonly ratePaise: number;
  readonly currency: "INR";
  readonly roundingPolicy?: HourlyRoundingPolicy;
}

export type BillingWorkEvidence =
  | {
    readonly method: "HOURLY";
    /** Sum of closed, non-overlapping active intervals in whole milliseconds. */
    readonly activeMilliseconds: number;
    readonly evidenceReferences: readonly string[];
  }
  | {
    readonly method: "PER_ACRE";
    readonly completedAcres: number | string;
    readonly evidenceReferences: readonly string[];
  }
  | {
    readonly method: "PER_TRIP";
    readonly completedTrips: number | string;
    readonly evidenceReferences: readonly string[];
  };

export type BillableUnit = "HOUR" | "ACRE" | "TRIP";

export interface FinalBillRoundingTrace {
  readonly method: PricingMethod;
  readonly roundingPolicy?: HourlyRoundingPolicy;
  readonly activeMilliseconds?: number;
  readonly blockMinutes?: number;
  readonly billableMilliseconds?: number;
  /** Measured quantity scaled by `quantityScale` (acres or trips). */
  readonly scaledQuantity?: string;
  readonly quantityScale?: string;
  /** Exact unrounded subtotal in paise is `rawSubtotalNumerator / rawSubtotalDenominator`. */
  readonly rawSubtotalNumerator: string;
  readonly rawSubtotalDenominator: string;
  readonly minorUnitRounding: "HALF_UP_ONCE_AT_FINAL_PAISE";
  readonly roundedSubtotalPaise: number;
  /** True when the displayed billable quantity is a 3-decimal rendering of an exact billable time. */
  readonly billableQuantityDisplayRounded: boolean;
}

export interface FinalBillCalculation {
  readonly agreementId: string;
  readonly agreementVersion: number;
  readonly pricingRuleId: string;
  readonly pricingRuleVersion: number;
  readonly method: PricingMethod;
  readonly ratePaise: number;
  readonly currency: "INR";
  readonly billableQuantity: string;
  readonly billableUnit: BillableUnit;
  readonly subtotalPaise: number;
  readonly adjustmentsPaise: number;
  readonly totalPaise: number;
  readonly evidenceReferences: readonly string[];
  readonly formula: string;
  readonly roundingTrace: FinalBillRoundingTrace;
}

export class FinalBillCalculationError extends Error {
  readonly code = "FINAL_BILL_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "FinalBillCalculationError";
  }
}

const MILLISECONDS_PER_MINUTE = 60_000n;
const MILLISECONDS_PER_HOUR = 3_600_000n;
const QUANTITY_SCALE = 1_000n;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

const blockMinutesByPolicy = Object.freeze({
  PROPORTIONAL_MINUTE: undefined,
  THIRTY_MINUTE_BLOCK: 30,
  ONE_HOUR_BLOCK: 60,
}) satisfies Readonly<Record<HourlyRoundingPolicy, number | undefined>>;

/** Rounds a nonnegative rational half-up to an integer exactly once. */
const roundHalfUp = (numerator: bigint, denominator: bigint): bigint =>
  (numerator * 2n + denominator) / (denominator * 2n);

const scaledText = (scaled: bigint): string => {
  const whole = scaled / QUANTITY_SCALE;
  const fraction = (scaled % QUANTITY_SCALE).toString().padStart(3, "0").replace(/0+$/u, "");
  return fraction.length === 0 ? whole.toString() : `${whole}.${fraction}`;
};

const parseScaledQuantity = (value: number | string, field: string): bigint => {
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new FinalBillCalculationError(`${field} must be a finite nonnegative decimal`);
  }
  const text = typeof value === "number" ? String(value) : value.trim();
  const match = /^(0|[1-9]\d{0,8})(?:\.(\d{1,3}))?$/u.exec(text);
  if (match === null || match[1] === undefined) {
    throw new FinalBillCalculationError(`${field} must be nonnegative with at most three decimal places`);
  }
  return BigInt(match[1]) * QUANTITY_SCALE + BigInt((match[2] ?? "").padEnd(3, "0"));
};

const toSafeNumber = (value: bigint, field: string): number => {
  if (value > MAX_SAFE || value < -MAX_SAFE) {
    throw new FinalBillCalculationError(`${field} is outside the supported paise range`);
  }
  return Number(value);
};

const validateTerms = (terms: BillingAgreementTerms): void => {
  if (!Number.isSafeInteger(terms.ratePaise) || terms.ratePaise <= 0) {
    throw new FinalBillCalculationError("Agreed rate must be a positive whole number of paise");
  }
  if (!Number.isInteger(terms.agreementVersion) || terms.agreementVersion <= 0) {
    throw new FinalBillCalculationError("Agreement version must be a positive integer");
  }
  if (!Number.isInteger(terms.pricingRuleVersion) || terms.pricingRuleVersion <= 0) {
    throw new FinalBillCalculationError("Pricing Rule version must be a positive integer");
  }
  if (terms.method === "HOURLY" && terms.roundingPolicy === undefined) {
    throw new FinalBillCalculationError("Hourly billing requires the rounding policy disclosed in the agreement");
  }
  if (terms.method !== "HOURLY" && terms.roundingPolicy !== undefined) {
    throw new FinalBillCalculationError("Non-hourly billing cannot apply a time rounding policy");
  }
};

/**
 * Returns billable minutes for a disclosed policy. Proportional billing returns minutes unchanged;
 * block policies return the least block multiple greater than or equal to the active minutes.
 */
export function applyDisclosedRounding(activeMinutes: number, policy: HourlyRoundingPolicy): number {
  if (!Number.isSafeInteger(activeMinutes) || activeMinutes < 0) {
    throw new FinalBillCalculationError("Active minutes must be a nonnegative integer");
  }
  const block = blockMinutesByPolicy[policy];
  return block === undefined ? activeMinutes : Math.ceil(activeMinutes / block) * block;
}

interface RawSubtotal {
  readonly numerator: bigint;
  readonly denominator: bigint;
  readonly billableQuantity: string;
  readonly billableUnit: BillableUnit;
  readonly formula: string;
  readonly trace: Omit<FinalBillRoundingTrace,
    "rawSubtotalNumerator" | "rawSubtotalDenominator" | "minorUnitRounding" | "roundedSubtotalPaise">;
}

const hourlySubtotal = (terms: BillingAgreementTerms, activeMilliseconds: number): RawSubtotal => {
  if (!Number.isSafeInteger(activeMilliseconds) || activeMilliseconds < 0) {
    throw new FinalBillCalculationError("Active work time must be a nonnegative whole number of milliseconds");
  }
  const policy = terms.roundingPolicy!;
  const blockMinutes = blockMinutesByPolicy[policy];
  const active = BigInt(activeMilliseconds);
  let billable = active;
  if (blockMinutes !== undefined) {
    const blockMs = BigInt(blockMinutes) * MILLISECONDS_PER_MINUTE;
    billable = ((active + blockMs - 1n) / blockMs) * blockMs;
  }
  const scaledHours = roundHalfUp(billable * QUANTITY_SCALE, MILLISECONDS_PER_HOUR);
  return {
    numerator: BigInt(terms.ratePaise) * billable,
    denominator: MILLISECONDS_PER_HOUR,
    billableQuantity: scaledText(scaledHours),
    billableUnit: "HOUR",
    formula: `total_paise = round_half_up(${terms.ratePaise} paise/hour × ${billable} billable ms ÷ 3600000 ms/hour)`
      + (blockMinutes === undefined ? "" : `; billable ms = ceil(${active} active ms ÷ ${blockMinutes}-minute block) × block`),
    trace: {
      method: "HOURLY",
      roundingPolicy: policy,
      activeMilliseconds,
      ...(blockMinutes === undefined ? {} : { blockMinutes }),
      billableMilliseconds: toSafeNumber(billable, "Billable time"),
      billableQuantityDisplayRounded: scaledHours * MILLISECONDS_PER_HOUR !== billable * QUANTITY_SCALE,
    },
  };
};

const measuredSubtotal = (
  terms: BillingAgreementTerms,
  scaled: bigint,
  unit: "ACRE" | "TRIP",
): RawSubtotal => ({
  numerator: BigInt(terms.ratePaise) * scaled,
  denominator: QUANTITY_SCALE,
  billableQuantity: scaledText(scaled),
  billableUnit: unit,
  formula: `total_paise = round_half_up(${terms.ratePaise} paise/${unit.toLowerCase()} × ${scaledText(scaled)} ${unit.toLowerCase()}s)`,
  trace: {
    method: terms.method,
    scaledQuantity: scaled.toString(),
    quantityScale: QUANTITY_SCALE.toString(),
    billableQuantityDisplayRounded: false,
  },
});

/**
 * Calculates a reproducible final bill from the agreed terms and recorded work evidence.
 * Money is held as an exact rational until one half-up rounding at the final paise boundary.
 */
export function calculateFinalBill(
  terms: BillingAgreementTerms,
  evidence: BillingWorkEvidence,
  adjustmentsPaise = 0,
): FinalBillCalculation {
  validateTerms(terms);
  if (evidence.method !== terms.method) {
    throw new FinalBillCalculationError("Work evidence does not match the agreed pricing method");
  }
  if (!Number.isSafeInteger(adjustmentsPaise)) {
    throw new FinalBillCalculationError("Adjustments must be a whole number of paise");
  }

  let raw: RawSubtotal;
  if (evidence.method === "HOURLY") {
    raw = hourlySubtotal(terms, evidence.activeMilliseconds);
  } else if (evidence.method === "PER_ACRE") {
    raw = measuredSubtotal(terms, parseScaledQuantity(evidence.completedAcres, "Completed acres"), "ACRE");
  } else {
    const scaled = parseScaledQuantity(evidence.completedTrips, "Completed trips");
    if (scaled % QUANTITY_SCALE !== 0n) {
      throw new FinalBillCalculationError("Completed trips must be a nonnegative integer");
    }
    raw = measuredSubtotal(terms, scaled, "TRIP");
  }

  const subtotal = toSafeNumber(roundHalfUp(raw.numerator, raw.denominator), "Subtotal");
  const total = toSafeNumber(BigInt(subtotal) + BigInt(adjustmentsPaise), "Total");
  if (total < 0) throw new FinalBillCalculationError("Adjustments cannot make the invoice total negative");

  return Object.freeze({
    agreementId: terms.agreementId,
    agreementVersion: terms.agreementVersion,
    pricingRuleId: terms.pricingRuleId,
    pricingRuleVersion: terms.pricingRuleVersion,
    method: terms.method,
    ratePaise: terms.ratePaise,
    currency: terms.currency,
    billableQuantity: raw.billableQuantity,
    billableUnit: raw.billableUnit,
    subtotalPaise: subtotal,
    adjustmentsPaise,
    totalPaise: total,
    evidenceReferences: Object.freeze([...evidence.evidenceReferences]),
    formula: adjustmentsPaise === 0 ? raw.formula : `${raw.formula}; total_paise = subtotal + ${adjustmentsPaise} adjustment paise`,
    roundingTrace: Object.freeze({
      ...raw.trace,
      rawSubtotalNumerator: raw.numerator.toString(),
      rawSubtotalDenominator: raw.denominator.toString(),
      minorUnitRounding: "HALF_UP_ONCE_AT_FINAL_PAISE" as const,
      roundedSubtotalPaise: subtotal,
    }),
  });
}

/** Recomputes the subtotal from a stored trace so an invoice can be independently reproduced. */
export function reproduceSubtotalFromTrace(trace: Pick<FinalBillRoundingTrace,
  "rawSubtotalNumerator" | "rawSubtotalDenominator">): number {
  const numerator = BigInt(trace.rawSubtotalNumerator);
  const denominator = BigInt(trace.rawSubtotalDenominator);
  if (numerator < 0n || denominator <= 0n) {
    throw new FinalBillCalculationError("Invoice trace contains an invalid rational subtotal");
  }
  return toSafeNumber(roundHalfUp(numerator, denominator), "Subtotal");
}
