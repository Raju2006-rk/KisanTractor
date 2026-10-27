/**
 * Client-side rules for Authoritative Actions (confirming a booking, accepting or rejecting work,
 * job controls, recording payment, disputing a bill) under unreliable connectivity.
 *
 * - An action is sent only when the user presses its control. Nothing here listens for
 *   connectivity changes, schedules timers, or replays a request: there is no queue.
 * - While the outcome of an attempt is unknown, its idempotency key is kept so the explicit
 *   retry reuses it and the server cannot record the action twice.
 * - Only allow-listed, non-sensitive form fields are kept as a safe draft, in tab-scoped storage.
 *
 * Kept free of React, the DOM, and translation catalogs so the rules are directly testable and
 * cheap to bundle into client components.
 */

/** The result of one attempt as far as the client can know it. */
export type ActionOutcome =
  /** Nothing left the device because it was offline; the same key is kept for the explicit retry. */
  | "NOT_SENT"
  /** The request may or may not have been applied; only a retry with the same key is safe. */
  | "UNKNOWN"
  /** The server definitely refused it, so nothing was recorded under the key. */
  | "REJECTED"
  | "SUCCEEDED";

export type AttemptState = "NOT_SENT" | "SENT" | "UNKNOWN";

export type SafeDraftValue = string | boolean;
export type SafeDraftFields = Readonly<Record<string, SafeDraftValue>>;

export interface StoredAttempt {
  readonly version: 1;
  readonly actionId: string;
  /** Absent for actions guarded by an expected version instead of an idempotency key. */
  readonly idempotencyKey?: string;
  readonly state: AttemptState;
  /** Epoch milliseconds when this key was first used. */
  readonly createdAt: number;
  /** Request-time values that must be resent unchanged, such as a capture timestamp. */
  readonly stableValues: Readonly<Record<string, string>>;
  readonly fields: SafeDraftFields;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  readonly length?: number;
  key?(index: number): string | null;
}

export const attemptStoragePrefix = "kisantractor:attempt:v1:";
export const safeDraftStoragePrefix = "kisantractor:draft:v2:";

/**
 * Pending attempts are dropped after 12 hours, well inside the server's 24-hour idempotency
 * retention, so a restored key is always one the server still recognizes.
 */
export const attemptMaxAgeMs = 12 * 60 * 60 * 1_000;

const idempotencyKeyPattern = /^[A-Za-z0-9_-]{8,100}$/u;
const actionIdPattern = /^[A-Za-z0-9:_-]{1,200}$/u;
const maximumDraftValueLength = 2_000;

/**
 * Field names that are never written to a draft even when a screen allow-lists them by mistake:
 * credentials, one-time codes, and payment-provider or card data.
 */
const sensitiveFieldPattern =
  /token|otp|one[-_]?time|passw|passcode|secret|credential|authori[sz]ation|cookie|session|signature|provider|razorpay|card|cvv|upi|vpa|^pin$|bank|account[-_]?number|ifsc/iu;

export function isSensitiveDraftField(name: string): boolean {
  return sensitiveFieldPattern.test(name);
}

export function isValidAttemptKey(value: unknown): value is string {
  return typeof value === "string" && idempotencyKeyPattern.test(value);
}

/** Keeps only allow-listed, non-sensitive, bounded string and boolean values. */
export function sanitizeSafeDraft(
  source: Readonly<Record<string, unknown>>,
  allowedFields: readonly string[],
): SafeDraftFields {
  const result: Record<string, SafeDraftValue> = {};
  for (const name of allowedFields) {
    if (isSensitiveDraftField(name) || !Object.hasOwn(source, name)) continue;
    const value = source[name];
    if (typeof value === "boolean") result[name] = value;
    else if (typeof value === "string" && value.length <= maximumDraftValueLength) result[name] = value;
  }
  return Object.freeze(result);
}

/** `navigator.onLine === false` reliably means offline; `true` only means "maybe online". */
export function isDeviceOnline(host: { readonly navigator?: { readonly onLine?: boolean } } | undefined): boolean {
  return host?.navigator?.onLine !== false;
}

/**
 * Maps an HTTP status to what the client can know. Timeouts, throttling, and server failures
 * may have been applied, so they are unknown; other 4xx responses are definite refusals.
 */
export function classifyHttpOutcome(status: number): Exclude<ActionOutcome, "NOT_SENT"> {
  if (status >= 200 && status < 300) return "SUCCEEDED";
  if (status === 408 || status === 425 || status === 429 || status >= 500 || status < 200) return "UNKNOWN";
  if (status >= 400) return "REJECTED";
  return "UNKNOWN";
}

