import { describe, expect, it } from "vitest";

import { createTestEnvironment } from "@kisantractor/test-utils";

import {
  getPublicRuntimeConfig,
  validateEnvironment,
} from "./environment.js";

describe("validateEnvironment", () => {
  it("loads repeatable local defaults", () => {
    const config = validateEnvironment({});

    expect(config).toMatchObject({
      APP_ENV: "local",
      NODE_ENV: "development",
      API_HOST: "127.0.0.1",
      API_PORT: 4000,
      ENABLE_PWA: true,
    });
    expect(Object.isFrozen(config)).toBe(true);
  });

  it("accepts a complete production profile", () => {
    const config = validateEnvironment(
      createTestEnvironment({
        APP_ENV: "production",
        NODE_ENV: "production",
        API_HOST: "0.0.0.0",
        API_PORT: "8080",
        PUBLIC_WEB_ORIGIN: "https://kisantractor.example",
        PUBLIC_API_ORIGIN: "https://api.kisantractor.example",
        DATABASE_URL:
          "postgresql://runtime-user:runtime-password@db.example:5432/kisantractor",
        LOG_LEVEL: "info",
        ENABLE_PWA: "true",
      }),
    );

    expect(config.APP_ENV).toBe("production");
    expect(config.API_PORT).toBe(8080);
  });

  it("rejects insecure production origins", () => {
    expect(() =>
      validateEnvironment(
        createTestEnvironment({
          APP_ENV: "production",
          NODE_ENV: "production",
          PUBLIC_WEB_ORIGIN: "http://kisantractor.example",
          PUBLIC_API_ORIGIN: "https://api.kisantractor.example",
        }),
      ),
    ).toThrow(/PUBLIC_WEB_ORIGIN: must use HTTPS/);
  });

  it("reports invalid fields without disclosing secret values", () => {
    const secret = "do-not-print-this-password";

    expect(() =>
      validateEnvironment(
        createTestEnvironment({
          APP_ENV: "production",
          NODE_ENV: "production",
          PUBLIC_WEB_ORIGIN: "not-a-url",
          PUBLIC_API_ORIGIN: "https://api.kisantractor.example",
          DATABASE_URL: secret,
        }),
      ),
    ).toThrowError(
      expect.objectContaining({
        message: expect.not.stringContaining(secret),
      }),
    );
  });
});

describe("getPublicRuntimeConfig", () => {
  it("exposes only non-secret startup configuration", () => {
    const config = validateEnvironment(createTestEnvironment());
    const publicConfig = getPublicRuntimeConfig(config);

    expect(publicConfig).toMatchObject({
      environment: "test",
      apiPort: 4100,
      databaseConfigured: true,
      capabilities: {
        OTP: {
          state: "UNCONFIGURED",
          isOperational: false,
          isLive: false,
        },
      },
    });
    expect(JSON.stringify(publicConfig)).not.toContain("DATABASE_URL");
    expect(JSON.stringify(publicConfig)).not.toContain("test-password");
    expect(JSON.stringify(publicConfig)).not.toContain("ALLOW_LOCAL_OTP_CODES");
    expect(Object.isFrozen(publicConfig)).toBe(true);
  });

  it("projects configured states with an explicit sandbox label", () => {
    const config = validateEnvironment(
      createTestEnvironment({
        OTP_CAPABILITY_STATE: "SANDBOX",
        STORAGE_CAPABILITY_STATE: "LIVE",
        PAYMENT_CAPABILITY_STATE: "DEGRADED",
      }),
    );

    const publicConfig = getPublicRuntimeConfig(config);

    expect(publicConfig.capabilities.OTP).toMatchObject({
      state: "SANDBOX",
      statusLabel: "Test service (sandbox)",
      isTest: true,
      isLive: false,
    });
    expect(publicConfig.capabilities.OBJECT_STORAGE.isLive).toBe(true);
    expect(publicConfig.capabilities.ONLINE_PAYMENT.canRetry).toBe(true);
  });
});

describe("telephony booking number", () => {
  const configuredNumber = "+910000000000";
  const publicNumber = (overrides: Record<string, string>) =>
    getPublicRuntimeConfig(validateEnvironment(createTestEnvironment(overrides)))
      .telephonyBookingNumber;

  it("is absent by default and when left blank", () => {
    expect(publicNumber({})).toBeNull();
    expect(publicNumber({ TELEPHONY_CAPABILITY_STATE: "LIVE", TELEPHONY_BOOKING_NUMBER: "  " })).toBeNull();
  });

  it("is published only while telephony is LIVE", () => {
    expect(publicNumber({ TELEPHONY_CAPABILITY_STATE: "LIVE", TELEPHONY_BOOKING_NUMBER: configuredNumber })).toBe(configuredNumber);
    for (const state of ["UNCONFIGURED", "SANDBOX", "DEGRADED"]) {
      expect(publicNumber({ TELEPHONY_CAPABILITY_STATE: state, TELEPHONY_BOOKING_NUMBER: configuredNumber })).toBeNull();
    }
  });

  it("rejects a number that is not E.164 at startup", () => {
    for (const value of ["1800-123-4567", "+0123456789", "+91 98765 43210", "call us"]) {
      expect(() =>
        validateEnvironment(createTestEnvironment({ TELEPHONY_BOOKING_NUMBER: value })),
      ).toThrow(/TELEPHONY_BOOKING_NUMBER: must be blank or an E\.164/);
    }
  });
});


