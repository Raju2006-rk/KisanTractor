import type {
  ChannelDispatchOutcome,
  NotificationChannel,
} from "@kisantractor/domain";
import { safeDeliveryErrorCode } from "@kisantractor/domain";

import { assertProviderRuntimeSafety, CapabilityRegistry } from "./capability-registry.js";
import type { CapabilityState, ProviderCapability, ProviderRuntimeSafety } from "./capability-registry.js";

export type ExternalNotificationChannel = Exclude<NotificationChannel, "IN_APP">;

/** SANDBOX adapters never deliver to a real recipient; LIVE adapters do. */
export type MessagingMode = "SANDBOX" | "LIVE";

/**
 * A rendered, provider-independent message. It names the recipient by user id
 * only: resolving a phone number or device token is the adapter's job, so the
 * worker, logs, and outbox never hold contact details.
 */
export interface NotificationChannelMessage {
  readonly notificationId: string;
  /** Stable per notification so providers can deduplicate a resend after a crash. */
  readonly idempotencyKey: string;
  readonly channel: ExternalNotificationChannel;
  readonly recipientUserId: string;
  readonly locale: string;
  readonly templateKey: string;
  /** Version of the template contract; registered SMS templates (DLT) are keyed by it. */
  readonly templateVersion?: number;
  /** The declared template variables, for providers that send registered templates (DLT). */
  readonly variables?: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface NotificationChannelReceipt {
  readonly providerReference?: string;
}

/** Implemented by real SMS/push/voice providers (Phase 2) and by the sandbox adapter. */
export interface NotificationChannelAdapter {
  readonly channels: readonly ExternalNotificationChannel[];
  send(message: NotificationChannelMessage, signal?: AbortSignal): Promise<NotificationChannelReceipt>;
  /** Short provider name for telemetry (for example `msg91`); never a credential. */
  providerName?(channel: ExternalNotificationChannel): string;
}

/** Adapters throw this to report a provider failure with a PII-free code. */
export class NotificationChannelError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(`Notification channel failed with ${code}`);
    this.name = "NotificationChannelError";
  }
}

/**
 * Adapters throw this when they decided, before contacting any provider, that the message cannot
 * be sent: no registered device, no reachable number, or no registered template. It is recorded as
 * NOT_SENT, which never claims delivery and is not retried.
 */
export class NotificationNotSentError extends Error {
  constructor(readonly reasonCode: string) {
    super(`Notification was not sent: ${reasonCode}`);
    this.name = "NotificationNotSentError";
  }
}

export const notificationChannelCapability: Readonly<
  Record<ExternalNotificationChannel, ProviderCapability>
> = Object.freeze({
  SMS: "MESSAGING",
  PUSH: "MESSAGING",
  IVR: "TELEPHONY",
});

/** Error code recorded while a capability is DEGRADED; no provider is contacted. */
export const CAPABILITY_DEGRADED_CODE = "CAPABILITY_DEGRADED";

export interface NotificationDispatchResult {
  readonly outcome: ChannelDispatchOutcome;
  /** Capability state at dispatch time; undefined for in-app notifications. */
  readonly capabilityState?: CapabilityState;
  readonly testOnly: boolean;
  /** Provider that handled the attempt: `in_app`, `none` (nothing contacted), or the adapter's name. */
  readonly provider: string;
}

export interface NotificationDispatchInput extends Omit<NotificationChannelMessage, "channel"> {
  readonly channel: NotificationChannel;
}

const isAbort = (error: unknown): boolean =>
  error instanceof DOMException && error.name === "AbortError";

const PROVIDER_NAME = /^[a-z][a-z0-9_]{0,31}$/u;

const providerOf = (adapter: NotificationChannelAdapter, channel: ExternalNotificationChannel): string => {
  const name = adapter.providerName?.(channel);
  return name !== undefined && PROVIDER_NAME.test(name) ? name : "other";
};

/**
 * Sends notifications only through configured capabilities. UNCONFIGURED
 * channels produce no external side effect and are recorded as NOT_SENT;
 * DEGRADED channels fail retryably without contacting a provider; SANDBOX
 * results are always test-only.
 */
export class CapabilityGatedNotificationDispatcher {
  constructor(private readonly registry: CapabilityRegistry) {}

