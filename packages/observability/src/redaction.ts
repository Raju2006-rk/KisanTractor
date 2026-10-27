import { safeDeliveryErrorCode } from "@kisantractor/domain";

export const REDACTED = "[REDACTED]";

export type LogValue =
  | null
  | boolean
  | number
  | string
  | readonly LogValue[]
  | { readonly [key: string]: LogValue };

export type LogFields = Readonly<Record<string, LogValue>>;

/**
 * Field names that carry operational identifiers, counters, and machine codes
 * rather than personal data. Their values pass through after value scanning;
 * every other field is checked against the sensitive-name list as well.
 */
export const SAFE_LOG_FIELDS: ReadonlySet<string> = new Set([
  "timestamp",
  "level",
  "service",
  "event",
  "environment",
  "correlationId",
  "traceId",
  "spanId",
  "parentSpanId",
  "span",
  "spanKind",
  "status",
  "outcome",
  "reasonCode",
  "errorCode",
  "errorName",
  "method",
  "route",
  "statusCode",
  "statusClass",
  "durationMs",
  "workerId",
  "outboxEventId",
  "eventType",
  "aggregateType",
  "attempt",
  "nextAttemptAt",
  "lagMs",
  "claimed",
  "published",
  "retryScheduled",
  "deadLettered",
  "leaseLost",
  "isolation",
  "readOnly",
  "capability",
  "capabilityState",
  "locale",
  "resolvedLocale",
  "fallbackLocale",
  "translationKey",
  "metric",
  "metrics",
  "vital",
  "rating",
  "routeGroup",
  "value",
  "config",
  // SHA-256 of a provider callback body: identifies a rejected request without revealing it.
  "eventDigest",
]);

/** Name segments that mark a field as personal, secret, or provider-private. */
const SENSITIVE_SEGMENTS: ReadonlySet<string> = new Set([
  "phone", "mobile", "msisdn", "email", "name", "names", "firstname", "lastname", "address",
  "landmark", "directions", "village", "street", "pincode", "postcode", "coordinate",
  "coordinates", "latitude", "longitude", "lat", "lng", "lon", "geo", "otp", "pin",
  "code", "password", "passcode", "secret", "token", "tokens", "credential", "credentials",
  "authorization", "cookie", "cookies", "bearer", "signature", "registration", "plate",
  "payload", "body", "recipient", "recipients", "contact", "aadhaar", "pan", "upi", "vpa",
  "ifsc", "account", "card", "url", "uri", "key", "message", "stack", "description",
  // Free text typed by people (cancellation reasons, notes) can contain names.
  "reason", "note", "notes", "comment", "comments", "text", "remarks",
]);

/**
 * Exact keys that are safe even though a segment looks sensitive, because they
 * name a code or count rather than the sensitive thing itself.
 */
const SENSITIVE_SEGMENT_EXCEPTIONS: ReadonlySet<string> = new Set([
  "errorCode",
  "reasonCode",
  "statusCode",
]);

const EMAIL_VALUE = /[^\s@]+@[^\s@]+\.[^\s@]+/u;
// Indian mobile numbers with optional +91/0 prefix and common separators.
const INDIAN_PHONE_VALUE = /(?<!\d)(?:\+?91[\s-]?|0)?[6-9]\d{4}[\s-]?\d{5}(?!\d)/u;
const LONG_DIGIT_RUN = /\d{10,}/u;
const BEARER_VALUE = /\bBearer\s+\S+/iu;
const JWT_VALUE = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/u;
const OTP_LIKE_VALUE = /^\s*\d{4,8}\s*$/u;
const COORDINATE_PAIR = /-?\d{1,3}\.\d{4,}\s*[,;\s]\s*-?\d{1,3}\.\d{4,}/u;
// Indian vehicle registration marks, e.g. "AP 03 AB 1234", "KA01MX9999", "22 BH 1234 AA".
const VEHICLE_REGISTRATION =
  /(?<![A-Za-z0-9])[A-Z]{2}[\s-]?\d{1,2}[\s-]?[A-Z]{0,3}[\s-]?\d{4}(?!\d)|(?<![A-Za-z0-9])\d{2}[\s-]?BH[\s-]?\d{4}[\s-]?[A-Z]{1,2}(?![A-Za-z])/iu;
const URL_WITH_QUERY = /\bhttps?:\/\/\S+\?\S+/iu;
const HIGH_PRECISION_FRACTION = /\.\d{4,}$/u;

const MAX_DEPTH = 6;
const MAX_ARRAY_ITEMS = 50;
const MAX_STRING_LENGTH = 512;
const MAX_OBJECT_KEYS = 64;

/** Splits camelCase, PascalCase, snake_case, and kebab-case keys into lower-case segments. */
export function fieldNameSegments(key: string): readonly string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1 $2")
    // "phone2" and "name1" are still phone and name fields.
    .replace(/([A-Za-z])(\d)/gu, "$1 $2")
    .replace(/(\d)([A-Za-z])/gu, "$1 $2")
    .split(/[^A-Za-z0-9]+/u)
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.toLowerCase());
}

