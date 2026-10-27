import type {
  ProviderIntentSnapshot,
  ProviderPaymentEventKind,
  ProviderRefundSnapshot,
} from "@kisantractor/domain";

/**
 * Provider-independent online payment contract (Requirements 11.3-11.6, 14.1, 14.3).
 *
 * Adapters create provider-linked intents and verify provider webhooks. They never decide
 * settlement: the domain (`evaluateProviderPaymentEvent`) and the payment store apply the
 * financial effect, so a provider can be replaced without touching invoice rules.
 */
export type OnlinePaymentMode = "SANDBOX" | "LIVE";

export interface OnlinePaymentIntentRequest {
  /** Stable per (Farmer, invoice, idempotency key); sent to the provider as its receipt id. */
  readonly intentKey: string;
  readonly amountPaise: number;
  readonly currency: "INR";
  /** Non-personal identifiers only (booking and invoice ids) for provider-side reconciliation. */
  readonly metadata: Readonly<Record<string, string>>;
}

export interface OnlinePaymentIntent {
  readonly provider: string;
  /** The provider's intent reference (for example a Razorpay order id). */
  readonly providerReference: string;
  readonly amountPaise: number;
  readonly currency: "INR";
}

/** Client-safe values the browser needs to open the provider checkout. No secret is included. */
export interface OnlinePaymentCheckout {
  readonly provider: string;
  readonly mode: OnlinePaymentMode;
  /** True for a sandbox provider: no real money moves (Requirement 14.3). */
  readonly testMode: boolean;
  readonly statusLabel: string;
  /** The provider's publishable key id; designed to be public. */
  readonly publicKey: string;
  readonly providerReference: string;
  readonly amountPaise: number;
  readonly currency: "INR";
}

/** A webhook whose signature was verified over the raw request body, normalized for the domain. */
export interface VerifiedProviderPaymentEvent {
  readonly provider: string;
  /** The provider's unique event id, or `sha256:<digest>` when the provider sent none. */
  readonly providerEventId: string;
  readonly eventIdSource: "HEADER" | "DIGEST";
  /** The provider's own event name, for example `payment.captured`. */
  readonly eventType: string;
  readonly kind: ProviderPaymentEventKind;
  readonly providerReference?: string;
  readonly providerPaymentId?: string;
  /** Refund events: the provider's refund id and the platform's refund key (its receipt). */
  readonly providerRefundId?: string;
  readonly refundKey?: string;
  /** For refund events, the refund amount; otherwise the payment amount. */
  readonly amountPaise?: number;
  readonly currency?: string;
  readonly occurredAt?: Date;
  /** SHA-256 of the raw body; safe to log and store. */
  readonly payloadDigest: string;
}

export type ProviderWebhookHeaders = Readonly<Record<string, string | readonly string[] | undefined>>;

export interface OnlinePaymentProviderAdapter {
  readonly provider: string;
  readonly mode: OnlinePaymentMode;
  createIntent(request: OnlinePaymentIntentRequest, signal?: AbortSignal): Promise<OnlinePaymentIntent>;
  checkoutFor(intent: Pick<OnlinePaymentIntent, "providerReference" | "amountPaise" | "currency">): OnlinePaymentCheckout;
  /** Verifies the signature before parsing anything. Throws `ProviderWebhookRejectedError`. */
  verifyWebhook(rawBody: Uint8Array, headers: ProviderWebhookHeaders): VerifiedProviderPaymentEvent;
}

/** A provider status read over the authenticated API, with a digest of the normalized facts. */
export interface ProviderStatusRead<Snapshot> {
  readonly snapshot: Snapshot;
  /** SHA-256 of the normalized snapshot; stored as the evidence digest. */
  readonly digest: string;
}

export interface OnlinePaymentRefundRequest {
  readonly providerPaymentId: string;
  /** Integer paise; the platform only requests full refunds of a captured payment. */
  readonly amountPaise: number;
  readonly currency: "INR";
  /** Stable per refund request: sent as the provider idempotency key and receipt. */
  readonly refundKey: string;
  /** Non-personal identifiers only. */
  readonly metadata: Readonly<Record<string, string>>;
}

/**
 * Server-to-server status reads and refunds (task 16.2). Every call is authenticated with the
 * provider's API credentials over HTTPS, so its answers are verified provider evidence; browsers
 * never reach these methods. Adapters normalize answers; the domain decides their effect.
 */
export interface OnlinePaymentRecoveryAdapter extends OnlinePaymentProviderAdapter {
  /** The intent and every payment attempt the provider lists for it. */
  fetchIntentStatus(providerReference: string, signal?: AbortSignal): Promise<ProviderStatusRead<ProviderIntentSnapshot>>;
  /** Creates (or, with the same refund key, returns) one refund. */
  createRefund(request: OnlinePaymentRefundRequest, signal?: AbortSignal): Promise<ProviderStatusRead<ProviderRefundSnapshot>>;
  fetchRefund(providerPaymentId: string, providerRefundId: string, signal?: AbortSignal): Promise<ProviderStatusRead<ProviderRefundSnapshot>>;
  /** Finds the refund created with this refund key, or undefined when the provider has none. */
  findRefund(providerPaymentId: string, refundKey: string, signal?: AbortSignal): Promise<ProviderStatusRead<ProviderRefundSnapshot> | undefined>;
}

export const supportsPaymentRecovery = (adapter: OnlinePaymentProviderAdapter): adapter is OnlinePaymentRecoveryAdapter => {
  const candidate = adapter as Partial<OnlinePaymentRecoveryAdapter>;
  return typeof candidate.fetchIntentStatus === "function" && typeof candidate.createRefund === "function"
    && typeof candidate.fetchRefund === "function" && typeof candidate.findRefund === "function";
};

export type OnlinePaymentProviderErrorCode =
  | "PROVIDER_AMOUNT_BELOW_MINIMUM"
  | "PROVIDER_REJECTED_REQUEST"
  | "PROVIDER_NOT_FOUND"
  | "PROVIDER_CONFLICT"
  | "PROVIDER_AUTH_FAILED"
  | "PROVIDER_THROTTLED"
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_UNREACHABLE"
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_RESPONSE_INVALID";

/** A provider call failed. The message and code never contain provider response bodies. */
export class OnlinePaymentProviderError extends Error {
  constructor(readonly code: OnlinePaymentProviderErrorCode, readonly retryable: boolean) {
    super(`Online payment provider request failed with ${code}`);
    this.name = "OnlinePaymentProviderError";
  }
}

export type ProviderWebhookRejectionCode = "SIGNATURE_MISSING" | "SIGNATURE_INVALID" | "PAYLOAD_INVALID";

/** A webhook was refused before any financial effect. Carries only the body digest. */
export class ProviderWebhookRejectedError extends Error {
  constructor(readonly code: ProviderWebhookRejectionCode, readonly payloadDigest: string) {
    super(`Provider webhook rejected: ${code}`);
    this.name = "ProviderWebhookRejectedError";
  }
}

export const sandboxPaymentStatusLabel = "Test payment (sandbox): no real money moves";
export const livePaymentStatusLabel = "Live payment";
