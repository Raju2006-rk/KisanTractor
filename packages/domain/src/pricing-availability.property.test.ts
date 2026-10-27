import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  defaultCatalogEligibilityPolicy,
  evaluateTractorEligibility,
  hourlyRoundingPolicies,
  tractorOperationalStatuses,
} from "./owner-catalog.js";
import type {
  HourlyRoundingPolicy,
  PricingMethod,
  TractorEligibilityFacts,
  TractorOperationalStatus,
} from "./owner-catalog.js";
import {
  calculatePricingEstimate,
  createQuoteSnapshot,
} from "./pricing.js";
import type {
  ActivePricingRuleProjection,
  QuoteSnapshot,
} from "./pricing.js";

const propertyRuns = 250;
const seeds = {
  offlineExclusion: 6_405_203,
  quoteImmutability: 6_406_710,
} as const;

const evaluatedAt = new Date("2025-03-01T12:00:00.000Z");
const confirmedStatuses = ["ACCEPTED", "SCHEDULED", "IN_PROGRESS"] as const;
type GeneratedBookingStatus =
  | (typeof confirmedStatuses)[number]
  | "PENDING_OWNER_RESPONSE"
  | "WORK_COMPLETED"
  | "CANCELLED";

interface GeneratedTractor {
  readonly id: string;
  readonly ownerId: string;
  readonly operationalStatus: TractorOperationalStatus;
}

interface GeneratedBooking {
  readonly id: string;
  readonly tractorId: string;
  readonly status: GeneratedBookingStatus;
}

interface GeneratedEligibility {
  readonly hasRequiredTractorInformation: boolean;
  readonly hasRequiredDocuments: boolean;
  readonly hasEnabledServiceOffering: boolean;
  readonly hasActiveServicePricing: boolean;
  readonly locationAgeMs: number;
}

interface WorkEvidence {
  readonly method: PricingMethod;
  readonly billableQuantity: string;
  readonly evidenceReferences: readonly string[];
}

interface AgreedInvoiceProjection {
  readonly agreementVersion: number;
  readonly pricingRuleId: string;
  readonly ratePaise: number;
  readonly billableQuantity: string;
  readonly subtotalPaise: number;
  readonly totalPaise: number;
  readonly evidenceReferences: readonly string[];
  readonly formula: string;
  readonly roundingTrace: string;
}

const idPartArbitrary = fc.string({
  unit: fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789"),
  minLength: 1,
  maxLength: 12,
});

const eligibilityArbitrary = fc.record({
  hasRequiredTractorInformation: fc.boolean(),
  hasRequiredDocuments: fc.boolean(),
  hasEnabledServiceOffering: fc.boolean(),
  hasActiveServicePricing: fc.boolean(),
  locationAgeMs: fc.integer({
    min: 0,
    max: defaultCatalogEligibilityPolicy.maximumLocationAgeMs * 2,
  }),
});

const bookingStatusArbitrary = fc.constantFrom<GeneratedBookingStatus>(
  "PENDING_OWNER_RESPONSE",
  ...confirmedStatuses,
  "WORK_COMPLETED",
  "CANCELLED",
);

const decimalQuantityArbitrary = fc
  .integer({ min: 0, max: 1_000_000 })
  .map((scaled) => decimalFromScaled(scaled));

const workEvidenceArbitrary: fc.Arbitrary<WorkEvidence> = fc.oneof(
  fc.record({
    quarterHours: fc.integer({ min: 0, max: 2_000 }),
    evidenceReferences: fc.uniqueArray(idPartArbitrary, { minLength: 1, maxLength: 5 }),
  }).map(({ quarterHours, evidenceReferences }) => ({
    method: "HOURLY" as const,
    billableQuantity: decimalFromScaled(quarterHours * 250),
    evidenceReferences: evidenceReferences.map((id) => `work-event-${id}`),
  })),
  fc.record({
    acreageScaled: fc.integer({ min: 0, max: 1_000_000 }),
    evidenceReferences: fc.uniqueArray(idPartArbitrary, { minLength: 1, maxLength: 3 }),
  }).map(({ acreageScaled, evidenceReferences }) => ({
    method: "PER_ACRE" as const,
    billableQuantity: decimalFromScaled(acreageScaled),
    evidenceReferences: evidenceReferences.map((id) => `acre-measurement-${id}`),
  })),
  fc.record({
    trips: fc.integer({ min: 0, max: 10_000 }),
    evidenceReferences: fc.uniqueArray(idPartArbitrary, { minLength: 1, maxLength: 3 }),
  }).map(({ trips, evidenceReferences }) => ({
    method: "PER_TRIP" as const,
    billableQuantity: String(trips),
    evidenceReferences: evidenceReferences.map((id) => `trip-measurement-${id}`),
  })),
);

function decimalFromScaled(scaled: number): string {
  const whole = Math.floor(scaled / 1_000);
  const fraction = String(scaled % 1_000).padStart(3, "0").replace(/0+$/u, "");
  return fraction.length === 0 ? String(whole) : `${whole}.${fraction}`;
}

