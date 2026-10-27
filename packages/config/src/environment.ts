import {
  capabilityStates,
  projectCapabilityStates,
  type CapabilityState,
  type CapabilityStateMap,
  type ClientCapabilityProjection,
  type DevelopmentOnlyProviderFeature,
} from "@kisantractor/providers";
import { z } from "zod";

export const deploymentEnvironments = [
  "local",
  "test",
  "staging",
  "production",
] as const;

export type DeploymentEnvironment = (typeof deploymentEnvironments)[number];

const deploymentEnvironmentSchema = z.enum(deploymentEnvironments);
const nodeEnvironmentSchema = z.enum(["development", "test", "production"]);
const logLevelSchema = z.enum(["debug", "info", "warn", "error"]);
/**
 * Telemetry export target. `none` keeps spans and metric snapshots in process;
 * `stdout` writes them as JSON lines for a collector. Neither needs a backend.
 */
export const telemetryExporterValues = ["none", "stdout"] as const;
const telemetryExporterSchema = z.enum(telemetryExporterValues);
const capabilityStateSchema = z.enum(capabilityStates);
const booleanTextSchema = z
  .enum(["true", "false"])
  .transform((value) => value === "true");

/** E.164: a plus sign, a nonzero country-code digit, and 8 to 15 digits in total. */
export const e164PhoneNumberPattern = /^\+[1-9]\d{7,14}$/;

/**
 * The dedicated public booking number for the IVR channel. It is optional and
 * blank by default; a non-blank value must be E.164 so the site can never show
 * a malformed or placeholder number.
 */
const telephonyBookingNumberSchema = z
  .string()
  .trim()
  .transform((value) => (value ? value : undefined))
  .refine((value) => value === undefined || e164PhoneNumberPattern.test(value), {
    message: "must be blank or an E.164 phone number: + then the country code and number, digits only",
  })
  .optional();

/** Online payment adapter. `none` keeps ONLINE_PAYMENT honest (UNCONFIGURED or DEGRADED). */
export const paymentProviderValues = ["none", "razorpay"] as const;
export type PaymentProviderName = (typeof paymentProviderValues)[number];

/** Razorpay publishable key id. Its prefix decides test (`rzp_test_`) or live (`rzp_live_`) mode. */
export const razorpayKeyIdPattern = /^rzp_(test|live)_[A-Za-z0-9]{8,32}$/;

const razorpayKeyIdSchema = z
  .string()
  .trim()
  .transform((value) => (value ? value : undefined))
  .refine((value) => value === undefined || razorpayKeyIdPattern.test(value), {
    message: "must be blank or a Razorpay key id (rzp_test_... or rzp_live_...)",
  })
  .optional();

const paymentProviderEnvironmentShape = {
  PAYMENT_PROVIDER: z.enum(paymentProviderValues),
  RAZORPAY_KEY_ID: razorpayKeyIdSchema,
};

/** SMS adapter. `msg91` sends DLT-registered templates through the MSG91 Flow API. */
export const smsProviderValues = ["none", "msg91"] as const;
/** Push adapter. `fcm` sends through Firebase Cloud Messaging HTTP v1. */
export const pushProviderValues = ["none", "fcm"] as const;

/** `<templateKey>@<version>:<locale>`, the key of one DLT-registered SMS template. */
export const smsTemplateRegistrationKeyPattern = /^notification\.[a-z][A-Za-z.]{2,80}@[1-9]\d{0,3}:(en|hi|te|kn|ta|mr|bn)$/u;
const msg91TemplateIdPattern = /^[A-Za-z0-9_-]{6,64}$/u;

const optionalText = z
  .string()
  .trim()
  .transform((value) => (value ? value : undefined))
  .optional();

/**
 * MSG91 template ids as JSON: `{"notification.booking.accepted@1:en": "<MSG91 template id>"}`.
 * Each MSG91 template is linked to its DLT template id in the MSG91 dashboard; ids differ per
 * environment and account, so they are configuration, never code.
 */
const msg91TemplateIdsSchema = z
  .string()
  .trim()
  .transform((value, context): Readonly<Record<string, string>> | undefined => {
    if (!value) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      context.addIssue({ code: "custom", message: "must be a JSON object of template registration keys to MSG91 template ids" });
      return z.NEVER;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      context.addIssue({ code: "custom", message: "must be a JSON object of template registration keys to MSG91 template ids" });
      return z.NEVER;
    }
    for (const [key, id] of Object.entries(parsed)) {
      if (!smsTemplateRegistrationKeyPattern.test(key) || typeof id !== "string" || !msg91TemplateIdPattern.test(id)) {
        context.addIssue({ code: "custom", message: "keys must look like notification.<name>@<version>:<locale> and ids like an MSG91 template id" });
        return z.NEVER;
      }
    }
    return Object.freeze({ ...(parsed as Record<string, string>) });
  })
  .optional();

