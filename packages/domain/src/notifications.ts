/**
 * Provider-independent notification delivery rules and outbox retry policy.
 *
 * Notification delivery is always downstream of a committed domain transaction:
 * nothing in this module reads or changes booking, invoice, or payment state.
 */

export const notificationChannels = ["IN_APP", "SMS", "PUSH", "IVR"] as const;
export type NotificationChannel = (typeof notificationChannels)[number];

/**
 * Delivery states recorded for every generated notification.
 *
 * - `SENT`: a LIVE provider accepted the message; delivery is not yet confirmed.
 * - `SANDBOX_SENT`: a SANDBOX provider accepted it; test-only, no real recipient.
 * - `DELIVERED`: delivery is confirmed (in-app records are delivered when stored).
 * - `NOT_SENT`: no external attempt happened, for example an UNCONFIGURED channel.
 * - `FAILED`: an attempt failed and the outbox will retry it.
 * - `DEAD_LETTER`: retries are exhausted or the failure is permanent.
 */
export const notificationDeliveryStates = [
  "PENDING",
  "PROCESSING",
  "SENT",
  "SANDBOX_SENT",
  "DELIVERED",
  "NOT_SENT",
  "FAILED",
  "DEAD_LETTER",
] as const;
export type NotificationDeliveryState = (typeof notificationDeliveryStates)[number];

const settledStates: ReadonlySet<NotificationDeliveryState> = new Set([
  "SENT",
  "SANDBOX_SENT",
  "DELIVERED",
  "NOT_SENT",
  "DEAD_LETTER",
]);

/** A settled notification is never dispatched again, which keeps retries idempotent. */
export function isNotificationDispatchSettled(state: NotificationDeliveryState): boolean {
  return settledStates.has(state);
}

/** Only these states may be presented as "sent to a real recipient". */
export function claimsRealDelivery(state: NotificationDeliveryState): boolean {
  return state === "SENT" || state === "DELIVERED";
}

export type ChannelDispatchOutcome =
  | Readonly<{ kind: "DELIVERED" }>
  | Readonly<{
      kind: "ACCEPTED";
      mode: "LIVE" | "SANDBOX";
      providerReference?: string;
    }>
  | Readonly<{ kind: "NOT_SENT"; reasonCode: string }>
  | Readonly<{ kind: "FAILED"; errorCode: string; retryable: boolean }>;

/** Maps one channel attempt to the next recorded delivery state. */
export function nextNotificationDeliveryState(
  outcome: ChannelDispatchOutcome,
  isFinalAttempt: boolean,
): NotificationDeliveryState {
  switch (outcome.kind) {
    case "DELIVERED":
      return "DELIVERED";
    case "ACCEPTED":
      return outcome.mode === "LIVE" ? "SENT" : "SANDBOX_SENT";
    case "NOT_SENT":
      return "NOT_SENT";
    case "FAILED":
      return outcome.retryable && !isFinalAttempt ? "FAILED" : "DEAD_LETTER";
  }
}

export interface OutboxRetryPolicy {
  /** Total attempts including the first one. */
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  /** Fraction of the capped delay that random jitter may remove, from 0 to 1. */
  readonly jitterRatio: number;
}

export const defaultOutboxRetryPolicy: OutboxRetryPolicy = Object.freeze({
  maxAttempts: 8,
  baseDelayMs: 5_000,
  maxDelayMs: 15 * 60_000,
  jitterRatio: 0.2,
});

export function validateOutboxRetryPolicy(policy: OutboxRetryPolicy): OutboxRetryPolicy {
  if (!Number.isSafeInteger(policy.maxAttempts) || policy.maxAttempts < 1) {
    throw new RangeError("maxAttempts must be a positive safe integer");
  }
  if (!Number.isSafeInteger(policy.baseDelayMs) || policy.baseDelayMs < 1) {
    throw new RangeError("baseDelayMs must be a positive safe integer");
  }
  if (!Number.isSafeInteger(policy.maxDelayMs) || policy.maxDelayMs < policy.baseDelayMs) {
    throw new RangeError("maxDelayMs must be a safe integer of at least baseDelayMs");
  }
  if (!Number.isFinite(policy.jitterRatio) || policy.jitterRatio < 0 || policy.jitterRatio > 1) {
    throw new RangeError("jitterRatio must be between 0 and 1");
  }
  return policy;
}

/** Exponential delay before jitter: base × 2^(attempt − 1), capped at maxDelayMs. */
export function cappedRetryDelayMs(attempt: number, policy: OutboxRetryPolicy): number {
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new RangeError("attempt must be a positive safe integer");
  }
  const exponent = Math.min(attempt - 1, 52);
  return Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** exponent);
}

/**
 * Bounded exponential backoff with jitter. The result lies in
 * [capped × (1 − jitterRatio), capped] and never exceeds maxDelayMs.
 * `random` must return a value in [0, 1).
 */
export function computeRetryDelayMs(
  attempt: number,
  policy: OutboxRetryPolicy,
  random: () => number = Math.random,
): number {
  const capped = cappedRetryDelayMs(attempt, policy);
  const sample = random();
  const unit = Number.isFinite(sample) ? Math.min(Math.max(sample, 0), 1) : 0;
  return Math.max(1, Math.round(capped * (1 - policy.jitterRatio * unit)));
}

export type OutboxRetryPlan =
  | Readonly<{
      kind: "RETRY";
      attempt: number;
      isFinalAttempt: false;
      delayMs: number;
      nextAttemptAt: Date;
    }>
  | Readonly<{ kind: "DEAD_LETTER"; attempt: number; isFinalAttempt: true }>;

/**
 * Decides, before an attempt runs, what happens if it fails: a jittered retry
 * while attempts remain, otherwise dead-lettering.
 */
export function planOutboxRetry(
  attempt: number,
  now: Date,
  policy: OutboxRetryPolicy = defaultOutboxRetryPolicy,
  random: () => number = Math.random,
): OutboxRetryPlan {
  validateOutboxRetryPolicy(policy);
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new RangeError("attempt must be a positive safe integer");
  }
  if (attempt >= policy.maxAttempts) {
    return Object.freeze({ kind: "DEAD_LETTER", attempt, isFinalAttempt: true });
  }
  const delayMs = computeRetryDelayMs(attempt, policy, random);
  return Object.freeze({
    kind: "RETRY",
    attempt,
    isFinalAttempt: false,
    delayMs,
    nextAttemptAt: new Date(now.getTime() + delayMs),
  });
}

const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/u;
const SQLSTATE = /^[0-9A-Z]{5}$/u;

/**
 * Reduces an arbitrary failure to a bounded, PII-free error code. Error
 * messages are never used because they can contain phone numbers or names.
 */
export function safeDeliveryErrorCode(error: unknown, fallback = "HANDLER_ERROR"): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { readonly code: unknown }).code;
    if (typeof code === "string") {
      if (SAFE_ERROR_CODE.test(code)) return code;
      if (SQLSTATE.test(code)) return `SQLSTATE_${code}`;
    }
  }
  return fallback;
}
