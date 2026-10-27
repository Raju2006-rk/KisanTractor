import { withDomainTransaction, type SqlPool } from "@kisantractor/database";

import { MAX_SUPPORT_GRANT_MS, type SupportGrantScope } from "./support.contracts.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const TICKET = /^[A-Za-z0-9][A-Za-z0-9-]{2,39}$/u;
const MIN_GRANT_MS = 5 * 60 * 1_000;

export class SupportAdminError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "SupportAdminError";
  }
}

export interface GrantSupportAccessInput {
  readonly operatorUserId: string;
  readonly caseId: string;
  readonly scope: SupportGrantScope;
  /** A change or support ticket reference that justifies the access; a code, not free text. */
  readonly ticketReference: string;
  readonly durationMs: number;
  readonly correlationId: string;
  readonly now?: Date;
}

export interface SupportGrantRecord {
  readonly grantId: string;
  readonly caseId: string;
  readonly bookingId: string;
  readonly operatorUserId: string;
  readonly scope: SupportGrantScope;
  readonly validFrom: Date;
  readonly expiresAt: Date;
  readonly revokedAt?: Date;
}

interface GrantRow extends Record<string, unknown> {
  readonly id: string;
  readonly case_id: string;
  readonly booking_id: string;
  readonly operator_user_id: string;
  readonly scope: SupportGrantScope;
  readonly valid_from: Date;
  readonly expires_at: Date;
  readonly revoked_at: Date | null;
}

const toRecord = (row: GrantRow): SupportGrantRecord => Object.freeze({
  grantId: row.id, caseId: row.case_id, bookingId: row.booking_id, operatorUserId: row.operator_user_id,
  scope: row.scope, validFrom: row.valid_from, expiresAt: row.expires_at,
  ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at }),
});

const requireUuid = (value: string, field: string): string => {
  if (!UUID.test(value.trim())) throw new SupportAdminError("INVALID_ARGUMENT", `${field} must be a UUID`);
  return value.trim().toLowerCase();
};

/**
 * Issues one explicit, time-bounded grant (the admin path for support access, task 16.5). The
 * operator must be an active account with an unrevoked FUTURE_OPERATOR membership; a RESOLVE
 * grant needs an OPEN case. Audited with ids and codes only.
 */