const messagingProviderEnvironmentShape = {
  SMS_PROVIDER: z.enum(smsProviderValues),
  PUSH_PROVIDER: z.enum(pushProviderValues),
  MSG91_TEMPLATE_IDS: msg91TemplateIdsSchema,
  FCM_PROJECT_ID: optionalText,
  FCM_SERVICE_ACCOUNT_EMAIL: optionalText,
  /** Phase 2 launch switch for consent-aware Owner contact sharing (Requirement 1.4). */
  ENABLE_OWNER_CONTACT_SHARING: z.enum(["true", "false"]).transform((value) => value === "true"),
  /**
   * Phase 2 launch switch for support dispute workflows (Requirement 1.4). While false, the API
   * keeps the deny-all support access policy: no operator can read or resolve a case or request a
   * refund, whatever grants exist.
   */
  ENABLE_SUPPORT_WORKFLOWS: z.enum(["true", "false"]).transform((value) => value === "true"),
};

const capabilityEnvironmentShape = {
  OTP_CAPABILITY_STATE: capabilityStateSchema,
  MAPS_CAPABILITY_STATE: capabilityStateSchema,
  PAYMENT_CAPABILITY_STATE: capabilityStateSchema,
  MESSAGING_CAPABILITY_STATE: capabilityStateSchema,
  STORAGE_CAPABILITY_STATE: capabilityStateSchema,
  TELEPHONY_CAPABILITY_STATE: capabilityStateSchema,
  TELEPHONY_BOOKING_NUMBER: telephonyBookingNumberSchema,
};

const providerSafetyEnvironmentShape = {
  ALLOW_LOCAL_OTP_CODES: booleanTextSchema,
  ALLOW_UNSIGNED_PROVIDER_CALLBACKS: booleanTextSchema,
  ALLOW_FAKE_PHONE_NUMBERS: booleanTextSchema,
  ALLOW_TEST_PAYMENT_SUCCESS: booleanTextSchema,
};

const commonEnvironmentShape = {
  CONFIG_VERSION: z.literal("1"),
  API_HOST: z.string().trim().min(1).refine((value) => !/\s/.test(value), {
    message: "must not contain whitespace",
  }),
  API_PORT: z.coerce.number().int().min(1).max(65_535),
  PUBLIC_WEB_ORIGIN: z.url(),
  PUBLIC_API_ORIGIN: z.url(),
  DATABASE_URL: z.string().trim().min(1).refine(
    (value) => value.startsWith("postgresql://") || value.startsWith("postgres://"),
    { message: "must be a PostgreSQL connection URL" },
  ),
  LOG_LEVEL: logLevelSchema,
  TELEMETRY_EXPORTER: telemetryExporterSchema,
  ENABLE_PWA: booleanTextSchema,
  ...capabilityEnvironmentShape,
  ...paymentProviderEnvironmentShape,
  ...messagingProviderEnvironmentShape,
  ...providerSafetyEnvironmentShape,
};

interface MessagingProviderFields {
  readonly APP_ENV: DeploymentEnvironment;
  readonly SMS_PROVIDER?: (typeof smsProviderValues)[number] | undefined;
  readonly PUSH_PROVIDER?: (typeof pushProviderValues)[number] | undefined;
  readonly MSG91_TEMPLATE_IDS?: Readonly<Record<string, string>> | undefined;
  readonly FCM_PROJECT_ID?: string | undefined;
  readonly FCM_SERVICE_ACCOUNT_EMAIL?: string | undefined;
  readonly MESSAGING_CAPABILITY_STATE: CapabilityState;
}

/**
 * Configured messaging providers run in the MESSAGING state's mode: SANDBOX (MSG91 not called,
 * FCM validate-only) never in production, LIVE (real recipients) never in local or test
 * (Requirements 14.3, 14.5). Credentials (MSG91 auth key, FCM private key) come from the secret
 * store, not this schema.
 */