function eligibilityFacts(
  eligibility: GeneratedEligibility,
  operationalStatus: TractorOperationalStatus,
): TractorEligibilityFacts {
  return {
    hasRequiredTractorInformation: eligibility.hasRequiredTractorInformation,
    missingRequiredDocumentKinds: eligibility.hasRequiredDocuments
      ? []
      : [...defaultCatalogEligibilityPolicy.requiredDocumentKinds],
    hasEnabledServiceOffering: eligibility.hasEnabledServiceOffering,
    hasActiveServicePricing: eligibility.hasActiveServicePricing,
    locationUpdatedAt: new Date(evaluatedAt.getTime() - eligibility.locationAgeMs),
    operationalStatus,
  };
}

function existingManageableBookings(
  tractorId: string,
  bookings: readonly GeneratedBooking[],
): readonly GeneratedBooking[] {
  return bookings.filter((booking) =>
    booking.tractorId === tractorId
      && confirmedStatuses.some((status) => status === booking.status),
  );
}

function activeRuleFromQuote(quote: QuoteSnapshot): ActivePricingRuleProjection {
  return {
    id: quote.pricingRuleId,
    serviceOfferingId: "snapshotted-offering",
    method: quote.method,
    ratePaise: quote.ratePaise,
    currency: quote.currency,
    ...(quote.roundingPolicy === undefined
      ? {}
      : { roundingPolicy: quote.roundingPolicy }),
    version: quote.pricingRuleVersion,
  };
}

function calculateAgreedInvoice(
  quote: QuoteSnapshot,
  evidence: WorkEvidence,
): AgreedInvoiceProjection {
  const calculation = calculatePricingEstimate(
    activeRuleFromQuote(quote),
    evidence.billableQuantity,
  );
  return Object.freeze({
    agreementVersion: quote.pricingRuleVersion,
    pricingRuleId: quote.pricingRuleId,
    ratePaise: quote.ratePaise,
    billableQuantity: calculation.estimatedQuantity,
    subtotalPaise: calculation.estimatedTotalPaise,
    totalPaise: calculation.estimatedTotalPaise,
    evidenceReferences: Object.freeze([...evidence.evidenceReferences]),
    formula: `${quote.method}:${quote.ratePaise}*${calculation.estimatedQuantity}`,
    roundingTrace: "rounded-once-at-final-paise-boundary",
  });
}

function ruleForEvidence(
  id: string,
  serviceOfferingId: string,
  evidence: WorkEvidence,
  ratePaise: number,
  version: number,
  roundingPolicy: HourlyRoundingPolicy,
): ActivePricingRuleProjection {
  return {
    id,
    serviceOfferingId,
    method: evidence.method,
    ratePaise,
    currency: "INR",
    ...(evidence.method === "HOURLY" ? { roundingPolicy } : {}),
    version,
  };
}

function runSeededProperty(
  name: string,
  seed: number,
  assertion: () => void,
): void {
  try {
    assertion();
    console.info(
      `[PBT] ${name}: seed=${seed} runs=${propertyRuns} minimizedCounterexample=none`,
    );
  } catch (error) {
    console.error(
      `[PBT] ${name}: seed=${seed} minimizedCounterexample=reported by fast-check below`,
    );
    throw error;
  }
}

describe("Property 3: Offline Exclusion and Existing-Booking Preservation", () => {
  /** **Validates: Requirements 5.2, 5.3, 5.4** */
  it("excludes every offline Tractor from new demand without changing confirmed bookings", () => {
    const seed = seeds.offlineExclusion;

    runSeededProperty("offline-exclusion-existing-booking-preservation", seed, () => {
      fc.assert(
        fc.property(
          idPartArbitrary,
          idPartArbitrary,
          eligibilityArbitrary,
          fc.array(fc.constantFrom(...tractorOperationalStatuses), { minLength: 1, maxLength: 12 }),
          fc.array(fc.record({
            suffix: idPartArbitrary,
            belongsToTarget: fc.boolean(),
            status: bookingStatusArbitrary,
          }), { maxLength: 30 }),
          (tractorSuffix, ownerSuffix, eligibility, statusChanges, generatedBookings) => {
            const originalTractor: GeneratedTractor = Object.freeze({
              id: `tractor-${tractorSuffix}`,
              ownerId: `owner-${ownerSuffix}`,
              operationalStatus: statusChanges[0] ?? "OFFLINE",
            });
            const bookings: readonly GeneratedBooking[] = Object.freeze(
              generatedBookings.map((booking, index) => Object.freeze({
                id: `booking-${index}-${booking.suffix}`,
                tractorId: booking.belongsToTarget
                  ? originalTractor.id
                  : `${originalTractor.id}-other`,
                status: booking.status,
              })),
            );
            const before = existingManageableBookings(originalTractor.id, bookings);

            for (const operationalStatus of [...statusChanges, "OFFLINE" as const]) {
              const evaluation = evaluateTractorEligibility(
                originalTractor.id,
                eligibilityFacts(eligibility, operationalStatus),
                defaultCatalogEligibilityPolicy,
                evaluatedAt,
              );
              const isFullyEligible = evaluation.reasons.length === 0;

              expect(evaluation.discoverable).toBe(
                operationalStatus === "ONLINE" && isFullyEligible,
              );
              if (operationalStatus === "OFFLINE") {
                expect(evaluation.discoverable).toBe(false);
              }
            }

            const offlineTractor: GeneratedTractor = Object.freeze({
              ...originalTractor,
              operationalStatus: "OFFLINE",
            });
            const candidates = [offlineTractor].filter((tractor) =>
              evaluateTractorEligibility(
                tractor.id,
                eligibilityFacts(eligibility, tractor.operationalStatus),
                defaultCatalogEligibilityPolicy,
                evaluatedAt,
              ).discoverable,
            );

            expect(candidates.map((tractor) => tractor.id)).not.toContain(originalTractor.id);
            expect(existingManageableBookings(offlineTractor.id, bookings)).toEqual(before);
            expect(bookings).toEqual(generatedBookings.map((booking, index) => ({
              id: `booking-${index}-${booking.suffix}`,
              tractorId: booking.belongsToTarget
                ? originalTractor.id
                : `${originalTractor.id}-other`,
              status: booking.status,
            })));
          },
        ),
        { seed, numRuns: propertyRuns, verbose: 2 },
      );
    });
  });
});

