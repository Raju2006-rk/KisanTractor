import { createVerify, generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import { CapabilityRegistry } from "./capability-registry.js";
import { FcmPushAdapter, type PushDeviceDirectory, type PushDeviceToken } from "./fcm-push-adapter.js";
import type { MessagingHttpClient, MessagingHttpRequest } from "./messaging-http.js";
import { Msg91SmsAdapter, smsTemplateRegistrationKey, type SmsRecipientDirectory } from "./msg91-sms-adapter.js";
import {
  CapabilityGatedNotificationDispatcher,
  MessagingChannelRouter,
  type NotificationChannelMessage,
} from "./notification-channel.js";

/**
 * Contract tests for the MSG91 (SMS) and FCM HTTP v1 (push) adapters. Every provider response is a
 * local fixture returned by an injected HTTP client; no request leaves the process, and every
 * credential is synthetic (the RSA key is generated per run).
 *
 * Validates: Requirements 1.4, 14.1, 14.3, 14.5, 14.6, 17.6
 */
const AUTH_KEY = "Kt0SyntheticMsg91AuthKey01";
const RECIPIENT = "10000000-0000-4000-8000-000000000001";
const PHONE = "+919876543210";
const notificationId = "90000000-0000-4000-8000-000000000001";
const templateIds = {
  [smsTemplateRegistrationKey("notification.booking.accepted", 1, "en")]: "64f0aSyntheticAccepted",
  [smsTemplateRegistrationKey("notification.booking.ownerContact", 1, "en")]: "64f0aSyntheticContact",
};

const sms = (overrides: Partial<NotificationChannelMessage> = {}): NotificationChannelMessage => ({
  notificationId,
  idempotencyKey: notificationId,
  channel: "SMS",
  recipientUserId: RECIPIENT,
  locale: "en",
  templateKey: "notification.booking.accepted",
  templateVersion: 1,
  variables: { reference: "KT-ABCDEF123456" },
  body: "KisanTractor: Your booking KT-ABCDEF123456 was accepted by the Owner.",
  ...overrides,
});

interface Fixture {
  readonly status: number;
  readonly body?: unknown;
  readonly error?: Error;
}

const scriptedHttp = (fixtures: Array<Fixture | ((request: MessagingHttpRequest) => Fixture)>) => {
  const requests: MessagingHttpRequest[] = [];
  const http: MessagingHttpClient = async (request) => {
    requests.push(request);
    const next = fixtures.shift();
    if (next === undefined) throw new Error("unexpected provider call");
    const fixture = typeof next === "function" ? next(request) : next;
    if (fixture.error !== undefined) throw fixture.error;
    return { status: fixture.status, json: async () => fixture.body };
  };
  return { http, requests };
};

const directory = (number: string | undefined = PHONE): SmsRecipientDirectory & { lookups: string[] } => {
  const lookups: string[] = [];
  return { lookups, smsNumber: async (userId) => { lookups.push(userId); return number; } };
};

const msg91 = (options: { mode?: "SANDBOX" | "LIVE"; environment?: "local" | "test" | "staging" | "production"; http?: MessagingHttpClient; number?: string } = {}) =>
  new Msg91SmsAdapter({
    environment: options.environment ?? (options.mode === "SANDBOX" ? "test" : "staging"),
    mode: options.mode ?? "LIVE",
    authKey: AUTH_KEY,
    templateIds,
    recipients: directory(options.number),
    ...(options.http === undefined ? {} : { http: options.http }),
  });

describe("MSG91 SMS adapter", () => {
  it("sends a DLT-registered template with the declared variables and the resolved number", async () => {
    const { http, requests } = scriptedHttp([{ status: 200, body: { type: "success", message: "3763646c3058373530" } }]);
    const receipt = await msg91({ http }).send(sms());
    expect(receipt).toEqual({ providerReference: "msg91:3763646c3058373530" });
    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request).toMatchObject({ method: "POST", url: "https://control.msg91.com/api/v5/flow" });
    expect(request!.headers).toMatchObject({ authkey: AUTH_KEY, "content-type": "application/json" });
    expect(JSON.parse(request!.body)).toEqual({
      template_id: "64f0aSyntheticAccepted",
      short_url: "0",
      recipients: [{ mobiles: "919876543210", reference: "KT-ABCDEF123456" }],
    });
    // The rendered body never travels: MSG91 sends the registered template text.
    expect(request!.body).not.toContain("accepted by the Owner");
  });

  it("never calls MSG91 in SANDBOX and is refused where it could mislabel real sends", async () => {
    const { http, requests } = scriptedHttp([]);
    await expect(msg91({ mode: "SANDBOX", http }).send(sms())).resolves.toEqual({ providerReference: `msg91-sandbox:${notificationId}` });
    expect(requests).toEqual([]);
    expect(() => msg91({ mode: "SANDBOX", environment: "production" })).toThrow(/not allowed in production/u);
    expect(() => msg91({ mode: "LIVE", environment: "test" })).toThrow(/staging or production/u);
    expect(() => msg91({ mode: "LIVE", environment: "local" })).toThrow(/staging or production/u);
    expect(() => new Msg91SmsAdapter({ environment: "staging", mode: "LIVE", authKey: "short", templateIds, recipients: directory() }))
      .toThrow(/auth key/u);
    expect(() => new Msg91SmsAdapter({ environment: "staging", mode: "LIVE", authKey: AUTH_KEY, templateIds: { "booking.accepted": "x" }, recipients: directory() }))
      .toThrow(/keyed as/u);
  });

  it("records unregistered templates and unreachable recipients as not sent without a provider call", async () => {
    const { http, requests } = scriptedHttp([]);
    await expect(msg91({ http }).send(sms({ locale: "te" }))).rejects.toMatchObject({ name: "NotificationNotSentError", reasonCode: "SMS_TEMPLATE_NOT_REGISTERED" });
    await expect(msg91({ http }).send(sms({ templateVersion: 2 }))).rejects.toMatchObject({ reasonCode: "SMS_TEMPLATE_NOT_REGISTERED" });
    await expect(msg91({ http, number: "" }).send(sms())).rejects.toMatchObject({ reasonCode: "RECIPIENT_UNREACHABLE" });
    await expect(msg91({ http, number: "+15005550006" }).send(sms())).rejects.toMatchObject({ reasonCode: "RECIPIENT_UNREACHABLE" });
    await expect(msg91({ http }).send(sms({ variables: { reference: "KT-1\nVisit http://x" } }))).rejects.toMatchObject({ code: "SMS_TEMPLATE_VARIABLE_INVALID", retryable: false });
    await expect(msg91({ http }).send(sms({ variables: { mobiles: "919999999999" } }))).rejects.toMatchObject({ code: "SMS_TEMPLATE_VARIABLE_INVALID" });
    expect(requests).toEqual([]);
  });

  it("maps provider responses to typed retryable and non-retryable errors without echoing bodies", async () => {
    const cases: Array<[Fixture, string, boolean]> = [
      [{ status: 200, body: { type: "error", message: "Invalid template for +919876543210" } }, "PROVIDER_REJECTED_REQUEST", false],
      [{ status: 200, body: "<html>" }, "PROVIDER_RESPONSE_INVALID", false],
      [{ status: 401, body: {} }, "PROVIDER_AUTH_FAILED", false],
      [{ status: 400, body: {} }, "PROVIDER_REJECTED_REQUEST", false],
      [{ status: 429, body: {} }, "PROVIDER_THROTTLED", true],
      [{ status: 503, body: {} }, "PROVIDER_UNAVAILABLE", true],
      [{ status: 0, error: new TypeError("fetch failed for 9876543210") }, "PROVIDER_UNREACHABLE", true],
      [{ status: 0, error: new DOMException("timed out", "TimeoutError") }, "PROVIDER_TIMEOUT", true],
    ];
    for (const [fixture, code, retryable] of cases) {
      const { http } = scriptedHttp([fixture]);
      const error = await msg91({ http }).send(sms()).catch((caught: unknown) => caught);
      expect(error, code).toMatchObject({ name: "NotificationChannelError", code, retryable });
      expect(String((error as Error).message)).not.toContain("9876543210");
    }
  });

  it("aborts with the provider timeout", async () => {
    const hanging: MessagingHttpClient = (request) => new Promise((_resolve, reject) => {
      request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
    });
    const adapter = new Msg91SmsAdapter({ environment: "staging", mode: "LIVE", authKey: AUTH_KEY, templateIds, recipients: directory(), http: hanging, timeoutMs: 20 });
    await expect(adapter.send(sms())).rejects.toMatchObject({ code: "PROVIDER_TIMEOUT", retryable: true });
  });
});

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIVATE_KEY_PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const SERVICE_ACCOUNT = "kisan-fcm@kt-synthetic.iam.gserviceaccount.com";

