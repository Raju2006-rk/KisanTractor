import { Buffer } from "node:buffer";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import type {
  ProviderIntentPaymentSnapshot,
  ProviderIntentSnapshot,
  ProviderPaymentEventKind,
  ProviderRefundSnapshot,
} from "@kisantractor/domain";

import { assertProviderRuntimeSafety, type ProviderRuntimeSafety } from "./capability-registry.js";
import {
  livePaymentStatusLabel,
  OnlinePaymentProviderError,
  ProviderWebhookRejectedError,
  sandboxPaymentStatusLabel,
  type OnlinePaymentCheckout,
  type OnlinePaymentIntent,
  type OnlinePaymentIntentRequest,
  type OnlinePaymentMode,
  type OnlinePaymentRecoveryAdapter,
  type OnlinePaymentRefundRequest,
  type ProviderStatusRead,
  type ProviderWebhookHeaders,
  type VerifiedProviderPaymentEvent,
} from "./online-payment.js";

/** Minimal HTTP seam so contract tests never reach the provider. `body` is empty for GET. */
export interface PaymentHttpRequest {
  readonly method: "POST" | "GET";
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly signal: AbortSignal;
}

export interface PaymentHttpResponse {
  readonly status: number;
  json(): Promise<unknown>;
}

export type PaymentHttpClient = (request: PaymentHttpRequest) => Promise<PaymentHttpResponse>;

/** Default client: global fetch, refusing redirects so credentials never follow a hop. */
export const fetchPaymentHttpClient: PaymentHttpClient = async (request) => {
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    ...(request.method === "GET" ? {} : { body: request.body }),
    signal: request.signal,
    redirect: "error",
  });
  return { status: response.status, json: () => response.json() as Promise<unknown> };
};

export const RAZORPAY_PROVIDER = "razorpay";
export const RAZORPAY_API_BASE_URL = "https://api.razorpay.com";
/** Razorpay's smallest chargeable (and refundable) amount is ₹1. */
export const RAZORPAY_MINIMUM_AMOUNT_PAISE = 100;
const DEFAULT_TIMEOUT_MS = 10_000;

const KEY_ID_PATTERN = /^rzp_(test|live)_[A-Za-z0-9]{8,32}$/u;
const ORDER_ID_PATTERN = /^order_[A-Za-z0-9]{6,40}$/u;
const PAYMENT_ID_PATTERN = /^pay_[A-Za-z0-9]{6,40}$/u;
const REFUND_ID_PATTERN = /^rfnd_[A-Za-z0-9]{6,40}$/u;
const RECEIPT_PATTERN = /^[A-Za-z0-9_-]{1,40}$/u;
/** Razorpay refund idempotency keys: at least 10 letters, digits, hyphens, or underscores. */
const REFUND_KEY_PATTERN = /^[A-Za-z0-9_-]{10,40}$/u;
const EVENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/u;
const SIGNATURE_PATTERN = /^[0-9a-f]{64}$/iu;
const CURRENCY_PATTERN = /^[A-Z]{3}$/u;
const MAX_NOTES = 15;
const MAX_NOTE_LENGTH = 256;
/** Bounds a status read: an order with more attempts than this is reported as invalid. */
const MAX_LISTED_ITEMS = 100;

/** Razorpay test keys start with `rzp_test_`, live keys with `rzp_live_`. */
export function razorpayModeForKeyId(keyId: string): OnlinePaymentMode | undefined {
  const match = KEY_ID_PATTERN.exec(keyId.trim());
  if (match === null) return undefined;
  return match[1] === "live" ? "LIVE" : "SANDBOX";
}

export interface RazorpayPaymentAdapterOptions {
  readonly environment: ProviderRuntimeSafety["environment"];
  /** Publishable key id; its prefix decides SANDBOX (`rzp_test_`) or LIVE (`rzp_live_`). */
  readonly keyId: string;
  readonly keySecret: string;
  /** The secret configured on the Razorpay webhook; never the API key secret. */
  readonly webhookSecret: string;
  readonly http?: PaymentHttpClient;
  readonly apiBaseUrl?: string;
  readonly timeoutMs?: number;
}

