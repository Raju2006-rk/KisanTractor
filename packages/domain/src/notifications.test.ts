import { describe, expect, it } from "vitest";

import {
  cappedRetryDelayMs,
  claimsRealDelivery,
  computeRetryDelayMs,
  isNotificationDispatchSettled,
  nextNotificationDeliveryState,
  planOutboxRetry,
  safeDeliveryErrorCode,
  validateOutboxRetryPolicy,
} from "./notifications.js";
import type { OutboxRetryPolicy } from "./notifications.js";

const policy: OutboxRetryPolicy = {
  maxAttempts: 5,
  baseDelayMs: 1_000,
  maxDelayMs: 10_000,
  jitterRatio: 0.2,
};
const now = new Date("2026-05-12T04:00:00.000Z");

/** Validates: Requirements 14.6 */
describe("outbox retry backoff", () => {
  it("doubles the delay per attempt and caps it at maxDelayMs", () => {
    expect([1, 2, 3, 4, 5, 6, 60].map((attempt) => cappedRetryDelayMs(attempt, policy)))
      .toEqual([1_000, 2_000, 4_000, 8_000, 10_000, 10_000, 10_000]);
  });

  it("keeps jittered delays within [capped × (1 − jitter), capped] for every attempt", () => {
    for (let attempt = 1; attempt <= 40; attempt += 1) {
      const capped = cappedRetryDelayMs(attempt, policy);
      for (const sample of [0, 0.25, 0.5, 0.999999]) {
        const delay = computeRetryDelayMs(attempt, policy, () => sample);
        expect(delay).toBeGreaterThanOrEqual(Math.floor(capped * (1 - policy.jitterRatio)));
        expect(delay).toBeLessThanOrEqual(capped);
        expect(delay).toBeLessThanOrEqual(policy.maxDelayMs);
      }
    }
    expect(computeRetryDelayMs(3, policy, () => 0)).toBe(4_000);
    expect(computeRetryDelayMs(3, policy, () => 0.5)).toBe(3_600);
  });

  it("clamps a misbehaving random source instead of exceeding the bounds", () => {
    expect(computeRetryDelayMs(2, policy, () => Number.NaN)).toBe(2_000);
    expect(computeRetryDelayMs(2, policy, () => 7)).toBe(1_600);
    expect(computeRetryDelayMs(2, policy, () => -3)).toBe(2_000);
  });

  it("schedules retries until the last attempt and then dead-letters", () => {
    for (let attempt = 1; attempt < policy.maxAttempts; attempt += 1) {
      const plan = planOutboxRetry(attempt, now, policy, () => 0);
      expect(plan.kind).toBe("RETRY");
      if (plan.kind === "RETRY") {
        expect(plan.isFinalAttempt).toBe(false);
        expect(plan.nextAttemptAt.getTime() - now.getTime()).toBe(plan.delayMs);
      }
    }
    expect(planOutboxRetry(policy.maxAttempts, now, policy)).toEqual({
      kind: "DEAD_LETTER",
      attempt: policy.maxAttempts,
      isFinalAttempt: true,
    });
    expect(planOutboxRetry(policy.maxAttempts + 3, now, policy).kind).toBe("DEAD_LETTER");
  });

  it("rejects invalid policies and attempt numbers", () => {
    expect(() => validateOutboxRetryPolicy({ ...policy, maxAttempts: 0 })).toThrow(RangeError);
    expect(() => validateOutboxRetryPolicy({ ...policy, maxDelayMs: 10 })).toThrow(RangeError);
    expect(() => validateOutboxRetryPolicy({ ...policy, jitterRatio: 1.5 })).toThrow(RangeError);
    expect(() => planOutboxRetry(0, now, policy)).toThrow(RangeError);
  });
});

/** Validates: Requirements 14.1, 14.3, 14.6, 17.6 */
describe("notification delivery states", () => {
  it("maps channel outcomes to honest delivery states", () => {
    expect(nextNotificationDeliveryState({ kind: "DELIVERED" }, false)).toBe("DELIVERED");
    expect(nextNotificationDeliveryState({ kind: "ACCEPTED", mode: "LIVE" }, false)).toBe("SENT");
    expect(nextNotificationDeliveryState({ kind: "ACCEPTED", mode: "SANDBOX" }, false)).toBe("SANDBOX_SENT");
    expect(nextNotificationDeliveryState({ kind: "NOT_SENT", reasonCode: "CHANNEL_UNCONFIGURED" }, false))
      .toBe("NOT_SENT");
    expect(nextNotificationDeliveryState({ kind: "FAILED", errorCode: "X", retryable: true }, false)).toBe("FAILED");
    expect(nextNotificationDeliveryState({ kind: "FAILED", errorCode: "X", retryable: true }, true))
      .toBe("DEAD_LETTER");
    expect(nextNotificationDeliveryState({ kind: "FAILED", errorCode: "X", retryable: false }, false))
      .toBe("DEAD_LETTER");
  });

  it("claims real delivery only for live sends and never for sandbox or skipped records", () => {
    expect(claimsRealDelivery("SENT")).toBe(true);
    expect(claimsRealDelivery("DELIVERED")).toBe(true);
    for (const state of ["PENDING", "PROCESSING", "SANDBOX_SENT", "NOT_SENT", "FAILED", "DEAD_LETTER"] as const) {
      expect(claimsRealDelivery(state)).toBe(false);
    }
  });

  it("treats only pending and failed records as dispatchable", () => {
    expect(isNotificationDispatchSettled("PENDING")).toBe(false);
    expect(isNotificationDispatchSettled("FAILED")).toBe(false);
    for (const state of ["SENT", "SANDBOX_SENT", "DELIVERED", "NOT_SENT", "DEAD_LETTER"] as const) {
      expect(isNotificationDispatchSettled(state)).toBe(true);
    }
  });

  it("reduces failures to PII-free codes and never uses error messages", () => {
    expect(safeDeliveryErrorCode(new Error("SMS to +91 98765 43210 failed"))).toBe("HANDLER_ERROR");
    expect(safeDeliveryErrorCode({ code: "PROVIDER_TIMEOUT" })).toBe("PROVIDER_TIMEOUT");
    expect(safeDeliveryErrorCode({ code: "40001" })).toBe("SQLSTATE_40001");
    expect(safeDeliveryErrorCode({ code: "call 9876543210" }, "PROVIDER_ERROR")).toBe("PROVIDER_ERROR");
  });
});
