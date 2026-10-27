import { createPrivateKey, createSign, type KeyObject } from "node:crypto";

import { assertProviderRuntimeSafety, type ProviderRuntimeSafety } from "./capability-registry.js";
import {
  asJsonRecord,
  callMessagingProvider,
  DEFAULT_MESSAGING_TIMEOUT_MS,
  fetchMessagingHttpClient,
  messagingErrorForStatus,
  requireHttpsBase,
  requireTimeout,
  type MessagingHttpClient,
} from "./messaging-http.js";
import {
  NotificationChannelError,
  NotificationNotSentError,
  type ExternalNotificationChannel,
  type MessagingMode,
  type ModalNotificationChannelAdapter,
  type NotificationChannelMessage,
  type NotificationChannelReceipt,
} from "./notification-channel.js";

export const FCM_PROVIDER = "fcm";
export const FCM_API_BASE_URL = "https://fcm.googleapis.com";
export const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
/** At most this many devices are notified per recipient (most recently registered first). */
export const MAX_PUSH_DEVICES_PER_USER = 5;

export interface PushDeviceToken {
  readonly registrationId: string;
  readonly token: string;
}

/** Resolves a user's registered push tokens at send time; they never leave the adapter. */
export interface PushDeviceDirectory {
  pushTokens(userId: string, limit: number): Promise<readonly PushDeviceToken[]>;
  /** Called when FCM reports a token as no longer registered. */
  revokePushToken(registrationId: string, reasonCode: string): Promise<void>;
}

export interface FcmPushAdapterOptions {
  readonly environment: ProviderRuntimeSafety["environment"];
  /** SANDBOX sends with `validate_only`, so FCM checks the request and delivers nothing. */
  readonly mode: MessagingMode;
  readonly projectId: string;
  readonly serviceAccountEmail: string;
  /** PEM private key of the service account, from the secret store. */
  readonly privateKeyPem: string;
  readonly devices: PushDeviceDirectory;
  readonly http?: MessagingHttpClient;
  readonly apiBaseUrl?: string;
  readonly tokenUrl?: string;
  readonly timeoutMs?: number;
  readonly now?: () => Date;
}

const PROJECT_ID = /^[a-z][a-z0-9-]{4,29}$/u;
const SERVICE_ACCOUNT_EMAIL = /^[a-z0-9][a-z0-9._-]{0,99}@[a-z0-9-]+(\.[a-z0-9-]+)*\.iam\.gserviceaccount\.com$/u;
const MESSAGE_NAME = /^projects\/[a-z0-9-]+\/messages\/[A-Za-z0-9:_%-]{1,200}$/u;
const ACCESS_TOKEN = /^[A-Za-z0-9._~+/=-]{20,4096}$/u;

const base64Url = (value: string | Buffer): string => Buffer.from(value).toString("base64url");

/** FCM error code from an error body (`details[].errorCode`), else the Google status. */
const fcmErrorCode = (body: unknown): string | undefined => {
  const error = asJsonRecord(asJsonRecord(body)?.error);
  const details = Array.isArray(error?.details) ? error.details : [];
  for (const detail of details) {
    const code = asJsonRecord(detail)?.errorCode;
    if (typeof code === "string") return code;
  }
  return typeof error?.status === "string" ? error.status : undefined;
};

/**
 * Firebase Cloud Messaging HTTP v1 adapter. It signs a service-account JWT (RS256) and exchanges
 * it for a short-lived OAuth access token, cached until shortly before expiry. Each registered
 * device gets one `messages:send` request with collapse keys derived from the notification id,
 * so a resend after a crash replaces rather than duplicates the shown notification.
 *
 * - SANDBOX uses `validate_only: true`: FCM validates and nothing is delivered. Refused in production.
 * - LIVE delivers. Refused in local and test environments.
 * - An `UNREGISTERED` token is revoked; a recipient with no registered device is NOT_SENT.
 * - FCM offers no server delivery receipts, so `SENT` means FCM accepted the message.
 */
export class FcmPushAdapter implements ModalNotificationChannelAdapter {
  readonly channels: readonly ExternalNotificationChannel[] = Object.freeze(["PUSH"] as const);
  readonly mode: MessagingMode;
  readonly #serviceAccountEmail: string;
  readonly #privateKey: KeyObject;
  readonly #devices: PushDeviceDirectory;
  readonly #http: MessagingHttpClient;
  readonly #sendUrl: string;
  readonly #tokenUrl: string;
  readonly #timeoutMs: number;
  readonly #now: () => Date;
  #accessToken: { readonly value: string; readonly expiresAtMs: number } | undefined;

