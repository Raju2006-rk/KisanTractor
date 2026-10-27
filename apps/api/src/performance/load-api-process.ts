import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

import type { MetricSample } from "@kisantractor/observability";

type HistogramSample = Extract<MetricSample, { readonly kind: "histogram" }>;

import { SECRET_ENV_KEYS, type RuntimeSecrets, type SecretEnvKey } from "../runtime-config.js";

const apiRoot = fileURLToPath(new URL("../../", import.meta.url));
const serverEntry = fileURLToPath(new URL("./load-api-server.ts", import.meta.url));

export interface LoadApiProcess {
  readonly baseUrl: string;
  readonly secrets: RuntimeSecrets;
  metrics(): Promise<readonly MetricSample[]>;
  resetMetrics(): Promise<void>;
  stop(): Promise<void>;
}

/** Fresh random key material per run, handed to the child as hex in its environment only. */
export function randomSecretHex(): Readonly<Record<SecretEnvKey, string>> {
  return Object.freeze(Object.fromEntries(SECRET_ENV_KEYS.map((name) => [name, randomBytes(32).toString("hex")]))) as Record<SecretEnvKey, string>;
}

const awaitMessage = <T>(child: ChildProcess, type: string, timeoutMs: number): Promise<T> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off("message", onMessage);
      reject(new Error(`load API did not answer ${type} within ${timeoutMs} ms`));
    }, timeoutMs);
    const onMessage = (message: { type?: string }) => {
      if (message?.type !== type) return;
      clearTimeout(timer);
      child.off("message", onMessage);
      resolve(message as T);
    };
    child.on("message", onMessage);
  });

/**
 * Starts `load-api-server.ts` in a child Node process (through tsx, as `pnpm dev` does) and
 * waits until it listens. `poolMax` overrides the pg pool size for tuning comparisons only.
 */
export async function startLoadApi(options: { databaseUrl: string; poolMax?: number; timeoutMs?: number }): Promise<LoadApiProcess> {
  const secretHex = randomSecretHex();
  const env: NodeJS.ProcessEnv = { ...process.env, ...secretHex, NODE_ENV: "production", LOAD_API_DATABASE_URL: options.databaseUrl };
  for (const key of ["VITEST", "VITEST_POOL_ID", "VITEST_WORKER_ID", "TEST", "LOAD_API_POOL_MAX"]) delete env[key];
  if (options.poolMax !== undefined) env.LOAD_API_POOL_MAX = String(options.poolMax);
  const child = spawn(process.execPath, ["--import", "tsx", serverEntry], { cwd: apiRoot, env, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let stderr = "";
  child.stderr!.on("data", (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString()}`.slice(-8_000);
  });
  const exited = new Promise<never>((_, reject) => {
    child.once("exit", (code) => reject(new Error(`load API exited with ${code}:\n${stderr}`)));
  });
  exited.catch(() => undefined);
  const ready = await Promise.race([awaitMessage<{ port: number }>(child, "ready", options.timeoutMs ?? 90_000), exited]);
  const secrets = Object.freeze(Object.fromEntries(
    Object.entries(secretHex).map(([name, hex]) => [name, Uint8Array.from(Buffer.from(hex, "hex"))]),
  )) as RuntimeSecrets;
  return {
    baseUrl: `http://127.0.0.1:${ready.port}`,
    secrets,
    async metrics() {
      const answer = awaitMessage<{ snapshot: MetricSample[] }>(child, "metrics", 10_000);
      child.send({ type: "metrics" });
      return (await answer).snapshot;
    },
    async resetMetrics() {
      const answer = awaitMessage(child, "metrics-reset", 10_000);
      child.send({ type: "reset-metrics" });
      await answer;
    },
    stop: () => new Promise<void>((resolve) => {
      if (child.exitCode !== null) return resolve();
      const timer = setTimeout(() => child.kill(), 10_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.disconnect();
    }),
  };
}

export interface ServerRouteLatency {
  readonly method: string;
  readonly route: string;
  readonly count: number;
  readonly meanMs: number;
  /** Upper bound of the histogram bucket holding the 95th percentile. */
  readonly p95UpperBoundMs: number | "+Inf";
  readonly statusClasses: readonly string[];
}

/**
 * Server-side view of a step from kt_http_server_request_duration_ms. Buckets are coarse
 * (…250, 500, 800, 1000…), so the p95 is reported as the bucket bound that contains it.
 */
export function summarizeServerLatency(snapshot: readonly MetricSample[]): ServerRouteLatency[] {
  const series = snapshot.filter((sample): sample is HistogramSample =>
    sample.kind === "histogram" && sample.name === "kt_http_server_request_duration_ms");
  const grouped = new Map<string, HistogramSample[]>();
  for (const sample of series) {
    const key = `${sample.labels.method} ${sample.labels.route}`;
    grouped.set(key, [...(grouped.get(key) ?? []), sample]);
  }
  return [...grouped.entries()].map(([key, samples]) => {
    const [method, route] = key.split(" ") as [string, string];
    const count = samples.reduce((sum, sample) => sum + sample.count, 0);
    const sum = samples.reduce((total, sample) => total + sample.sum, 0);
    const bounds = samples[0]!.buckets.map((bucket) => bucket.le);
    const cumulative = bounds.map((_, index) => samples.reduce((total, sample) => total + sample.buckets[index]!.count, 0));
    const p95Index = cumulative.findIndex((value) => value >= Math.ceil(count * 0.95));
    return {
      method,
      route,
      count,
      meanMs: Math.round((sum / Math.max(1, count)) * 10) / 10,
      p95UpperBoundMs: bounds[p95Index] ?? "+Inf",
      statusClasses: [...new Set(samples.map((sample) => sample.labels.status_class ?? "UNKNOWN"))].sort(),
    };
  }).sort((left, right) => right.count - left.count);
}
