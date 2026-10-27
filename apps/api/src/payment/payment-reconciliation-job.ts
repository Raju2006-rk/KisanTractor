import { randomUUID } from "node:crypto";

import type { PaymentRecoveryService, RecoveryRunResult } from "./payment-recovery.service.js";

export interface PaymentReconciliationJobOptions {
  /** Pause between passes. */
  readonly intervalMs?: number;
  readonly batchSize?: number;
  /** Receives codes only (never payloads or personal data). */
  readonly onFailure?: (code: string) => void;
}

export interface PaymentReconciliationPass {
  readonly intents: RecoveryRunResult;
  readonly refunds: RecoveryRunResult;
}

const DEFAULT_INTERVAL_MS = 5 * 60_000;
const DEFAULT_BATCH_SIZE = 25;

const failureCode = (error: unknown): string => {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && /^[A-Z0-9_]{1,64}$/u.test(code) ? code : "RECONCILIATION_PASS_FAILED";
};

/**
 * Periodic payment reconciliation (task 16.2), run by the worker process next to the outbox
 * worker. Each pass asks the provider about stale pending intents and refunds in flight, and
 * applies only what verified provider evidence proves, through the same idempotent store paths as
 * webhooks; a pass that fails part-way is simply repeated. Several workers may run it: every
 * effect is state-gated, so concurrent passes cannot double-apply.
 */
export class PaymentReconciliationJob {
  readonly #intervalMs: number;
  readonly #batchSize: number;
  readonly #onFailure: (code: string) => void;
  #loop: Promise<void> | undefined;
  #abort: AbortController | undefined;

  constructor(private readonly recovery: PaymentRecoveryService, options: PaymentReconciliationJobOptions = {}) {
    this.#intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.#batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    if (!Number.isSafeInteger(this.#intervalMs) || this.#intervalMs < 1_000) throw new RangeError("intervalMs must be at least 1000");
    if (!Number.isSafeInteger(this.#batchSize) || this.#batchSize < 1 || this.#batchSize > 200) throw new RangeError("batchSize must be 1..200");
    this.#onFailure = options.onFailure ?? (() => undefined);
  }

  async runOnce(): Promise<PaymentReconciliationPass> {
    const context = { correlationId: `payment-reconciliation:${randomUUID()}`, actorChannel: "SYSTEM" as const };
    const intents = await this.recovery.recoverPendingIntents(context, this.#batchSize);
    const refunds = await this.recovery.reconcileRefunds(context, this.#batchSize);
    return Object.freeze({ intents, refunds });
  }

  start(): void {
    if (this.#loop !== undefined) return;
    const abort = new AbortController();
    this.#abort = abort;
    this.#loop = (async () => {
      while (!abort.signal.aborted) {
        try {
          await this.runOnce();
        } catch (error) {
          this.#onFailure(failureCode(error));
        }
        // Always pause: items still pending at the provider must not turn into a hot loop of reads.
        await sleep(this.#intervalMs, abort.signal);
      }
    })();
  }

  async stop(): Promise<void> {
    this.#abort?.abort();
    await this.#loop;
    this.#loop = undefined;
    this.#abort = undefined;
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