const devices = (tokens: readonly PushDeviceToken[]): PushDeviceDirectory & { revoked: string[] } => {
  const revoked: string[] = [];
  return { revoked, pushTokens: async () => tokens, revokePushToken: async (id) => { revoked.push(id); } };
};

const tokenFixture = (request: MessagingHttpRequest): Fixture => {
  const assertion = new URLSearchParams(request.body).get("assertion")!;
  const [header, claims, signature] = assertion.split(".");
  const valid = createVerify("RSA-SHA256").update(`${header}.${claims}`).verify(publicKey, Buffer.from(signature!, "base64url"));
  const payload = JSON.parse(Buffer.from(claims!, "base64url").toString("utf8")) as Record<string, unknown>;
  return valid && payload.iss === SERVICE_ACCOUNT && payload.scope === "https://www.googleapis.com/auth/firebase.messaging"
    ? { status: 200, body: { access_token: "ya29.synthetic-access-token-0001", expires_in: 3_599, token_type: "Bearer" } }
    : { status: 401, body: { error: "invalid_grant" } };
};
const accepted = (id = "0:1700000000000000%synthetic"): Fixture => ({ status: 200, body: { name: `projects/kt-synthetic/messages/${id}` } });
const fcmError = (status: number, errorCode: string): Fixture => ({
  status,
  body: { error: { code: status, status: "NOT_FOUND", details: [{ "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", errorCode }] } },
});

