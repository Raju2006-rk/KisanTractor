import { withDomainTransaction, type DomainTransaction, type SqlPool } from "@kisantractor/database";

import {
  ERASED_PROFILE_NAME,
  REDACTED_RECIPIENT_NAME,
  type AccountErasureRequest,
  type AccountErasureResult,
  type AccountErasureStore,
} from "./account-deletion.contracts.js";

const MAX_ATTEMPTS = 5;

interface UserRow extends Record<string, unknown> {
  readonly status: string;
  readonly deleted_at: Date | null;
  readonly phone_lookup_hash: string;
}

interface CountRow extends Record<string, unknown> {
  readonly count: string;
}

interface PrivateObjectRow extends Record<string, unknown> {
  readonly kind: "DOCUMENT" | "TRACTOR_PHOTO";
  readonly stored_key: string;
}

const databaseErrorCode = (error: unknown): string | undefined => {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" ? code : undefined;
};

const count = async (transaction: DomainTransaction, text: string, values: readonly unknown[]): Promise<number> =>
  Number((await transaction.sql.query<CountRow>(text, values)).rows[0]?.count ?? 0);

/**
 * Erases one account in a single SERIALIZABLE transaction, so a concurrent booking for this user
 * either commits first (and blocks the deletion) or is refused after it. Removal and
 * anonymization follow ops/runbooks/account-deletion.md; financial and audit rows are never
 * updated or deleted.
 */
export class PostgresAccountDeletionStore implements AccountErasureStore {
  constructor(private readonly pool: SqlPool) {}

