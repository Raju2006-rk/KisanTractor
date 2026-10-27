import { timingSafeEqual } from "node:crypto";

import {
  userRoles,
  type AuthPrincipal,
  type UserRole,
} from "@kisantractor/domain";
import {
  withDomainTransaction,
  writeAuditEvent,
  type DomainTransaction,
  type SqlPool,
} from "@kisantractor/database";

import type {
  IdentityStore,
  NewOtpChallenge,
  RefreshInput,
  RefreshResult,
  RequestContext,
  VerifyAndIssueInput,
  VerifyAndIssueResult,
} from "./identity.contracts.js";

interface CountRow extends Record<string, unknown> {
  readonly phone_count: string | number;
  readonly requester_count: string | number;
}

interface ChallengeRow extends Record<string, unknown> {
  readonly phone_lookup_hash: string;
  readonly purpose: string;
  readonly code_hash: string;
  readonly expires_at: Date;
  readonly max_attempts: number;
  readonly attempt_count: number;
  readonly consumed_at: Date | null;
  readonly invalidated_at: Date | null;
}

interface UserRow extends Record<string, unknown> {
  readonly id: string;
  readonly status: string;
}

interface RoleRow extends Record<string, unknown> {
  readonly role_code: string;
}

interface SessionRow extends Record<string, unknown> {
  readonly id: string;
  readonly user_id: string;
  readonly refresh_expires_at: Date;
  readonly revoked_at: Date | null;
  readonly status: string;
}

/**
 * SERIALIZABLE identity transactions abort with 40001 (or 40P01) when concurrent sign-ins touch
 * the same index ranges, and two first-time verifications for one phone can race on the unique
 * phone identity (23505). Each is retried from scratch with a fresh snapshot; a retry re-reads
 * the challenge, session, and user, so it either succeeds or is refused like any stale request.
 */
const MAX_IDENTITY_TRANSACTION_ATTEMPTS = 6;

const databaseErrorCode = (error: unknown): string | undefined => {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" ? code : undefined;
};

const retryPause = (attempt: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 15 * attempt)));

const hashesEqual = (left: string, right: string): boolean => {
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
};

const rolesFromRows = (rows: readonly RoleRow[]): readonly UserRole[] =>
  Object.freeze(
    rows
      .map(({ role_code }) => role_code)
      .filter((role): role is UserRole => userRoles.includes(role as UserRole)),
  );

const appendAuthAudit = async (
  transaction: DomainTransaction,
  action: string,
  resourceId: string,
  context: RequestContext,
  outcome: "SUCCESS" | "REJECTED",
  reasonCode?: string,
  actorId?: string,
): Promise<void> => {
  await transaction.appendAudit({
    ...(actorId === undefined ? {} : { actorId }),
    actorChannel: context.actorChannel,
    action,
    resourceType: action.startsWith("session.") ? "AuthSession" : "OtpChallenge",
    resourceId,
    outcome,
    ...(reasonCode === undefined ? {} : { reasonCode }),
    metadata: { authenticationEvent: true },
  });
};

export class PostgresIdentityStore implements IdentityStore {
  constructor(private readonly pool: SqlPool) {}

