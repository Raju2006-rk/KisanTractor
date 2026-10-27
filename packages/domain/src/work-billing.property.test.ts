import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  applyDisclosedRounding,
  type BillingAgreementTerms,
  calculateFinalBill,
  FinalBillCalculationError,
  reproduceSubtotalFromTrace,
} from "./billing.js";
import { hourlyRoundingPolicies, type HourlyRoundingPolicy } from "./owner-catalog.js";
import {
  evaluateWorkSequence,
  foldActiveWorkIntervals,
  type RecordedWorkEvent,
  resolveWorkEventCorrections,
  type WorkAction,
  workActions,
  WorkSequenceError,
  type WorkState,
} from "./work-events.js";

// Feature: kisantractor-platform, Properties 8, 9 and 10 plus work-correction history (task 11.4).
const propertyRuns = 250;
const seeds = {
  workEventAccounting: 1_104_101,
  invalidSequences: 1_104_202,
  correctionHistory: 1_104_303,
  proportionalHourly: 1_104_404,
  blockHourly: 1_104_505,
  acreTripBilling: 1_104_606,
} as const;

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000n;
const baseTime = Date.UTC(2026, 2, 1, 6, 0, 0);

function runSeededProperty(name: string, seed: number, assertion: () => void): void {
  try {
    assertion();
    console.info(`[PBT] ${name}: seed=${seed} runs=${propertyRuns} minimizedCounterexample=none`);
  } catch (error) {
    console.error(`[PBT] ${name}: seed=${seed} minimizedCounterexample=reported by fast-check below`);
    throw error;
  }
}

/** Independent exact half-up rounding of a nonnegative rational to whole paise. */
function expectedHalfUp(numerator: bigint, denominator: bigint): number {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  return Number(remainder * 2n >= denominator ? quotient + 1n : quotient);
}

const eventId = (prefix: string, index: number): string => `${prefix}${String(index).padStart(4, "0")}`;

const original = (index: number, eventType: WorkAction, atMs: number): RecordedWorkEvent => ({
  id: eventId("e", index),
  eventType,
  effectiveAt: new Date(atMs),
  receivedAt: new Date(atMs),
});

interface Segment {
  readonly activeMs: number;
  /** Pause after this segment; ignored for the final segment, which ends with COMPLETE. */
  readonly pauseMs: number;
}

const segmentArbitrary: fc.Arbitrary<Segment> = fc.record({
  activeMs: fc.oneof(
    fc.integer({ min: 0, max: 8 * 60 }).map((minutes) => minutes * MINUTE_MS),
    fc.integer({ min: 0, max: 8 * 3_600_000 }),
  ),
  pauseMs: fc.integer({ min: 0, max: 4 * 3_600_000 }),
});

const segmentsArbitrary = fc.array(segmentArbitrary, { minLength: 1, maxLength: 8 });

/** Builds START, (PAUSE, RESUME)*, COMPLETE with authoritative server times. */
function buildSequence(segments: readonly Segment[]): RecordedWorkEvent[] {
  const events: RecordedWorkEvent[] = [];
  let clock = baseTime;
  events.push(original(0, "START", clock));
  segments.forEach((segment, index) => {
    clock += segment.activeMs;
    if (index === segments.length - 1) {
      events.push(original(events.length, "COMPLETE", clock));
      return;
    }
    events.push(original(events.length, "PAUSE", clock));
    clock += segment.pauseMs;
    events.push(original(events.length, "RESUME", clock));
  });
  return events;
}

const sumActive = (segments: readonly Segment[]): number =>
  segments.reduce((total, segment) => total + segment.activeMs, 0);

const nextActionsModel: Readonly<Record<WorkState, readonly WorkAction[]>> = {
  NOT_STARTED: ["START"],
  ACTIVE: ["PAUSE", "COMPLETE"],
  PAUSED: ["RESUME"],
  COMPLETED: [],
};

const stateAfter = (action: WorkAction): WorkState =>
  action === "START" || action === "RESUME" ? "ACTIVE" : action === "PAUSE" ? "PAUSED" : "COMPLETED";

