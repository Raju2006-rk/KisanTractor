import { describe, expect, it } from "vitest";

import { CapabilityRegistry } from "./capability-registry.js";
import {
  CapabilityGatedNotificationDispatcher,
  MessagingChannelRouter,
  NotificationChannelError,
  NotificationNotSentError,
  SandboxNotificationAdapter,
} from "./notification-channel.js";
import type {
  NotificationChannelAdapter,
  NotificationChannelMessage,
  NotificationDispatchInput,
} from "./notification-channel.js";

const message: NotificationDispatchInput = {
  notificationId: "n-1",
  idempotencyKey: "n-1",
  channel: "SMS",
  recipientUserId: "10000000-0000-4000-8000-000000000001",
  locale: "en",
  templateKey: "notification.booking.accepted",
  body: "KisanTractor: Your booking KT-ABC was accepted by the Owner.",
};

class RecordingAdapter implements NotificationChannelAdapter {
  readonly channels = ["SMS", "PUSH"] as const;
  readonly sent: NotificationChannelMessage[] = [];

  constructor(private readonly failure?: Error) {}

  async send(input: NotificationChannelMessage) {
    this.sent.push(input);
    if (this.failure !== undefined) throw this.failure;
    return { providerReference: "provider-123" };
  }
}

/** Validates: Requirements 14.1, 14.2, 14.3, 14.4, 14.6, 17.6 */
describe("capability-gated notification dispatch", () => {
  it("records an unconfigured channel as not sent without any provider call", async () => {
    const dispatcher = new CapabilityGatedNotificationDispatcher(new CapabilityRegistry());
    await expect(dispatcher.dispatch(message)).resolves.toEqual({
      outcome: { kind: "NOT_SENT", reasonCode: "CHANNEL_UNCONFIGURED" },
      capabilityState: "UNCONFIGURED",
      testOnly: false,
      provider: "none",
    });
  });

  it("fails retryably while the messaging capability is degraded", async () => {
    const dispatcher = new CapabilityGatedNotificationDispatcher(
      new CapabilityRegistry({ MESSAGING: { state: "DEGRADED" } }),
    );
    const result = await dispatcher.dispatch(message);
    expect(result.outcome).toEqual({ kind: "FAILED", errorCode: "CAPABILITY_DEGRADED", retryable: true });
  });

  it("labels sandbox sends as test-only and live sends as live", async () => {
    const sandboxAdapter = new RecordingAdapter();
    const sandbox = new CapabilityGatedNotificationDispatcher(
      new CapabilityRegistry({ MESSAGING: { state: "SANDBOX", provider: sandboxAdapter } }),
    );
    await expect(sandbox.dispatch(message)).resolves.toEqual({
      outcome: { kind: "ACCEPTED", mode: "SANDBOX", providerReference: "provider-123" },
      capabilityState: "SANDBOX",
      testOnly: true,
      provider: "other",
    });

    const liveAdapter = new RecordingAdapter();
    const live = new CapabilityGatedNotificationDispatcher(
      new CapabilityRegistry({ MESSAGING: { state: "LIVE", provider: liveAdapter } }),
    );
    const result = await live.dispatch(message);
    expect(result).toMatchObject({ outcome: { kind: "ACCEPTED", mode: "LIVE" }, testOnly: false });
    expect(liveAdapter.sent).toEqual([{ ...message, channel: "SMS" }]);
  });

  it("routes IVR through telephony and delivers in-app records without a provider", async () => {
    const dispatcher = new CapabilityGatedNotificationDispatcher(
      new CapabilityRegistry({ MESSAGING: { state: "LIVE", provider: new RecordingAdapter() } }),
    );
    await expect(dispatcher.dispatch({ ...message, channel: "IVR" })).resolves.toMatchObject({
      outcome: { kind: "NOT_SENT", reasonCode: "CHANNEL_UNCONFIGURED" },
      capabilityState: "UNCONFIGURED",
    });
    await expect(dispatcher.dispatch({ ...message, channel: "IN_APP" })).resolves.toEqual({
      outcome: { kind: "DELIVERED" },
      testOnly: false,
      provider: "in_app",
    });
  });

  it("records an adapter's pre-send refusal as not sent, never as a failure to retry", async () => {
    const dispatcher = new CapabilityGatedNotificationDispatcher(new CapabilityRegistry({
      MESSAGING: { state: "LIVE", provider: new RecordingAdapter(new NotificationNotSentError("NO_PUSH_DEVICE")) },
    }));
    await expect(dispatcher.dispatch({ ...message, channel: "PUSH" })).resolves.toEqual({
      outcome: { kind: "NOT_SENT", reasonCode: "NO_PUSH_DEVICE" },
      capabilityState: "LIVE",
      testOnly: false,
      provider: "other",
    });
  });

  it("routes each channel to its own adapter, which must share one mode", async () => {
    const sms = new SandboxNotificationAdapter({ environment: "test", channels: ["SMS"] });
    const push = new SandboxNotificationAdapter({ environment: "test", channels: ["PUSH"] });
    const router = new MessagingChannelRouter([sms, push]);
    expect(router).toMatchObject({ mode: "SANDBOX", channels: ["SMS", "PUSH"] });
    const dispatcher = new CapabilityGatedNotificationDispatcher(
      new CapabilityRegistry({ MESSAGING: { state: "SANDBOX", provider: router } }),
    );
    await expect(dispatcher.dispatch({ ...message, channel: "PUSH" })).resolves.toMatchObject({ provider: "sandbox", testOnly: true });
    expect(push.sent).toHaveLength(1);
    expect(sms.sent).toHaveLength(0);
    const live = { mode: "LIVE" as const, channels: ["PUSH"] as const, send: async () => ({}) };
    expect(() => new MessagingChannelRouter([sms, live])).toThrow(/same mode/u);
    expect(() => new MessagingChannelRouter([sms, sms])).toThrow(/Two messaging adapters/u);
  });

  it("reports provider failures with PII-free codes", async () => {
    const coded = new CapabilityGatedNotificationDispatcher(new CapabilityRegistry({
      MESSAGING: { state: "LIVE", provider: new RecordingAdapter(new NotificationChannelError("INVALID_RECIPIENT", false)) },
    }));
    await expect(coded.dispatch(message)).resolves.toMatchObject({
      outcome: { kind: "FAILED", errorCode: "INVALID_RECIPIENT", retryable: false },
    });

    const uncoded = new CapabilityGatedNotificationDispatcher(new CapabilityRegistry({
      MESSAGING: { state: "LIVE", provider: new RecordingAdapter(new Error("timeout sending to 9876543210")) },
    }));
    const result = await uncoded.dispatch(message);
    expect(result.outcome).toEqual({ kind: "FAILED", errorCode: "PROVIDER_ERROR", retryable: true });
    expect(JSON.stringify(result)).not.toContain("9876543210");
  });

  it("does not send on channels the configured adapter does not support", async () => {
    const adapter = new SandboxNotificationAdapter({ environment: "test", channels: ["PUSH"] });
    const dispatcher = new CapabilityGatedNotificationDispatcher(
      new CapabilityRegistry({ MESSAGING: { state: "SANDBOX", provider: adapter } }),
    );
    await expect(dispatcher.dispatch(message)).resolves.toMatchObject({
      outcome: { kind: "NOT_SENT", reasonCode: "CHANNEL_NOT_SUPPORTED" },
      testOnly: true,
    });
    expect(adapter.sent).toEqual([]);
  });
});

describe("sandbox notification adapter", () => {
  it("is refused in production", () => {
    expect(() => new SandboxNotificationAdapter({ environment: "production" })).toThrow(/production/u);
  });

  it("deduplicates by idempotency key and returns a sandbox reference", async () => {
    const adapter = new SandboxNotificationAdapter({ environment: "local" });
    const channelMessage: NotificationChannelMessage = { ...message, channel: "SMS" };
    await expect(adapter.send(channelMessage)).resolves.toEqual({ providerReference: "sandbox:n-1" });
    await adapter.send(channelMessage);
    expect(adapter.sent).toHaveLength(1);
  });
});
