import { Buffer } from "node:buffer";
import type { EnvironmentConfig } from "@kisantractor/config";
import {
  CapabilityRegistry,
  FcmPushAdapter,
  LocalDevelopmentOtpAdapter,
  MessagingChannelRouter,
  Msg91SmsAdapter,
  RazorpayPaymentAdapter,
  type CapabilityRegistration,
  type CapabilityRegistrations,
  type CapabilityState,
  type ConfiguredMapGeocodingProvider,
  type MessagingHttpClient,
  type ModalNotificationChannelAdapter,
  type OnlinePaymentProviderAdapter,
  type PaymentHttpClient,
  type ProviderCapability,
  type PushDeviceDirectory,
  type SmsRecipientDirectory,
} from "@kisantractor/providers";
import type { IdentityPolicy, IdentityRuntimeConfig } from "./identity/identity.contracts.js";

/**
 * Required byte length for every cryptographic key loaded from the environment.
 * Field encryption, HMAC lookup, OTP, and session keys are all 32-byte secrets.
 */
const SECRET_KEY_BYTES = 32;

/**
 * Names of the hex-encoded 32-byte secret keys that the running API requires.
 * Secrets are never hard-coded; they are loaded from the process environment
 * and validated at startup so the service fails fast when any is absent.
 */
export const SECRET_ENV_KEYS = [
  "FIELD_ENCRYPTION_KEY",
  "LOOKUP_HASH_KEY",
  "OTP_HASH_KEY",
  "SESSION_HASH_KEY",
  "PHONE_ENCRYPTION_KEY",
  "DISCOVERY_CURSOR_SIGNING_KEY",
] as const;

export type SecretEnvKey = (typeof SECRET_ENV_KEYS)[number];

export type RuntimeSecrets = Readonly<Record<SecretEnvKey, Uint8Array>>;

function readSecretKey(
  env: Readonly<Record<string, string | undefined>>,
  name: SecretEnvKey,
): Uint8Array {
  const raw = env[name];
  if (raw === undefined || raw.trim().length === 0) {
    throw new Error(
      `Missing required secret environment variable ${name}: provide a ${SECRET_KEY_BYTES}-byte key as ${SECRET_KEY_BYTES * 2} hex characters`,
    );
  }
  const normalized = raw.trim();
  if (!/^[0-9a-fA-F]+$/u.test(normalized) || normalized.length !== SECRET_KEY_BYTES * 2) {
    throw new Error(
      `Invalid secret environment variable ${name}: expected ${SECRET_KEY_BYTES * 2} hex characters (${SECRET_KEY_BYTES} bytes)`,
    );
  }
  return Uint8Array.from(Buffer.from(normalized, "hex"));
}

/**
 * Loads every required secret from the environment, failing fast with a clear,
 * secret-free message when a key is missing or malformed.
 */
export function loadRuntimeSecrets(
  env: Readonly<Record<string, string | undefined>>,
): RuntimeSecrets {
  const entries = SECRET_ENV_KEYS.map(
    (name) => [name, readSecretKey(env, name)] as const,
  );
  return Object.freeze(Object.fromEntries(entries)) as RuntimeSecrets;
}

/** Provider credentials, read from the secret store (process environment) only when needed. */
export const PAYMENT_PROVIDER_SECRET_ENV_KEYS = ["RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET"] as const;

export interface PaymentProviderSecrets {
  readonly razorpayKeySecret: string;
  readonly razorpayWebhookSecret: string;
}

const configuredPaymentProvider = (config: Readonly<EnvironmentConfig>): "none" | "razorpay" =>
  // Hand-built test configs may omit the field; absent means no provider.
  config.PAYMENT_PROVIDER ?? "none";

/**
 * Loads the online payment provider's secrets when PAYMENT_PROVIDER names one, failing fast with
 * a value-free message when a secret is absent. Returns undefined when no provider is configured.
 */
export function loadPaymentProviderSecrets(
  config: Readonly<EnvironmentConfig>,
  env: Readonly<Record<string, string | undefined>>,
): PaymentProviderSecrets | undefined {
  if (configuredPaymentProvider(config) !== "razorpay") return undefined;
  const read = (name: (typeof PAYMENT_PROVIDER_SECRET_ENV_KEYS)[number]): string => {
    const value = env[name]?.trim();
    if (value === undefined || value.length === 0) {
      throw new Error(`Missing required secret environment variable ${name} for PAYMENT_PROVIDER=razorpay`);
    }
    return value;
  };
  return Object.freeze({
    razorpayKeySecret: read("RAZORPAY_KEY_SECRET"),
    razorpayWebhookSecret: read("RAZORPAY_WEBHOOK_SECRET"),
  });
}

