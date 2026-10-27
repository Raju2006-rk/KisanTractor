export const capabilityStates = [
  "UNCONFIGURED",
  "SANDBOX",
  "LIVE",
  "DEGRADED",
] as const;

export type CapabilityState = (typeof capabilityStates)[number];

export const providerCapabilities = [
  "OTP",
  "MAPS_GEOCODING",
  "ONLINE_PAYMENT",
  "MESSAGING",
  "OBJECT_STORAGE",
  "TELEPHONY",
] as const;

export type ProviderCapability = (typeof providerCapabilities)[number];

export interface ClientCapabilityPresentation {
  readonly capability: ProviderCapability;
  readonly state: CapabilityState;
  readonly statusLabel: string;
  readonly message: string;
  readonly isOperational: boolean;
  readonly isLive: boolean;
  readonly isTest: boolean;
  readonly canRetry: boolean;
  readonly manualAlternativeAvailable: boolean;
}

export type ClientCapabilityProjection = Readonly<
  Record<ProviderCapability, Readonly<ClientCapabilityPresentation>>
>;

export type CapabilityRegistration =
  | {
      readonly state: "UNCONFIGURED";
      readonly provider?: never;
      readonly manualAlternativeAvailable?: boolean;
    }
  | {
      readonly state: "SANDBOX" | "LIVE";
      readonly provider: unknown;
      readonly manualAlternativeAvailable?: boolean;
    }
  | {
      readonly state: "DEGRADED";
      readonly provider?: unknown;
      readonly manualAlternativeAvailable?: boolean;
    };

export type CapabilityRegistrations = Partial<
  Readonly<Record<ProviderCapability, CapabilityRegistration>>
>;

export type CapabilityStateMap = Readonly<
  Record<ProviderCapability, CapabilityState>
>;

const presentationByState = {
  UNCONFIGURED: {
    statusLabel: "Unavailable",
    message: "This service is not configured.",
    isOperational: false,
    isLive: false,
    isTest: false,
    canRetry: false,
  },
  SANDBOX: {
    statusLabel: "Test service (sandbox)",
    message: "This is a test service. No live provider action will occur.",
    isOperational: true,
    isLive: false,
    isTest: true,
    canRetry: false,
  },
  LIVE: {
    statusLabel: "Live service",
    message: "This provider service is live.",
    isOperational: true,
    isLive: true,
    isTest: false,
    canRetry: false,
  },
  DEGRADED: {
    statusLabel: "Temporarily unavailable",
    message: "This service is temporarily unavailable. Please retry safely.",
    isOperational: false,
    isLive: false,
    isTest: false,
    canRetry: true,
  },
} as const satisfies Readonly<
  Record<
    CapabilityState,
    Omit<
      ClientCapabilityPresentation,
      "capability" | "state" | "manualAlternativeAvailable"
    >
  >
>;

function projectCapability(
  capability: ProviderCapability,
  state: CapabilityState,
  manualAlternativeAvailable: boolean,
): Readonly<ClientCapabilityPresentation> {
  return Object.freeze({
    capability,
    state,
    ...presentationByState[state],
    manualAlternativeAvailable,
  });
}

export function projectCapabilityStates(
  states: CapabilityStateMap,
): ClientCapabilityProjection {
  const projection = {} as Record<
    ProviderCapability,
    Readonly<ClientCapabilityPresentation>
  >;

  for (const capability of providerCapabilities) {
    projection[capability] = projectCapability(
      capability,
      states[capability],
      capability === "MAPS_GEOCODING",
    );
  }

  return Object.freeze(projection);
}

export class CapabilityUnavailableError extends Error {
  readonly code = "CAPABILITY_UNAVAILABLE";

  constructor(
    readonly capability: ProviderCapability,
    readonly state: "UNCONFIGURED" | "DEGRADED",
    readonly retryable: boolean,
    readonly manualAlternativeAvailable: boolean,
  ) {
    super(
      state === "UNCONFIGURED"
        ? `${capability} capability is not configured`
        : `${capability} capability is temporarily degraded`,
    );
    this.name = "CapabilityUnavailableError";
  }
}