/** Reference active-time model over already-resolved effective events. */
function modelActiveMs(events: readonly { readonly eventType: string; readonly effectiveAt: Date }[]): number {
  let openedAt: number | undefined;
  let total = 0;
  for (const event of events) {
    if (event.eventType === "START" || event.eventType === "RESUME") {
      openedAt = event.effectiveAt.getTime();
    } else if (openedAt !== undefined) {
      total += event.effectiveAt.getTime() - openedAt;
      openedAt = undefined;
    }
  }
  return total;
}

const hourlyTerms = (ratePaise: number, roundingPolicy: HourlyRoundingPolicy, agreementVersion = 1): BillingAgreementTerms => ({
  agreementId: "agreement-pbt",
  agreementVersion,
  pricingRuleId: "rule-pbt",
  pricingRuleVersion: 3,
  method: "HOURLY",
  ratePaise,
  currency: "INR",
  roundingPolicy,
});

const measuredTerms = (method: "PER_ACRE" | "PER_TRIP", ratePaise: number, agreementVersion = 1): BillingAgreementTerms => ({
  agreementId: "agreement-pbt",
  agreementVersion,
  pricingRuleId: "rule-pbt",
  pricingRuleVersion: 3,
  method,
  ratePaise,
  currency: "INR",
});

const rateArbitrary = fc.integer({ min: 1, max: 10_000_000 });
const agreementVersionArbitrary = fc.integer({ min: 1, max: 50 });

function decimalText(scaled: bigint, padFraction: boolean): string {
  const whole = scaled / 1_000n;
  const fraction = (scaled % 1_000n).toString().padStart(3, "0");
  if (padFraction) return `${whole}.${fraction}`;
  const trimmed = fraction.replace(/0+$/u, "");
  return trimmed.length === 0 ? whole.toString() : `${whole}.${trimmed}`;
}