function validateMessagingProviders(value: MessagingProviderFields, context: z.RefinementCtx): void {
  const sms = value.SMS_PROVIDER === "msg91";
  const push = value.PUSH_PROVIDER === "fcm";
  if (sms && (value.MSG91_TEMPLATE_IDS === undefined || Object.keys(value.MSG91_TEMPLATE_IDS).length === 0)) {
    context.addIssue({ code: "custom", path: ["MSG91_TEMPLATE_IDS"], message: "is required when SMS_PROVIDER is msg91" });
  }
  if (push && value.FCM_PROJECT_ID === undefined) {
    context.addIssue({ code: "custom", path: ["FCM_PROJECT_ID"], message: "is required when PUSH_PROVIDER is fcm" });
  }
  if (push && value.FCM_SERVICE_ACCOUNT_EMAIL === undefined) {
    context.addIssue({ code: "custom", path: ["FCM_SERVICE_ACCOUNT_EMAIL"], message: "is required when PUSH_PROVIDER is fcm" });
  }
  if (!sms && !push) return;
  if (value.MESSAGING_CAPABILITY_STATE === "SANDBOX" && value.APP_ENV === "production") {
    context.addIssue({
      code: "custom", path: ["MESSAGING_CAPABILITY_STATE"],
      message: "SANDBOX messaging is development-only and must not run in production",
    });
  }
  if (value.MESSAGING_CAPABILITY_STATE === "LIVE" && (value.APP_ENV === "local" || value.APP_ENV === "test")) {
    context.addIssue({
      code: "custom", path: ["MESSAGING_CAPABILITY_STATE"],
      message: "LIVE messaging reaches real phones and is allowed only in staging or production",
    });
  }
}

function validateProviders(value: PaymentProviderFields & MessagingProviderFields, context: z.RefinementCtx): void {
  validatePaymentProvider(value, context);
  validateMessagingProviders(value, context);
}

interface PaymentProviderFields {
  readonly APP_ENV: DeploymentEnvironment;
  readonly PAYMENT_PROVIDER: PaymentProviderName;
  readonly RAZORPAY_KEY_ID?: string | undefined;
  readonly PAYMENT_CAPABILITY_STATE: CapabilityState;
}

/**
 * Keeps test money and live money apart (Requirements 14.3, 14.5). Secrets (key secret, webhook
 * secret) are not part of this schema; the API reads them from the secret store at startup.
 */
function validatePaymentProvider(value: PaymentProviderFields, context: z.RefinementCtx): void {
  if (value.PAYMENT_PROVIDER !== "razorpay") return;
  const keyId = value.RAZORPAY_KEY_ID;
  if (keyId === undefined) {
    context.addIssue({ code: "custom", path: ["RAZORPAY_KEY_ID"], message: "is required when PAYMENT_PROVIDER is razorpay" });
    return;
  }
  const live = keyId.startsWith("rzp_live_");
  if (live && (value.APP_ENV === "local" || value.APP_ENV === "test")) {
    context.addIssue({
      code: "custom", path: ["RAZORPAY_KEY_ID"],
      message: "a live Razorpay key is allowed only in staging or production",
    });
  }
  if (!live && value.APP_ENV === "production") {
    context.addIssue({
      code: "custom", path: ["RAZORPAY_KEY_ID"],
      message: "a Razorpay test key is development-only and must not be used in production",
    });
  }
  if (value.PAYMENT_CAPABILITY_STATE === "SANDBOX" && live) {
    context.addIssue({ code: "custom", path: ["PAYMENT_CAPABILITY_STATE"], message: "SANDBOX requires a Razorpay test key" });
  }
  if (value.PAYMENT_CAPABILITY_STATE === "LIVE" && !live) {
    context.addIssue({ code: "custom", path: ["PAYMENT_CAPABILITY_STATE"], message: "LIVE requires a Razorpay live key" });
  }
}

export const localEnvironmentSchema = z
  .object({
    ...commonEnvironmentShape,
    APP_ENV: z.literal("local"),
    NODE_ENV: z.literal("development"),
  })
  .superRefine(validateProviders);

export const testEnvironmentSchema = z
  .object({
    ...commonEnvironmentShape,
    APP_ENV: z.literal("test"),
    NODE_ENV: z.literal("test"),
  })
  .superRefine(validateProviders);

function requireSecurePublicOrigins(
  value: { PUBLIC_WEB_ORIGIN: string; PUBLIC_API_ORIGIN: string },
  context: z.RefinementCtx,
): void {
  for (const field of ["PUBLIC_WEB_ORIGIN", "PUBLIC_API_ORIGIN"] as const) {
    if (!value[field].startsWith("https://")) {
      context.addIssue({
        code: "custom",
        path: [field],
        message: "must use HTTPS outside local and test environments",
      });
    }
  }
}