export interface OnlinePaymentAdapterOptions {
  /** Injectable HTTP client; contract tests use it so no request reaches the provider. */
  readonly http?: PaymentHttpClient;
  readonly apiBaseUrl?: string;
}

/**
 * Builds the configured online payment adapter, or undefined when PAYMENT_PROVIDER is `none`.
 * A configured provider without its credentials is a startup error, never a silent fallback.
 */
export function buildOnlinePaymentAdapter(
  config: Readonly<EnvironmentConfig>,
  secrets: PaymentProviderSecrets | undefined,
  options: OnlinePaymentAdapterOptions = {},
): OnlinePaymentProviderAdapter | undefined {
  if (configuredPaymentProvider(config) !== "razorpay") return undefined;
  const keyId = config.RAZORPAY_KEY_ID;
  if (secrets === undefined || keyId === undefined) {
    throw new Error("PAYMENT_PROVIDER=razorpay requires RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, and RAZORPAY_WEBHOOK_SECRET");
  }
  return new RazorpayPaymentAdapter({
    environment: config.APP_ENV,
    keyId,
    keySecret: secrets.razorpayKeySecret,
    webhookSecret: secrets.razorpayWebhookSecret,
    ...(options.http === undefined ? {} : { http: options.http }),
    ...(options.apiBaseUrl === undefined ? {} : { apiBaseUrl: options.apiBaseUrl }),
  });
}

/** Messaging credentials, read from the secret store only for the configured providers. */
export const MESSAGING_PROVIDER_SECRET_ENV_KEYS = ["MSG91_AUTH_KEY", "FCM_SERVICE_ACCOUNT_PRIVATE_KEY"] as const;

export interface MessagingProviderSecrets {
  readonly msg91AuthKey?: string;
  readonly fcmPrivateKeyPem?: string;
}

const smsProviderOf = (config: Readonly<EnvironmentConfig>): "none" | "msg91" => config.SMS_PROVIDER ?? "none";
const pushProviderOf = (config: Readonly<EnvironmentConfig>): "none" | "fcm" => config.PUSH_PROVIDER ?? "none";

/** True when SMS_PROVIDER or PUSH_PROVIDER names a provider. */
export const messagingProviderConfigured = (config: Readonly<EnvironmentConfig>): boolean =>
  smsProviderOf(config) !== "none" || pushProviderOf(config) !== "none";

/**
 * Loads the secrets of every configured messaging provider, failing fast with a value-free
 * message when one is absent. Returns undefined when no messaging provider is configured.
 */
export function loadMessagingProviderSecrets(
  config: Readonly<EnvironmentConfig>,
  env: Readonly<Record<string, string | undefined>>,
): MessagingProviderSecrets | undefined {
  if (!messagingProviderConfigured(config)) return undefined;
  const read = (name: (typeof MESSAGING_PROVIDER_SECRET_ENV_KEYS)[number], provider: string): string => {
    const value = env[name]?.trim();
    if (value === undefined || value.length === 0) {
      throw new Error(`Missing required secret environment variable ${name} for ${provider}`);
    }
    return value;
  };
  return Object.freeze({
    ...(smsProviderOf(config) === "msg91" ? { msg91AuthKey: read("MSG91_AUTH_KEY", "SMS_PROVIDER=msg91") } : {}),
    ...(pushProviderOf(config) === "fcm" ? { fcmPrivateKeyPem: read("FCM_SERVICE_ACCOUNT_PRIVATE_KEY", "PUSH_PROVIDER=fcm") } : {}),
  });
}

/** Where messaging adapters resolve numbers and device tokens at send time. */
export interface MessagingDirectories {
  readonly sms: SmsRecipientDirectory;
  readonly push: PushDeviceDirectory;
}

export interface MessagingAdapterOptions {
  /** Injectable HTTP client; contract tests use it so no request reaches a provider. */
  readonly http?: MessagingHttpClient;
  readonly msg91ApiBaseUrl?: string;
  readonly fcmApiBaseUrl?: string;
  readonly oauthTokenUrl?: string;
}

/**
 * Builds the MESSAGING provider handle from configuration: a router over the configured SMS
 * (MSG91) and push (FCM) adapters, each in the mode the configured state names. Returns
 * undefined unless the state is SANDBOX or LIVE and a provider is configured; a configured
 * provider without its credentials is a startup error, never a silent fallback. Production
 * never builds a SANDBOX adapter, and local/test never build a LIVE one.
 */