/** Joins identifier parts into a storage-safe action id or family, e.g. `job:<bookingId>:start`. */
export function attemptScope(...parts: readonly string[]): string {
  return parts.map((part) => part.replace(/[^A-Za-z0-9_-]/gu, "_").slice(0, 80)).join(":");
}

const attemptStorageKey = (actionId: string) => `${attemptStoragePrefix}${actionId}`;

function safeGet(storage: StorageLike | undefined, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function safeSet(storage: StorageLike | undefined, key: string, value: string): void {
  try {
    storage?.setItem(key, value);
  } catch {
    // Storage can be full or disabled; the in-page form still holds the values and the key.
  }
}

function safeRemove(storage: StorageLike | undefined, key: string): void {
  try {
    storage?.removeItem(key);
  } catch {
    // Best effort.
  }
}

function parseAttempt(actionId: string, raw: string | null): StoredAttempt | undefined {
  if (raw === null) return undefined;
  try {
    const value = JSON.parse(raw) as Partial<StoredAttempt> | null;
    if (!value || value.version !== 1 || value.actionId !== actionId) return undefined;
    if (value.state !== "NOT_SENT" && value.state !== "SENT" && value.state !== "UNKNOWN") return undefined;
    if (typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt)) return undefined;
    if (value.idempotencyKey !== undefined && !isValidAttemptKey(value.idempotencyKey)) return undefined;
    const stableValues: Record<string, string> = {};
    for (const [name, item] of Object.entries(value.stableValues ?? {})) {
      if (typeof item === "string" && item.length <= 200 && !isSensitiveDraftField(name)) stableValues[name] = item;
    }
    const fields = sanitizeSafeDraft(
      value.fields && typeof value.fields === "object" ? value.fields as Record<string, unknown> : {},
      Object.keys(value.fields ?? {}),
    );
    return Object.freeze({
      version: 1,
      actionId,
      ...(value.idempotencyKey === undefined ? {} : { idempotencyKey: value.idempotencyKey }),
      state: value.state,
      createdAt: value.createdAt,
      stableValues: Object.freeze(stableValues),
      fields,
    });
  } catch {
    return undefined;
  }
}

/** Reads a pending attempt; expired or malformed records are discarded. */
export function loadAttempt(storage: StorageLike | undefined, actionId: string, now: number): StoredAttempt | undefined {
  if (!actionIdPattern.test(actionId)) return undefined;
  const attempt = parseAttempt(actionId, safeGet(storage, attemptStorageKey(actionId)));
  if (attempt === undefined) {
    safeRemove(storage, attemptStorageKey(actionId));
    return undefined;
  }
  if (now - attempt.createdAt > attemptMaxAgeMs || attempt.createdAt - now > 5 * 60 * 1_000) {
    safeRemove(storage, attemptStorageKey(actionId));
    return undefined;
  }
  return attempt;
}

export function saveAttempt(storage: StorageLike | undefined, attempt: StoredAttempt): void {
  if (!actionIdPattern.test(attempt.actionId)) return;
  safeSet(storage, attemptStorageKey(attempt.actionId), JSON.stringify(attempt));
}

export function clearAttempt(storage: StorageLike | undefined, actionId: string): void {
  safeRemove(storage, attemptStorageKey(actionId));
}

/** Clears every pending attempt in one action family, e.g. all job controls for one booking. */
export function clearAttemptFamily(storage: StorageLike | undefined, family: string): void {
  if (!storage || typeof storage.key !== "function" || typeof storage.length !== "number") return;
  const prefix = attemptStorageKey(`${family}:`);
  const matches: string[] = [];
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(prefix)) matches.push(key);
    }
  } catch {
    return;
  }
  for (const key of matches) safeRemove(storage, key);
}

export interface BeginAttemptInput {
  readonly actionId: string;
  readonly existing: StoredAttempt | undefined;
  /** The key rendered with the form, or a freshly generated one for client-driven actions. */
  readonly renderedKey?: string;
  readonly online: boolean;
  readonly fields: SafeDraftFields;
  readonly stableValues?: Readonly<Record<string, string>>;
  readonly now: number;
}

export interface BeginAttemptResult {
  readonly decision: "SEND" | "BLOCK_OFFLINE";
  readonly attempt: StoredAttempt;
}