export async function grantSupportAccess(pool: SqlPool, input: GrantSupportAccessInput): Promise<SupportGrantRecord> {
  const operatorUserId = requireUuid(input.operatorUserId, "operator");
  const caseId = requireUuid(input.caseId, "case");
  if (input.scope !== "READ" && input.scope !== "RESOLVE") throw new SupportAdminError("INVALID_ARGUMENT", "scope must be READ or RESOLVE");
  if (!TICKET.test(input.ticketReference)) throw new SupportAdminError("INVALID_ARGUMENT", "ticket must be 3-40 letters, digits, or hyphens");
  if (!Number.isSafeInteger(input.durationMs) || input.durationMs < MIN_GRANT_MS || input.durationMs > MAX_SUPPORT_GRANT_MS) {
    throw new SupportAdminError("INVALID_ARGUMENT", "duration must be between 5 minutes and 7 days");
  }
  const now = input.now ?? new Date();
  return withDomainTransaction(pool, { correlationId: input.correlationId, isolation: "SERIALIZABLE" }, async (tx) => {
    const operator = await tx.sql.query<{ readonly ok: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM public.users u JOIN public.user_role_memberships m ON m.user_id = u.id
         WHERE u.id = $1::uuid AND u.status = 'ACTIVE' AND u.deleted_at IS NULL
           AND m.role_code = 'FUTURE_OPERATOR' AND m.revoked_at IS NULL
       ) AS ok`, [operatorUserId]);
    if (operator.rows[0]?.ok !== true) throw new SupportAdminError("OPERATOR_NOT_ELIGIBLE", "The account is not an active support operator");
    const supportCase = (await tx.sql.query<{ readonly booking_id: string; readonly status: string }>(
      "SELECT booking_id, status FROM public.support_cases WHERE id = $1::uuid FOR SHARE", [caseId])).rows[0];
    if (supportCase === undefined) throw new SupportAdminError("CASE_NOT_FOUND", "No such support case");
    if (input.scope === "RESOLVE" && supportCase.status !== "OPEN") {
      throw new SupportAdminError("CASE_NOT_OPEN", "A RESOLVE grant needs an open case; issue READ to review a resolved case");
    }
    const inserted = (await tx.sql.query<GrantRow>(
      `INSERT INTO public.support_access_grants
         (case_id, booking_id, operator_user_id, scope, ticket_reference, issued_via, valid_from, expires_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, 'ADMIN_CLI', $6::timestamptz, $7::timestamptz)
       RETURNING id, case_id, booking_id, operator_user_id, scope, valid_from, expires_at, revoked_at`,
      [caseId, supportCase.booking_id, operatorUserId, input.scope, input.ticketReference, now.toISOString(),
        new Date(now.getTime() + input.durationMs).toISOString()])).rows[0];
    if (inserted === undefined) throw new Error("Support grant was not stored");
    await tx.appendAudit({
      actorChannel: "SYSTEM", action: "support.grant.issue", resourceType: "SupportAccessGrant", resourceId: inserted.id,
      outcome: "SUCCEEDED", metadata: {
        issuedVia: "ADMIN_CLI", caseId, bookingId: supportCase.booking_id, operatorUserId, scope: input.scope,
        ticketReference: input.ticketReference, expiresAt: inserted.expires_at.toISOString(),
      },
      occurredAt: now,
    });
    return toRecord(inserted);
  });
}

/** Revokes a grant immediately; revoking twice is a no-op that still reports the grant. */
export async function revokeSupportAccess(
  pool: SqlPool,
  input: { readonly grantId: string; readonly correlationId: string; readonly now?: Date },
): Promise<SupportGrantRecord> {
  const grantId = requireUuid(input.grantId, "grant");
  const now = input.now ?? new Date();
  return withDomainTransaction(pool, { correlationId: input.correlationId, isolation: "SERIALIZABLE" }, async (tx) => {
    const row = (await tx.sql.query<GrantRow>(
      `UPDATE public.support_access_grants SET revoked_at = COALESCE(revoked_at, $2::timestamptz)
       WHERE id = $1::uuid
       RETURNING id, case_id, booking_id, operator_user_id, scope, valid_from, expires_at, revoked_at`,
      [grantId, now.toISOString()])).rows[0];
    if (row === undefined) throw new SupportAdminError("GRANT_NOT_FOUND", "No such grant");
    await tx.appendAudit({
      actorChannel: "SYSTEM", action: "support.grant.revoke", resourceType: "SupportAccessGrant", resourceId: row.id,
      outcome: "SUCCEEDED", metadata: { issuedVia: "ADMIN_CLI", caseId: row.case_id, operatorUserId: row.operator_user_id },
      occurredAt: now,
    });
    return toRecord(row);
  });
}

/** Lists grants that are active now, optionally for one operator. */
export async function listActiveSupportGrants(pool: SqlPool, operatorUserId?: string, now = new Date()): Promise<readonly SupportGrantRecord[]> {
  const result = await pool.query<GrantRow>(
    `SELECT id, case_id, booking_id, operator_user_id, scope, valid_from, expires_at, revoked_at
     FROM public.support_access_grants
     WHERE revoked_at IS NULL AND valid_from <= $1::timestamptz AND expires_at > $1::timestamptz
       AND ($2::uuid IS NULL OR operator_user_id = $2::uuid)
     ORDER BY expires_at, id LIMIT 500`,
    [now.toISOString(), operatorUserId === undefined ? null : requireUuid(operatorUserId, "operator")]);
  return result.rows.map(toRecord);
}
