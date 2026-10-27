import { describe, expect, it } from "vitest";

import {
  assertProviderRuntimeSafety,
  CapabilityRegistry,
  CapabilityUnavailableError,
  capabilityStates,
  developmentOnlyProviderFeatures,
  providerCapabilities,
  UnsafeProductionProviderConfigurationError,
} from "./capability-registry.js";

describe("CapabilityRegistry", () => {
  it("represents every provider capability as unconfigured by default", () => {
    const registry = new CapabilityRegistry();

    expect(providerCapabilities.map((capability) => registry.getState(capability)))
      .toEqual(providerCapabilities.map(() => "UNCONFIGURED"));
    expect(capabilityStates).toEqual([
      "UNCONFIGURED",
      "SANDBOX",
      "LIVE",
      "DEGRADED",
    ]);
  });

  it("returns provider handles only for sandbox and live capabilities", () => {
    const sandboxProvider = { send: () => "sandbox" };
    const liveProvider = { send: () => "live" };
    const registry = new CapabilityRegistry({
      OTP: { state: "SANDBOX", provider: sandboxProvider },
      MESSAGING: { state: "LIVE", provider: liveProvider },
    });

    expect(registry.requireConfigured("OTP")).toBe(sandboxProvider);
    expect(registry.requireConfigured("MESSAGING")).toBe(liveProvider);
  });

  it("rejects unconfigured operations before an external side effect can run", () => {
    let externalEffects = 0;
    const registry = new CapabilityRegistry();

    const invoke = () => {
      const provider = registry.requireConfigured<{ send: () => void }>("OTP");
      provider.send();
      externalEffects += 1;
    };

    expect(invoke).toThrowError(
      expect.objectContaining({
        code: "CAPABILITY_UNAVAILABLE",
        state: "UNCONFIGURED",
        retryable: false,
      }),
    );
    expect(externalEffects).toBe(0);
  });

  it("returns retry and manual-alternative metadata for degraded services", () => {
    const registry = new CapabilityRegistry({
      MAPS_GEOCODING: {
        state: "DEGRADED",
        provider: { secret: "server-only" },
        manualAlternativeAvailable: true,
      },
    });

    expect(() => registry.requireConfigured("MAPS_GEOCODING")).toThrowError(
      expect.objectContaining({
        state: "DEGRADED",
        retryable: true,
        manualAlternativeAvailable: true,
      }),
    );
    expect(registry.getClientProjection("MAPS_GEOCODING")).toMatchObject({
      state: "DEGRADED",
      canRetry: true,
      manualAlternativeAvailable: true,
      isOperational: false,
    });
  });

  it("projects truthful sandbox and live labels without provider secrets", () => {
    const secret = "provider-secret-value";
    const registry = new CapabilityRegistry({
      ONLINE_PAYMENT: {
        state: "SANDBOX",
        provider: { secret },
      },
      OBJECT_STORAGE: {
        state: "LIVE",
        provider: { secret },
      },
    });

    const projection = registry.getClientCapabilities();

    expect(projection.ONLINE_PAYMENT).toMatchObject({
      statusLabel: "Test service (sandbox)",
      isTest: true,
      isLive: false,
    });
    expect(projection.OBJECT_STORAGE).toMatchObject({
      statusLabel: "Live service",
      isTest: false,
      isLive: true,
    });
    expect(JSON.stringify(projection)).not.toContain(secret);
    expect(Object.isFrozen(projection)).toBe(true);
    expect(Object.isFrozen(projection.ONLINE_PAYMENT)).toBe(true);
  });

  it("rejects operational registrations that have no provider handle", () => {
    expect(
      () =>
        new CapabilityRegistry({
          OTP: { state: "LIVE" } as never,
        }),
    ).toThrow(/requires a provider handle/);
  });
});

describe("assertProviderRuntimeSafety", () => {
  it.each(developmentOnlyProviderFeatures)(
    "rejects %s in production",
    (feature) => {
      expect(() =>
        assertProviderRuntimeSafety({
          environment: "production",
          enabledDevelopmentFeatures: [feature],
        }),
      ).toThrow(UnsafeProductionProviderConfigurationError);
    },
  );

  it("allows explicitly enabled development features outside production", () => {
    expect(() =>
      assertProviderRuntimeSafety({
        environment: "test",
        enabledDevelopmentFeatures: developmentOnlyProviderFeatures,
      }),
    ).not.toThrow();
  });
});