describe("Property 7: Quote Immutability", () => {
  /** **Validates: Requirements 6.6, 6.7, 10.6** */
  it("keeps agreed snapshots and evidence-based billing independent of later catalog versions", () => {
    const seed = seeds.quoteImmutability;

    runSeededProperty("quote-snapshot-immutable-agreed-billing", seed, () => {
      fc.assert(
        fc.property(
          idPartArbitrary,
          idPartArbitrary,
          workEvidenceArbitrary,
          decimalQuantityArbitrary,
          fc.integer({ min: 1, max: 5_000_000 }),
          fc.integer({ min: 1, max: 5_000_000 }),
          fc.integer({ min: 1, max: 100 }),
          fc.integer({ min: 1, max: 20 }),
          fc.constantFrom(...hourlyRoundingPolicies),
          (
            ruleSuffix,
            offeringSuffix,
            evidence,
            estimatedQuantity,
            agreedRatePaise,
            rateDelta,
            agreedVersion,
            versionDelta,
            roundingPolicy,
          ) => {
            const serviceOfferingId = `offering-${offeringSuffix}`;
            const originalRule = ruleForEvidence(
              `pricing-${ruleSuffix}-v${agreedVersion}`,
              serviceOfferingId,
              evidence,
              agreedRatePaise,
              agreedVersion,
              roundingPolicy,
            );
            const agreedQuote = createQuoteSnapshot(
              originalRule,
              estimatedQuantity,
              evaluatedAt,
            );
            const confirmedBooking = Object.freeze({
              id: `booking-${ruleSuffix}`,
              serviceOfferingId,
              quoteSnapshot: agreedQuote,
            });
            const beforeCatalogChange = structuredClone(confirmedBooking.quoteSnapshot);
            const invoiceBeforeCatalogChange = calculateAgreedInvoice(
              confirmedBooking.quoteSnapshot,
              evidence,
            );

            const laterRule = ruleForEvidence(
              `pricing-${ruleSuffix}-v${agreedVersion + versionDelta}`,
              serviceOfferingId,
              evidence,
              agreedRatePaise + rateDelta,
              agreedVersion + versionDelta,
              roundingPolicy,
            );
            const pricingRuleVersions = Object.freeze([originalRule, laterRule]);
            const currentCatalogRule = pricingRuleVersions.at(-1);
            const invoiceAfterCatalogChange = calculateAgreedInvoice(
              confirmedBooking.quoteSnapshot,
              evidence,
            );

            expect(currentCatalogRule).toBe(laterRule);
            expect(currentCatalogRule?.ratePaise).not.toBe(agreedQuote.ratePaise);
            expect(currentCatalogRule?.version).toBeGreaterThan(agreedQuote.pricingRuleVersion);
            expect(confirmedBooking.quoteSnapshot).toEqual(beforeCatalogChange);
            expect(Object.isFrozen(confirmedBooking.quoteSnapshot)).toBe(true);
            expect(invoiceAfterCatalogChange).toEqual(invoiceBeforeCatalogChange);
            expect(invoiceAfterCatalogChange).toMatchObject({
              agreementVersion: agreedQuote.pricingRuleVersion,
              pricingRuleId: agreedQuote.pricingRuleId,
              ratePaise: agreedQuote.ratePaise,
              billableQuantity: evidence.billableQuantity,
              evidenceReferences: evidence.evidenceReferences,
            });
            expect(invoiceAfterCatalogChange.ratePaise).not.toBe(currentCatalogRule?.ratePaise);
          },
        ),
        { seed, numRuns: propertyRuns, verbose: 2 },
      );
    });
  });
});