type JsonRecord = Readonly<Record<string, unknown>>;
const asRecord = (value: unknown): JsonRecord | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonRecord : undefined;

const headerValue = (headers: ProviderWebhookHeaders, name: string): string | undefined => {
  const value = headers[name] ?? headers[name.toLowerCase()];
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === "string" && first.trim().length > 0 ? first.trim() : undefined;
};

const isAbort = (error: unknown): boolean =>
  (error instanceof DOMException || error instanceof Error) && error.name === "AbortError";
const isTimeout = (error: unknown): boolean =>
  (error instanceof DOMException || error instanceof Error) && error.name === "TimeoutError";

const errorForStatus = (status: number): OnlinePaymentProviderError => {
  if (status === 401 || status === 403) return new OnlinePaymentProviderError("PROVIDER_AUTH_FAILED", false);
  if (status === 404) return new OnlinePaymentProviderError("PROVIDER_NOT_FOUND", false);
  // An idempotent request with the same key is still being processed; retry it later.
  if (status === 409) return new OnlinePaymentProviderError("PROVIDER_CONFLICT", true);
  if (status === 429) return new OnlinePaymentProviderError("PROVIDER_THROTTLED", true);
  if (status >= 500) return new OnlinePaymentProviderError("PROVIDER_UNAVAILABLE", true);
  return new OnlinePaymentProviderError("PROVIDER_REJECTED_REQUEST", false);
};

const invalidResponse = (): OnlinePaymentProviderError => new OnlinePaymentProviderError("PROVIDER_RESPONSE_INVALID", false);
const safePaise = (value: unknown, allowZero = false): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && (allowZero ? value >= 0 : value > 0) ? value : undefined;

/** Evidence digest of a normalized provider read; never covers credentials or personal fields. */
const digestOf = (kind: string, snapshot: unknown): string =>
  `api:${createHash("sha256").update(`${kind}\u0000${JSON.stringify(snapshot)}`).digest("hex")}`;

const ORDER_STATES: Readonly<Record<string, ProviderIntentSnapshot["orderState"]>> = {
  created: "OPEN", attempted: "ATTEMPTED", paid: "PAID",
};
const PAYMENT_STATES: Readonly<Record<string, ProviderIntentPaymentSnapshot["state"]>> = {
  created: "CREATED", authorized: "AUTHORIZED", captured: "CAPTURED", refunded: "REFUNDED", failed: "FAILED",
};
const REFUND_STATES: Readonly<Record<string, ProviderRefundSnapshot["state"]>> = {
  pending: "PENDING", processed: "PROCESSED", failed: "FAILED",
};

/** Normalizes one refund entity, or throws when it is not the refund that was asked for. */
function refundSnapshot(value: unknown, providerPaymentId: string): ProviderRefundSnapshot {
  const refund = asRecord(value);
  const id = refund?.id;
  const amountPaise = safePaise(refund?.amount);
  const currency = refund?.currency;
  const state = typeof refund?.status === "string" ? REFUND_STATES[refund.status] : undefined;
  if (refund?.entity !== "refund" || typeof id !== "string" || !REFUND_ID_PATTERN.test(id) || refund.payment_id !== providerPaymentId
    || amountPaise === undefined || typeof currency !== "string" || !CURRENCY_PATTERN.test(currency) || state === undefined) {
    throw invalidResponse();
  }
  return Object.freeze({ providerRefundId: id, providerPaymentId, amountPaise, currency, state });
}

/**
 * Razorpay adapter (Orders, Payments, and Refunds APIs plus signed webhooks).
 *
 * - Intents are Razorpay orders created server-side with Basic auth over HTTPS; the browser only
 *   ever receives the order id and the publishable key id.
 * - Webhooks are verified with HMAC-SHA256 of the exact raw body using the webhook secret
 *   (`X-Razorpay-Signature`), compared in constant time, before the body is parsed.
 *   `X-Razorpay-Event-Id` identifies the event for deduplication.
 * - `payment.captured` and `order.paid` confirm money; `payment.failed` is one failed attempt on an
 *   order that stays payable; `refund.processed` and `refund.failed` finish a refund; everything
 *   else is informational.
 * - Status reads (`GET /v1/orders/:id`, `/v1/orders/:id/payments`, refunds) are authenticated
 *   server-to-server calls used by pending-intent recovery and reconciliation.
 * - Refunds are full refunds sent with `X-Refund-Idempotency`, so a retried request with the same
 *   refund key never refunds twice.
 * - A test key (`rzp_test_`) runs SANDBOX and is refused in production; a live key is refused in
 *   local and test environments.
 */