describe("production provider safety", () => {
  const unsafeFlags = [
    "ALLOW_LOCAL_OTP_CODES",
    "ALLOW_UNSIGNED_PROVIDER_CALLBACKS",
    "ALLOW_FAKE_PHONE_NUMBERS",
    "ALLOW_TEST_PAYMENT_SUCCESS",
  ] as const;

  it.each(unsafeFlags)("rejects %s", (flag) => {
    expect(() =>
      validateEnvironment(
        createTestEnvironment({
          APP_ENV: "production",
          NODE_ENV: "production",
          PUBLIC_WEB_ORIGIN: "https://kisantractor.example",
          PUBLIC_API_ORIGIN: "https://api.kisantractor.example",
          [flag]: "true",
        }),
      ),
    ).toThrow(new RegExp(`${flag}: .*development-only`));
  });

  it("allows development-only provider features in a test environment", () => {
    expect(() =>
      validateEnvironment(
        createTestEnvironment({
          ALLOW_LOCAL_OTP_CODES: "true",
          ALLOW_UNSIGNED_PROVIDER_CALLBACKS: "true",
          ALLOW_FAKE_PHONE_NUMBERS: "true",
          ALLOW_TEST_PAYMENT_SUCCESS: "true",
        }),
      ),
    ).not.toThrow();
  });
});

/** Validates: Requirements 11.3, 14.3, 14.5 */
describe("online payment provider configuration", () => {
  // Synthetic key ids; the live-shaped one is assembled so no live-looking literal is committed.
  const testKey = "rzp_test_Kt0Synthetic01";
  const liveKey = ["rzp", "live", "Kt0Synthetic01"].join("_");
  const secureOrigins = {
    PUBLIC_WEB_ORIGIN: "https://kisantractor.example",
    PUBLIC_API_ORIGIN: "https://api.kisantractor.example",
  };

  it("defaults to no provider and keeps the key id out of the public configuration", () => {
    expect(validateEnvironment(createTestEnvironment())).toMatchObject({ PAYMENT_PROVIDER: "none" });
    const config = validateEnvironment(createTestEnvironment({
      PAYMENT_PROVIDER: "razorpay", RAZORPAY_KEY_ID: testKey, PAYMENT_CAPABILITY_STATE: "SANDBOX",
    }));
    expect(config).toMatchObject({ PAYMENT_PROVIDER: "razorpay", RAZORPAY_KEY_ID: testKey });
    expect(getPublicRuntimeConfig(config).capabilities.ONLINE_PAYMENT).toMatchObject({
      state: "SANDBOX", isTest: true, statusLabel: "Test service (sandbox)",
    });
    expect(JSON.stringify(getPublicRuntimeConfig(config))).not.toContain(testKey);
  });

  it("requires a key id and keeps test keys out of production and live keys out of local and test", () => {
    expect(() => validateEnvironment(createTestEnvironment({ PAYMENT_PROVIDER: "razorpay" })))
      .toThrow(/RAZORPAY_KEY_ID: is required/u);
    expect(() => validateEnvironment(createTestEnvironment({ PAYMENT_PROVIDER: "razorpay", RAZORPAY_KEY_ID: "sk_test_123" })))
      .toThrow(/RAZORPAY_KEY_ID: must be blank or a Razorpay key id/u);
    expect(() => validateEnvironment(createTestEnvironment({ PAYMENT_PROVIDER: "razorpay", RAZORPAY_KEY_ID: liveKey })))
      .toThrow(/RAZORPAY_KEY_ID: a live Razorpay key is allowed only in staging or production/u);
    expect(() => validateEnvironment(createTestEnvironment({
      APP_ENV: "production", NODE_ENV: "production", ...secureOrigins, PAYMENT_PROVIDER: "razorpay", RAZORPAY_KEY_ID: testKey,
    }))).toThrow(/RAZORPAY_KEY_ID: a Razorpay test key is development-only/u);
    expect(validateEnvironment(createTestEnvironment({
      APP_ENV: "production", NODE_ENV: "production", ...secureOrigins, PAYMENT_PROVIDER: "razorpay", RAZORPAY_KEY_ID: liveKey,
      PAYMENT_CAPABILITY_STATE: "LIVE",
    }))).toMatchObject({ PAYMENT_CAPABILITY_STATE: "LIVE" });
  });

  it("matches the key mode to SANDBOX or LIVE, and leaves rollback states free", () => {
    const staging = (state: string, key: string) => () => validateEnvironment(createTestEnvironment({
      APP_ENV: "staging", NODE_ENV: "production", ...secureOrigins, PAYMENT_PROVIDER: "razorpay", RAZORPAY_KEY_ID: key,
      PAYMENT_CAPABILITY_STATE: state,
    }));
    expect(staging("SANDBOX", liveKey)).toThrow(/PAYMENT_CAPABILITY_STATE: SANDBOX requires a Razorpay test key/u);
    expect(staging("LIVE", testKey)).toThrow(/PAYMENT_CAPABILITY_STATE: LIVE requires a Razorpay live key/u);
    for (const state of ["DEGRADED", "UNCONFIGURED"]) {
      expect(staging(state, testKey)).not.toThrow();
      expect(staging(state, liveKey)).not.toThrow();
    }
  });
});

