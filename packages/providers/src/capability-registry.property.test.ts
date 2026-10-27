import fc from "fast-check";
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
import type {
  CapabilityRegistrations,
  CapabilityState,
  DevelopmentOnlyProviderFeature,
  ProviderCapability,
  ProviderRuntimeSafety,
} from "./capability-registry.js";

const propertyRuns = 200;
const seeds = {
  unconfiguredSideEffects: 1_401_402,
  truthfulOperationalLabels: 1_403_001,
  productionSafety: 1_405_005,
} as const;

const capabilityArbitrary = fc.constantFrom<ProviderCapability>(
  ...providerCapabilities,
);
const environmentArbitrary = fc.constantFrom<
  ProviderRuntimeSafety["environment"]
>("local", "test", "staging", "production");
const operationalStateArbitrary = fc.constantFrom<"SANDBOX" | "LIVE">(
  "SANDBOX",
  "LIVE",
);
const developmentFeatureSetArbitrary = fc.uniqueArray(
  fc.constantFrom<DevelopmentOnlyProviderFeature>(
    ...developmentOnlyProviderFeatures,
  ),
  { maxLength: developmentOnlyProviderFeatures.length },
);

function registrationFor(
  capability: ProviderCapability,
  state: CapabilityState,
  provider?: unknown,
): CapabilityRegistrations {
  if (state === "SANDBOX" || state === "LIVE") {
    return {
      [capability]: { state, provider },
    } as CapabilityRegistrations;
  }

  return {
    [capability]: { state },
  } as CapabilityRegistrations;
}

function runSeededProperty(
  name: string,
  seed: number,
  assertion: () => void,
): void {
  try {
    assertion();
    console.info(
      `[PBT] ${name}: seed=${seed} runs=${propertyRuns} minimizedCounterexample=none`,
    );
  } catch (error) {
    console.error(
      `[PBT] ${name}: seed=${seed} minimizedCounterexample=reported by fast-check below`,
    );
    throw error;
  }
}

describe("Property 16: Capability Honesty", () => {
  /** Validates: Requirements 14.1, 14.2 */
  it("blocks every unconfigured capability before any external effect in every environment", () => {
    const seed = seeds.unconfiguredSideEffects;

    runSeededProperty("unconfigured-side-effects", seed, () => {
      fc.assert(
        fc.property(
          capabilityArbitrary,
          environmentArbitrary,
          (capability, environment) => {
            assertProviderRuntimeSafety({ environment });

            const externalEffects: ProviderCapability[] = [];
            const registry = new CapabilityRegistry(
              registrationFor(capability, "UNCONFIGURED"),
            );

            const invoke = () => {
              const provider = registry.requireConfigured<{
                invoke: () => void;
              }>(capability);
              provider.invoke();
              externalEffects.push(capability);
            };

            expect(invoke).toThrowError(
              expect.objectContaining({
                code: "CAPABILITY_UNAVAILABLE",
                capability,
                state: "UNCONFIGURED",
                retryable: false,
              }),
            );
            expect(externalEffects).toEqual([]);

            const presentation = registry.getClientProjection(capability);
            expect(capabilityStates).toContain(presentation.state);
            expect(presentation).toMatchObject({
              capability,
              state: "UNCONFIGURED",
              isOperational: false,
              isLive: false,
              isTest: false,
            });
            expect(presentation.statusLabel).not.toMatch(/\blive\b/i);
          },
        ),
        { seed, numRuns: propertyRuns, verbose: 2 },
      );
    });
  });

  /** Validates: Requirements 14.1, 14.3 */
  it("truthfully distinguishes generated sandbox and live capability presentations", () => {
    const seed = seeds.truthfulOperationalLabels;

    runSeededProperty("truthful-sandbox-live-labels", seed, () => {
      fc.assert(
        fc.property(
          capabilityArbitrary,
          environmentArbitrary,
          operationalStateArbitrary,
          (capability, environment, state) => {
            assertProviderRuntimeSafety({ environment });

            const provider = Object.freeze({ capability, environment, state });
            const registry = new CapabilityRegistry(
              registrationFor(capability, state, provider),
            );
            const presentation = registry.getClientProjection(capability);

            expect(capabilityStates).toContain(registry.getState(capability));
            expect(registry.requireConfigured(capability)).toBe(provider);
            expect(presentation).toMatchObject({ capability, state });

            if (state === "SANDBOX") {
              expect(presentation.statusLabel).toMatch(/test|sandbox/i);
              expect(presentation).toMatchObject({
                isOperational: true,
                isLive: false,
                isTest: true,
              });
              expect(presentation.message).toMatch(/test/i);
              expect(presentation.message).toMatch(/no live/i);
            } else {
              expect(presentation.statusLabel).toMatch(/\blive\b/i);
              expect(presentation.statusLabel).not.toMatch(/test|sandbox/i);
              expect(presentation).toMatchObject({
                isOperational: true,
                isLive: true,
                isTest: false,
              });
            }
          },
        ),
        { seed, numRuns: propertyRuns, verbose: 2 },
      );
    });
  });

  /** Validates: Requirements 14.5 */
  it("rejects generated development-only provider features exactly in production", () => {
    const seed = seeds.productionSafety;

    runSeededProperty("production-development-feature-safety", seed, () => {
      fc.assert(
        fc.property(
          environmentArbitrary,
          developmentFeatureSetArbitrary,
          (environment, enabledDevelopmentFeatures) => {
            const check = () =>
              assertProviderRuntimeSafety({
                environment,
                enabledDevelopmentFeatures,
              });

            if (
              environment === "production" &&
              enabledDevelopmentFeatures.length > 0
            ) {
              expect(check).toThrow(UnsafeProductionProviderConfigurationError);

              try {
                check();
              } catch (error) {
                expect(error).toBeInstanceOf(
                  UnsafeProductionProviderConfigurationError,
                );
                expect(
                  (error as UnsafeProductionProviderConfigurationError)
                    .enabledFeatures,
                ).toEqual(enabledDevelopmentFeatures);
              }
            } else {
              expect(check).not.toThrow();
            }
          },
        ),
        { seed, numRuns: propertyRuns, verbose: 2 },
      );
    });
  });
});