  async eraseAccount(request: AccountErasureRequest): Promise<AccountErasureResult> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await withDomainTransaction(
          this.pool,
          { correlationId: request.correlationId, isolation: "SERIALIZABLE" },
          (transaction) => this.#erase(transaction, request),
        );
      } catch (error) {
        const code = databaseErrorCode(error);
        if ((code !== "40001" && code !== "40P01") || attempt >= MAX_ATTEMPTS) throw error;
        await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 20 * attempt)));
      }
    }
  }

  async #erase(transaction: DomainTransaction, request: AccountErasureRequest): Promise<AccountErasureResult> {
    const { sql } = transaction;
    const userId = request.userId;
    const user = (await sql.query<UserRow>(
      "SELECT status, deleted_at, phone_lookup_hash FROM public.users WHERE id = $1 FOR UPDATE",
      [userId],
    )).rows[0];
    const audit = (outcome: "SUCCESS" | "REJECTED", reasonCode?: string, metadata: Record<string, unknown> = {}) =>
      transaction.appendAudit({
        // audit_events.actor_id references users; an unknown id is recorded as the resource only.
        ...(user === undefined ? {} : { actorId: userId }),
        actorChannel: request.actorChannel,
        action: "account.delete",
        resourceType: "User",
        resourceId: userId,
        outcome,
        ...(reasonCode === undefined ? {} : { reasonCode }),
        metadata,
      });

    if (user === undefined || user.status !== "ACTIVE" || user.deleted_at !== null) {
      await audit("REJECTED", "ACCOUNT_NOT_ACTIVE");
      return { status: "REFUSED", reason: "ACCOUNT_NOT_ACTIVE" };
    }
    const openBookings = await count(transaction,
      `SELECT count(*)::text AS count FROM public.bookings
       WHERE (customer_id = $1 OR owner_id = $1) AND NOT (status::text = ANY($2::text[]))`,
      [userId, request.closedBookingStatuses]);
    if (openBookings > 0) {
      await audit("REJECTED", "OPEN_BOOKINGS", { openBookings });
      return { status: "REFUSED", reason: "OPEN_BOOKINGS", openBookings };
    }

    // Permits the one redaction the booking_recipients guard allows (migration 0017).
    await sql.query("SELECT set_config('app.account_erasure', 'on', true)");

    const sessionsRevoked = (await sql.query(
      `UPDATE public.auth_sessions SET revoked_at = CURRENT_TIMESTAMP, revocation_reason = 'ACCOUNT_DELETED'
       WHERE user_id = $1 AND revoked_at IS NULL`, [userId])).rowCount;
    const rolesRevoked = (await sql.query(
      `UPDATE public.user_role_memberships SET revoked_at = GREATEST(CURRENT_TIMESTAMP, granted_at), version = version + 1
       WHERE user_id = $1 AND revoked_at IS NULL`, [userId])).rowCount;
    const otpChallengesDeleted = (await sql.query(
      "DELETE FROM public.otp_challenges WHERE phone_lookup_hash = $1", [user.phone_lookup_hash])).rowCount;

    const profileAnonymized = (await sql.query(
      `UPDATE public.user_profiles
       SET full_name = $2, contact_sharing_consent = false, default_location_id = NULL,
           version = version + 1, updated_at = CURRENT_TIMESTAMP
       WHERE user_id = $1`, [userId, ERASED_PROFILE_NAME])).rowCount > 0;

    // Private files: the rows go now; the stored object references are handed to the outbox so a
    // storage purge can delete the bytes (no purge consumer exists yet; see the runbook).
    const privateObjects = (await sql.query<PrivateObjectRow>(
      `WITH deleted_documents AS (
         DELETE FROM public.documents WHERE owner_id = $1 RETURNING object_key
       ), deleted_photos AS (
         DELETE FROM public.tractor_photos p USING public.tractors t
         WHERE p.tractor_id = t.id AND t.owner_id = $1
         RETURNING encode(p.object_key_ciphertext, 'base64') AS stored_key
       )
       SELECT 'DOCUMENT' AS kind, object_key AS stored_key FROM deleted_documents
       UNION ALL SELECT 'TRACTOR_PHOTO' AS kind, stored_key FROM deleted_photos`, [userId])).rows;

    // Tractors stay (bookings reference them) but leave discovery and lose the registration number.
    const tractorsWithdrawn = (await sql.query(
      `UPDATE public.tractors
       SET operational_status = 'OFFLINE', eligibility_status = 'INELIGIBLE',
           registration_number_ciphertext = '\\x'::bytea, registration_lookup_hash = 'erased:' || id::text,
           version = version + 1, updated_at = CURRENT_TIMESTAMP
       WHERE owner_id = $1`, [userId])).rowCount;
    await sql.query(
      `WITH changed AS (
         UPDATE public.tractor_availability ta
         SET operational_status = 'OFFLINE', reason = 'ACCOUNT_DELETED', effective_at = CURRENT_TIMESTAMP,
             changed_by_user_id = $1, version = ta.version + 1, updated_at = CURRENT_TIMESTAMP
         FROM public.tractors t
         WHERE t.id = ta.tractor_id AND t.owner_id = $1 AND ta.operational_status = 'ONLINE'
         RETURNING ta.tractor_id
       )
       INSERT INTO public.tractor_availability_history (tractor_id, from_status, to_status, reason, actor_id, actor_channel)
       SELECT tractor_id, 'ONLINE', 'OFFLINE', 'ACCOUNT_DELETED', $1, $2::actor_channel FROM changed`,
      [userId, request.actorChannel]);
    await sql.query(
      `UPDATE public.service_offerings so SET enabled = false, version = so.version + 1, updated_at = CURRENT_TIMESTAMP
       FROM public.tractors t WHERE so.tractor_id = t.id AND t.owner_id = $1 AND so.enabled`, [userId]);
    await sql.query(
      `UPDATE public.equipment SET availability_status = 'UNAVAILABLE', version = version + 1, updated_at = CURRENT_TIMESTAMP
       WHERE owner_id = $1 AND availability_status <> 'UNAVAILABLE'`, [userId]);

    // Locations: delete those nothing references; keep only the administrative area of the rest.
    const locationsDeleted = (await sql.query(
      `DELETE FROM public.locations l
       WHERE l.owner_user_id = $1
         AND NOT EXISTS (SELECT 1 FROM public.owner_profiles op WHERE op.operating_location_id = l.id)
         AND NOT EXISTS (SELECT 1 FROM public.tractors t WHERE t.current_location_id = l.id)
         AND NOT EXISTS (SELECT 1 FROM public.user_profiles up WHERE up.default_location_id = l.id)`, [userId])).rowCount;
    const locationsCoarsened = (await sql.query(
      `UPDATE public.locations
       SET coordinates = NULL, accuracy_meters = NULL, postal_code = NULL, landmark = NULL,
           source = 'MANUAL_ADDRESS', location_consent_at = NULL, version = version + 1, updated_at = CURRENT_TIMESTAMP
       WHERE owner_user_id = $1
          OR id IN (SELECT operating_location_id FROM public.owner_profiles WHERE user_id = $1)
          OR id IN (SELECT current_location_id FROM public.tractors WHERE owner_id = $1)`, [userId])).rowCount;

    const recipientSnapshotsRedacted = (await sql.query(
      `UPDATE public.booking_recipients br
       SET name = $2, phone_ciphertext = NULL, phone_lookup_hash = NULL, landmark_or_directions = NULL
       FROM public.bookings b
       WHERE b.id = br.booking_id AND b.customer_id = $1
         AND (br.name <> $2 OR br.phone_ciphertext IS NOT NULL OR br.phone_lookup_hash IS NOT NULL
              OR br.landmark_or_directions IS NOT NULL)`, [userId, REDACTED_RECIPIENT_NAME])).rowCount;
    const ivrSessionsRedacted = (await sql.query(
      `UPDATE public.ivr_sessions
       SET caller_phone_ciphertext = '\\x'::bytea, caller_phone_lookup_hash = 'erased:' || id::text,
           version = version + 1, updated_at = CURRENT_TIMESTAMP
       WHERE verified_user_id = $1 OR caller_phone_lookup_hash = $2`, [userId, user.phone_lookup_hash])).rowCount;
    // Replay records can hold response bodies; the account can no longer replay a request.
    const idempotencyRecordsDeleted = (await sql.query(
      "DELETE FROM public.idempotency_records WHERE strpos(actor_scope, $1) > 0", [userId])).rowCount;
    // Push registration tokens identify the person's devices; an erased account gets no pushes.
    const pushDevicesDeleted = (await sql.query(
      "DELETE FROM public.push_device_registrations WHERE user_id = $1", [userId])).rowCount;
    // Dispute cases and their timelines are financial and audit records and stay. Only the free
    // text this person wrote is erased; codes, evidence ids, and outcomes remain (migration 0021).
    const disputeStatementsRedacted = (await sql.query(
      `UPDATE public.support_case_entries SET statement_text = NULL, statement_redacted_at = CURRENT_TIMESTAMP
       WHERE author_user_id = $1 AND statement_text IS NOT NULL`, [userId])).rowCount;
    // A deleted support operator keeps no access.
    const supportGrantsRevoked = (await sql.query(
      `UPDATE public.support_access_grants SET revoked_at = GREATEST(CURRENT_TIMESTAMP, valid_from)
       WHERE operator_user_id = $1 AND revoked_at IS NULL`, [userId])).rowCount;

    // The phone is erased, and the lookup hash replaced with a per-row tombstone, so the number can
    // register a new account and the old row can no longer be linked to it.
    const erased = (await sql.query<{ deleted_at: Date }>(
      `UPDATE public.users
       SET status = 'DELETED', deleted_at = CURRENT_TIMESTAMP, normalized_phone_ciphertext = '\\x'::bytea,
           phone_lookup_hash = 'erased:' || id::text, version = version + 1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 RETURNING deleted_at`, [userId])).rows[0];
    if (erased === undefined) throw new Error("User row disappeared during erasure");

    const retained = {
      bookings: await count(transaction,
        "SELECT count(*)::text AS count FROM public.bookings WHERE customer_id = $1 OR owner_id = $1", [userId]),
      invoices: await count(transaction,
        `SELECT count(*)::text AS count FROM public.invoices i JOIN public.bookings b ON b.id = i.booking_id
         WHERE b.customer_id = $1 OR b.owner_id = $1`, [userId]),
      payments: await count(transaction,
        `SELECT count(*)::text AS count FROM public.payments p JOIN public.invoices i ON i.id = p.invoice_id
         JOIN public.bookings b ON b.id = i.booking_id WHERE b.customer_id = $1 OR b.owner_id = $1`, [userId]),
      auditEvents: await count(transaction, "SELECT count(*)::text AS count FROM public.audit_events WHERE actor_id = $1", [userId]),
      disputeCases: await count(transaction,
        `SELECT count(*)::text AS count FROM public.support_cases c JOIN public.bookings b ON b.id = c.booking_id
         WHERE b.customer_id = $1 OR b.owner_id = $1`, [userId]),
    };
    const summary = {
      sessionsRevoked, rolesRevoked, profileAnonymized, locationsDeleted, locationsCoarsened,
      privateFilesDeleted: privateObjects.filter(({ kind }) => kind === "DOCUMENT").length,
      tractorPhotosDeleted: privateObjects.filter(({ kind }) => kind === "TRACTOR_PHOTO").length,
      tractorsWithdrawn, recipientSnapshotsRedacted, otpChallengesDeleted, idempotencyRecordsDeleted, ivrSessionsRedacted,
      pushDevicesDeleted, disputeStatementsRedacted, supportGrantsRevoked,
    };

    await transaction.appendOutbox({
      aggregateType: "User",
      aggregateId: userId,
      eventType: "AccountErased",
      eventVersion: 1,
      payload: {
        userId,
        erasedAt: erased.deleted_at.toISOString(),
        privateObjects: privateObjects.map(({ kind, stored_key }) => ({ kind, storedKey: stored_key })),
      },
    });
    await audit("SUCCESS", undefined, { ...summary, retainedBookings: retained.bookings, retainedInvoices: retained.invoices });
    return { status: "ERASED", userId, erasedAt: erased.deleted_at, erased: summary, retained };
  }
}