describe("Property 10: Work Event Accounting", () => {
  /** **Validates: Requirements 9.1, 9.3, 9.4, 9.7** */
  it("sums closed active intervals exactly, excludes paused time, and is not increased by inserted pauses", () => {
    runSeededProperty("work-event-active-interval-accounting", seeds.workEventAccounting, () => {
      fc.assert(fc.property(
        segmentsArbitrary,
        fc.nat(),
        fc.integer({ min: 0, max: 1_000 }),
        fc.integer({ min: 0, max: 1_000 }),
        (segments, segmentPick, offsetPermille, gapPermille) => {
          const events = buildSequence(segments);
          const fold = foldActiveWorkIntervals(events);
          const expectedActive = sumActive(segments);

          expect(fold.state).toBe("COMPLETED");
          expect(fold.validNextActions).toEqual([]);
          expect(fold.openStartedAt).toBeUndefined();
          expect(fold.activeMilliseconds).toBe(expectedActive);
          expect(fold.activeMilliseconds).toBeGreaterThanOrEqual(0);
          expect(fold.activeMinutes).toBe(expectedActive / MINUTE_MS);
          expect(fold.intervals).toHaveLength(segments.length);

          // Closed, ordered, non-overlapping intervals whose durations make up the total.
          fold.intervals.forEach((interval, index) => {
            expect(interval.durationMilliseconds).toBe(segments[index]!.activeMs);
            expect(interval.endedAt.getTime() - interval.startedAt.getTime()).toBe(interval.durationMilliseconds);
            expect(interval.closedBy).toBe(index === segments.length - 1 ? "COMPLETE" : "PAUSE");
            const next = fold.intervals[index + 1];
            if (next !== undefined) expect(next.startedAt.getTime()).toBeGreaterThanOrEqual(interval.endedAt.getTime());
          });

          // Paused time is excluded: total span minus every pause.
          const span = events.at(-1)!.effectiveAt.getTime() - events[0]!.effectiveAt.getTime();
          const paused = segments.slice(0, -1).reduce((total, segment) => total + segment.pauseMs, 0);
          expect(fold.activeMilliseconds).toBe(span - paused);

          // Insert a paused interval inside one active segment without moving any other event.
          const k = segmentPick % segments.length;
          const target = segments[k]!;
          const offset = Math.floor((target.activeMs * offsetPermille) / 1_000);
          const gap = Math.floor(((target.activeMs - offset) * gapPermille) / 1_000);
          const split = (insertedPause: number): Segment[] => [
            ...segments.slice(0, k),
            { activeMs: offset, pauseMs: insertedPause },
            { activeMs: target.activeMs - offset - insertedPause, pauseMs: target.pauseMs },
            ...segments.slice(k + 1),
          ];
          const withPause = buildSequence(split(gap));
          expect(withPause.at(-1)!.effectiveAt).toEqual(events.at(-1)!.effectiveAt);
          const pausedFold = foldActiveWorkIntervals(withPause);
          expect(pausedFold.activeMilliseconds).toBeLessThanOrEqual(fold.activeMilliseconds);
          expect(pausedFold.activeMilliseconds).toBe(fold.activeMilliseconds - gap);

          // Splitting one active interval at a resume-safe boundary preserves active time.
          expect(foldActiveWorkIntervals(buildSequence(split(0))).activeMilliseconds).toBe(fold.activeMilliseconds);

          // Any still-open interval is excluded until a pause or completion closes it.
          const openPrefix = events.slice(0, 1 + 2 * k + (k === segments.length - 1 ? 0 : 2));
          const prefixFold = foldActiveWorkIntervals(openPrefix);
          expect(prefixFold.state).toBe("ACTIVE");
          expect(prefixFold.openStartedAt).toEqual(openPrefix.at(-1)!.effectiveAt);
          expect(prefixFold.activeMilliseconds).toBe(sumActive(segments.slice(0, k === segments.length - 1 ? k : k + 1)));
          expect(prefixFold.validNextActions).toEqual(["PAUSE", "COMPLETE"]);
        },
      ), { seed: seeds.workEventAccounting, numRuns: propertyRuns, verbose: 2 });
    });
  });

  /** **Validates: Requirements 9.1, 9.3** */
  it("rejects every out-of-sequence or backwards event with the current state and valid next actions, without mutation", () => {
    runSeededProperty("work-event-invalid-sequence-rejection", seeds.invalidSequences, () => {
      fc.assert(fc.property(
        fc.array(fc.record({
          action: fc.constantFrom(...workActions),
          deltaMs: fc.oneof(
            { weight: 6, arbitrary: fc.integer({ min: 0, max: 2 * 3_600_000 }) },
            { weight: 1, arbitrary: fc.integer({ min: -3_600_000, max: -1 }) },
          ),
        }), { minLength: 1, maxLength: 10 }),
        (steps) => {
          let effective = baseTime;
          const events: RecordedWorkEvent[] = steps.map((step, index) => {
            if (index > 0) effective += step.deltaMs;
            // Server receipt order is the command order; effective time may be corrected backwards.
            return {
              id: eventId("e", index),
              eventType: step.action,
              effectiveAt: new Date(effective),
              receivedAt: new Date(baseTime + index * 1_000),
            };
          });
          const before = structuredClone(events);

          let state: WorkState = "NOT_STARTED";
          let failure: { index: number; state: WorkState; backwards: boolean } | undefined;
          for (const [index, step] of steps.entries()) {
            if (index > 0 && step.deltaMs < 0) {
              failure = { index, state, backwards: true };
              break;
            }
            if (!nextActionsModel[state].includes(step.action)) {
              failure = { index, state, backwards: false };
              break;
            }
            state = stateAfter(step.action);
          }

          if (failure === undefined) {
            const evaluation = evaluateWorkSequence(events);
            expect(evaluation.state).toBe(state);
            expect(evaluation.validNextActions).toEqual(nextActionsModel[state]);
          } else {
            let thrown: unknown;
            try {
              evaluateWorkSequence(events);
            } catch (error) {
              thrown = error;
            }
            expect(thrown).toBeInstanceOf(WorkSequenceError);
            const sequenceError = thrown as WorkSequenceError;
            expect(sequenceError.code).toBe("WORK_EVENT_OUT_OF_SEQUENCE");
            expect(sequenceError.currentState).toBe(failure.state);
            expect(sequenceError.validNextActions).toEqual(nextActionsModel[failure.state]);
            expect(sequenceError.eventId).toBe(eventId("e", failure.index));
            expect(sequenceError.message).toMatch(failure.backwards ? /earlier than the preceding event/u : /^Cannot /u);
            expect(() => foldActiveWorkIntervals(events)).toThrow(WorkSequenceError);
          }
          expect(events).toEqual(before);
        },
      ), { seed: seeds.invalidSequences, numRuns: propertyRuns, verbose: 2 });
    });
  });

  /** **Validates: Requirements 9.4, 9.7** */
  it("applies the latest append-only correction per event while retaining every original record", () => {
    runSeededProperty("work-event-append-only-correction-history", seeds.correctionHistory, () => {
      fc.assert(fc.property(
        segmentsArbitrary,
        fc.array(fc.record({ target: fc.nat(), permille: fc.integer({ min: 0, max: 1_000 }) }), { minLength: 1, maxLength: 12 }),
        (segments, generatedCorrections) => {
          const originals = buildSequence(segments);
          const times = originals.map((event) => event.effectiveAt.getTime());
          const lastReceived = originals.at(-1)!.receivedAt.getTime();

          // Each corrected time stays between the midpoints to its neighbours, so any mix of
          // corrected and uncorrected events remains in nondecreasing effective order.
          const corrections: RecordedWorkEvent[] = generatedCorrections.map((correction, index) => {
            const i = correction.target % originals.length;
            const low = i === 0 ? times[0]! - 10 * MINUTE_MS : Math.ceil((times[i - 1]! + times[i]!) / 2);
            const high = i === originals.length - 1 ? times[i]! + 10 * MINUTE_MS : Math.floor((times[i]! + times[i + 1]!) / 2);
            return {
              id: eventId("c", index),
              eventType: "CORRECTION",
              effectiveAt: new Date(low + Math.floor(((high - low) * correction.permille) / 1_000)),
              receivedAt: new Date(lastReceived + (index + 1) * 1_000),
              correctionOfId: originals[i]!.id,
            };
          });
          const history = [...originals, ...corrections];
          const before = structuredClone(history);

          const latestByTarget = new Map<string, RecordedWorkEvent>();
          for (const correction of corrections) latestByTarget.set(correction.correctionOfId!, correction);

          const resolved = resolveWorkEventCorrections(history);
          expect(resolved).toHaveLength(originals.length);
          resolved.forEach((event, index) => {
            const source = originals[index]!;
            const latest = latestByTarget.get(source.id);
            expect(event.id).toBe(source.id);
            expect(event.eventType).toBe(source.eventType);
            expect(event.receivedAt).toEqual(source.receivedAt);
            expect(event.effectiveAt).toEqual(latest?.effectiveAt ?? source.effectiveAt);
            expect(event.correctedById).toBe(latest?.id);
          });

          const fold = foldActiveWorkIntervals(history);
          expect(fold.state).toBe("COMPLETED");
          expect(fold.activeMilliseconds).toBe(modelActiveMs(resolved));
          expect(fold.activeMilliseconds).toBeGreaterThanOrEqual(0);

          // The history itself is append-only: no original or correction record is changed or dropped.
          expect(history).toEqual(before);
          expect(history).toHaveLength(originals.length + corrections.length);
          // Without the corrections, the original evidence still folds to its original total.
          expect(foldActiveWorkIntervals(originals).activeMilliseconds).toBe(sumActive(segments));
        },
      ), { seed: seeds.correctionHistory, numRuns: propertyRuns, verbose: 2 });
    });
  });
});