function normalizeRegistration(
  capability: ProviderCapability,
  registration: CapabilityRegistration | undefined,
): Readonly<CapabilityRegistration> {
  const resolved = registration ?? { state: "UNCONFIGURED" };

  if (
    (resolved.state === "SANDBOX" || resolved.state === "LIVE") &&
    resolved.provider === undefined
  ) {
    throw new TypeError(
      `${capability} capability in ${resolved.state} state requires a provider handle`,
    );
  }

  if (resolved.state === "UNCONFIGURED" && "provider" in resolved) {
    throw new TypeError(
      `${capability} capability in UNCONFIGURED state cannot have a provider handle`,
    );
  }

  return Object.freeze({ ...resolved });
}

export class CapabilityRegistry {
  readonly #registrations: Readonly<
    Record<ProviderCapability, Readonly<CapabilityRegistration>>
  >;

  constructor(registrations: CapabilityRegistrations = {}) {
    const normalized = {} as Record<
      ProviderCapability,
      Readonly<CapabilityRegistration>
    >;

    for (const capability of providerCapabilities) {
      normalized[capability] = normalizeRegistration(
        capability,
        registrations[capability],
      );
    }

    this.#registrations = Object.freeze(normalized);
  }

  getState(capability: ProviderCapability): CapabilityState {
    return this.#registrations[capability].state;
  }

  requireConfigured<TProvider = unknown>(
    capability: ProviderCapability,
  ): TProvider {
    const registration = this.#registrations[capability];

    if (
      registration.state === "UNCONFIGURED" ||
      registration.state === "DEGRADED"
    ) {
      throw new CapabilityUnavailableError(
        capability,
        registration.state,
        registration.state === "DEGRADED",
        registration.manualAlternativeAvailable ?? false,
      );
    }

    return registration.provider as TProvider;
  }

  /**
   * Returns the registered provider handle, including one kept while the capability is DEGRADED.
   * Use it only to finish work the provider already started, such as verifying a signed callback
   * for an intent created before a rollback. New provider actions must use `requireConfigured`.
   */
  getInFlightProvider<TProvider = unknown>(
    capability: ProviderCapability,
  ): TProvider | undefined {
    const registration = this.#registrations[capability];
    return registration.state === "UNCONFIGURED"
      ? undefined
      : (registration.provider as TProvider | undefined);
  }

  getClientProjection(
    capability: ProviderCapability,
  ): Readonly<ClientCapabilityPresentation> {
    const registration = this.#registrations[capability];

    return projectCapability(
      capability,
      registration.state,
      registration.manualAlternativeAvailable ?? false,
    );
  }

  getClientCapabilities(): ClientCapabilityProjection {
    const projection = {} as Record<
      ProviderCapability,
      Readonly<ClientCapabilityPresentation>
    >;

    for (const capability of providerCapabilities) {
      projection[capability] = this.getClientProjection(capability);
    }

    return Object.freeze(projection);
  }
}

export const developmentOnlyProviderFeatures = [
  "LOCAL_OTP_CODES",
  "UNSIGNED_CALLBACKS",
  "FAKE_PHONE_NUMBERS",
  "TEST_PAYMENT_SUCCESS",
] as const;

export type DevelopmentOnlyProviderFeature =
  (typeof developmentOnlyProviderFeatures)[number];

export interface ProviderRuntimeSafety {
  readonly environment: "local" | "test" | "staging" | "production";
  readonly enabledDevelopmentFeatures?: readonly DevelopmentOnlyProviderFeature[];
}

export class UnsafeProductionProviderConfigurationError extends Error {
  readonly code = "UNSAFE_PRODUCTION_PROVIDER_CONFIGURATION";

  constructor(
    readonly enabledFeatures: readonly DevelopmentOnlyProviderFeature[],
  ) {
    super(
      `Production cannot enable development-only provider features: ${enabledFeatures.join(
        ", ",
      )}`,
    );
    this.name = "UnsafeProductionProviderConfigurationError";
  }
}

export function assertProviderRuntimeSafety(
  safety: ProviderRuntimeSafety,
): void {
  const enabledFeatures = safety.enabledDevelopmentFeatures ?? [];

  if (safety.environment === "production" && enabledFeatures.length > 0) {
    throw new UnsafeProductionProviderConfigurationError(
      Object.freeze([...enabledFeatures]),
    );
  }
}