const developmentFeatureEnvironmentFields = {
  LOCAL_OTP_CODES: "ALLOW_LOCAL_OTP_CODES",
  UNSIGNED_CALLBACKS: "ALLOW_UNSIGNED_PROVIDER_CALLBACKS",
  FAKE_PHONE_NUMBERS: "ALLOW_FAKE_PHONE_NUMBERS",
  TEST_PAYMENT_SUCCESS: "ALLOW_TEST_PAYMENT_SUCCESS",
} as const satisfies Readonly<
  Record<DevelopmentOnlyProviderFeature, keyof typeof providerSafetyEnvironmentShape>
>;

function rejectUnsafeProductionProviderFeatures(
  value: Record<keyof typeof providerSafetyEnvironmentShape, boolean>,
  context: z.RefinementCtx,
): void {
  for (const [feature, field] of Object.entries(
    developmentFeatureEnvironmentFields,
  ) as [DevelopmentOnlyProviderFeature, keyof typeof providerSafetyEnvironmentShape][]) {
    if (value[field]) {
      context.addIssue({
        code: "custom",
        path: [field],
        message: `${feature} is development-only and must be false in production`,
      });
    }
  }
}

export const stagingEnvironmentSchema = z
  .object({
    ...commonEnvironmentShape,
    APP_ENV: z.literal("staging"),
    NODE_ENV: z.literal("production"),
  })
  .superRefine((value, context) => {
    requireSecurePublicOrigins(value, context);
    validateProviders(value, context);
  });

export const productionEnvironmentSchema = z
  .object({
    ...commonEnvironmentShape,
    APP_ENV: z.literal("production"),
    NODE_ENV: z.literal("production"),
  })
  .superRefine((value, context) => {
    requireSecurePublicOrigins(value, context);
    rejectUnsafeProductionProviderFeatures(value, context);
    validateProviders(value, context);
  });

export const environmentSchemas = {
  local: localEnvironmentSchema,
  test: testEnvironmentSchema,
  staging: stagingEnvironmentSchema,
  production: productionEnvironmentSchema,
} as const;

export type EnvironmentConfig =
  | z.output<typeof localEnvironmentSchema>
  | z.output<typeof testEnvironmentSchema>
  | z.output<typeof stagingEnvironmentSchema>
  | z.output<typeof productionEnvironmentSchema>;

export interface PublicRuntimeConfig {
  readonly configVersion: "1";
  readonly environment: DeploymentEnvironment;
  readonly nodeEnvironment: z.output<typeof nodeEnvironmentSchema>;
  readonly apiHost: string;
  readonly apiPort: number;
  readonly publicWebOrigin: string;
  readonly publicApiOrigin: string;
  readonly logLevel: z.output<typeof logLevelSchema>;
  readonly telemetryExporter: z.output<typeof telemetryExporterSchema>;
  readonly pwaEnabled: boolean;
  readonly databaseConfigured: boolean;
  readonly capabilities: ClientCapabilityProjection;
  /**
   * The configured dedicated booking number, present only while telephony is
   * LIVE. Every other state yields null so no surface can advertise it early.
   */
  readonly telephonyBookingNumber: string | null;
}

const providerDefaults = {
  TELEMETRY_EXPORTER: "none",
  OTP_CAPABILITY_STATE: "UNCONFIGURED",
  MAPS_CAPABILITY_STATE: "UNCONFIGURED",
  PAYMENT_CAPABILITY_STATE: "UNCONFIGURED",
  MESSAGING_CAPABILITY_STATE: "UNCONFIGURED",
  STORAGE_CAPABILITY_STATE: "UNCONFIGURED",
  TELEPHONY_CAPABILITY_STATE: "UNCONFIGURED",
  PAYMENT_PROVIDER: "none",
  SMS_PROVIDER: "none",
  PUSH_PROVIDER: "none",
  ENABLE_OWNER_CONTACT_SHARING: "false",
  ENABLE_SUPPORT_WORKFLOWS: "false",
  ALLOW_LOCAL_OTP_CODES: "false",
  ALLOW_UNSIGNED_PROVIDER_CALLBACKS: "false",
  ALLOW_FAKE_PHONE_NUMBERS: "false",
  ALLOW_TEST_PAYMENT_SUCCESS: "false",
} as const;

const profileDefaults: Readonly<
  Record<DeploymentEnvironment, Readonly<Record<string, string>>>