const fcm = (directoryFor: PushDeviceDirectory, http: MessagingHttpClient, mode: "SANDBOX" | "LIVE" = "LIVE", now = () => new Date("2026-05-12T04:00:00.000Z")) =>
  new FcmPushAdapter({
    environment: mode === "SANDBOX" ? "test" : "staging",
    mode,
    projectId: "kt-synthetic",
    serviceAccountEmail: SERVICE_ACCOUNT,
    privateKeyPem: PRIVATE_KEY_PEM,
    devices: directoryFor,
    http,
    now,
  });

const push = (): NotificationChannelMessage => ({ ...sms(), channel: "PUSH" });

describe("FCM HTTP v1 push adapter", () => {
  it("exchanges a signed service-account JWT once and sends one collapsible message per device", async () => {
    const { http, requests } = scriptedHttp([tokenFixture, accepted("0:1"), accepted("0:2"), accepted("0:3"), accepted("0:4")]);
    const adapter = fcm(devices([{ registrationId: "d-1", token: "fcm-token-device-1" }, { registrationId: "d-2", token: "fcm-token-device-2" }]), http);
    await expect(adapter.send(push())).resolves.toEqual({ providerReference: "fcm:0:1" });
    // The cached access token serves the next message.
    await adapter.send({ ...push(), notificationId: "n-2", idempotencyKey: "n-2" });
    expect(requests.map((request) => request.url)).toEqual([
      "https://oauth2.googleapis.com/token",
      ...Array.from({ length: 4 }, () => "https://fcm.googleapis.com/v1/projects/kt-synthetic/messages:send"),
    ]);
    const first = JSON.parse(requests[1]!.body) as { validate_only: boolean; message: Record<string, unknown> };
    expect(requests[1]!.headers.authorization).toBe("Bearer ya29.synthetic-access-token-0001");
    expect(first.validate_only).toBe(false);
    expect(first.message).toMatchObject({
      token: "fcm-token-device-1",
      notification: { title: "KisanTractor", body: push().body },
      android: { collapse_key: "90000000000040008000000000000001" },
      webpush: { headers: { Topic: "90000000000040008000000000000001" } },
    });
    expect(JSON.stringify(first)).not.toContain(PHONE);
  });

  it("validates only in SANDBOX and refuses mode/environment mismatches and malformed credentials", async () => {
    const { http, requests } = scriptedHttp([tokenFixture, accepted()]);
    await fcm(devices([{ registrationId: "d-1", token: "t-1" }]), http, "SANDBOX").send(push());
    expect(JSON.parse(requests[1]!.body)).toMatchObject({ validate_only: true });
    const base = { projectId: "kt-synthetic", serviceAccountEmail: SERVICE_ACCOUNT, privateKeyPem: PRIVATE_KEY_PEM, devices: devices([]) };
    expect(() => new FcmPushAdapter({ ...base, environment: "production", mode: "SANDBOX" })).toThrow(/not allowed in production/u);
    expect(() => new FcmPushAdapter({ ...base, environment: "test", mode: "LIVE" })).toThrow(/staging or production/u);
    expect(() => new FcmPushAdapter({ ...base, environment: "staging", mode: "LIVE", privateKeyPem: "not a key" })).toThrow(/PEM private key/u);
    expect(() => new FcmPushAdapter({ ...base, environment: "staging", mode: "LIVE", serviceAccountEmail: "someone@example.com" })).toThrow(/email/u);
  });

  it("revokes unregistered tokens and reports a recipient without devices as not sent", async () => {
    const directoryWithStale = devices([{ registrationId: "d-stale", token: "stale" }, { registrationId: "d-ok", token: "ok" }]);
    const { http } = scriptedHttp([tokenFixture, fcmError(404, "UNREGISTERED"), accepted()]);
    await expect(fcm(directoryWithStale, http).send(push())).resolves.toMatchObject({ providerReference: expect.stringMatching(/^fcm:/u) });
    expect(directoryWithStale.revoked).toEqual(["d-stale"]);

    const onlyStale = devices([{ registrationId: "d-stale", token: "stale" }]);
    const second = scriptedHttp([tokenFixture, fcmError(404, "UNREGISTERED")]);
    await expect(fcm(onlyStale, second.http).send(push())).rejects.toMatchObject({ reasonCode: "NO_PUSH_DEVICE" });

    const none = scriptedHttp([]);
    await expect(fcm(devices([]), none.http).send(push())).rejects.toMatchObject({ reasonCode: "NO_PUSH_DEVICE" });
    expect(none.requests).toEqual([]);
  });

  it("maps FCM failures to typed errors and refreshes a rejected access token once", async () => {
    const one = devices([{ registrationId: "d-1", token: "t-1" }]);
    const cases: Array<[Fixture[], string, boolean]> = [
      [[fcmError(429, "QUOTA_EXCEEDED")], "PROVIDER_THROTTLED", true],
      [[fcmError(503, "UNAVAILABLE")], "PROVIDER_UNAVAILABLE", true],
      [[fcmError(403, "SENDER_ID_MISMATCH")], "PROVIDER_AUTH_FAILED", false],
      [[fcmError(400, "INVALID_ARGUMENT")], "PROVIDER_REJECTED_REQUEST", false],
      [[{ status: 200, body: { name: "unexpected" } }], "PROVIDER_RESPONSE_INVALID", false],
    ];
    for (const [fixtures, code, retryable] of cases) {
      const { http } = scriptedHttp([tokenFixture, ...fixtures]);
      await expect(fcm(one, http).send(push()), code).rejects.toMatchObject({ code, retryable });
    }
    const refreshed = scriptedHttp([tokenFixture, { status: 401, body: {} }, tokenFixture, accepted()]);
    await expect(fcm(one, refreshed.http).send(push())).resolves.toMatchObject({ providerReference: expect.stringMatching(/^fcm:/u) });
    expect(refreshed.requests).toHaveLength(4);
    const badGrant = scriptedHttp([{ status: 400, body: { error: "invalid_grant" } }]);
    await expect(fcm(one, badGrant.http).send(push())).rejects.toMatchObject({ code: "PROVIDER_AUTH_FAILED", retryable: false });
  });
});

