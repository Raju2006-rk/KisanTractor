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

export const MSG91_PROVIDER = "msg91";
export const MSG91_API_BASE_URL = "https://control.msg91.com";

/** Resolves a user's SMS number at send time; it never leaves the adapter. */
export interface SmsRecipientDirectory {
  /** E.164 Indian mobile number of an active account, or undefined when there is none. */
  smsNumber(userId: string): Promise<string | undefined>;
}

/** Key of one registered template: `<templateKey>@<version>:<locale>`. */
export const smsTemplateRegistrationKey = (templateKey: string, version: number, locale: string): string =>
  `${templateKey}@${version}:${locale}`;

export const SMS_TEMPLATE_REGISTRATION_KEY_PATTERN = /^notification\.[a-z][A-Za-z.]{2,80}@[1-9]\d{0,3}:(en|hi|te|kn|ta|mr|bn)$/u;
export const MSG91_TEMPLATE_ID_PATTERN = /^[A-Za-z0-9_-]{6,64}$/u;

/** Indian mobile in E.164; MSG91 takes it without the plus sign. */
const INDIAN_MOBILE = /^\+91([6-9]\d{9})$/u;
const VARIABLE_NAME = /^[A-Za-z][A-Za-z0-9_]{0,30}$/u;
/** DLT `{#var#}` values are short; control characters could alter the registered template. */
const VARIABLE_VALUE = /^[\p{L}\p{N}+\-.: /]{1,30}$/u;
const REQUEST_ID = /^[A-Za-z0-9_-]{6,64}$/u;

export interface Msg91SmsAdapterOptions {
  readonly environment: ProviderRuntimeSafety["environment"];
  /** SANDBOX validates and records the request without calling MSG91; LIVE sends it. */
  readonly mode: MessagingMode;
  readonly authKey: string;
  /**
   * MSG91 template ids (each linked to its DLT template id in the MSG91 dashboard), keyed by
   * `smsTemplateRegistrationKey`. A message whose template, version, and locale are not
   * registered is NOT_SENT; it is never sent with other content.
   */
  readonly templateIds: Readonly<Record<string, string>>;
  readonly recipients: SmsRecipientDirectory;
  readonly http?: MessagingHttpClient;
  readonly apiBaseUrl?: string;
  readonly timeoutMs?: number;
}

/**
 * MSG91 SMS adapter (Flow API, `POST /api/v5/flow`). Indian commercial SMS must use a
 * DLT-registered sender and template; MSG91 binds both to its own template id, so the request
 * carries only that id, the recipient, and the declared template variables, never free text.
 *
 * - SANDBOX: everything is validated and the number resolved, but MSG91 is never called
 *   (MSG91 has no test mode). Refused in production.
 * - LIVE: sends through MSG91. Refused in local and test environments.
 * - MSG91 delivery-report webhooks are not signed, so they are not accepted; `SENT` means MSG91
 *   accepted the request, never that the handset received it.
 */
export class Msg91SmsAdapter implements ModalNotificationChannelAdapter {
  readonly channels: readonly ExternalNotificationChannel[] = Object.freeze(["SMS"] as const);
  readonly mode: MessagingMode;
  readonly #authKey: string;
  readonly #templateIds: ReadonlyMap<string, string>;
  readonly #recipients: SmsRecipientDirectory;
  readonly #http: MessagingHttpClient;
  readonly #url: string;
  readonly #timeoutMs: number;

