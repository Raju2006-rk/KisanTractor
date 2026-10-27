import { validateEnvironment } from "@kisantractor/config";
import { CapabilityUnavailableError, LocalDevelopmentOtpAdapter } from "@kisantractor/providers";
import { describe, expect, it } from "vitest";

import { buildCapabilityRegistry, buildOnlinePaymentAdapter, loadPaymentProviderSecrets } from "./runtime-config.js";

const secureOrigins = {
  PUBLIC_WEB_ORIGIN: "https://kisantractor.example",
  PUBLIC_API_ORIGIN: "https://api.kisantractor.example",
  API_HOST: "0.0.0.0",
  API_PORT: "4000",
  DATABASE_URL: "postgresql://app:secret@db.internal:5432/kisantractor",
};
const sandboxStorage = { issueUploadGrant: async () => ({}) };

describe("buildCapabilityRegistry sandbox wiring", () => {
  it("registers the labelled local OTP adapter only for local/test with explicit opt-in", () => {
    for (const APP_ENV of ["local", "test"] as const) {
      const registry = buildCapabilityRegistry(validateEnvironment({
        APP_ENV, NODE_ENV: APP_ENV === "local" ? "development" : "test",
        OTP_CAPABILITY_STATE: "SANDBOX", ALLOW_LOCAL_OTP_CODES: "true",
      }));
      expect(registry.getState("OTP")).toBe("SANDBOX");
      expect(registry.requireConfigured("OTP")).toBeInstanceOf(LocalDevelopmentOtpAdapter);
      expect(registry.getClientProjection("OTP")).toMatchObject({ isTest: true, isLive: false });
    }
  });

  it("reports DEGRADED instead of claiming a sandbox without opt-in or outside local/test", () => {
    const withoutOptIn = buildCapabilityRegistry(validateEnvironment({
      APP_ENV: "test", NODE_ENV: "test", OTP_CAPABILITY_STATE: "SANDBOX", ALLOW_LOCAL_OTP_CODES: "false",
    }));
    expect(withoutOptIn.getState("OTP")).toBe("DEGRADED");
    expect(() => withoutOptIn.requireConfigured("OTP")).toThrow(CapabilityUnavailableError);

    const staging = buildCapabilityRegistry(validateEnvironment({
      APP_ENV: "staging", NODE_ENV: "production", ...secureOrigins,
      OTP_CAPABILITY_STATE: "SANDBOX", ALLOW_LOCAL_OTP_CODES: "true", STORAGE_CAPABILITY_STATE: "SANDBOX",
    }), { OBJECT_STORAGE: sandboxStorage });
    expect(staging.getState("OTP")).toBe("DEGRADED");
    expect(staging.getState("OBJECT_STORAGE")).toBe("DEGRADED");

    const production = buildCapabilityRegistry(validateEnvironment({
      APP_ENV: "production", NODE_ENV: "production", ...secureOrigins, OTP_CAPABILITY_STATE: "SANDBOX",
    }));
    expect(production.getState("OTP")).toBe("DEGRADED");
  });

  it("registers a configured map provider only when its declared mode matches the capability state", () => {
    const provider = {
      mode: "LIVE" as const,
      search: async () => [],
      reverseGeocode: async () => undefined,
    };
    const liveConfig = validateEnvironment({
      APP_ENV: "staging", NODE_ENV: "production", ...secureOrigins,
      MAPS_CAPABILITY_STATE: "LIVE",
    });
    const live = buildCapabilityRegistry(liveConfig, {}, { MAPS_GEOCODING: provider });
    expect(live.getState("MAPS_GEOCODING")).toBe("LIVE");
    expect(live.requireConfigured("MAPS_GEOCODING")).toBe(provider);

    const mismatched = buildCapabilityRegistry(
      validateEnvironment({ APP_ENV: "test", NODE_ENV: "test", MAPS_CAPABILITY_STATE: "SANDBOX" }),
      {},
      { MAPS_GEOCODING: provider },
    );
    expect(mismatched.getState("MAPS_GEOCODING")).toBe("DEGRADED");
  });

  it("uses a supplied sandbox provider only when its capability is configured as SANDBOX", () => {
    const sandbox = buildCapabilityRegistry(validateEnvironment({
      APP_ENV: "test", NODE_ENV: "test", STORAGE_CAPABILITY_STATE: "SANDBOX",
    }), { OBJECT_STORAGE: sandboxStorage });
    expect(sandbox.getState("OBJECT_STORAGE")).toBe("SANDBOX");
    expect(sandbox.requireConfigured("OBJECT_STORAGE")).toBe(sandboxStorage);

    const unconfigured = buildCapabilityRegistry(validateEnvironment({
      APP_ENV: "test", NODE_ENV: "test", STORAGE_CAPABILITY_STATE: "UNCONFIGURED",
    }), { OBJECT_STORAGE: sandboxStorage });
    expect(unconfigured.getState("OBJECT_STORAGE")).toBe("UNCONFIGURED");
    expect(unconfigured.getState("OTP")).toBe("UNCONFIGURED");
  });
});