describe("configured messaging through the capability gate", () => {
  it("routes SMS to MSG91 and PUSH to FCM and reports the provider per channel", async () => {
    const { http, requests } = scriptedHttp([
      { status: 200, body: { type: "success", message: "req0000001" } },
      tokenFixture,
      accepted(),
    ]);
    const router = new MessagingChannelRouter([msg91({ http }), fcm(devices([{ registrationId: "d-1", token: "t-1" }]), http)]);
    const dispatcher = new CapabilityGatedNotificationDispatcher(new CapabilityRegistry({ MESSAGING: { state: "LIVE", provider: router } }));
    await expect(dispatcher.dispatch(sms())).resolves.toMatchObject({ provider: "msg91", outcome: { kind: "ACCEPTED", mode: "LIVE" } });
    await expect(dispatcher.dispatch(push())).resolves.toMatchObject({ provider: "fcm", outcome: { kind: "ACCEPTED", mode: "LIVE" } });
    await expect(dispatcher.dispatch({ ...sms(), channel: "IVR" })).resolves.toMatchObject({ outcome: { kind: "NOT_SENT" } });
    expect(requests).toHaveLength(3);

    // DEGRADED never reaches the adapters.
    const degraded = new CapabilityGatedNotificationDispatcher(new CapabilityRegistry({ MESSAGING: { state: "DEGRADED", provider: router } }));
    await expect(degraded.dispatch(sms())).resolves.toMatchObject({ outcome: { kind: "FAILED", errorCode: "CAPABILITY_DEGRADED", retryable: true } });
    expect(requests).toHaveLength(3);
  });
});