/**
 * Starts (or restarts) an attempt when the user presses the control. A pending attempt's key and
 * stable values always win over freshly rendered ones, so a retry is byte-for-byte the same request.
 */
export function beginAttempt(input: BeginAttemptInput): BeginAttemptResult {
  const key = input.existing?.idempotencyKey ?? (isValidAttemptKey(input.renderedKey) ? input.renderedKey : undefined);
  const attempt: StoredAttempt = Object.freeze({
    version: 1,
    actionId: input.actionId,
    ...(key === undefined ? {} : { idempotencyKey: key }),
    state: input.online ? "SENT" : "NOT_SENT",
    createdAt: input.existing?.createdAt ?? input.now,
    stableValues: Object.freeze({ ...(input.stableValues ?? {}), ...(input.existing?.stableValues ?? {}) }),
    fields: input.fields,
  });
  return Object.freeze({ decision: input.online ? "SEND" : "BLOCK_OFFLINE", attempt });
}

/**
 * Applies an outcome. Success and definite refusals end the attempt, so the next press uses a new
 * key; unknown and unsent outcomes keep the same key for the explicit retry.
 */
export function settleAttempt(attempt: StoredAttempt, outcome: ActionOutcome): StoredAttempt | undefined {
  if (outcome === "SUCCEEDED" || outcome === "REJECTED") return undefined;
  return Object.freeze({ ...attempt, state: outcome === "NOT_SENT" ? "NOT_SENT" : "UNKNOWN" });
}

export type ResumeNotice = "NONE" | "NOT_SENT" | "UNKNOWN";

/**
 * Decides what a freshly loaded screen shows for a pending attempt. When the page already reports
 * the outcome (the server redirected back with feedback), the pending record is obsolete.
 */
export function resumeNotice(attempt: StoredAttempt | undefined, outcomeReported: boolean): ResumeNotice {
  if (attempt === undefined || outcomeReported) return "NONE";
  return attempt.state === "NOT_SENT" ? "NOT_SENT" : "UNKNOWN";
}

export interface ActionResponse {
  readonly status: number;
}

export interface RunAuthoritativeActionInput<T extends ActionResponse> {
  readonly storage: StorageLike | undefined;
  readonly actionId: string;
  readonly renderedKey: string;
  readonly online: boolean;
  readonly fields: SafeDraftFields;
  readonly stableValues?: Readonly<Record<string, string>>;
  readonly now: number;
  /** Sends exactly one request. Called at most once per explicit user action. */
  readonly send: (attempt: StoredAttempt) => Promise<T>;
}

export interface RunAuthoritativeActionResult<T extends ActionResponse> {
  readonly outcome: ActionOutcome;
  /** The attempt that was used; still stored when the outcome is NOT_SENT or UNKNOWN. */
  readonly attempt: StoredAttempt;
  /** True when this attempt reused a key whose earlier outcome was unknown. */
  readonly resumedUnknown: boolean;
  readonly response?: T;
}

/**
 * Runs one explicit attempt for a client-driven Authoritative Action. Offline devices send
 * nothing; the attempt and its key are kept for the user's next explicit press.
 */
export async function runAuthoritativeAction<T extends ActionResponse>(
  input: RunAuthoritativeActionInput<T>,
): Promise<RunAuthoritativeActionResult<T>> {
  const existing = loadAttempt(input.storage, input.actionId, input.now);
  const resumedUnknown = existing?.state === "UNKNOWN" || existing?.state === "SENT";
  const { attempt, decision } = beginAttempt({
    actionId: input.actionId,
    existing,
    renderedKey: input.renderedKey,
    online: input.online,
    fields: input.fields,
    ...(input.stableValues ? { stableValues: input.stableValues } : {}),
    now: input.now,
  });
  saveAttempt(input.storage, attempt);
  if (decision === "BLOCK_OFFLINE") return Object.freeze({ outcome: "NOT_SENT", attempt, resumedUnknown });

  let outcome: ActionOutcome;
  let response: T | undefined;
  try {
    response = await input.send(attempt);
    outcome = classifyHttpOutcome(response.status);
  } catch {
    outcome = "UNKNOWN";
  }
  const next = settleAttempt(attempt, outcome);
  if (next === undefined) clearAttempt(input.storage, input.actionId);
  else saveAttempt(input.storage, next);
  return Object.freeze({
    outcome,
    attempt: next ?? attempt,
    resumedUnknown,
    ...(response === undefined ? {} : { response }),
  });
}
