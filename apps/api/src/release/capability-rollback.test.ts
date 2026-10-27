import { createHmac, generateKeyPairSync } from "node:crypto";

import { getPublicRuntimeConfig, validateEnvironment } from "@kisantractor/config";
import type { AuthPrincipal } from "@kisantractor/domain";
import { noopIndicators } from "@kisantractor/observability";
import {
  CapabilityGatedNotificationDispatcher,
  CapabilityUnavailableError,
  capabilityStates,
  providerCapabilities,
  type CapabilityState,
  type MessagingHttpRequest,
  type NotificationDispatchInput,
  type PaymentHttpRequest,
  type ProviderCapability,
} from "@kisantractor/providers";
import { describe, expect, it } from "vitest";

import { PaymentService, type PaymentStore, type VerifiedProviderEventRecord } from "../payment/index.js";
import {
  buildCapabilityRegistry,
  buildMessagingAdapter,
  buildOnlinePaymentAdapter,
  type SandboxProviders,
} from "../runtime-config.js";

/**
 * Capability rollback is a configuration change plus a restart: the operator sets the
 * capability's `*_CAPABILITY_STATE` to DEGRADED or UNCONFIGURED, and every process rebuilds its
 * registry. This suite checks every capability and rollback path (ops/release/production-readiness.md).
 * The domain-side effects are covered next to each service: identity (OTP), private documents
 * (OBJECT_STORAGE), and notification delivery (MESSAGING) each have a rollback test; online
 * payment (the configured Razorpay adapter) is covered at the end of this file.
 *
 * Validates: Requirements 14.1, 14.2, 14.4, 18.7
 */
const STATE_FIELD: Readonly<Record<ProviderCapability, string>> = {
  OTP: "OTP_CAPABILITY_STATE",
  MAPS_GEOCODING: "MAPS_CAPABILITY_STATE",
  ONLINE_PAYMENT: "PAYMENT_CAPABILITY_STATE",
  MESSAGING: "MESSAGING_CAPABILITY_STATE",
  OBJECT_STORAGE: "STORAGE_CAPABILITY_STATE",
  TELEPHONY: "TELEPHONY_CAPABILITY_STATE",
};

const testEnvironment = {
  APP_ENV: "test",
  NODE_ENV: "test",
  ALLOW_LOCAL_OTP_CODES: "true",
  TELEPHONY_BOOKING_NUMBER: "+918000000000",
} as const;

const productionEnvironment = {
  APP_ENV: "production",
  NODE_ENV: "production",
  API_HOST: "0.0.0.0",
  API_PORT: "4000",
  PUBLIC_WEB_ORIGIN: "https://kisantractor.example",
  PUBLIC_API_ORIGIN: "https://api.kisantractor.example",
  DATABASE_URL: "postgresql://app@db.internal:5432/kisantractor",
  TELEPHONY_BOOKING_NUMBER: "+918000000000",
} as const;

/** Provider handles that record any use; a rolled-back registry must never hand one out. */
const sandboxProviders = (): { providers: SandboxProviders; used: string[] } => {
  const used: string[] = [];
  const handle = (capability: string) => new Proxy({}, { get: (_target, property) => {
    used.push(`${capability}.${String(property)}`);
    return undefined;
  } });
  return {
    used,
    providers: {
      MAPS_GEOCODING: handle("MAPS_GEOCODING"),
      ONLINE_PAYMENT: handle("ONLINE_PAYMENT"),
      MESSAGING: handle("MESSAGING"),
      OBJECT_STORAGE: handle("OBJECT_STORAGE"),
      TELEPHONY: handle("TELEPHONY"),
    },
  };
};

const configWith = (base: Readonly<Record<string, string>>, capability: ProviderCapability, state: CapabilityState) =>
  validateEnvironment({ ...base, [STATE_FIELD[capability]]: state });

