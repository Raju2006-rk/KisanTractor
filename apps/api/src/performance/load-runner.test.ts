import { describe, expect, it } from "vitest";

import { assertLoadProfileConsistent, dataVolume, requestMix } from "./load-profile.js";
import {
  createRandom,
  LatencyRecorder,
  percentile,
  pickWeighted,
  runOpenLoop,
  summarizeLatencies,
} from "./load-runner.js";
import { isoMicros } from "./load-seed.js";

describe("load profile", () => {
  it("is internally consistent: mixes sum to one and owners keep one to four Tractors", () => {
    expect(() => assertLoadProfileConsistent()).not.toThrow();
    const writes = requestMix.filter((entry) => entry.kind === "write").reduce((sum, entry) => sum + entry.share, 0);
    expect(writes).toBeCloseTo(0.2, 9);
    expect(dataVolume.tractors).toBeGreaterThan(dataVolume.owners);
  });
});

describe("load runner", () => {
  it("uses nearest-rank percentiles", () => {
    expect(percentile([5, 1, 4, 2, 3], 0.5)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95)).toBe(10);
    expect(percentile([7], 0.99)).toBe(7);
    expect(() => percentile([], 0.5)).toThrow();
    expect(summarizeLatencies([])).toMatchObject({ count: 0, p95Ms: 0 });
  });

  it("is reproducible for a seed and picks entries in proportion to their share", () => {
    const first = createRandom(42);
    const second = createRandom(42);
    expect(Array.from({ length: 5 }, first)).toEqual(Array.from({ length: 5 }, second));
    const random = createRandom(1);
    const counts = { a: 0, b: 0 };
    for (let index = 0; index < 20_000; index += 1) counts[pickWeighted(random, [{ id: "a", share: 0.8 }, { id: "b", share: 0.2 }] as const).id] += 1;
    expect(counts.a / 20_000).toBeGreaterThan(0.78);
    expect(counts.a / 20_000).toBeLessThan(0.82);
  });

  it("counts unexpected statuses and server errors separately from latency", () => {
    const recorder = new LatencyRecorder();
    recorder.record("read.a", "read", 10, { status: 200, expected: true });
    recorder.record("read.a", "read", 30, { status: 500, expected: false });
    recorder.record("write.b", "write", 20, { status: 409, expected: true, code: "OVERLAP" });
    const [reads, writes] = recorder.byKind();
    expect(reads).toMatchObject({ count: 2, unexpected: 1, serverErrors: 1, maxMs: 30 });
    expect(writes).toMatchObject({ count: 1, unexpected: 0, serverErrors: 0 });
    expect(recorder.byOperation().find((row) => row.operation === "write.b")!.statuses).toEqual({ "409:OVERLAP": 1 });
  });

  it("offers load open-loop at the target rate even when requests are slower than arrivals", async () => {
    const report = await runOpenLoop({
      label: "unit",
      requestsPerSecond: 100,
      durationSeconds: 0.5,
      random: createRandom(3),
      next: () => ({
        operation: "slow",
        kind: "read",
        run: () => new Promise((resolve) => setTimeout(() => resolve({ status: 200, expected: true }), 60)),
      }),
    });
    // Each request takes 60 ms but arrivals keep coming every ~10 ms, so several overlap.
    expect(report.maxInFlight).toBeGreaterThan(3);
    expect(report.byKind[0]!.count).toBeGreaterThan(25);
    expect(report.byKind[0]!.p50Ms).toBeGreaterThanOrEqual(55);
  });

  it("records a rejected request as a client failure instead of losing it", async () => {
    const report = await runOpenLoop({
      label: "unit",
      requestsPerSecond: 50,
      durationSeconds: 0.1,
      random: createRandom(4),
      next: () => ({ operation: "broken", kind: "write", run: () => Promise.reject(new Error("socket hang up")) }),
    });
    expect(report.byKind[1]!.serverErrors).toBe(report.byKind[1]!.count);
    expect(report.byOperation[0]!.statuses).toEqual({ [`0:CLIENT_ERROR`]: report.byKind[1]!.count });
  });
});

describe("load seed helpers", () => {
  it("formats microsecond timestamps that keep sub-millisecond order", () => {
    expect(isoMicros(Date.UTC(2025, 0, 2, 3, 4, 5, 6) + 0.789)).toBe("2025-01-02T03:04:05.006789Z");
    expect(isoMicros(Date.UTC(2025, 0, 2) + 0.05)).toBe("2025-01-02T00:00:00.000050Z");
  });
});