  constructor(options: FcmPushAdapterOptions) {
    assertProviderRuntimeSafety({ environment: options.environment });
    if (options.mode === "SANDBOX" && options.environment === "production") {
      throw new Error("FCM validate-only (sandbox) mode is not allowed in production");
    }
    if (options.mode === "LIVE" && (options.environment === "local" || options.environment === "test")) {
      throw new Error("Live FCM delivery is allowed only in staging or production");
    }
    if (!PROJECT_ID.test(options.projectId)) throw new TypeError("FCM project id is malformed");
    if (!SERVICE_ACCOUNT_EMAIL.test(options.serviceAccountEmail)) throw new TypeError("FCM service account email is malformed");
    let privateKey: KeyObject;
    try {
      privateKey = createPrivateKey(options.privateKeyPem.replaceAll("\\n", "\n"));
    } catch {
      throw new TypeError("FCM service account private key is missing or not a PEM private key");
    }
    if (privateKey.asymmetricKeyType !== "rsa") throw new TypeError("FCM service account private key must be an RSA key");

    this.mode = options.mode;
    this.#serviceAccountEmail = options.serviceAccountEmail;
    this.#privateKey = privateKey;
    this.#devices = options.devices;
    this.#http = options.http ?? fetchMessagingHttpClient;
    this.#sendUrl = new URL(`/v1/projects/${options.projectId}/messages:send`,
      requireHttpsBase(options.apiBaseUrl ?? FCM_API_BASE_URL, "FCM API base URL")).toString();
    this.#tokenUrl = requireHttpsBase(options.tokenUrl ?? GOOGLE_OAUTH_TOKEN_URL, "OAuth token URL").toString();
    this.#timeoutMs = requireTimeout(options.timeoutMs ?? DEFAULT_MESSAGING_TIMEOUT_MS);
    this.#now = options.now ?? (() => new Date());
  }

  providerName(): string {
    return FCM_PROVIDER;
  }

  async send(message: NotificationChannelMessage, signal?: AbortSignal): Promise<NotificationChannelReceipt> {
    if (message.channel !== "PUSH") throw new NotificationNotSentError("CHANNEL_NOT_SUPPORTED");
    let devices: readonly PushDeviceToken[];
    try {
      devices = (await this.#devices.pushTokens(message.recipientUserId, MAX_PUSH_DEVICES_PER_USER)).slice(0, MAX_PUSH_DEVICES_PER_USER);
    } catch {
      throw new NotificationChannelError("RECIPIENT_LOOKUP_FAILED", true);
    }
    if (devices.length === 0) throw new NotificationNotSentError("NO_PUSH_DEVICE");

    let accepted: string | undefined;
    let failure: NotificationChannelError | undefined;
    let unregistered = 0;
    for (const device of devices) {
      const outcome = await this.#sendToDevice(device, message, signal);
      if (outcome.kind === "ACCEPTED") accepted ??= outcome.name;
      else if (outcome.kind === "UNREGISTERED") {
        unregistered += 1;
        await this.#devices.revokePushToken(device.registrationId, "FCM_UNREGISTERED").catch(() => undefined);
      } else if (failure === undefined || (failure.retryable && !outcome.error.retryable)) {
        failure = outcome.error;
      }
    }
    // One accepted device is a send; retrying would repeat it on that device.
    if (accepted !== undefined) return Object.freeze({ providerReference: `fcm:${accepted}` });
    if (failure !== undefined) throw failure;
    if (unregistered === devices.length) throw new NotificationNotSentError("NO_PUSH_DEVICE");
    throw new NotificationChannelError("PROVIDER_RESPONSE_INVALID", false);
  }

  async #sendToDevice(
    device: PushDeviceToken,
    message: NotificationChannelMessage,
    signal: AbortSignal | undefined,
    retriedAuth = false,
  ): Promise<
    | { readonly kind: "ACCEPTED"; readonly name: string }
    | { readonly kind: "UNREGISTERED" }
    | { readonly kind: "FAILED"; readonly error: NotificationChannelError }
  > {
    // A UUID without hyphens is 32 characters: the Web Push `Topic` limit.
    const collapseKey = message.idempotencyKey.replace(/[^A-Za-z0-9]/gu, "").slice(0, 32) || "kisantractor";
    const body = JSON.stringify({
      validate_only: this.mode === "SANDBOX",
      message: {
        token: device.token,
        notification: { title: "KisanTractor", body: message.body },
        data: { templateKey: message.templateKey, notificationId: message.notificationId },
        android: { collapse_key: collapseKey },
        webpush: { headers: { Topic: collapseKey, Urgency: "normal" } },
        apns: { headers: { "apns-collapse-id": collapseKey } },
      },
    });
    let accessToken: string;
    try {
      accessToken = await this.#token(signal);
    } catch (error) {
      if (error instanceof NotificationChannelError) return { kind: "FAILED", error };
      throw error;
    }
    let response;
    try {
      response = await callMessagingProvider(this.#http, {
        url: this.#sendUrl,
        headers: { authorization: `Bearer ${accessToken}`, accept: "application/json", "content-type": "application/json; charset=utf-8" },
        body,
      }, this.#timeoutMs, signal);
    } catch (error) {
      if (error instanceof NotificationChannelError) return { kind: "FAILED", error };
      throw error;
    }
    if (response.status >= 200 && response.status < 300) {
      const name = asJsonRecord(response.body)?.name;
      // validate_only answers with a placeholder name; either way the name is the reference.
      return typeof name === "string" && MESSAGE_NAME.test(name)
        ? { kind: "ACCEPTED", name: name.slice(name.lastIndexOf("/") + 1) }
        : { kind: "FAILED", error: new NotificationChannelError("PROVIDER_RESPONSE_INVALID", false) };
    }
    const code = fcmErrorCode(response.body);
    if (code === "UNREGISTERED" || (response.status === 404 && code === "NOT_FOUND")) return { kind: "UNREGISTERED" };
    if (response.status === 401 && !retriedAuth) {
      // An access token revoked or expired early: fetch a new one once.
      this.#accessToken = undefined;
      return this.#sendToDevice(device, message, signal, true);
    }
    if (code === "QUOTA_EXCEEDED") return { kind: "FAILED", error: new NotificationChannelError("PROVIDER_THROTTLED", true) };
    if (code === "SENDER_ID_MISMATCH" || code === "THIRD_PARTY_AUTH_ERROR") {
      return { kind: "FAILED", error: new NotificationChannelError("PROVIDER_AUTH_FAILED", false) };
    }
    return { kind: "FAILED", error: messagingErrorForStatus(response.status) };
  }

  /** Cached OAuth access token for the FCM scope, refreshed a minute before it expires. */
  async #token(signal: AbortSignal | undefined): Promise<string> {
    const nowMs = this.#now().getTime();
    if (this.#accessToken !== undefined && this.#accessToken.expiresAtMs - 60_000 > nowMs) return this.#accessToken.value;
    const issuedAt = Math.floor(nowMs / 1_000);
    const unsigned = `${base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64Url(JSON.stringify({
      iss: this.#serviceAccountEmail, scope: FCM_SCOPE, aud: this.#tokenUrl, iat: issuedAt, exp: issuedAt + 3_600,
    }))}`;
    const signature = createSign("RSA-SHA256").update(unsigned).sign(this.#privateKey);
    const assertion = `${unsigned}.${base64Url(signature)}`;
    const response = await callMessagingProvider(this.#http, {
      url: this.#tokenUrl,
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
    }, this.#timeoutMs, signal);
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      throw new NotificationChannelError("PROVIDER_AUTH_FAILED", false);
    }
    if (response.status < 200 || response.status >= 300) throw messagingErrorForStatus(response.status);
    const token = asJsonRecord(response.body);
    const value = token?.access_token;
    const expiresIn = token?.expires_in;
    if (typeof value !== "string" || !ACCESS_TOKEN.test(value) || typeof expiresIn !== "number"
      || !Number.isSafeInteger(expiresIn) || expiresIn <= 0) {
      throw new NotificationChannelError("PROVIDER_RESPONSE_INVALID", false);
    }
    this.#accessToken = { value, expiresAtMs: nowMs + expiresIn * 1_000 };
    return value;
  }
}