describe("provider capability rollback", () => {
  it("names a configuration field for every capability, so rollback needs no code change", () => {
    expect(Object.keys(STATE_FIELD).sort()).toEqual([...providerCapabilities].sort());
    for (const capability of providerCapabilities) {
      for (const state of capabilityStates) expect(configWith(testEnvironment, capability, state)[STATE_FIELD[capability] as "OTP_CAPABILITY_STATE"]).toBe(state);
    }
  });

  for (const capability of providerCapabilities) {
    for (const from of ["SANDBOX", "LIVE"] as const) {
      for (const to of ["DEGRADED", "UNCONFIGURED"] as const) {
        it(`${capability}: ${from} -> ${to} refuses provider use, reports the honest state, and changes nothing else`, () => {
          const { providers, used } = sandboxProviders();
          const before = buildCapabilityRegistry(configWith(testEnvironment, capability, from), providers);
          // No live adapter is configured here, so a LIVE setting already reports DEGRADED rather than live.
          expect(before.getState(capability)).toBe(from === "SANDBOX" ? "SANDBOX" : "DEGRADED");

          const rolledBackConfig = configWith(testEnvironment, capability, to);
          const after = buildCapabilityRegistry(rolledBackConfig, providers);
          expect(after.getState(capability)).toBe(to);
          const error = (() => {
            try {
              after.requireConfigured(capability);
            } catch (caught) {
              return caught;
            }
            return undefined;
          })();
          expect(error).toBeInstanceOf(CapabilityUnavailableError);
          expect(error).toMatchObject({ capability, state: to, retryable: to === "DEGRADED" });
          expect(after.getClientProjection(capability)).toMatchObject({
            state: to, isLive: false, isOperational: false, isTest: false, canRetry: to === "DEGRADED",
          });

          const publicConfig = getPublicRuntimeConfig(rolledBackConfig);
          expect(publicConfig.capabilities[capability]).toMatchObject({ state: to, isLive: false, isOperational: false });
          // A rolled-back telephony capability never advertises the booking number.
          expect(publicConfig.telephonyBookingNumber).toBeNull();

          for (const other of providerCapabilities.filter((candidate) => candidate !== capability)) {
            expect(after.getState(other), other).toBe(before.getState(other));
          }
          expect(used).toEqual([]);
        });
      }
    }
  }

  it("hides the IVR number the moment telephony leaves LIVE", () => {
    expect(getPublicRuntimeConfig(configWith(testEnvironment, "TELEPHONY", "LIVE")).telephonyBookingNumber).toBe("+918000000000");
    for (const state of ["DEGRADED", "UNCONFIGURED", "SANDBOX"] as const) {
      expect(getPublicRuntimeConfig(configWith(testEnvironment, "TELEPHONY", state)).telephonyBookingNumber, state).toBeNull();
    }
  });

  it("accepts every rollback state in production and never honours sandbox providers there", () => {
    const { providers, used } = sandboxProviders();
    for (const capability of providerCapabilities) {
      for (const to of ["DEGRADED", "UNCONFIGURED"] as const) {
        expect(buildCapabilityRegistry(configWith(productionEnvironment, capability, to), providers).getState(capability)).toBe(to);
      }
      // A mistaken roll "back" to SANDBOX in production degrades instead of running test providers.
      expect(buildCapabilityRegistry(configWith(productionEnvironment, capability, "SANDBOX"), providers).getState(capability)).toBe("DEGRADED");
    }
    expect(used).toEqual([]);
  });
});