export class RazorpayPaymentAdapter implements OnlinePaymentRecoveryAdapter {
  readonly provider = RAZORPAY_PROVIDER;
  readonly mode: OnlinePaymentMode;
  readonly #keyId: string;
  readonly #authorization: string;
  readonly #webhookSecret: Buffer;
  readonly #http: PaymentHttpClient;
  readonly #base: URL;
  readonly #timeoutMs: number;

  constructor(options: RazorpayPaymentAdapterOptions) {
    assertProviderRuntimeSafety({ environment: options.environment });
    const keyId = options.keyId.trim();
    const mode = razorpayModeForKeyId(keyId);
    if (mode === undefined) throw new TypeError("Razorpay key id must look like rzp_test_... or rzp_live_...");
    if (mode === "SANDBOX" && options.environment === "production") {
      throw new Error("Razorpay test keys are not allowed in production");
    }
    if (mode === "LIVE" && (options.environment === "local" || options.environment === "test")) {
      throw new Error("Razorpay live keys are allowed only in staging or production");
    }
    if (options.keySecret.trim().length < 12) throw new TypeError("Razorpay key secret is missing or too short");
    if (options.webhookSecret.trim().length < 16) {
      throw new TypeError("Razorpay webhook secret must have at least 16 characters");
    }
    const base = new URL(options.apiBaseUrl ?? RAZORPAY_API_BASE_URL);
    if (base.protocol !== "https:") throw new TypeError("Razorpay API base URL must use HTTPS");
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError("timeoutMs must be a positive integer");

    this.mode = mode;
    this.#keyId = keyId;
    this.#authorization = `Basic ${Buffer.from(`${keyId}:${options.keySecret.trim()}`, "utf8").toString("base64")}`;
    this.#webhookSecret = Buffer.from(options.webhookSecret.trim(), "utf8");
    this.#http = options.http ?? fetchPaymentHttpClient;
    this.#base = base;
    this.#timeoutMs = timeoutMs;
  }