  /**
   * Runs one SERIALIZABLE identity transaction, retrying serialization failures. When retries are
   * exhausted the request fails closed with `exhausted` (no code issued, no session granted).
   */
  async #serializable<Result>(
    context: RequestContext,
    work: (transaction: DomainTransaction) => Promise<Result>,
    exhausted: () => Result,
    retryUniqueViolation = false,
  ): Promise<Result> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await withDomainTransaction(
          this.pool,
          { correlationId: context.correlationId, isolation: "SERIALIZABLE" },
          work,
        );
      } catch (error) {
        const code = databaseErrorCode(error);
        const retryable = code === "40001" || code === "40P01" || (retryUniqueViolation && code === "23505");
        if (!retryable) throw error;
        if (attempt >= MAX_IDENTITY_TRANSACTION_ATTEMPTS) return exhausted();
        await retryPause(attempt);
      }
    }
  }

  async auditAuthenticationEvent(
    action: "otp.request" | "otp.verify" | "session.refresh" | "session.revoke",
    reason: string,
    resourceId: string | undefined,
    context: RequestContext,
  ): Promise<void> {
    await writeAuditEvent(this.pool, {
      actorChannel: context.actorChannel,
      action,
      resourceType: action.startsWith("session.") ? "AuthSession" : "OtpChallenge",
      ...(resourceId === undefined ? {} : { resourceId }),
      outcome: "REJECTED",
      reasonCode: reason,
      correlationId: context.correlationId,
      metadata: { authenticationEvent: true },
    });
  }

  async createOtpChallenge(challenge: NewOtpChallenge): Promise<boolean> {
    return this.#serializable(
      challenge.context,
      async (transaction) => {
        const lockKeys = [challenge.phoneLookupHash, challenge.requesterHash].sort();
        for (const key of lockKeys) {
          await transaction.sql.query(
            "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
            [key],
          );
        }

        const counts = await transaction.sql.query<CountRow>(
          `SELECT
             count(*) FILTER (
               WHERE phone_lookup_hash = $1 AND created_at >= $2::timestamptz
             ) AS phone_count,
             count(*) FILTER (
               WHERE requester_hash = $3 AND created_at >= $4::timestamptz
             ) AS requester_count
           FROM public.otp_challenges
           WHERE (phone_lookup_hash = $1 AND created_at >= $2::timestamptz)
              OR (requester_hash = $3 AND created_at >= $4::timestamptz)`,
          [
            challenge.phoneLookupHash,
            challenge.phoneWindowStartsAt.toISOString(),
            challenge.requesterHash,
            challenge.requesterWindowStartsAt.toISOString(),
          ],
        );
        const count = counts.rows[0];
        const throttled =
          Number(count?.phone_count ?? 0) >= challenge.maxPhoneRequests ||
          Number(count?.requester_count ?? 0) >= challenge.maxRequesterRequests;

        if (throttled) {
          await appendAuthAudit(
            transaction,
            "otp.request",
            challenge.id,
            challenge.context,
            "REJECTED",
            "RATE_LIMITED",
          );
          return false;
        }

        await transaction.sql.query(
          `INSERT INTO public.otp_challenges
             (id, phone_lookup_hash, purpose, code_hash, requester_hash,
              expires_at, max_attempts)
           VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7)`,
          [
            challenge.id,
            challenge.phoneLookupHash,
            challenge.purpose,
            challenge.codeHash,
            challenge.requesterHash,
            challenge.expiresAt.toISOString(),
            challenge.maxAttempts,
          ],
        );
        await appendAuthAudit(
          transaction,
          "otp.request",
          challenge.id,
          challenge.context,
          "SUCCESS",
        );
        return true;
      },
      // Fail closed: under persistent contention no code is issued; the response stays generic.
      () => false,
    );
  }

  async invalidateOtpChallenge(
    challengeId: string,
    reason: string,
    context: RequestContext,
  ): Promise<void> {
    await withDomainTransaction(
      this.pool,
      { correlationId: context.correlationId },
      async (transaction) => {
        await transaction.sql.query(
          `UPDATE public.otp_challenges
           SET invalidated_at = CURRENT_TIMESTAMP, invalidation_reason = $2
           WHERE id = $1 AND consumed_at IS NULL AND invalidated_at IS NULL`,
          [challengeId, reason],
        );
        await appendAuthAudit(
          transaction,
          "otp.request",
          challengeId,
          context,
          "REJECTED",
          reason,
        );
      },
    );
  }

  async verifyAndIssueSession(
    input: VerifyAndIssueInput,
  ): Promise<VerifyAndIssueResult> {
    return this.#serializable(
      input.context,
      async (transaction) => {
        const challengeResult = await transaction.sql.query<ChallengeRow>(
          `SELECT phone_lookup_hash, purpose, code_hash, expires_at,
                  max_attempts, attempt_count, consumed_at, invalidated_at
           FROM public.otp_challenges WHERE id = $1 FOR UPDATE`,
          [input.challengeId],
        );
        const challenge = challengeResult.rows[0];
        if (challenge === undefined) {
          await appendAuthAudit(
            transaction,
            "otp.verify",
            input.challengeId,
            input.context,
            "REJECTED",
            "NOT_FOUND",
          );
          return { status: "REJECTED", reason: "NOT_FOUND" };
        }

        const reject = async (
          reason: Exclude<VerifyAndIssueResult, { status: "ISSUED" }>["reason"],
          incrementAttempt: boolean,
        ): Promise<VerifyAndIssueResult> => {
          if (incrementAttempt) {
            const nextAttempts = challenge.attempt_count + 1;
            await transaction.sql.query(
              `UPDATE public.otp_challenges
               SET attempt_count = $2,
                   invalidated_at = CASE WHEN $2 >= max_attempts THEN $3::timestamptz ELSE invalidated_at END,
                   invalidation_reason = CASE WHEN $2 >= max_attempts THEN 'ATTEMPTS_EXHAUSTED' ELSE invalidation_reason END
               WHERE id = $1`,
              [input.challengeId, nextAttempts, input.now.toISOString()],
            );
          } else if (reason === "EXPIRED") {
            await transaction.sql.query(
              `UPDATE public.otp_challenges
               SET invalidated_at = $2::timestamptz, invalidation_reason = 'EXPIRED'
               WHERE id = $1 AND invalidated_at IS NULL`,
              [input.challengeId, input.now.toISOString()],
            );
          }
          await appendAuthAudit(
            transaction,
            "otp.verify",
            input.challengeId,
            input.context,
            "REJECTED",
            reason,
          );
          return { status: "REJECTED", reason };
        };

        if (challenge.consumed_at !== null || challenge.invalidated_at !== null) {
          return reject("CONSUMED", false);
        }
        if (challenge.expires_at.getTime() <= input.now.getTime()) {
          return reject("EXPIRED", false);
        }
        if (challenge.attempt_count >= challenge.max_attempts) {
          return reject("ATTEMPTS_EXHAUSTED", false);
        }
        if (
          !hashesEqual(challenge.phone_lookup_hash, input.phoneLookupHash) ||
          challenge.purpose !== input.purpose
        ) {
          return reject("BINDING_MISMATCH", true);
        }
        if (!hashesEqual(challenge.code_hash, input.submittedCodeHash)) {
          return reject("INVALID_CODE", true);
        }

        await transaction.sql.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          [input.phoneLookupHash],
        );
        const users = await transaction.sql.query<UserRow>(
          `SELECT id, status FROM public.users
           WHERE phone_lookup_hash = $1 AND deleted_at IS NULL
           ORDER BY created_at ASC LIMIT 1 FOR UPDATE`,
          [input.phoneLookupHash],
        );
        let user = users.rows[0];

        if (user === undefined && input.roleToGrant === undefined) {
          await transaction.sql.query(
            "UPDATE public.otp_challenges SET consumed_at = $2::timestamptz WHERE id = $1",
            [input.challengeId, input.now.toISOString()],
          );
          return reject("ACCOUNT_NOT_FOUND", false);
        }
        if (user === undefined) {
          const inserted = await transaction.sql.query<UserRow>(
            `INSERT INTO public.users
               (normalized_phone_ciphertext, phone_lookup_hash)
             VALUES ($1, $2)
             RETURNING id, status`,
            [Buffer.from(input.phoneCiphertext), input.phoneLookupHash],
          );
          user = inserted.rows[0];
          if (user === undefined) throw new Error("User was not created");
        }
        if (user.status !== "ACTIVE") {
          return reject("ACCOUNT_INACTIVE", false);
        }

        if (input.roleToGrant !== undefined) {
          await transaction.sql.query(
            `INSERT INTO public.user_role_memberships (user_id, role_code)
             VALUES ($1, $2)
             ON CONFLICT (user_id, role_code) WHERE revoked_at IS NULL DO NOTHING`,
            [user.id, input.roleToGrant],
          );
        }
        const roleResult = await transaction.sql.query<RoleRow>(
          `SELECT role_code FROM public.user_role_memberships
           WHERE user_id = $1 AND revoked_at IS NULL
           ORDER BY role_code`,
          [user.id],
        );

        await transaction.sql.query(
          `INSERT INTO public.auth_sessions
             (id, user_id, access_token_hash, refresh_token_hash,
              access_expires_at, refresh_expires_at)
           VALUES ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz)`,
          [
            input.session.id,
            user.id,
            input.session.accessTokenHash,
            input.session.refreshTokenHash,
            input.session.accessExpiresAt.toISOString(),
            input.session.refreshExpiresAt.toISOString(),
          ],
        );
        await transaction.sql.query(
          "UPDATE public.otp_challenges SET consumed_at = $2::timestamptz WHERE id = $1",
          [input.challengeId, input.now.toISOString()],
        );
        await appendAuthAudit(
          transaction,
          "otp.verify",
          input.challengeId,
          input.context,
          "SUCCESS",
          undefined,
          user.id,
        );
        return {
          status: "ISSUED",
          principal: {
            userId: user.id,
            sessionId: input.session.id,
            roles: rolesFromRows(roleResult.rows),
          },
        };
      },
      // Persistent contention is almost always a concurrent replay of the same challenge.
      (): VerifyAndIssueResult => ({ status: "REJECTED", reason: "CONSUMED" }),
      true,
    );
  }

  async refreshSession(input: RefreshInput): Promise<RefreshResult> {
    return this.#serializable(
      input.context,
      async (transaction) => {
        const sessions = await transaction.sql.query<SessionRow>(
          `SELECT s.id, s.user_id, s.refresh_expires_at, s.revoked_at, u.status
           FROM public.auth_sessions s
           JOIN public.users u ON u.id = s.user_id
           WHERE s.refresh_token_hash = $1
           FOR UPDATE OF s`,
          [input.refreshTokenHash],
        );
        const current = sessions.rows[0];
        if (
          current === undefined ||
          current.revoked_at !== null ||
          current.refresh_expires_at.getTime() <= input.now.getTime() ||
          current.status !== "ACTIVE"
        ) {
          await appendAuthAudit(
            transaction,
            "session.refresh",
            input.replacement.id,
            input.context,
            "REJECTED",
            "INVALID_REFRESH_CREDENTIAL",
          );
          return { status: "REJECTED" };
        }

        await transaction.sql.query(
          `UPDATE public.auth_sessions
           SET revoked_at = $2::timestamptz, revocation_reason = 'ROTATED',
               last_refreshed_at = $2::timestamptz
           WHERE id = $1`,
          [current.id, input.now.toISOString()],
        );
        await transaction.sql.query(
          `INSERT INTO public.auth_sessions
             (id, user_id, access_token_hash, refresh_token_hash,
              access_expires_at, refresh_expires_at, rotated_from_session_id)
           VALUES ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz, $7)`,
          [
            input.replacement.id,
            current.user_id,
            input.replacement.accessTokenHash,
            input.replacement.refreshTokenHash,
            input.replacement.accessExpiresAt.toISOString(),
            input.replacement.refreshExpiresAt.toISOString(),
            current.id,
          ],
        );
        const roleResult = await transaction.sql.query<RoleRow>(
          `SELECT role_code FROM public.user_role_memberships
           WHERE user_id = $1 AND revoked_at IS NULL ORDER BY role_code`,
          [current.user_id],
        );
        await appendAuthAudit(
          transaction,
          "session.refresh",
          input.replacement.id,
          input.context,
          "SUCCESS",
          undefined,
          current.user_id,
        );
        return {
          status: "ROTATED",
          principal: {
            userId: current.user_id,
            sessionId: input.replacement.id,
            roles: rolesFromRows(roleResult.rows),
          },
        };
      },
      (): RefreshResult => ({ status: "REJECTED" }),
    );
  }

  async revokeSession(
    sessionId: string,
    userId: string,
    reason: string,
    now: Date,
    context: RequestContext,
  ): Promise<boolean> {
    return withDomainTransaction(
      this.pool,
      { correlationId: context.correlationId },
      async (transaction) => {
        const result = await transaction.sql.query<{ readonly id: string }>(
          `UPDATE public.auth_sessions
           SET revoked_at = $3::timestamptz, revocation_reason = $4
           WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
           RETURNING id`,
          [sessionId, userId, now.toISOString(), reason],
        );
        const revoked = result.rowCount === 1;
        await appendAuthAudit(
          transaction,
          "session.revoke",
          sessionId,
          context,
          revoked ? "SUCCESS" : "REJECTED",
          revoked ? undefined : "SESSION_NOT_FOUND",
          userId,
        );
        return revoked;
      },
    );
  }

  async authenticateAccessToken(
    accessTokenHash: string,
    now: Date,
  ): Promise<AuthPrincipal | undefined> {
    const sessions = await this.pool.query<SessionRow>(
      `SELECT s.id, s.user_id, s.refresh_expires_at, s.revoked_at, u.status
       FROM public.auth_sessions s
       JOIN public.users u ON u.id = s.user_id
       WHERE s.access_token_hash = $1
         AND s.revoked_at IS NULL
         AND s.access_expires_at > $2::timestamptz
         AND u.status = 'ACTIVE'`,
      [accessTokenHash, now.toISOString()],
    );
    const session = sessions.rows[0];
    if (session === undefined) return undefined;

    const roleResult = await this.pool.query<RoleRow>(
      `SELECT role_code FROM public.user_role_memberships
       WHERE user_id = $1 AND revoked_at IS NULL ORDER BY role_code`,
      [session.user_id],
    );
    return {
      userId: session.user_id,
      sessionId: session.id,
      roles: rolesFromRows(roleResult.rows),
    };
  }
}
