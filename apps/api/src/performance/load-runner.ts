import { performance } from "node:perf_hooks";

import type { LoadOperationKind } from "./load-profile.js";

/** Small deterministic PRNG (mulberry32) so seeds and request mixes are reproducible. */
export function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function randomInt(random: () => number, minInclusive: number, maxInclusive: number): number {
  return minInclusive + Math.floor(random() * (maxInclusive - minInclusive + 1));
}

export function pick<T>(random: () => number, items: readonly T[]): T {
  if (items.length === 0) throw new Error("cannot pick from an empty list");
  return items[Math.floor(random() * items.length)]!;
}

/** Picks an entry with probability proportional to its share. Shares need not sum to 1. */
export function pickWeighted<T extends { readonly share: number }>(random: () => number, entries: readonly T[]): T {
  const total = entries.reduce((sum, entry) => sum + entry.share, 0);
  if (!(total > 0)) throw new Error("weighted pick needs a positive total share");
  let remaining = random() * total;
  for (const entry of entries) {
    remaining -= entry.share;
    if (remaining < 0) return entry;
  }
  return entries.at(-1)!;
}

/** Nearest-rank percentile (the same definition the web lab uses). */
export function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) throw new Error("percentile of an empty sample");
  if (!(fraction > 0 && fraction <= 1)) throw new RangeError("fraction must be in (0, 1]");
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(1, Math.ceil(fraction * sorted.length)) - 1]!;
}

export interface LatencySummary {
  readonly count: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
}

export function summarizeLatencies(values: readonly number[]): LatencySummary {
  if (values.length === 0) return { count: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0 };
  const round = (value: number) => Math.round(value * 10) / 10;
  return {
    count: values.length,
    p50Ms: round(percentile(values, 0.5)),
    p95Ms: round(percentile(values, 0.95)),
    p99Ms: round(percentile(values, 0.99)),
    maxMs: round(Math.max(...values)),
  };
}

/** How one executed request ended, as judged by the operation that issued it. */
export interface OperationOutcome {
  readonly status: number;
  /** True when the status is one this operation may legitimately return (for example 409 on a race). */
  readonly expected: boolean;
  /** Optional machine code for expected non-2xx outcomes, such as `OVERLAP`. */
  readonly code?: string;
}

interface Sample {
  readonly operation: string;
  readonly kind: LoadOperationKind;
  /** From the scheduled start, so queueing in the generator is not hidden (no coordinated omission). */
  readonly latencyMs: number;
  readonly status: number;
  readonly expected: boolean;
  readonly code?: string;
}

export interface OperationReport extends LatencySummary {
  readonly operation: string;
  readonly kind: LoadOperationKind;
  readonly statuses: Readonly<Record<string, number>>;
  readonly unexpected: number;
  readonly serverErrors: number;
}

export interface KindReport extends LatencySummary {
  readonly kind: LoadOperationKind;
  readonly unexpected: number;
  readonly serverErrors: number;
}

export interface StepReport {
  readonly label: string;
  readonly targetRequestsPerSecond: number;
  readonly achievedRequestsPerSecond: number;
  readonly durationSeconds: number;
  readonly maxInFlight: number;
  readonly byKind: readonly KindReport[];
  readonly byOperation: readonly OperationReport[];
}

/** Collects request samples for one load step. */
export class LatencyRecorder {
  readonly #samples: Sample[] = [];