/** Validates: Requirements 11.3, 11.6, 14.2, 14.4, 18.7 */
describe("online payment (Razorpay) rollback", () => {
  // Synthetic values only; the live-shaped key id is assembled so no live-looking literal is committed.
  const secrets = { razorpayKeySecret: "synthetic-key-secret-for-tests", razorpayWebhookSecret: "synthetic-webhook-secret-for-tests" };
  const configured = [
    ["SANDBOX", { ...testEnvironment, PAYMENT_PROVIDER: "razorpay", RAZORPAY_KEY_ID: "rzp_test_Kt0Synthetic01" }],
    ["LIVE", { ...productionEnvironment, APP_ENV: "staging", PAYMENT_PROVIDER: "razorpay", RAZORPAY_KEY_ID: ["rzp", "live", "Kt0Synthetic01"].join("_") }],
  ] as const;
  const farmer = { userId: "farmer-1", roles: ["FARMER"], sessionId: "session-1" } as unknown as AuthPrincipal;
  const context = { correlationId: "corr-rollback-1", actorChannel: "WEB" } as const;
  const body = JSON.stringify({
    entity: "event", event: "payment.captured", contains: ["payment"], created_at: 1_767_225_700,
    payload: { payment: { entity: { id: "pay_KtSynthPay0001", entity: "payment", amount: 120_000, currency: "INR", status: "captured", order_id: "order_KtSynthOrder01" } } },
  });
  const headers = {
    "x-razorpay-signature": createHmac("sha256", secrets.razorpayWebhookSecret).update(body).digest("hex"),
    "x-razorpay-event-id": "KtSynthEvent0001",
  };

  /** A payment service on the registry the given configuration builds; records provider and store use. */
  const runtime = (base: Readonly<Record<string, string>>, state: CapabilityState) => {
    const providerCalls: PaymentHttpRequest[] = [];
    const storeCalls: string[] = [];
    const events: VerifiedProviderEventRecord[] = [];
    const config = validateEnvironment({ ...base, PAYMENT_CAPABILITY_STATE: state });
    const adapter = buildOnlinePaymentAdapter(config, secrets, {
      http: async (request) => { providerCalls.push(request); throw new Error("no provider call is expected"); },
    });
    const registry = buildCapabilityRegistry(config, {}, adapter === undefined ? {} : { ONLINE_PAYMENT: adapter });
    const unexpected = (name: string) => async (): Promise<never> => { storeCalls.push(name); throw new Error(`unexpected ${name}`); };
    const store: PaymentStore = {
      loadBookingPayments: unexpected("loadBookingPayments"),
      loadReceiptSource: unexpected("loadReceiptSource"),
      applyPayment: unexpected("applyPayment"),
      previewPaymentApplication: unexpected("previewPaymentApplication"),
      transitionPayment: unexpected("transitionPayment"),
      recordProviderEvent: async (input) => { events.push(input); return { disposition: "APPLIED", paymentStatus: "PAID_ONLINE" }; },
    };
    const service = new PaymentService(store, () => new Date("2026-03-01T12:00:00.000Z"), noopIndicators, registry);
    return { registry, service, providerCalls, storeCalls, events };
  };
  const intent = { bookingId: "booking-1", invoiceId: "invoice-1", amountPaise: 120_000, idempotencyKey: "online-key-1" };

  for (const [from, base] of configured) {
    it(`${from} -> DEGRADED refuses new intents without a provider call and still settles in-flight intents`, async () => {
      expect(runtime(base, from).registry.getState("ONLINE_PAYMENT")).toBe(from);
      const degraded = runtime(base, "DEGRADED");
      expect(degraded.registry.getState("ONLINE_PAYMENT")).toBe("DEGRADED");

      await expect(degraded.service.createOnlineIntent(farmer, intent, context))
        .rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE", state: "DEGRADED", retryable: true });
      // A signed callback for an intent created before the rollback is still verified and recorded once.
      expect(await degraded.service.handleProviderWebhook("razorpay", new TextEncoder().encode(body), headers, context))
        .toMatchObject({ outcome: "ACCEPTED", httpStatus: 200 });
      expect(degraded.events).toHaveLength(1);
      expect(degraded.service.onlinePaymentAvailability()).toMatchObject({ state: "DEGRADED", available: false, canRetry: true });
      expect(degraded.providerCalls).toEqual([]);
      expect(degraded.storeCalls).toEqual([]);
    });

    it(`${from} -> UNCONFIGURED refuses intents and webhooks, so the provider retries them later`, async () => {
      const unconfigured = runtime(base, "UNCONFIGURED");
      expect(unconfigured.registry.getState("ONLINE_PAYMENT")).toBe("UNCONFIGURED");
      await expect(unconfigured.service.createOnlineIntent(farmer, intent, context))
        .rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE", state: "UNCONFIGURED", retryable: false });
      await expect(unconfigured.service.handleProviderWebhook("razorpay", new TextEncoder().encode(body), headers, context))
        .rejects.toMatchObject({ code: "PAYMENT_CAPABILITY_UNAVAILABLE", retryable: true });
      expect(unconfigured.events).toEqual([]);
      expect(unconfigured.providerCalls).toEqual([]);
      expect(unconfigured.storeCalls).toEqual([]);
    });
  }
});