describe("Property 8: Proportional Hourly Billing", () => {
  /** **Validates: Requirements 10.1, 10.5, 10.6, 10.7** */
  it("bills rate × active time ÷ 60 minutes with one half-up rounding and no upward time rounding", () => {
    runSeededProperty("proportional-hourly-billing", seeds.proportionalHourly, () => {
      fc.assert(fc.property(
        rateArbitrary,
        fc.oneof(
          fc.integer({ min: 0, max: 24 * 60 }).map((minutes) => minutes * MINUTE_MS),
          fc.integer({ min: 0, max: 24 * 3_600_000 }),
        ),
        agreementVersionArbitrary,
        (ratePaise, activeMilliseconds, agreementVersion) => {
          const bill = calculateFinalBill(hourlyTerms(ratePaise, "PROPORTIONAL_MINUTE", agreementVersion), {
            method: "HOURLY", activeMilliseconds, evidenceReferences: ["work_event:pbt"],
          });
          const expected = expectedHalfUp(BigInt(ratePaise) * BigInt(activeMilliseconds), HOUR_MS);

          expect(bill.subtotalPaise).toBe(expected);
          expect(bill.totalPaise).toBe(expected);
          expect(Number.isSafeInteger(bill.totalPaise)).toBe(true);
          expect(bill.ratePaise).toBe(ratePaise);
          expect(bill.agreementVersion).toBe(agreementVersion);
          expect(bill.roundingTrace.activeMilliseconds).toBe(activeMilliseconds);
          expect(bill.roundingTrace.billableMilliseconds).toBe(activeMilliseconds);
          expect(bill.roundingTrace.blockMinutes).toBeUndefined();
          expect(reproduceSubtotalFromTrace(bill.roundingTrace)).toBe(bill.subtotalPaise);
          // Whole-minute work billed proportionally: rate × minutes ÷ 60 exactly when divisible.
          if (activeMilliseconds % MINUTE_MS === 0 && (BigInt(ratePaise) * BigInt(activeMilliseconds / MINUTE_MS)) % 60n === 0n) {
            expect(bill.totalPaise).toBe(Number((BigInt(ratePaise) * BigInt(activeMilliseconds / MINUTE_MS)) / 60n));
          }
        },
      ), { seed: seeds.proportionalHourly, numRuns: propertyRuns, verbose: 2 });
    });
  });

  /** **Validates: Requirements 9.4, 10.1** */
  it("bills folded work events from closed active intervals only", () => {
    runSeededProperty("folded-work-events-to-proportional-bill", seeds.proportionalHourly + 1, () => {
      fc.assert(fc.property(rateArbitrary, segmentsArbitrary, (ratePaise, segments) => {
        const fold = foldActiveWorkIntervals(buildSequence(segments));
        const bill = calculateFinalBill(hourlyTerms(ratePaise, "PROPORTIONAL_MINUTE"), {
          method: "HOURLY", activeMilliseconds: fold.activeMilliseconds, evidenceReferences: [],
        });
        expect(bill.totalPaise).toBe(expectedHalfUp(BigInt(ratePaise) * BigInt(sumActive(segments)), HOUR_MS));
      }), { seed: seeds.proportionalHourly + 1, numRuns: propertyRuns, verbose: 2 });
    });
  });

  /** **Validates: Requirements 10.2, 10.5** */
  it("rounds disclosed block billing to the least block multiple at or above active time", () => {
    runSeededProperty("disclosed-block-hourly-billing", seeds.blockHourly, () => {
      fc.assert(fc.property(
        rateArbitrary,
        fc.integer({ min: 0, max: 24 * 60 }),
        fc.integer({ min: 0, max: 24 * 3_600_000 }),
        fc.constantFrom(...hourlyRoundingPolicies),
        (ratePaise, activeMinutes, activeMilliseconds, policy) => {
          const block = policy === "THIRTY_MINUTE_BLOCK" ? 30 : policy === "ONE_HOUR_BLOCK" ? 60 : undefined;
          const roundedMinutes = applyDisclosedRounding(activeMinutes, policy);
          if (block === undefined) {
            expect(roundedMinutes).toBe(activeMinutes);
          } else {
            expect(roundedMinutes % block).toBe(0);
            expect(roundedMinutes).toBeGreaterThanOrEqual(activeMinutes);
            expect(roundedMinutes - activeMinutes).toBeLessThan(block);
          }

          const bill = calculateFinalBill(hourlyTerms(ratePaise, policy), {
            method: "HOURLY", activeMilliseconds, evidenceReferences: [],
          });
          const active = BigInt(activeMilliseconds);
          const blockMs = block === undefined ? undefined : BigInt(block * MINUTE_MS);
          const billable = blockMs === undefined ? active : ((active + blockMs - 1n) / blockMs) * blockMs;
          expect(BigInt(bill.roundingTrace.billableMilliseconds!)).toBe(billable);
          if (blockMs !== undefined) {
            expect(billable % blockMs).toBe(0n);
            expect(billable >= active && billable - active < blockMs).toBe(true);
          }
          expect(bill.totalPaise).toBe(expectedHalfUp(BigInt(ratePaise) * billable, HOUR_MS));
          expect(reproduceSubtotalFromTrace(bill.roundingTrace)).toBe(bill.subtotalPaise);
        },
      ), { seed: seeds.blockHourly, numRuns: propertyRuns, verbose: 2 });
    });
  });
});