  constructor(options: Msg91SmsAdapterOptions) {
    assertProviderRuntimeSafety({ environment: options.environment });
    if (options.mode === "SANDBOX" && options.environment === "production") {
      throw new Error("The MSG91 sandbox mode is not allowed in production");
    }
    if (options.mode === "LIVE" && (options.environment === "local" || options.environment === "test")) {
      throw new Error("Live MSG91 sending is allowed only in staging or production");
    }
    const authKey = options.authKey.trim();
    if (!/^[A-Za-z0-9]{16,64}$/u.test(authKey)) throw new TypeError("MSG91 auth key is missing or malformed");
    const templateIds = new Map<string, string>();
    for (const [key, id] of Object.entries(options.templateIds)) {
      if (!SMS_TEMPLATE_REGISTRATION_KEY_PATTERN.test(key)) throw new TypeError("MSG91 template ids must be keyed as <templateKey>@<version>:<locale>");
      if (!MSG91_TEMPLATE_ID_PATTERN.test(id)) throw new TypeError("MSG91 template ids must be 6-64 letters, digits, - or _");
      templateIds.set(key, id);
    }
    if (templateIds.size === 0) throw new TypeError("At least one MSG91 template id is required");

    this.mode = options.mode;
    this.#authKey = authKey;
    this.#templateIds = templateIds;
    this.#recipients = options.recipients;
    this.#http = options.http ?? fetchMessagingHttpClient;
    this.#url = new URL("/api/v5/flow", requireHttpsBase(options.apiBaseUrl ?? MSG91_API_BASE_URL, "MSG91 API base URL")).toString();
    this.#timeoutMs = requireTimeout(options.timeoutMs ?? DEFAULT_MESSAGING_TIMEOUT_MS);
  }

  providerName(): string {
    return MSG91_PROVIDER;
  }

  async send(message: NotificationChannelMessage, signal?: AbortSignal): Promise<NotificationChannelReceipt> {
    if (message.channel !== "SMS") throw new NotificationNotSentError("CHANNEL_NOT_SUPPORTED");
    if (message.templateVersion === undefined || message.variables === undefined) {
      throw new NotificationChannelError("SMS_TEMPLATE_CONTRACT_MISSING", false);
    }
    const templateId = this.#templateIds.get(smsTemplateRegistrationKey(message.templateKey, message.templateVersion, message.locale));
    if (templateId === undefined) throw new NotificationNotSentError("SMS_TEMPLATE_NOT_REGISTERED");
    const variables: Record<string, string> = {};
    for (const [name, value] of Object.entries(message.variables)) {
      if (!VARIABLE_NAME.test(name) || name === "mobiles" || !VARIABLE_VALUE.test(value)) {
        throw new NotificationChannelError("SMS_TEMPLATE_VARIABLE_INVALID", false);
      }
      variables[name] = value;
    }

    let number: string | undefined;
    try {
      number = await this.#recipients.smsNumber(message.recipientUserId);
    } catch {
      throw new NotificationChannelError("RECIPIENT_LOOKUP_FAILED", true);
    }
    const mobile = number === undefined ? undefined : INDIAN_MOBILE.exec(number)?.[1];
    if (mobile === undefined) throw new NotificationNotSentError("RECIPIENT_UNREACHABLE");

    const body = JSON.stringify({
      template_id: templateId,
      short_url: "0",
      recipients: [{ mobiles: `91${mobile}`, ...variables }],
    });
    if (this.mode === "SANDBOX") {
      return Object.freeze({ providerReference: `msg91-sandbox:${message.idempotencyKey}` });
    }

    const response = await callMessagingProvider(this.#http, {
      url: this.#url,
      headers: { authkey: this.#authKey, accept: "application/json", "content-type": "application/json" },
      body,
    }, this.#timeoutMs, signal);
    if (response.status < 200 || response.status >= 300) throw messagingErrorForStatus(response.status);
    const result = asJsonRecord(response.body);
    if (result?.type !== "success") {
      // MSG91 reports refused requests (bad template, DLT scrub, auth) with HTTP 200 and type "error".
      throw new NotificationChannelError(result?.type === "error" ? "PROVIDER_REJECTED_REQUEST" : "PROVIDER_RESPONSE_INVALID", false);
    }
    const requestId = typeof result.message === "string" && REQUEST_ID.test(result.message) ? result.message : undefined;
    return Object.freeze(requestId === undefined ? {} : { providerReference: `msg91:${requestId}` });
  }
}