  record(operation: string, kind: LoadOperationKind, latencyMs: number, outcome: OperationOutcome): void {
    this.#samples.push({
      operation, kind, latencyMs, status: outcome.status, expected: outcome.expected,
      ...(outcome.code === undefined ? {} : { code: outcome.code }),
    });
  }

  get size(): number {
    return this.#samples.length;
  }

  byKind(): KindReport[] {
    return (["read", "write"] as const).map((kind) => {
      const samples = this.#samples.filter((sample) => sample.kind === kind);
      return {
        kind,
        ...summarizeLatencies(samples.map((sample) => sample.latencyMs)),
        unexpected: samples.filter((sample) => !sample.expected).length,
        serverErrors: samples.filter((sample) => sample.status >= 500 || sample.status === 0).length,
      };
    });
  }

  byOperation(): OperationReport[] {
    const names = [...new Set(this.#samples.map((sample) => sample.operation))].sort();
    return names.map((operation) => {
      const samples = this.#samples.filter((sample) => sample.operation === operation);
      const statuses: Record<string, number> = {};
      for (const sample of samples) {
        const key = sample.code === undefined ? String(sample.status) : `${sample.status}:${sample.code}`;
        statuses[key] = (statuses[key] ?? 0) + 1;
      }
      return {
        operation,
        kind: samples[0]!.kind,
        ...summarizeLatencies(samples.map((sample) => sample.latencyMs)),
        statuses,
        unexpected: samples.filter((sample) => !sample.expected).length,
        serverErrors: samples.filter((sample) => sample.status >= 500 || sample.status === 0).length,
      };
    });
  }
}

export interface ScheduledOperation {
  readonly operation: string;
  readonly kind: LoadOperationKind;
  run(): Promise<OperationOutcome>;
}

export interface OpenLoopOptions {
  readonly label: string;
  readonly requestsPerSecond: number;
  readonly durationSeconds: number;
  /** Chooses and prepares the next request; called at each arrival. */
  readonly next: () => ScheduledOperation;
  readonly random: () => number;
  /** Arrivals beyond this many requests in flight are still sent but counted. */
  readonly inFlightWarning?: number;
  readonly recorder?: LatencyRecorder;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));

/**
 * Open-loop arrivals with exponential inter-arrival times (a Poisson process) at the target
 * rate. Each request starts at its scheduled time whether or not earlier ones finished, and its
 * latency is measured from that scheduled time, so a slow server cannot slow the offered load.
 */
export async function runOpenLoop(options: OpenLoopOptions): Promise<StepReport> {
  const recorder = options.recorder ?? new LatencyRecorder();
  const intervalMs = 1_000 / options.requestsPerSecond;
  const startedAt = performance.now();
  const endAt = startedAt + options.durationSeconds * 1_000;
  const inFlight = new Set<Promise<void>>();
  let maxInFlight = 0;
  let scheduled = startedAt;
  let launched = 0;

  while (scheduled < endAt) {
    await sleep(scheduled - performance.now());
    const intendedStart = scheduled;
    const operation = options.next();
    launched += 1;
    const task = operation.run()
      .catch((): OperationOutcome => ({ status: 0, expected: false, code: "CLIENT_ERROR" }))
      .then((outcome) => {
        recorder.record(operation.operation, operation.kind, performance.now() - intendedStart, outcome);
      })
      .finally(() => {
        inFlight.delete(task);
      });
    inFlight.add(task);
    maxInFlight = Math.max(maxInFlight, inFlight.size);
    scheduled += -Math.log(1 - options.random()) * intervalMs;
  }
  await Promise.all(inFlight);
  const durationSeconds = (performance.now() - startedAt) / 1_000;
  return {
    label: options.label,
    targetRequestsPerSecond: options.requestsPerSecond,
    achievedRequestsPerSecond: Math.round((launched / options.durationSeconds) * 10) / 10,
    durationSeconds: Math.round(durationSeconds * 10) / 10,
    maxInFlight,
    byKind: recorder.byKind(),
    byOperation: recorder.byOperation(),
  };
}

/** Renders a step as a Markdown table for the console and the performance doc. */
export function formatStepReport(report: StepReport): string {
  const header = "| Operation | Kind | Count | p50 ms | p95 ms | p99 ms | max ms | Statuses |\n|---|---|---:|---:|---:|---:|---:|---|";
  const rows = report.byOperation.map((row) =>
    `| ${row.operation} | ${row.kind} | ${row.count} | ${row.p50Ms} | ${row.p95Ms} | ${row.p99Ms} | ${row.maxMs} | ${
      Object.entries(row.statuses).map(([status, count]) => `${status}×${count}`).join(", ")} |`);
  const kinds = report.byKind.map((row) =>
    `| **all ${row.kind}s** | ${row.kind} | ${row.count} | ${row.p50Ms} | ${row.p95Ms} | ${row.p99Ms} | ${row.maxMs} | unexpected ${row.unexpected}, 5xx ${row.serverErrors} |`);
  return [
    `### ${report.label}: target ${report.targetRequestsPerSecond} req/s, achieved ${report.achievedRequestsPerSecond} req/s over ${report.durationSeconds} s, max in flight ${report.maxInFlight}`,
    "",
    header,
    ...rows,
    ...kinds,
  ].join("\n");
}
