import { NotificationChannelError } from "./notification-channel.js";

/** Minimal HTTP seam for messaging providers, so contract tests never reach a provider. */
export interface MessagingHttpRequest {
  readonly method: "POST";
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly signal: AbortSignal;
}

export interface MessagingHttpResponse {
  readonly status: number;
  json(): Promise<unknown>;
}

export type MessagingHttpClient = (request: MessagingHttpRequest) => Promise<MessagingHttpResponse>;

/** Default client: global fetch, refusing redirects so credentials never follow a hop. */
export const fetchMessagingHttpClient: MessagingHttpClient = async (request) => {
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    signal: request.signal,
    redirect: "error",
  });
  return { status: response.status, json: () => response.json() as Promise<unknown> };
};

export const DEFAULT_MESSAGING_TIMEOUT_MS = 10_000;

export const requireHttpsBase = (value: string, name: string): URL => {
  const base = new URL(value);
  if (base.protocol !== "https:") throw new TypeError(`${name} must use HTTPS`);
  return base;
};

export const requireTimeout = (timeoutMs: number): number => {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError("timeoutMs must be a positive integer");
  return timeoutMs;
};

const isAbort = (error: unknown): boolean =>
  (error instanceof DOMException || error instanceof Error) && error.name === "AbortError";
const isTimeout = (error: unknown): boolean =>
  (error instanceof DOMException || error instanceof Error) && error.name === "TimeoutError";

/** Status-to-error mapping shared by messaging adapters; codes are PII-free. */
export const messagingErrorForStatus = (status: number): NotificationChannelError => {
  if (status === 401 || status === 403) return new NotificationChannelError("PROVIDER_AUTH_FAILED", false);
  if (status === 408) return new NotificationChannelError("PROVIDER_TIMEOUT", true);
  if (status === 429) return new NotificationChannelError("PROVIDER_THROTTLED", true);
  if (status >= 500) return new NotificationChannelError("PROVIDER_UNAVAILABLE", true);
  return new NotificationChannelError("PROVIDER_REJECTED_REQUEST", false);
};

export interface MessagingCallResult {
  readonly status: number;
  /** Parsed body, or undefined when the body was not JSON. */
  readonly body: unknown;
}

/**
 * One provider call with a timeout. Transport failures become retryable, body-free channel
 * errors; the caller decides what each HTTP status means. A caller abort is rethrown as is.
 */
export async function callMessagingProvider(
  http: MessagingHttpClient,
  request: Omit<MessagingHttpRequest, "signal" | "method">,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<MessagingCallResult> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
  let response: MessagingHttpResponse;
  try {
    response = await http({ ...request, method: "POST", signal: combined });
  } catch (error) {
    if (signal?.aborted === true && isAbort(error)) throw error;
    if (timeout.aborted || isTimeout(error)) throw new NotificationChannelError("PROVIDER_TIMEOUT", true);
    throw new NotificationChannelError("PROVIDER_UNREACHABLE", true);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    if (signal?.aborted === true && isAbort(error)) throw error;
    if (timeout.aborted || isTimeout(error)) throw new NotificationChannelError("PROVIDER_TIMEOUT", true);
    body = undefined;
  }
  return { status: response.status, body };
}

type JsonRecord = Readonly<Record<string, unknown>>;
export const asJsonRecord = (value: unknown): JsonRecord | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonRecord : undefined;
