import type { SqlExecutor } from "./client.js";
import type { JsonObject, JsonValue } from "./json.js";

export type AuditActorChannel =
  | "WEB"
  | "PWA"
  | "MOBILE"
  | "IVR"
  | "OPERATOR"
  | "SYSTEM"
  | "PROVIDER";

export interface AuditEventInput {
  readonly actorId?: string;
  readonly actorChannel: AuditActorChannel;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId?: string;
  readonly outcome: string;
  readonly reasonCode?: string;
  readonly correlationId: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly occurredAt?: Date;
}

export interface StoredAuditEvent {
  readonly id: string;
  readonly correlationId: string;
  readonly metadata: JsonObject;
  readonly occurredAt: Date;
}

interface AuditRow extends Record<string, unknown> {
  readonly id: string;
  readonly correlation_id: string;
  readonly pii_safe_metadata: JsonObject;
  readonly occurred_at: Date;
}

const REDACTED = "[REDACTED]";
const SENSITIVE_KEY =
  /(?:^|_)(?:phone|mobile|email|name|address|landmark|coordinate|latitude|longitude|lat|lon|otp|password|secret|token|authorization|cookie|registration|document|payload)(?:_|$)/iu;
const EMAIL_VALUE = /\b[^\s@]+@[^\s@]+\.[^\s@]+\b/u;
const PHONE_VALUE = /(?:\+?91[\s-]?)?[6-9]\d{9}\b/u;
const BEARER_VALUE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/iu;
const JWT_VALUE = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/u;
const MAX_METADATA_DEPTH = 8;
const MAX_METADATA_BYTES = 16_384;

const sanitizeValue = (value: unknown, depth: number): JsonValue => {
  if (depth > MAX_METADATA_DEPTH) {
    return REDACTED;
  }
  if (value === null || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : REDACTED;
  }
  if (typeof value === "string") {
    return EMAIL_VALUE.test(value) ||
      PHONE_VALUE.test(value) ||
      BEARER_VALUE.test(value) ||
      JWT_VALUE.test(value)
      ? REDACTED
      : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, depth + 1));
  }
  if (typeof value === "object") {
    const sanitized: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      sanitized[key] = SENSITIVE_KEY.test(key)
        ? REDACTED
        : sanitizeValue(item, depth + 1);
    }
    return sanitized;
  }
  return REDACTED;
};

export function sanitizeAuditMetadata(
  metadata: Readonly<Record<string, unknown>> = {},
): JsonObject {
  const sanitized = sanitizeValue(metadata, 0);
  if (
    sanitized === null ||
    Array.isArray(sanitized) ||
    typeof sanitized !== "object"
  ) {
    throw new TypeError("Audit metadata must be an object");
  }
  const sanitizedObject = sanitized as JsonObject;
  if (Buffer.byteLength(JSON.stringify(sanitizedObject), "utf8") > MAX_METADATA_BYTES) {
    throw new RangeError("PII-safe audit metadata exceeds 16 KiB");
  }
  return sanitizedObject;
}

const requireText = (value: string, field: string): string => {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new TypeError(`${field} must not be empty`);
  }
  return trimmed;
};

export async function writeAuditEvent(
  executor: SqlExecutor,
  input: AuditEventInput,
): Promise<StoredAuditEvent> {
  const metadata = sanitizeAuditMetadata(input.metadata);
  const result = await executor.query<AuditRow>(
    `INSERT INTO public.audit_events
      (actor_id, actor_channel, action, resource_type, resource_id, outcome,
       reason_code, correlation_id, pii_safe_metadata, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb,
       COALESCE($10::timestamptz, CURRENT_TIMESTAMP))
     RETURNING id, correlation_id, pii_safe_metadata, occurred_at`,
    [
      input.actorId ?? null,
      input.actorChannel,
      requireText(input.action, "action"),
      requireText(input.resourceType, "resourceType"),
      input.resourceId ?? null,
      requireText(input.outcome, "outcome"),
      input.reasonCode ?? null,
      requireText(input.correlationId, "correlationId"),
      JSON.stringify(metadata),
      input.occurredAt?.toISOString() ?? null,
    ],
  );
  const row = result.rows[0];
  if (result.rowCount !== 1 || row === undefined) {
    throw new Error("Audit event was not stored");
  }
  return {
    id: row.id,
    correlationId: row.correlation_id,
    metadata: row.pii_safe_metadata,
    occurredAt: row.occurred_at,
  };
}