> = {
  local: {
    CONFIG_VERSION: "1",
    APP_ENV: "local",
    NODE_ENV: "development",
    API_HOST: "127.0.0.1",
    API_PORT: "4000",
    PUBLIC_WEB_ORIGIN: "http://localhost:3000",
    PUBLIC_API_ORIGIN: "http://localhost:4000",
    DATABASE_URL:
      "postgresql://kisantractor:kisantractor@localhost:5432/kisantractor_local",
    LOG_LEVEL: "debug",
    ENABLE_PWA: "true",
    ...providerDefaults,
  },
  test: {
    CONFIG_VERSION: "1",
    APP_ENV: "test",
    NODE_ENV: "test",
    API_HOST: "127.0.0.1",
    API_PORT: "4100",
    PUBLIC_WEB_ORIGIN: "http://localhost:3100",
    PUBLIC_API_ORIGIN: "http://localhost:4100",
    DATABASE_URL:
      "postgresql://kisantractor:kisantractor@localhost:5432/kisantractor_test",
    LOG_LEVEL: "warn",
    ENABLE_PWA: "false",
    ...providerDefaults,
  },
  staging: {
    CONFIG_VERSION: "1",
    APP_ENV: "staging",
    NODE_ENV: "production",
    LOG_LEVEL: "info",
    ENABLE_PWA: "true",
    ...providerDefaults,
  },
  production: {
    CONFIG_VERSION: "1",
    APP_ENV: "production",
    NODE_ENV: "production",
    LOG_LEVEL: "info",
    ENABLE_PWA: "true",
    ...providerDefaults,
  },
};

function formatValidationError(error: z.ZodError): Error {
  const details = error.issues
    .map((issue) => {
      const field = issue.path.length > 0 ? issue.path.join(".") : "environment";
      return `- ${field}: ${issue.message}`;
    })
    .join("\n");

  return new Error(`Invalid environment configuration:\n${details}`);
}

export function validateEnvironment(
  input: Readonly<Record<string, string | undefined>>,
): Readonly<EnvironmentConfig> {
  const environmentResult = deploymentEnvironmentSchema.safeParse(
    input.APP_ENV ?? "local",
  );

  if (!environmentResult.success) {
    throw new Error(
      `Invalid environment configuration:\n- APP_ENV: must be one of ${deploymentEnvironments.join(
        ", ",
      )}`,
    );
  }

  const environment = environmentResult.data;
  const result = environmentSchemas[environment].safeParse({
    ...profileDefaults[environment],
    ...input,
  });

  if (!result.success) {
    throw formatValidationError(result.error);
  }

  return Object.freeze(result.data) as Readonly<EnvironmentConfig>;
}

function getCapabilityStates(
  config: Readonly<EnvironmentConfig>,
): CapabilityStateMap {
  return Object.freeze({
    OTP: config.OTP_CAPABILITY_STATE as CapabilityState,
    MAPS_GEOCODING: config.MAPS_CAPABILITY_STATE as CapabilityState,
    ONLINE_PAYMENT: config.PAYMENT_CAPABILITY_STATE as CapabilityState,
    MESSAGING: config.MESSAGING_CAPABILITY_STATE as CapabilityState,
    OBJECT_STORAGE: config.STORAGE_CAPABILITY_STATE as CapabilityState,
    TELEPHONY: config.TELEPHONY_CAPABILITY_STATE as CapabilityState,
  });
}

export function getPublicRuntimeConfig(
  config: Readonly<EnvironmentConfig>,
): Readonly<PublicRuntimeConfig> {
  return Object.freeze({
    configVersion: config.CONFIG_VERSION,
    environment: config.APP_ENV,
    nodeEnvironment: config.NODE_ENV,
    apiHost: config.API_HOST,
    apiPort: config.API_PORT,
    publicWebOrigin: config.PUBLIC_WEB_ORIGIN,
    publicApiOrigin: config.PUBLIC_API_ORIGIN,
    logLevel: config.LOG_LEVEL,
    // Older validated configs built by hand (tests) may omit the field.
    telemetryExporter: config.TELEMETRY_EXPORTER ?? "none",
    pwaEnabled: config.ENABLE_PWA,
    databaseConfigured: config.DATABASE_URL.length > 0,
    capabilities: projectCapabilityStates(getCapabilityStates(config)),
    telephonyBookingNumber: publicTelephonyBookingNumber(config),
  });
}

function publicTelephonyBookingNumber(config: Readonly<EnvironmentConfig>): string | null {
  const number = config.TELEPHONY_BOOKING_NUMBER;
  return config.TELEPHONY_CAPABILITY_STATE === "LIVE" &&
    typeof number === "string" &&
    e164PhoneNumberPattern.test(number)
    ? number
    : null;
}