/** Validates: Requirements 14.2, 14.3, 14.4, 14.5, 14.6, 18.7 */
describe("messaging (MSG91 SMS, FCM push) rollback", () => {
  // Synthetic credentials only: a per-run RSA key and a made-up MSG91 auth key.
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const secrets = {
    msg91AuthKey: "Kt0SyntheticMsg91AuthKey01",
    fcmPrivateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
  const messagingConfig = {
    SMS_PROVIDER: "msg91",
    PUSH_PROVIDER: "fcm",
    MSG91_TEMPLATE_IDS: JSON.stringify({ "notification.booking.accepted@1:en": "64f0aSyntheticAccepted" }),
    FCM_PROJECT_ID: "kt-synthetic",
    FCM_SERVICE_ACCOUNT_EMAIL: "kisan-fcm@kt-synthetic.iam.gserviceaccount.com",
  } as const;
  const configured = [
    ["SANDBOX", { ...testEnvironment, ...messagingConfig }],
    ["LIVE", { ...productionEnvironment, APP_ENV: "staging", ...messagingConfig }],
  ] as const;
  const message = (channel: "SMS" | "PUSH"): NotificationDispatchInput => ({
    notificationId: "90000000-0000-4000-8000-000000000001",
    idempotencyKey: "90000000-0000-4000-8000-000000000001",
    channel,
    recipientUserId: "10000000-0000-4000-8000-000000000001",
    locale: "en",
    templateKey: "notification.booking.accepted",
    templateVersion: 1,
    variables: { reference: "KT-ABCDEF123456" },
    body: "KisanTractor: Your booking KT-ABCDEF123456 was accepted by the Owner.",
  });

  /** The registry and dispatcher one process builds for `state`; records provider calls and contact lookups. */
  const runtime = (base: Readonly<Record<string, string>>, state: CapabilityState) => {
    const providerCalls: MessagingHttpRequest[] = [];
    const lookups: string[] = [];
    const config = validateEnvironment({ ...base, MESSAGING_CAPABILITY_STATE: state });
    const adapter = buildMessagingAdapter(config, secrets, () => ({
      sms: { smsNumber: async (userId) => { lookups.push(`sms:${userId}`); return "+919876543210"; } },
      push: {
        pushTokens: async (userId) => { lookups.push(`push:${userId}`); return [{ registrationId: "d-1", token: "fcm-token-device-1" }]; },
        revokePushToken: async () => undefined,
      },
    }), {
      http: async (request) => {
        providerCalls.push(request);
        if (request.url.endsWith("/token")) {
          return { status: 200, json: async () => ({ access_token: "ya29.synthetic-access-token-0001", expires_in: 3_599 }) };
        }
        if (request.url.includes("fcm.googleapis.com")) {
          return { status: 200, json: async () => ({ name: "projects/kt-synthetic/messages/0:1" }) };
        }
        return { status: 200, json: async () => ({ type: "success", message: "req0000001" }) };
      },
    });
    const registry = buildCapabilityRegistry(config, {}, adapter === undefined ? {} : { MESSAGING: adapter });
    return { registry, dispatcher: new CapabilityGatedNotificationDispatcher(registry), providerCalls, lookups };
  };

  for (const [from, base] of configured) {
    it(`${from} -> DEGRADED -> ${from}: no provider contact or contact lookup while degraded, delivery resumes after roll-forward`, async () => {
      const before = runtime(base, from);
      expect(before.registry.getState("MESSAGING")).toBe(from);

      const degraded = runtime(base, "DEGRADED");
      expect(degraded.registry.getState("MESSAGING")).toBe("DEGRADED");
      for (const channel of ["SMS", "PUSH"] as const) {
        await expect(degraded.dispatcher.dispatch(message(channel))).resolves.toMatchObject({
          outcome: { kind: "FAILED", errorCode: "CAPABILITY_DEGRADED", retryable: true }, provider: "none", testOnly: false,
        });
      }
      // In-app delivery does not depend on the capability.
      await expect(degraded.dispatcher.dispatch({ ...message("SMS"), channel: "IN_APP" })).resolves.toMatchObject({ outcome: { kind: "DELIVERED" } });
      expect(degraded.providerCalls).toEqual([]);
      expect(degraded.lookups).toEqual([]);
      expect(degraded.registry.getClientProjection("MESSAGING")).toMatchObject({ state: "DEGRADED", isLive: false, canRetry: true });

      const rolledForward = runtime(base, from);
      await expect(rolledForward.dispatcher.dispatch(message("SMS"))).resolves.toMatchObject({
        outcome: { kind: "ACCEPTED", mode: from }, provider: "msg91", testOnly: from === "SANDBOX",
      });
      await expect(rolledForward.dispatcher.dispatch(message("PUSH"))).resolves.toMatchObject({
        outcome: { kind: "ACCEPTED", mode: from }, provider: "fcm", testOnly: from === "SANDBOX",
      });
      // SANDBOX never calls MSG91; FCM only validates (validate_only) and delivers nothing.
      const sends = rolledForward.providerCalls.filter((request) => !request.url.endsWith("/token"));
      expect(sends.map((request) => new URL(request.url).hostname)).toEqual(from === "SANDBOX"
        ? ["fcm.googleapis.com"]
        : ["control.msg91.com", "fcm.googleapis.com"]);
      if (from === "SANDBOX") expect(JSON.parse(sends[0]!.body)).toMatchObject({ validate_only: true });
    });

    it(`${from} -> UNCONFIGURED records NOT_SENT, never claims delivery, and contacts nothing`, async () => {
      const unconfigured = runtime(base, "UNCONFIGURED");
      expect(unconfigured.registry.getState("MESSAGING")).toBe("UNCONFIGURED");
      for (const channel of ["SMS", "PUSH"] as const) {
        await expect(unconfigured.dispatcher.dispatch(message(channel))).resolves.toEqual({
          outcome: { kind: "NOT_SENT", reasonCode: "CHANNEL_UNCONFIGURED" }, capabilityState: "UNCONFIGURED", testOnly: false, provider: "none",
        });
      }
      expect(unconfigured.providerCalls).toEqual([]);
      expect(unconfigured.lookups).toEqual([]);
    });
  }

  it("never builds a sandbox messaging adapter in production or a live one in local/test", () => {
    expect(() => validateEnvironment({ ...productionEnvironment, ...messagingConfig, MESSAGING_CAPABILITY_STATE: "SANDBOX" }))
      .toThrow(/SANDBOX messaging/u);
    expect(() => validateEnvironment({ ...testEnvironment, ...messagingConfig, MESSAGING_CAPABILITY_STATE: "LIVE" }))
      .toThrow(/LIVE messaging/u);
    // Even an unvalidated config never gets such an adapter.
    const unvalidated = { ...validateEnvironment({ ...testEnvironment, ...messagingConfig, MESSAGING_CAPABILITY_STATE: "SANDBOX" }) };
    expect(buildMessagingAdapter({ ...unvalidated, MESSAGING_CAPABILITY_STATE: "LIVE" }, secrets, () => {
      throw new Error("no directory is expected");
    })).toBeUndefined();
    expect(buildMessagingAdapter({ ...unvalidated, APP_ENV: "production" }, secrets, () => {
      throw new Error("no directory is expected");
    })).toBeUndefined();
  });
});
