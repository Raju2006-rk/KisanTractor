import { describe, expect, it } from "vitest";

import {
  evaluateWorkSequence,
  foldActiveWorkIntervals,
  resolveWorkEventCorrections,
  type RecordedWorkEvent,
  WorkSequenceError,
} from "./work-events.js";

const at = (minutes: number) => new Date(Date.UTC(2026, 2, 1, 8, minutes));
const event = (id: string, eventType: RecordedWorkEvent["eventType"], minutes: number,
  correctionOfId?: string): RecordedWorkEvent => ({
  id,
  eventType,
  effectiveAt: at(minutes),
  receivedAt: at(minutes),
  ...(correctionOfId === undefined ? {} : { correctionOfId }),
});

/** Validates: Requirements 9.1, 9.3, 9.4 */
describe("work event sequence and active interval folding", () => {
  it("accepts start/pause/resume/complete order and excludes paused time", () => {
    const result = foldActiveWorkIntervals([
      event("start", "START", 0),
      event("pause", "PAUSE", 30),
      event("resume", "RESUME", 60),
      event("complete", "COMPLETE", 120),
    ]);

    expect(result.state).toBe("COMPLETED");
    expect(result.validNextActions).toEqual([]);
    expect(result.activeMinutes).toBe(90);
    expect(result.intervals).toEqual([
      { startedAt: at(0), endedAt: at(30), closedBy: "PAUSE", durationMilliseconds: 30 * 60_000 },
      { startedAt: at(60), endedAt: at(120), closedBy: "COMPLETE", durationMilliseconds: 60 * 60_000 },
    ]);
  });

  it("reports the current state and valid next actions for an invalid sequence", () => {
    try {
      evaluateWorkSequence([event("start", "START", 0), event("resume", "RESUME", 1)]);
      throw new Error("Expected sequence validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkSequenceError);
      expect(error).toMatchObject({ currentState: "ACTIVE", validNextActions: ["PAUSE", "COMPLETE"], eventId: "resume" });
    }
  });

  it("keeps an active interval open and excludes it until pause or completion closes it", () => {
    const result = foldActiveWorkIntervals([event("start", "START", 0)]);
    expect(result).toMatchObject({ state: "ACTIVE", activeMinutes: 0, openStartedAt: at(0) });
    expect(result.validNextActions).toEqual(["PAUSE", "COMPLETE"]);
  });
});

/** Validates: Requirements 9.7 */
describe("append-only work event corrections", () => {
  it("applies the latest correction while retaining the original and correction records", () => {
    const original = event("start", "START", 0);
    const pause = event("pause", "PAUSE", 30);
    const correction: RecordedWorkEvent = {
      id: "correction",
      eventType: "CORRECTION",
      effectiveAt: at(20),
      receivedAt: at(40),
      correctionOfId: "pause",
    };
    const all = [original, pause, correction];

    expect(resolveWorkEventCorrections(all)).toEqual([
      { id: "start", eventType: "START", effectiveAt: at(0), receivedAt: at(0) },
      { id: "pause", eventType: "PAUSE", effectiveAt: at(20), receivedAt: at(30), correctedById: "correction" },
    ]);
    expect(foldActiveWorkIntervals(all).activeMinutes).toBe(20);
    expect(all).toHaveLength(3);
    expect(all[1]?.effectiveAt).toEqual(at(30));
  });

  it("rejects a correction that makes effective event times run backwards", () => {
    const events: RecordedWorkEvent[] = [
      event("start", "START", 0),
      event("pause", "PAUSE", 30),
      { ...event("correction", "CORRECTION", 40, "pause"), effectiveAt: at(-1) },
    ];
    expect(() => evaluateWorkSequence(events)).toThrow("earlier than the preceding event");
  });
});
