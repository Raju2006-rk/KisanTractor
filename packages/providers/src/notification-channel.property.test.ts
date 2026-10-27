import { claimsRealDelivery, nextNotificationDeliveryState } from "@kisantractor/domain";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { CapabilityRegistry, capabilityStates } from "./capability-registry.js";
import type { CapabilityRegistrations, CapabilityState } from "./capability-registry.js";
import {
  CapabilityGatedNotificationDispatcher,
  NotificationChannelError,
  notificationChannelCapability,
} from "./notification-channel.js";
import type {
  ExternalNotificationChannel,
  NotificationChannelAdapter,
  NotificationChannelMessage,
} from "./notification-channel.js";

const propertyRuns = 200;
const seed = 1_406_017;

type AdapterBehavior = "ACCEPT" | "RETRYABLE_ERROR" | "PERMANENT_ERROR" | "UNCODED_ERROR";

class CountingAdapter implements NotificationChannelAdapter {
  readonly channels: readonly ExternalNotificationChannel[] = ["SMS", "PUSH", "IVR"];
  readonly calls: NotificationChannelMessage[] = [];

  constructor(private readonly behavior: AdapterBehavior) {}

  async send(message: NotificationChannelMessage) {
    this.calls.push(message);
    if (this.behavior === "RETRYABLE_ERROR") throw new NotificationChannelError("PROVIDER_TIMEOUT", true);
    if (this.behavior === "PERMANENT_ERROR") throw new NotificationChannelError("INVALID_RECIPIENT", false);
    if (this.behavior === "UNCODED_ERROR") throw new Error("failed for +919876543210");
    return { providerReference: "ref-1" };
  }
}

const registration = (state: CapabilityState, provider: unknown) =>
  state === "SANDBOX" || state === "LIVE" ? { state, provider } : { state };

describe("Property 16: Capability Honesty for notification channels", () => {
  /** Validates: Requirements 14.1, 14.2, 14.3, 17.6 */
  it("never contacts an unconfigured channel and never claims delivery for sandbox or skipped sends", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<ExternalNotificationChannel>("SMS", "PUSH", "IVR"),
        fc.constantFrom<CapabilityState>(...capabilityStates),
        fc.constantFrom<CapabilityState>(...capabilityStates),
        fc.constantFrom<AdapterBehavior>("ACCEPT", "RETRYABLE_ERROR", "PERMANENT_ERROR", "UNCODED_ERROR"),
        fc.boolean(),
        async (channel, messagingState, telephonyState, behavior, isFinalAttempt) => {
          const adapter = new CountingAdapter(behavior);
          const registrations = {
            MESSAGING: registration(messagingState, adapter),
            TELEPHONY: registration(telephonyState, adapter),
          } as CapabilityRegistrations;
          const dispatcher = new CapabilityGatedNotificationDispatcher(new CapabilityRegistry(registrations));
          const relevantState = notificationChannelCapability[channel] === "MESSAGING" ? messagingState : telephonyState;

          const result = await dispatcher.dispatch({
            notificationId: "n-1",
            idempotencyKey: "n-1",
            channel,
            recipientUserId: "u-1",
            locale: "en",
            templateKey: "notification.booking.accepted",
            body: "KisanTractor: Your booking KT-1 was accepted by the Owner.",
          });
          const state = nextNotificationDeliveryState(result.outcome, isFinalAttempt);

          expect(result.capabilityState).toBe(relevantState);
          expect(result.testOnly).toBe(relevantState === "SANDBOX");
          if (relevantState === "UNCONFIGURED" || relevantState === "DEGRADED") {
            expect(adapter.calls).toEqual([]);
          }
          if (relevantState === "UNCONFIGURED") {
            expect(result.outcome).toEqual({ kind: "NOT_SENT", reasonCode: "CHANNEL_UNCONFIGURED" });
            expect(state).toBe("NOT_SENT");
          }
          if (relevantState !== "LIVE") {
            expect(claimsRealDelivery(state)).toBe(false);
          }
          if (claimsRealDelivery(state)) {
            expect(relevantState).toBe("LIVE");
            expect(adapter.calls).toHaveLength(1);
          }
          expect(JSON.stringify(result)).not.toContain("9876543210");
        },
      ),
      { seed, numRuns: propertyRuns, verbose: 2 },
    );
  });
});