/** Validates: Requirements 11.3, 12.1, 14.1, 14.3, 14.5, 18.7 */
describe("online payment adapter wiring", () => {
  // Synthetic values only; the live-shaped key id is assembled so no live-looking literal is committed.
  const testKey = "rzp_test_Kt0Synthetic01";
  const liveKey = ["rzp", "live", "Kt0Synthetic01"].join("_");
  const providerSecrets = { razorpayKeySecret: "synthetic-key-secret-for-tests", razorpayWebhookSecret: "synthetic-webhook-secret-for-tests" };
  const config = (overrides: Record<string, string>) => validateEnvironment({
    APP_ENV: "test", NODE_ENV: "test", PAYMENT_PROVIDER: "razorpay", RAZORPAY_KEY_ID: testKey, ...overrides,
  });
  const registryFor = (environment: Readonly<ReturnType<typeof validateEnvironment>>) => {
    const adapter = buildOnlinePaymentAdapter(environment, providerSecrets);
    return { adapter, registry: buildCapabilityRegistry(environment, {}, adapter === undefined ? {} : { ONLINE_PAYMENT: adapter }) };
  };

  it("reads provider secrets from the environment only when a provider is configured, failing closed", () => {
    expect(loadPaymentProviderSecrets(validateEnvironment({ APP_ENV: "test", NODE_ENV: "test" }), {})).toBeUndefined();
    expect(() => loadPaymentProviderSecrets(config({}), { RAZORPAY_KEY_SECRET: "synthetic-key-secret-for-tests" }))
      .toThrow(/Missing required secret environment variable RAZORPAY_WEBHOOK_SECRET/u);
    const secretValue = "synthetic-key-secret-for-tests";
    try {
      loadPaymentProviderSecrets(config({}), { RAZORPAY_KEY_SECRET: secretValue, RAZORPAY_WEBHOOK_SECRET: " " });
    } catch (error) {
      expect(String(error)).not.toContain(secretValue);
    }
    expect(loadPaymentProviderSecrets(config({}), {
      RAZORPAY_KEY_SECRET: "synthetic-key-secret-for-tests", RAZORPAY_WEBHOOK_SECRET: "synthetic-webhook-secret-for-tests",
    })).toEqual(providerSecrets);
    expect(() => buildOnlinePaymentAdapter(config({}), undefined)).toThrow(/requires RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET/u);
  });

  it("registers a Razorpay test key as SANDBOX and labels it as a test service", () => {
    const { adapter, registry } = registryFor(config({ PAYMENT_CAPABILITY_STATE: "SANDBOX" }));
    expect(adapter?.mode).toBe("SANDBOX");
    expect(registry.getState("ONLINE_PAYMENT")).toBe("SANDBOX");
    expect(registry.requireConfigured("ONLINE_PAYMENT")).toBe(adapter);
    expect(registry.getClientProjection("ONLINE_PAYMENT")).toMatchObject({ isTest: true, isLive: false, statusLabel: "Test service (sandbox)" });
  });

  it("registers a live key as LIVE only in staging or production and never runs test keys in production", () => {
    const production = registryFor(validateEnvironment({
      APP_ENV: "production", NODE_ENV: "production", ...secureOrigins, PAYMENT_PROVIDER: "razorpay", RAZORPAY_KEY_ID: liveKey,
      PAYMENT_CAPABILITY_STATE: "LIVE",
    }));
    expect(production.registry.getState("ONLINE_PAYMENT")).toBe("LIVE");
    expect(production.registry.getClientProjection("ONLINE_PAYMENT")).toMatchObject({ isLive: true, isTest: false });
    // Without a provider, a LIVE setting stays honestly DEGRADED.
    expect(buildCapabilityRegistry(validateEnvironment({ APP_ENV: "test", NODE_ENV: "test", PAYMENT_CAPABILITY_STATE: "LIVE" }))
      .getState("ONLINE_PAYMENT")).toBe("DEGRADED");
  });

  it("keeps the adapter for in-flight callbacks when rolled back to DEGRADED, and drops it when UNCONFIGURED", () => {
    const degraded = registryFor(config({ PAYMENT_CAPABILITY_STATE: "DEGRADED" }));
    expect(degraded.registry.getState("ONLINE_PAYMENT")).toBe("DEGRADED");
    expect(() => degraded.registry.requireConfigured("ONLINE_PAYMENT")).toThrow(CapabilityUnavailableError);
    expect(degraded.registry.getInFlightProvider("ONLINE_PAYMENT")).toBe(degraded.adapter);

    const unconfigured = registryFor(config({ PAYMENT_CAPABILITY_STATE: "UNCONFIGURED" }));
    expect(unconfigured.registry.getState("ONLINE_PAYMENT")).toBe("UNCONFIGURED");
    expect(unconfigured.registry.getInFlightProvider("ONLINE_PAYMENT")).toBeUndefined();
  });
});