export function buildMessagingAdapter(
  config: Readonly<EnvironmentConfig>,
  secrets: MessagingProviderSecrets | undefined,
  directories: () => MessagingDirectories,
  options: MessagingAdapterOptions = {},
): ModalNotificationChannelAdapter | undefined {
  const state = config.MESSAGING_CAPABILITY_STATE as CapabilityState;
  if ((state !== "SANDBOX" && state !== "LIVE") || !messagingProviderConfigured(config)) return undefined;
  // Validation already refuses these; an unvalidated config still never gets such an adapter.
  if (state === "SANDBOX" && config.APP_ENV === "production") return undefined;
  if (state === "LIVE" && (config.APP_ENV === "local" || config.APP_ENV === "test")) return undefined;
  const resolved = directories();
  const adapters: ModalNotificationChannelAdapter[] = [];
  if (smsProviderOf(config) === "msg91") {
    if (secrets?.msg91AuthKey === undefined || config.MSG91_TEMPLATE_IDS === undefined) {
      throw new Error("SMS_PROVIDER=msg91 requires MSG91_TEMPLATE_IDS and MSG91_AUTH_KEY");
    }
    adapters.push(new Msg91SmsAdapter({
      environment: config.APP_ENV,
      mode: state,
      authKey: secrets.msg91AuthKey,
      templateIds: config.MSG91_TEMPLATE_IDS,
      recipients: resolved.sms,
      ...(options.http === undefined ? {} : { http: options.http }),
      ...(options.msg91ApiBaseUrl === undefined ? {} : { apiBaseUrl: options.msg91ApiBaseUrl }),
    }));
  }
  if (pushProviderOf(config) === "fcm") {
    if (secrets?.fcmPrivateKeyPem === undefined || config.FCM_PROJECT_ID === undefined || config.FCM_SERVICE_ACCOUNT_EMAIL === undefined) {
      throw new Error("PUSH_PROVIDER=fcm requires FCM_PROJECT_ID, FCM_SERVICE_ACCOUNT_EMAIL, and FCM_SERVICE_ACCOUNT_PRIVATE_KEY");
    }
    adapters.push(new FcmPushAdapter({
      environment: config.APP_ENV,
      mode: state,
      projectId: config.FCM_PROJECT_ID,
      serviceAccountEmail: config.FCM_SERVICE_ACCOUNT_EMAIL,
      privateKeyPem: secrets.fcmPrivateKeyPem,
      devices: resolved.push,
      ...(options.http === undefined ? {} : { http: options.http }),
      ...(options.fcmApiBaseUrl === undefined ? {} : { apiBaseUrl: options.fcmApiBaseUrl }),
      ...(options.oauthTokenUrl === undefined ? {} : { tokenUrl: options.oauthTokenUrl }),
    }));
  }
  return new MessagingChannelRouter(adapters);
}

/** Real provider adapters built from configuration and secrets (not test doubles). */
export interface ConfiguredProviders {
  readonly MAPS_GEOCODING?: ConfiguredMapGeocodingProvider;
  readonly ONLINE_PAYMENT?: OnlinePaymentProviderAdapter;
  readonly MESSAGING?: ModalNotificationChannelAdapter;
}

const capabilityStateByConfigField: Readonly<
  Record<ProviderCapability, keyof EnvironmentConfig>
> = {
  OTP: "OTP_CAPABILITY_STATE",
  MAPS_GEOCODING: "MAPS_CAPABILITY_STATE",
  ONLINE_PAYMENT: "PAYMENT_CAPABILITY_STATE",
  MESSAGING: "MESSAGING_CAPABILITY_STATE",
  OBJECT_STORAGE: "STORAGE_CAPABILITY_STATE",
  TELEPHONY: "TELEPHONY_CAPABILITY_STATE",
};

/**
 * Sandbox provider handles supplied by the composition root's caller (for example an
 * end-to-end harness). They are honoured only in local/test with the matching SANDBOX state.
 */
export type SandboxProviders = Partial<Readonly<Record<Exclude<ProviderCapability, "OTP">, unknown>>>;

const sandboxEnvironment = (config: Readonly<EnvironmentConfig>): "local" | "test" | undefined =>
  config.APP_ENV === "local" || config.APP_ENV === "test" ? config.APP_ENV : undefined;

/**
 * Registration for a capability backed by a configured real adapter. The adapter's own mode
 * (a Razorpay test or live key) must equal the configured state; the adapter already refuses
 * test keys in production and live keys in local/test. DEGRADED keeps the adapter only so
 * signed callbacks for intents created before a rollback can still be verified and recorded;
 * `requireConfigured` refuses it for any new provider action.
 */