describe("Property 9: Acre and Trip Billing", () => {
  /** **Validates: Requirements 10.3, 10.4, 10.5, 10.6, 10.7** */
  it("bills rate × acres with one final rounding and rate × trips exactly, recording a reproducible trace", () => {
    runSeededProperty("acre-and-trip-billing", seeds.acreTripBilling, () => {
      fc.assert(fc.property(
        rateArbitrary,
        fc.integer({ min: 0, max: 1_000_000_000 }).map(BigInt),
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.boolean(),
        fc.boolean(),
        agreementVersionArbitrary,
        fc.integer({ min: 0, max: 1_000 }),
        (ratePaise, scaledAcres, trips, padFraction, numericInput, agreementVersion, adjustmentPermille) => {
          const acreText = decimalText(scaledAcres, padFraction);
          const acreBill = calculateFinalBill(measuredTerms("PER_ACRE", ratePaise, agreementVersion), {
            method: "PER_ACRE",
            completedAcres: numericInput ? Number(decimalText(scaledAcres, false)) : acreText,
            evidenceReferences: ["work_measurement:pbt"],
          });
          const expectedAcres = expectedHalfUp(BigInt(ratePaise) * scaledAcres, 1_000n);
          expect(acreBill.subtotalPaise).toBe(expectedAcres);
          expect(acreBill.totalPaise).toBe(expectedAcres);
          expect(acreBill.billableQuantity).toBe(decimalText(scaledAcres, false));
          expect(acreBill.billableUnit).toBe("ACRE");
          expect(acreBill.agreementVersion).toBe(agreementVersion);
          expect(acreBill.roundingTrace.roundingPolicy).toBeUndefined();
          expect(reproduceSubtotalFromTrace(acreBill.roundingTrace)).toBe(acreBill.subtotalPaise);

          // Adjustments are applied after the single rounding and never make the total negative.
          const adjustment = -Math.floor((expectedAcres * adjustmentPermille) / 1_000);
          const adjusted = calculateFinalBill(measuredTerms("PER_ACRE", ratePaise), {
            method: "PER_ACRE", completedAcres: acreText, evidenceReferences: [],
          }, adjustment);
          expect(adjusted.subtotalPaise).toBe(expectedAcres);
          expect(adjusted.totalPaise).toBe(expectedAcres + adjustment);
          expect(adjusted.totalPaise).toBeGreaterThanOrEqual(0);

          const tripBill = calculateFinalBill(measuredTerms("PER_TRIP", ratePaise, agreementVersion), {
            method: "PER_TRIP", completedTrips: numericInput ? trips : String(trips), evidenceReferences: [],
          });
          const expectedTrips = BigInt(ratePaise) * BigInt(trips);
          expect(BigInt(tripBill.totalPaise)).toBe(expectedTrips);
          expect(tripBill.billableQuantity).toBe(String(trips));
          expect(tripBill.billableUnit).toBe("TRIP");
          expect(reproduceSubtotalFromTrace(tripBill.roundingTrace)).toBe(tripBill.subtotalPaise);

          // Fractional trip counts are never billable.
          const fractional = scaledAcres % 1_000n === 0n ? scaledAcres + 1n : scaledAcres;
          expect(() => calculateFinalBill(measuredTerms("PER_TRIP", ratePaise), {
            method: "PER_TRIP", completedTrips: decimalText(fractional, false), evidenceReferences: [],
          })).toThrow(FinalBillCalculationError);
        },
      ), { seed: seeds.acreTripBilling, numRuns: propertyRuns, verbose: 2 });
    });
  });
});