  async createIntent(request: OnlinePaymentIntentRequest, signal?: AbortSignal): Promise<OnlinePaymentIntent> {
    if (!Number.isSafeInteger(request.amountPaise) || request.amountPaise <= 0) {
      throw new TypeError("Intent amount must be a positive whole number of paise");
    }
    if (request.amountPaise < RAZORPAY_MINIMUM_AMOUNT_PAISE) {
      throw new OnlinePaymentProviderError("PROVIDER_AMOUNT_BELOW_MINIMUM", false);
    }
    if (request.currency !== "INR") throw new TypeError("Only INR intents are supported");
    if (!RECEIPT_PATTERN.test(request.intentKey)) throw new TypeError("Intent key must be 1-40 letters, digits, - or _");
    const notes = this.#notes(request.metadata);

    const order = asRecord(await this.#call("POST", "/v1/orders", signal, {
      amount: request.amountPaise,
      currency: request.currency,
      receipt: request.intentKey,
      notes,
      partial_payment: false,
    }));
    const id = order?.id;
    if (order?.entity !== "order" || typeof id !== "string" || !ORDER_ID_PATTERN.test(id)
      || order.amount !== request.amountPaise || order.currency !== request.currency
      || (order.receipt !== undefined && order.receipt !== null && order.receipt !== request.intentKey)) {
      throw invalidResponse();
    }
    return Object.freeze({
      provider: this.provider,
      providerReference: id,
      amountPaise: request.amountPaise,
      currency: request.currency,
    });
  }

  checkoutFor(intent: Pick<OnlinePaymentIntent, "providerReference" | "amountPaise" | "currency">): OnlinePaymentCheckout {
    return Object.freeze({
      provider: this.provider,
      mode: this.mode,
      testMode: this.mode === "SANDBOX",
      statusLabel: this.mode === "SANDBOX" ? sandboxPaymentStatusLabel : livePaymentStatusLabel,
      publicKey: this.#keyId,
      providerReference: intent.providerReference,
      amountPaise: intent.amountPaise,
      currency: intent.currency,
    });
  }

  async fetchIntentStatus(providerReference: string, signal?: AbortSignal): Promise<ProviderStatusRead<ProviderIntentSnapshot>> {
    if (!ORDER_ID_PATTERN.test(providerReference)) throw new TypeError("Unknown Razorpay order id shape");
    const path = `/v1/orders/${encodeURIComponent(providerReference)}`;
    const order = asRecord(await this.#call("GET", path, signal));
    const amountPaise = safePaise(order?.amount);
    const currency = order?.currency;
    const orderState = typeof order?.status === "string" ? ORDER_STATES[order.status] : undefined;
    if (order?.entity !== "order" || order.id !== providerReference || amountPaise === undefined
      || typeof currency !== "string" || !CURRENCY_PATTERN.test(currency) || orderState === undefined) {
      throw invalidResponse();
    }
    const collection = asRecord(await this.#call("GET", `${path}/payments`, signal));
    const items = collection?.items;
    if (collection?.entity !== "collection" || !Array.isArray(items) || items.length > MAX_LISTED_ITEMS) throw invalidResponse();
    const payments = items.map((item): ProviderIntentPaymentSnapshot => {
      const payment = asRecord(item);
      const id = payment?.id;
      const state = typeof payment?.status === "string" ? PAYMENT_STATES[payment.status] : undefined;
      const paymentAmount = safePaise(payment?.amount);
      const paymentCurrency = payment?.currency;
      if (payment?.entity !== "payment" || typeof id !== "string" || !PAYMENT_ID_PATTERN.test(id) || state === undefined
        || paymentAmount === undefined || typeof paymentCurrency !== "string" || !CURRENCY_PATTERN.test(paymentCurrency)
        || (payment.order_id !== undefined && payment.order_id !== null && payment.order_id !== providerReference)) {
        throw invalidResponse();
      }
      // Only the documented fields are kept; payer email, phone, and card details are dropped here.
      return Object.freeze({
        providerPaymentId: id, state, captured: payment.captured === true || state === "CAPTURED",
        amountPaise: paymentAmount, currency: paymentCurrency,
      });
    });
    const snapshot: ProviderIntentSnapshot = Object.freeze({
      providerReference, amountPaise, currency, orderState,
      payments: Object.freeze([...payments].sort((left, right) => left.providerPaymentId.localeCompare(right.providerPaymentId))),
    });
    return Object.freeze({ snapshot, digest: digestOf("intent", snapshot) });
  }

  async createRefund(request: OnlinePaymentRefundRequest, signal?: AbortSignal): Promise<ProviderStatusRead<ProviderRefundSnapshot>> {
    if (!PAYMENT_ID_PATTERN.test(request.providerPaymentId)) throw new TypeError("Unknown Razorpay payment id shape");
    if (!REFUND_KEY_PATTERN.test(request.refundKey)) throw new TypeError("Refund key must be 10-40 letters, digits, - or _");
    if (!Number.isSafeInteger(request.amountPaise) || request.amountPaise < RAZORPAY_MINIMUM_AMOUNT_PAISE) {
      throw new OnlinePaymentProviderError("PROVIDER_AMOUNT_BELOW_MINIMUM", false);
    }
    if (request.currency !== "INR") throw new TypeError("Only INR refunds are supported");
    const body = {
      amount: request.amountPaise,
      speed: "normal",
      receipt: request.refundKey,
      notes: this.#notes(request.metadata),
    };
    const refund = await this.#call("POST", `/v1/payments/${encodeURIComponent(request.providerPaymentId)}/refund`, signal, body,
      { "x-refund-idempotency": request.refundKey });
    const snapshot = refundSnapshot(refund, request.providerPaymentId);
    if (snapshot.amountPaise !== request.amountPaise || snapshot.currency !== request.currency) throw invalidResponse();
    return Object.freeze({ snapshot, digest: digestOf("refund", snapshot) });
  }

  async fetchRefund(providerPaymentId: string, providerRefundId: string, signal?: AbortSignal): Promise<ProviderStatusRead<ProviderRefundSnapshot>> {
    if (!PAYMENT_ID_PATTERN.test(providerPaymentId) || !REFUND_ID_PATTERN.test(providerRefundId)) {
      throw new TypeError("Unknown Razorpay payment or refund id shape");
    }
    const refund = await this.#call("GET",
      `/v1/payments/${encodeURIComponent(providerPaymentId)}/refunds/${encodeURIComponent(providerRefundId)}`, signal);
    const snapshot = refundSnapshot(refund, providerPaymentId);
    if (snapshot.providerRefundId !== providerRefundId) throw invalidResponse();
    return Object.freeze({ snapshot, digest: digestOf("refund", snapshot) });
  }

  async findRefund(providerPaymentId: string, refundKey: string, signal?: AbortSignal): Promise<ProviderStatusRead<ProviderRefundSnapshot> | undefined> {
    if (!PAYMENT_ID_PATTERN.test(providerPaymentId)) throw new TypeError("Unknown Razorpay payment id shape");
    if (!REFUND_KEY_PATTERN.test(refundKey)) throw new TypeError("Refund key must be 10-40 letters, digits, - or _");
    const collection = asRecord(await this.#call("GET",
      `/v1/payments/${encodeURIComponent(providerPaymentId)}/refunds?count=${MAX_LISTED_ITEMS}`, signal));
    const items = collection?.items;
    if (collection?.entity !== "collection" || !Array.isArray(items)) throw invalidResponse();
    const match = items.find((item) => asRecord(item)?.receipt === refundKey);
    if (match === undefined) return undefined;
    const snapshot = refundSnapshot(match, providerPaymentId);
    return Object.freeze({ snapshot, digest: digestOf("refund", snapshot) });
  }

  verifyWebhook(rawBody: Uint8Array, headers: ProviderWebhookHeaders): VerifiedProviderPaymentEvent {
    const body = Buffer.from(rawBody.buffer, rawBody.byteOffset, rawBody.byteLength);
    const payloadDigest = createHash("sha256").update(body).digest("hex");
    const signature = headerValue(headers, "x-razorpay-signature");
    if (signature === undefined) throw new ProviderWebhookRejectedError("SIGNATURE_MISSING", payloadDigest);
    if (!SIGNATURE_PATTERN.test(signature)) throw new ProviderWebhookRejectedError("SIGNATURE_INVALID", payloadDigest);
    const expected = createHmac("sha256", this.#webhookSecret).update(body).digest();
    if (!timingSafeEqual(expected, Buffer.from(signature, "hex"))) {
      throw new ProviderWebhookRejectedError("SIGNATURE_INVALID", payloadDigest);
    }

    // Only a verified body is parsed.
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
    } catch {
      throw new ProviderWebhookRejectedError("PAYLOAD_INVALID", payloadDigest);
    }
    const event = asRecord(parsed);
    const eventType = event?.event;
    const payload = asRecord(event?.payload);
    if (event?.entity !== "event" || typeof eventType !== "string" || !/^[a-z_]+(\.[a-z_]+)+$/u.test(eventType)
      || eventType.length > 100 || payload === undefined) {
      throw new ProviderWebhookRejectedError("PAYLOAD_INVALID", payloadDigest);
    }

    const payment = asRecord(asRecord(payload.payment)?.entity);
    const order = asRecord(asRecord(payload.order)?.entity);
    const refund = asRecord(asRecord(payload.refund)?.entity);
    const kind = eventKind(eventType, payment, order);
    const facts = kind === "PAYMENT_CONFIRMED" || kind === "PAYMENT_FAILED"
      ? strictPaymentFacts(eventType, payment, order, payloadDigest)
      : kind === "REFUND_CONFIRMED" || kind === "REFUND_FAILED"
        ? strictRefundFacts(kind, refund, payment, payloadDigest)
        : eventType.startsWith("refund.") ? lenientRefundFacts(refund, payment) : lenientPaymentFacts(payment, order);
    const eventId = headerValue(headers, "x-razorpay-event-id");
    const headerEventId = eventId !== undefined && EVENT_ID_PATTERN.test(eventId) ? eventId : undefined;
    const createdAt = event.created_at;

    return Object.freeze({
      provider: this.provider,
      providerEventId: headerEventId ?? `sha256:${payloadDigest}`,
      eventIdSource: headerEventId === undefined ? "DIGEST" : "HEADER",
      eventType,
      kind,
      ...facts,
      ...(typeof createdAt === "number" && Number.isSafeInteger(createdAt) && createdAt > 0
        ? { occurredAt: new Date(createdAt * 1_000) } : {}),
      payloadDigest,
    });
  }

  #notes(metadata: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
    const notes = Object.entries(metadata);
    if (notes.length > MAX_NOTES || notes.some(([key, value]) => key.length === 0 || key.length > MAX_NOTE_LENGTH
      || value.length > MAX_NOTE_LENGTH)) {
      throw new TypeError("Request metadata exceeds the provider's note limits");
    }
    return Object.fromEntries(notes);
  }

  /** One authenticated call; maps every failure to a body-free provider error. */
  async #call(
    method: "POST" | "GET",
    path: string,
    signal: AbortSignal | undefined,
    body?: Readonly<Record<string, unknown>>,
    extraHeaders: Readonly<Record<string, string>> = {},
  ): Promise<unknown> {
    const timeout = AbortSignal.timeout(this.#timeoutMs);
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    try {
      const response = await this.#http({
        method,
        url: new URL(path, this.#base).toString(),
        headers: {
          authorization: this.#authorization,
          accept: "application/json",
          ...(method === "POST" ? { "content-type": "application/json" } : {}),
          ...extraHeaders,
        },
        body: body === undefined ? "" : JSON.stringify(body),
        signal: combined,
      });
      if (response.status < 200 || response.status >= 300) throw errorForStatus(response.status);
      return await response.json();
    } catch (error) {
      if (error instanceof OnlinePaymentProviderError) throw error;
      if (signal?.aborted === true && isAbort(error)) throw error;
      if (timeout.aborted || isTimeout(error)) throw new OnlinePaymentProviderError("PROVIDER_TIMEOUT", true);
      if (error instanceof SyntaxError) throw invalidResponse();
      throw new OnlinePaymentProviderError("PROVIDER_UNREACHABLE", true);
    }
  }
}