function configuredRegistration(
  state: CapabilityState,
  adapter: { readonly mode: "SANDBOX" | "LIVE" } | undefined,
): CapabilityRegistration | undefined {
  if (adapter === undefined) return undefined;
  if (state === "UNCONFIGURED") return { state };
  if (state === "DEGRADED") return { state, provider: adapter, manualAlternativeAvailable: true };
  return state === adapter.mode
    ? { state, provider: adapter }
    : { state: "DEGRADED", manualAlternativeAvailable: true };
}

/**
 * Builds a capability registry from the validated environment. Capabilities that
 * are not LIVE/SANDBOX stay UNCONFIGURED or DEGRADED without a provider, so every
 * provider-backed entry point reports an honest state.
 *
 * OTP in SANDBOX uses the explicitly labelled local-development adapter, and only
 * when APP_ENV is local/test and ALLOW_LOCAL_OTP_CODES=true. Other SANDBOX states
 * use a supplied sandbox provider under the same environment rule.
 *
 * ONLINE_PAYMENT uses a configured real adapter when one is supplied (Razorpay: test keys
 * run SANDBOX in local/test/staging, live keys run LIVE in staging/production); see
 * `configuredRegistration`. MESSAGING does the same with the MSG91/FCM router built by
 * `buildMessagingAdapter`. Without one, the sandbox and DEGRADED rules above apply.
 */
export function buildCapabilityRegistry(
  config: Readonly<EnvironmentConfig>,
  sandboxProviders: SandboxProviders = {},
  configuredProviders: ConfiguredProviders = {},
): CapabilityRegistry {
  const environment = sandboxEnvironment(config);
  const sandboxProvider = (capability: ProviderCapability): unknown => {
    if (environment === undefined) return undefined;
    if (capability === "OTP") {
      return config.ALLOW_LOCAL_OTP_CODES
        ? new LocalDevelopmentOtpAdapter({ environment, enabled: true })
        : undefined;
    }
    return sandboxProviders[capability];
  };
  const entries = (Object.keys(capabilityStateByConfigField) as ProviderCapability[]).map(
    (capability): readonly [ProviderCapability, CapabilityRegistration] => {
      const state = config[capabilityStateByConfigField[capability]] as CapabilityState;
      const configured = capability === "MAPS_GEOCODING"
        ? configuredRegistration(state, configuredProviders.MAPS_GEOCODING)
        : capability === "ONLINE_PAYMENT"
          ? configuredRegistration(state, configuredProviders.ONLINE_PAYMENT)
          : capability === "MESSAGING"
            // Configured messaging providers replace any sandbox handle (the in-memory test adapter).
            ? configuredRegistration(state, configuredProviders.MESSAGING)
            : undefined;
      if (configured !== undefined) return [capability, configured];
      const provider = state === "SANDBOX" ? sandboxProvider(capability) : undefined;
      // SANDBOX/LIVE require a concrete provider instance. Without one the registry
      // reports DEGRADED so it never claims a provider action that cannot happen.
      // UNCONFIGURED/DEGRADED need no provider and are passed through unchanged.
      const registration: CapabilityRegistration =
        provider !== undefined
          ? { state: "SANDBOX", provider }
          : state === "SANDBOX" || state === "LIVE"
            ? { state: "DEGRADED", manualAlternativeAvailable: true }
            : { state };
      return [capability, registration];
    },
  );
  return new CapabilityRegistry(Object.fromEntries(entries) as CapabilityRegistrations);
}

const identityEnvironmentByAppEnv: Readonly<
  Record<EnvironmentConfig["APP_ENV"], IdentityRuntimeConfig["environment"]>
> = {
  local: "local",
  test: "test",
  staging: "staging",
  production: "production",
};

const defaultIdentityPolicy: IdentityPolicy = Object.freeze({
  otpLength: 6,
  otpTtlMs: 5 * 60_000,
  maxOtpAttempts: 3,
  phoneRequestWindowMs: 60_000,
  maxPhoneRequests: 3,
  requesterWindowMs: 60_000,
  maxRequesterRequests: 5,
  accessTtlMs: 15 * 60_000,
  refreshTtlMs: 30 * 24 * 60 * 60_000,
});

/** Assembles the identity runtime config from validated env and loaded secrets. */
export function buildIdentityRuntimeConfig(
  config: Readonly<EnvironmentConfig>,
  secrets: RuntimeSecrets,
): IdentityRuntimeConfig {
  return Object.freeze({
    environment: identityEnvironmentByAppEnv[config.APP_ENV],
    policy: defaultIdentityPolicy,
    secrets: Object.freeze({
      otpHashKey: secrets.OTP_HASH_KEY,
      lookupHashKey: secrets.LOOKUP_HASH_KEY,
      sessionHashKey: secrets.SESSION_HASH_KEY,
      phoneEncryptionKey: secrets.PHONE_ENCRYPTION_KEY,
    }),
  });
}
