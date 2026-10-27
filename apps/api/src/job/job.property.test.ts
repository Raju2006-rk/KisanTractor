import type { AuthPrincipal } from "@kisantractor/domain";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type {
  JobStore,
  ValidatedWorkEventCorrection,
  ValidatedWorkMeasurementCorrection,
  WorkSessionProjection,
} from "./job.contracts.js";
import { JobService, JobValidationError } from "./job.service.js";

// Feature: kisantractor-platform, Property 10 correction-history reason requirement (task 11.4).
const propertyRuns = 150;
const seeds = { correctionReason: 1_104_707 } as const;

const now = new Date("2026-03-01T10:00:00.000Z");
const context = { correlationId: "job-property", actorChannel: "WEB" as const };

const session: WorkSessionProjection = {
  bookingId: "booking-1",
  bookingStatus: "FINAL_BILL_GENERATED",
  bookingVersion: 4,
  pricingMethod: "PER_ACRE",
  state: "COMPLETED",
  validNextActions: [],
  events: [],
  measurements: [],
  activeIntervals: [],
  activeMilliseconds: 0,
  activeMinutes: 0,
};

/** Records what reaches persistence so the property can prove rejected corrections never do. */
class RecordingJobStore implements JobStore {
  readonly eventCorrections: ValidatedWorkEventCorrection[] = [];
  readonly measurementCorrections: ValidatedWorkMeasurementCorrection[] = [];

  async loadWorkSession() { return session; }
  async recordAction() { return session; }
  async correctWorkEvent(input: ValidatedWorkEventCorrection) {
    this.eventCorrections.push(input);
    return session;
  }
  async correctWorkMeasurement(input: ValidatedWorkMeasurementCorrection) {
    this.measurementCorrections.push(input);
    return session;
  }
}

async function outcome(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
    return undefined;
  } catch (error) {
    return error;
  }
}

async function runSeededProperty(name: string, seed: number, assertion: () => Promise<void>): Promise<void> {
  try {
    await assertion();
    console.info(`[PBT] ${name}: seed=${seed} runs=${propertyRuns} minimizedCounterexample=none`);
  } catch (error) {
    console.error(`[PBT] ${name}: seed=${seed} minimizedCounterexample=reported by fast-check below`);
    throw error;
  }
}

const blankReasonArbitrary = fc.array(fc.constantFrom(" ", "\t", "\n", "\r", "\u00a0", "\u2003"), { maxLength: 8 })
  .map((parts) => parts.join(""));
const reasonArbitrary = fc.string({ minLength: 1, maxLength: 120 }).filter((value) => value.trim().length > 0);
const actorArbitrary = fc.stringMatching(/^owner-[a-z0-9]{1,12}$/u);

describe("Property 10: Work Event Accounting — correction history", () => {
  /** **Validates: Requirements 9.7** */
  it("requires a reason for every correction, attributes it to the acting Owner, and persists nothing otherwise", async () => {
    await runSeededProperty("work-correction-requires-reason-and-actor", seeds.correctionReason, async () => {
      await fc.assert(fc.asyncProperty(
        actorArbitrary,
        fc.oneof(blankReasonArbitrary, reasonArbitrary),
        fc.integer({ min: 0, max: 24 * 60 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        async (actorId, reason, correctedMinute, scaledQuantity) => {
          const owner: AuthPrincipal = { userId: actorId, sessionId: "session-1", roles: ["OWNER"] };
          const store = new RecordingJobStore();
          const service = new JobService(store, () => now);
          const correctedEffectiveAt = new Date(Date.UTC(2026, 2, 1, 0, correctedMinute));
          const correctedQuantity = (scaledQuantity / 1_000).toString();

          const eventResult = await outcome(() => service.correctWorkEvent(owner, {
            bookingId: "booking-1", eventId: "event-1", correctedEffectiveAt, reason, idempotencyKey: "correct-event",
          }, context));
          const measurementResult = await outcome(() => service.correctWorkMeasurement(owner, {
            bookingId: "booking-1", measurementId: "measurement-1", correctedQuantity, reason, idempotencyKey: "correct-measurement",
          }, context));

          if (reason.trim().length === 0) {
            for (const result of [eventResult, measurementResult]) {
              expect(result).toBeInstanceOf(JobValidationError);
              expect((result as JobValidationError).field).toBe("reason");
            }
            expect(store.eventCorrections).toHaveLength(0);
            expect(store.measurementCorrections).toHaveLength(0);
            return;
          }

          expect(eventResult).toBeUndefined();
          expect(measurementResult).toBeUndefined();
          expect(store.eventCorrections).toHaveLength(1);
          expect(store.measurementCorrections).toHaveLength(1);
          for (const correction of [store.eventCorrections[0]!, store.measurementCorrections[0]!]) {
            expect(correction.actorId).toBe(actorId);
            expect(correction.reason.length).toBeGreaterThan(0);
            expect(correction.reason).toBe(correction.reason.trim());
            expect(correction.receivedAt).toEqual(now);
          }
          expect(store.eventCorrections[0]!.correctedEffectiveAt).toEqual(correctedEffectiveAt);
          expect(store.measurementCorrections[0]!.correctedQuantity).toBe(correctedQuantity);
        },
      ), { seed: seeds.correctionReason, numRuns: propertyRuns, verbose: 2 });
    });
  });
});
