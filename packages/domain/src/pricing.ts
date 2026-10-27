import type {
  HourlyRoundingPolicy,
  PricingMethod,
} from "./owner-catalog.js";

export type EstimatedPricingQuantity = number | string;

export interface ActivePricingRuleProjection {
  readonly id: string;
  readonly serviceOfferingId: string;
  readonly method: PricingMethod;
  readonly ratePaise: number;
  readonly currency: "INR";
  readonly roundingPolicy?: HourlyRoundingPolicy;
  readonly version: number;
}

export interface PricingEstimate {
  readonly pricingRuleId: string;
  readonly pricingRuleVersion: number;
  readonly method: PricingMethod;
  readonly ratePaise: number;
  readonly currency: "INR";
  readonly roundingPolicy?: HourlyRoundingPolicy;
  /** Canonical decimal quantity in the selected method's unit, with at most three decimal places. */
  readonly estimatedQuantity: string;
  readonly estimatedTotalPaise: number;
}

export interface QuoteSnapshot extends PricingEstimate {
  /** ISO-8601 server instant at which the quote was disclosed. */
  readonly disclosedAt: string;
}

export class PricingEstimateError extends Error {
  readonly code = "PRICING_ESTIMATE_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "PricingEstimateError";
  }
}

const MAX_QUANTITY_WHOLE_DIGITS = 9;
const QUANTITY_SCALE = 1_000n;

const quantityParts = (quantity: EstimatedPricingQuantity): {
  readonly canonical: string;
  readonly scaled: bigint;
} => {
  if (typeof quantity === "number" && !Number.isFinite(quantity)) {
    throw new PricingEstimateError("Estimated quantity must be a finite nonnegative decimal");
  }
  const text = typeof quantity === "number" ? String(quantity) : quantity.trim();
  const match = new RegExp(`^(0|[1-9]\\d{0,${MAX_QUANTITY_WHOLE_DIGITS - 1}})(?:\\.(\\d{1,3}))?$`, "u")
    .exec(text);
  if (match === null || match[1] === undefined) {
    throw new PricingEstimateError("Estimated quantity must be nonnegative with at most three decimal places");
  }

  const whole = match[1];
  const fraction = (match[2] ?? "").padEnd(3, "0");
  const canonicalFraction = (match[2] ?? "").replace(/0+$/u, "");
  return {
    canonical: canonicalFraction.length === 0 ? whole : `${whole}.${canonicalFraction}`,
    scaled: BigInt(whole) * QUANTITY_SCALE + BigInt(fraction || "0"),
  };
};

const validateRule = (rule: ActivePricingRuleProjection): void => {
  if (!Number.isSafeInteger(rule.ratePaise) || rule.ratePaise <= 0) {
    throw new PricingEstimateError("Pricing Rule rate must be a positive whole number of paise");
  }
  if (!Number.isInteger(rule.version) || rule.version <= 0) {
    throw new PricingEstimateError("Pricing Rule version must be a positive integer");
  }
  if (rule.method === "HOURLY" && rule.roundingPolicy === undefined) {
    throw new PricingEstimateError("Hourly pricing requires a disclosed rounding policy");
  }
  if (rule.method !== "HOURLY" && rule.roundingPolicy !== undefined) {
    throw new PricingEstimateError("Non-hourly pricing cannot use a time rounding policy");
  }
};

/** Calculates one display estimate and rounds only at the final paise boundary. */
export function calculatePricingEstimate(
  rule: ActivePricingRuleProjection,
  estimatedQuantity: EstimatedPricingQuantity,
): PricingEstimate {
  validateRule(rule);
  const quantity = quantityParts(estimatedQuantity);
  const rawScaledPaise = BigInt(rule.ratePaise) * quantity.scaled;
  const total = (rawScaledPaise + QUANTITY_SCALE / 2n) / QUANTITY_SCALE;
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new PricingEstimateError("Estimated total is outside the supported paise range");
  }

  return Object.freeze({
    pricingRuleId: rule.id,
    pricingRuleVersion: rule.version,
    method: rule.method,
    ratePaise: rule.ratePaise,
    currency: rule.currency,
    ...(rule.roundingPolicy === undefined ? {} : { roundingPolicy: rule.roundingPolicy }),
    estimatedQuantity: quantity.canonical,
    estimatedTotalPaise: Number(total),
  });
}

/** Captures all catalog values needed to preserve a booking's agreed quote. */
export function createQuoteSnapshot(
  rule: ActivePricingRuleProjection,
  estimatedQuantity: EstimatedPricingQuantity,
  disclosedAt: Date,
): QuoteSnapshot {
  if (Number.isNaN(disclosedAt.getTime())) {
    throw new PricingEstimateError("Quote disclosure time must be valid");
  }
  return Object.freeze({
    ...calculatePricingEstimate(rule, estimatedQuantity),
    disclosedAt: disclosedAt.toISOString(),
  });
}