/** True when a field name marks its value as personal, secret, or provider-private. */
export function isSensitiveFieldName(key: string): boolean {
  if (SAFE_LOG_FIELDS.has(key) || SENSITIVE_SEGMENT_EXCEPTIONS.has(key)) return false;
  return fieldNameSegments(key).some((segment) => SENSITIVE_SEGMENTS.has(segment));
}

/** True when a free-text value contains something that looks like personal or secret data. */
export function containsSensitiveText(value: string): boolean {
  return EMAIL_VALUE.test(value)
    || INDIAN_PHONE_VALUE.test(value)
    || LONG_DIGIT_RUN.test(value)
    || BEARER_VALUE.test(value)
    || JWT_VALUE.test(value)
    || OTP_LIKE_VALUE.test(value)
    || COORDINATE_PAIR.test(value)
    || VEHICLE_REGISTRATION.test(value)
    || URL_WITH_QUERY.test(value);
}

const UUID_TOKEN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu;
const HEX_ID = /^(?:[0-9a-f]{16}|[0-9a-f]{32})$/u;
const IDENTIFIER_FIELDS: ReadonlySet<string> = new Set([
  "correlationId", "traceId", "spanId", "parentSpanId", "outboxEventId",
]);

const SHA256_HEX = /^[0-9a-f]{64}$/u;

const redactString = (value: string, key?: string): string => {
  // Generated identifiers are hex/UUID shaped; keep them intact so logs stay joinable.
  if (key !== undefined && IDENTIFIER_FIELDS.has(key) && HEX_ID.test(value)) return value;
  // A body digest is random hex whose digit runs can look like phone numbers; it holds no data.
  if (key === "eventDigest" && SHA256_HEX.test(value)) return value;
  // UUIDs can contain digit runs or letter-digit groups that resemble phones or plates.
  if (containsSensitiveText(value.replace(UUID_TOKEN, " "))) return REDACTED;
  return value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}…` : value;
};

const redactNumber = (value: number, trustedField: boolean): LogValue => {
  if (!Number.isFinite(value)) return null;
  if (trustedField) return value;
  // High-precision fractions are treated as exact coordinates.
  if (!Number.isInteger(value) && HIGH_PRECISION_FRACTION.test(String(value))) return REDACTED;
  // Ten or more digits is phone-number shaped.
  if (Number.isInteger(value) && Math.abs(value) >= 1_000_000_000) return REDACTED;
  return value;
};

const isError = (value: unknown): value is Error => value instanceof Error;

/** Errors are reduced to their class name and a code-shaped identifier; messages and stacks never survive. */
export function redactError(error: unknown): LogFields {
  const errorName = isError(error) && /^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(error.name) ? error.name : "Error";
  return Object.freeze({ errorName, errorCode: safeDeliveryErrorCode(error, "UNCLASSIFIED") });
}

const redactValue = (value: unknown, depth: number, key: string | undefined): LogValue | undefined => {
  if (value === undefined || typeof value === "function" || typeof value === "symbol") return undefined;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return redactNumber(value, key !== undefined && SAFE_LOG_FIELDS.has(key));
  if (typeof value === "bigint") return redactString(value.toString());
  if (typeof value === "string") return redactString(value, key);
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (isError(value)) return redactError(value);
  if (depth >= MAX_DEPTH) return REDACTED;
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_ITEMS)
      .map((item) => redactValue(item, depth + 1, key))
      .map((item) => item ?? null);
    return Object.freeze(items);
  }
  if (typeof value === "object") {
    return redactObject(value as Readonly<Record<string, unknown>>, depth + 1);
  }
  return REDACTED;
};

const redactObject = (value: Readonly<Record<string, unknown>>, depth: number): LogFields => {
  const result: Record<string, LogValue> = {};
  let keys = 0;
  for (const [key, item] of Object.entries(value)) {
    if (keys >= MAX_OBJECT_KEYS) break;
    keys += 1;
    if (isSensitiveFieldName(key)) {
      if (item !== undefined) result[key] = REDACTED;
      continue;
    }
    const redacted = redactValue(item, depth, key);
    if (redacted !== undefined) result[key] = redacted;
  }
  return Object.freeze(result);
};

/**
 * Central PII redaction for structured logs, span attributes, and exported
 * telemetry. Allow-listed operational fields keep their values (after value
 * scanning); sensitive field names are replaced; free text that resembles a
 * phone number, OTP, token, exact coordinate, vehicle registration, signed URL,
 * or email is replaced; errors keep only a class name and a code.
 */
export function redactLogFields(fields: Readonly<Record<string, unknown>>): LogFields {
  return redactObject(fields, 0);
}