function eventKind(eventType: string, payment: JsonRecord | undefined, order: JsonRecord | undefined): ProviderPaymentEventKind {
  if (eventType === "payment.captured") return "PAYMENT_CONFIRMED";
  if (eventType === "order.paid" && (order?.status === "paid" || payment?.status === "captured")) return "PAYMENT_CONFIRMED";
  if (eventType === "payment.failed") return "PAYMENT_ATTEMPT_FAILED";
  if (eventType === "refund.processed") return "REFUND_CONFIRMED";
  if (eventType === "refund.failed") return "REFUND_FAILED";
  return "INFORMATIONAL";
}

interface PaymentFacts {
  readonly providerReference?: string;
  readonly providerPaymentId?: string;
  readonly providerRefundId?: string;
  readonly refundKey?: string;
  readonly amountPaise?: number;
  readonly currency?: string;
}

/** A money-moving event must carry a well-formed payment entity; otherwise nothing is applied. */
function strictPaymentFacts(
  eventType: string,
  payment: JsonRecord | undefined,
  order: JsonRecord | undefined,
  payloadDigest: string,
): PaymentFacts {
  const invalid = () => new ProviderWebhookRejectedError("PAYLOAD_INVALID", payloadDigest);
  if (payment === undefined || payment.entity !== "payment") throw invalid();
  if (eventType === "payment.captured" && payment.status !== "captured") throw invalid();
  const { id, amount, currency } = payment;
  if (typeof id !== "string" || !PAYMENT_ID_PATTERN.test(id)) throw invalid();
  if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount <= 0) throw invalid();
  if (typeof currency !== "string" || !CURRENCY_PATTERN.test(currency)) throw invalid();
  const paymentOrder = payment.order_id;
  if (paymentOrder !== undefined && paymentOrder !== null
    && (typeof paymentOrder !== "string" || !ORDER_ID_PATTERN.test(paymentOrder))) throw invalid();
  // order.paid names the order twice; both must agree.
  if (order !== undefined && order.id !== undefined && order.id !== paymentOrder) throw invalid();
  return Object.freeze({
    ...(typeof paymentOrder === "string" ? { providerReference: paymentOrder } : {}),
    providerPaymentId: id,
    amountPaise: amount,
    currency,
  });
}