/** Validates: Requirements 1.4, 14.3, 14.5 */
describe("messaging provider configuration", () => {
  const secureOrigins = {
    PUBLIC_WEB_ORIGIN: "https://kisantractor.example",
    PUBLIC_API_ORIGIN: "https://api.kisantractor.example",
  };
  const templates = JSON.stringify({ "notification.booking.accepted@1:en": "64f0aSyntheticAccepted" });
  const fcm = { PUSH_PROVIDER: "fcm", FCM_PROJECT_ID: "kt-synthetic", FCM_SERVICE_ACCOUNT_EMAIL: "kisan-fcm@kt-synthetic.iam.gserviceaccount.com" };

  it("defaults to no providers and contact sharing switched off", () => {
    expect(validateEnvironment(createTestEnvironment())).toMatchObject({
      SMS_PROVIDER: "none", PUSH_PROVIDER: "none", ENABLE_OWNER_CONTACT_SHARING: false,
    });
  });

  it("parses MSG91 template ids from configuration and refuses malformed maps", () => {
    const config = validateEnvironment(createTestEnvironment({
      SMS_PROVIDER: "msg91", MSG91_TEMPLATE_IDS: templates, MESSAGING_CAPABILITY_STATE: "SANDBOX",
    }));
    expect(config.MSG91_TEMPLATE_IDS).toEqual({ "notification.booking.accepted@1:en": "64f0aSyntheticAccepted" });
    const validExpandedTemplates = JSON.stringify({
      "notification.booking.accepted@1:mr": "64f0aSyntheticMarathi",
      "notification.booking.accepted@1:bn": "64f0aSyntheticBengali",
    });
    expect(validateEnvironment(createTestEnvironment({
      SMS_PROVIDER: "msg91", MSG91_TEMPLATE_IDS: validExpandedTemplates, MESSAGING_CAPABILITY_STATE: "SANDBOX",
    })).MSG91_TEMPLATE_IDS).toEqual(JSON.parse(validExpandedTemplates));

    expect(() => validateEnvironment(createTestEnvironment({ SMS_PROVIDER: "msg91" })))
      .toThrow(/MSG91_TEMPLATE_IDS: is required when SMS_PROVIDER is msg91/u);
    for (const malformed of ["not json", "[]", JSON.stringify({ "booking.accepted": "64f0aSynthetic" }), JSON.stringify({ "notification.booking.accepted@1:gu": "x" })]) {
      expect(() => validateEnvironment(createTestEnvironment({ SMS_PROVIDER: "msg91", MSG91_TEMPLATE_IDS: malformed })), malformed)
        .toThrow(/MSG91_TEMPLATE_IDS/u);
    }
    expect(() => validateEnvironment(createTestEnvironment({ PUSH_PROVIDER: "fcm" }))).toThrow(/FCM_PROJECT_ID: is required/u);
  });

  it("keeps sandbox messaging out of production and live messaging out of local and test", () => {
    expect(() => validateEnvironment(createTestEnvironment({ ...fcm, MESSAGING_CAPABILITY_STATE: "LIVE" })))
      .toThrow(/LIVE messaging reaches real phones/u);
    expect(() => validateEnvironment(createTestEnvironment({
      APP_ENV: "production", NODE_ENV: "production", ...secureOrigins, ...fcm, MESSAGING_CAPABILITY_STATE: "SANDBOX",
    }))).toThrow(/SANDBOX messaging is development-only/u);
    expect(validateEnvironment(createTestEnvironment({
      APP_ENV: "production", NODE_ENV: "production", ...secureOrigins, ...fcm, SMS_PROVIDER: "msg91",
      MSG91_TEMPLATE_IDS: templates, MESSAGING_CAPABILITY_STATE: "LIVE",
    }))).toMatchObject({ MESSAGING_CAPABILITY_STATE: "LIVE", SMS_PROVIDER: "msg91", PUSH_PROVIDER: "fcm" });
    // Rollback states are always accepted.
    for (const state of ["DEGRADED", "UNCONFIGURED"]) {
      expect(() => validateEnvironment(createTestEnvironment({
        APP_ENV: "production", NODE_ENV: "production", ...secureOrigins, ...fcm, MESSAGING_CAPABILITY_STATE: state,
      }))).not.toThrow();
    }
  });
});