  async dispatch(input: NotificationDispatchInput, signal?: AbortSignal): Promise<NotificationDispatchResult> {
    if (input.channel === "IN_APP") {
      // The stored notification record is the in-app delivery itself.
      return Object.freeze({ outcome: Object.freeze({ kind: "DELIVERED" }), testOnly: false, provider: "in_app" });
    }

    const channel = input.channel;
    const capability = notificationChannelCapability[channel];
    const state = this.registry.getState(capability);

    if (state === "UNCONFIGURED") {
      return Object.freeze({
        outcome: Object.freeze({ kind: "NOT_SENT", reasonCode: "CHANNEL_UNCONFIGURED" }),
        capabilityState: state,
        testOnly: false,
        provider: "none",
      });
    }
    if (state === "DEGRADED") {
      return Object.freeze({
        outcome: Object.freeze({ kind: "FAILED", errorCode: CAPABILITY_DEGRADED_CODE, retryable: true }),
        capabilityState: state,
        testOnly: false,
        provider: "none",
      });
    }

    const testOnly = state === "SANDBOX";
    const adapter = this.registry.requireConfigured<NotificationChannelAdapter>(capability);
    if (!adapter.channels.includes(channel)) {
      return Object.freeze({
        outcome: Object.freeze({ kind: "NOT_SENT", reasonCode: "CHANNEL_NOT_SUPPORTED" }),
        capabilityState: state,
        testOnly,
        provider: "none",
      });
    }
    const provider = providerOf(adapter, channel);

    try {
      const receipt = await adapter.send(Object.freeze({ ...input, channel }), signal);
      return Object.freeze({
        outcome: Object.freeze({
          kind: "ACCEPTED",
          mode: state,
          ...(receipt.providerReference === undefined ? {} : { providerReference: receipt.providerReference }),
        }),
        capabilityState: state,
        testOnly,
        provider,
      });
    } catch (error) {
      if (isAbort(error)) throw error;
      if (error instanceof NotificationNotSentError) {
        return Object.freeze({
          outcome: Object.freeze({ kind: "NOT_SENT", reasonCode: safeDeliveryErrorCode({ code: error.reasonCode }, "NOT_SENT") }),
          capabilityState: state,
          testOnly,
          provider,
        });
      }
      const retryable = error instanceof NotificationChannelError ? error.retryable : true;
      return Object.freeze({
        outcome: Object.freeze({
          kind: "FAILED",
          errorCode: safeDeliveryErrorCode(error, "PROVIDER_ERROR"),
          retryable,
        }),
        capabilityState: state,
        testOnly,
        provider,
      });
    }
  }
}

/** A channel adapter with a fixed mode, as built from configuration. */
export interface ModalNotificationChannelAdapter extends NotificationChannelAdapter {
  readonly mode: MessagingMode;
}

/**
 * The MESSAGING capability's provider handle: routes each channel to its configured adapter
 * (for example SMS to MSG91 and PUSH to FCM). Every routed adapter must run in the same mode, so
 * one capability state describes them all.
 */
export class MessagingChannelRouter implements ModalNotificationChannelAdapter {
  readonly mode: MessagingMode;
  readonly channels: readonly ExternalNotificationChannel[];
  readonly #routes: ReadonlyMap<ExternalNotificationChannel, ModalNotificationChannelAdapter>;

  constructor(adapters: readonly ModalNotificationChannelAdapter[]) {
    if (adapters.length === 0) throw new TypeError("At least one messaging adapter is required");
    const mode = adapters[0]!.mode;
    if (adapters.some((adapter) => adapter.mode !== mode)) {
      throw new TypeError("Every messaging adapter must run in the same mode");
    }
    const routes = new Map<ExternalNotificationChannel, ModalNotificationChannelAdapter>();
    for (const adapter of adapters) {
      for (const channel of adapter.channels) {
        if (routes.has(channel)) throw new TypeError(`Two messaging adapters handle ${channel}`);
        routes.set(channel, adapter);
      }
    }
    this.mode = mode;
    this.#routes = routes;
    this.channels = Object.freeze([...routes.keys()]);
  }

  providerName(channel: ExternalNotificationChannel): string {
    const adapter = this.#routes.get(channel);
    return adapter === undefined ? "none" : providerOf(adapter, channel);
  }

  send(message: NotificationChannelMessage, signal?: AbortSignal): Promise<NotificationChannelReceipt> {
    const adapter = this.#routes.get(message.channel);
    if (adapter === undefined) return Promise.reject(new NotificationNotSentError("CHANNEL_NOT_SUPPORTED"));
    return adapter.send(message, signal);
  }
}

export interface SandboxNotificationAdapterOptions {
  readonly environment: ProviderRuntimeSafety["environment"];
  readonly channels?: readonly ExternalNotificationChannel[];
}

/**
 * Test-only adapter for a SANDBOX messaging capability. It records messages in
 * memory and never contacts a provider. It cannot be constructed in production.
 */
export class SandboxNotificationAdapter implements ModalNotificationChannelAdapter {
  readonly mode = "SANDBOX" as const;
  readonly channels: readonly ExternalNotificationChannel[];
  readonly #sent: NotificationChannelMessage[] = [];

  constructor(options: SandboxNotificationAdapterOptions) {
    if (options.environment === "production") {
      throw new Error("Sandbox notification adapter is not allowed in production");
    }
    assertProviderRuntimeSafety({ environment: options.environment });
    this.channels = Object.freeze([...(options.channels ?? ["SMS", "PUSH"])]);
  }

  get sent(): readonly NotificationChannelMessage[] {
    return Object.freeze([...this.#sent]);
  }

  providerName(): string {
    return "sandbox";
  }

  async send(message: NotificationChannelMessage): Promise<NotificationChannelReceipt> {
    const duplicate = this.#sent.find((sent) => sent.idempotencyKey === message.idempotencyKey);
    if (duplicate === undefined) this.#sent.push(Object.freeze({ ...message }));
    return Object.freeze({ providerReference: `sandbox:${message.idempotencyKey}` });
  }
}