/** A refund that finishes must carry a well-formed refund entity whose status matches the event. */
function strictRefundFacts(
  kind: "REFUND_CONFIRMED" | "REFUND_FAILED",
  refund: JsonRecord | undefined,
  payment: JsonRecord | undefined,
  payloadDigest: string,
): PaymentFacts {
  const invalid = () => new ProviderWebhookRejectedError("PAYLOAD_INVALID", payloadDigest);
  if (refund === undefined || refund.entity !== "refund") throw invalid();
  if (refund.status !== (kind === "REFUND_CONFIRMED" ? "processed" : "failed")) throw invalid();
  const { id, payment_id: paymentId, amount, currency, receipt } = refund;
  if (typeof id !== "string" || !REFUND_ID_PATTERN.test(id)) throw invalid();
  if (typeof paymentId !== "string" || !PAYMENT_ID_PATTERN.test(paymentId)) throw invalid();
  if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount <= 0) throw invalid();
  if (typeof currency !== "string" || !CURRENCY_PATTERN.test(currency)) throw invalid();
  if (payment !== undefined && payment.id !== undefined && payment.id !== paymentId) throw invalid();
  const orderId = payment?.order_id;
  return Object.freeze({
    ...(typeof orderId === "string" && ORDER_ID_PATTERN.test(orderId) ? { providerReference: orderId } : {}),
    providerPaymentId: paymentId,
    providerRefundId: id,
    ...(typeof receipt === "string" && REFUND_KEY_PATTERN.test(receipt) ? { refundKey: receipt } : {}),
    amountPaise: amount,
    currency,
  });
}

/** Informational events keep only well-formed identifiers; malformed fields are dropped. */
function lenientPaymentFacts(payment: JsonRecord | undefined, order: JsonRecord | undefined): PaymentFacts {
  const orderId = payment?.order_id ?? order?.id;
  const paymentId = payment?.id;
  const amount = payment?.amount;
  const currency = payment?.currency;
  return Object.freeze({
    ...(typeof orderId === "string" && ORDER_ID_PATTERN.test(orderId) ? { providerReference: orderId } : {}),
    ...(typeof paymentId === "string" && PAYMENT_ID_PATTERN.test(paymentId) ? { providerPaymentId: paymentId } : {}),
    ...(typeof amount === "number" && Number.isSafeInteger(amount) && amount >= 0 ? { amountPaise: amount } : {}),
    ...(typeof currency === "string" && CURRENCY_PATTERN.test(currency) ? { currency } : {}),
  });
}

/** Other refund events (created, speed changed) keep only well-formed refund identifiers. */
function lenientRefundFacts(refund: JsonRecord | undefined, payment: JsonRecord | undefined): PaymentFacts {
  const refundId = refund?.id;
  const paymentId = refund?.payment_id ?? payment?.id;
  const receipt = refund?.receipt;
  const orderId = payment?.order_id;
  const amount = refund?.amount;
  const currency = refund?.currency;
  return Object.freeze({
    ...(typeof orderId === "string" && ORDER_ID_PATTERN.test(orderId) ? { providerReference: orderId } : {}),
    ...(typeof paymentId === "string" && PAYMENT_ID_PATTERN.test(paymentId) ? { providerPaymentId: paymentId } : {}),
    ...(typeof refundId === "string" && REFUND_ID_PATTERN.test(refundId) ? { providerRefundId: refundId } : {}),
    ...(typeof receipt === "string" && REFUND_KEY_PATTERN.test(receipt) ? { refundKey: receipt } : {}),
    ...(typeof amount === "number" && Number.isSafeInteger(amount) && amount >= 0 ? { amountPaise: amount } : {}),
    ...(typeof currency === "string" && CURRENCY_PATTERN.test(currency) ? { currency } : {}),
  });
}
