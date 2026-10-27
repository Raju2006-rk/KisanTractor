import { withTransaction, type SqlExecutor, type SqlPool } from "@kisantractor/database";
import type { NotificationChannel, NotificationDeliveryState } from "@kisantractor/domain";
import type { CapabilityState } from "@kisantractor/providers";

import {
  NotificationVersionConflictError,
  type NewNotificationRecord,
  type NotificationBookingContext,
  type NotificationDeliveryUpdate,
  type NotificationRecord,
  type NotificationStore,
} from "./notification.contracts.js";

const NOTIFICATION_COLUMNS = `id, dedupe_key, outbox_event_id, recipient_user_id, booking_id, channel, status,
  template_key, template_version, template_locale, related_entity_type, related_entity_id, attempt_count, test_only,
  provider_reference, capability_state, last_error_code, next_attempt_at, version, created_at, updated_at`;

interface NotificationRow extends Record<string, unknown> {
  readonly id: string;
  readonly dedupe_key: string;
  readonly outbox_event_id: string;
  readonly recipient_user_id: string;
  readonly booking_id: string;
  readonly channel: NotificationChannel;
  readonly status: NotificationDeliveryState;
  readonly template_key: string;
  readonly template_version?: number | null;
  readonly template_locale: string;
  readonly related_entity_type: string;
  readonly related_entity_id: string;
  readonly attempt_count: number;
  readonly test_only: boolean;
  readonly provider_reference: string | null;
  readonly capability_state: CapabilityState | null;
  readonly last_error_code: string | null;
  readonly next_attempt_at: Date | null;
  readonly version: number;
  readonly created_at: Date;
  readonly updated_at: Date;
}

const toRecord = (row: NotificationRow): NotificationRecord => Object.freeze({
  id: row.id,
  dedupeKey: row.dedupe_key,
  outboxEventId: row.outbox_event_id,
  recipientUserId: row.recipient_user_id,
  bookingId: row.booking_id,
  channel: row.channel,
  state: row.status,
  templateKey: row.template_key,
  templateLocale: row.template_locale,
  relatedEntityType: row.related_entity_type,
  relatedEntityId: row.related_entity_id,
  attemptCount: Number(row.attempt_count),
  testOnly: row.test_only,
  version: Number(row.version),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  ...(row.template_version === null || row.template_version === undefined ? {} : { templateVersion: Number(row.template_version) }),
  ...(row.provider_reference === null ? {} : { providerReference: row.provider_reference }),
  ...(row.capability_state === null ? {} : { capabilityState: row.capability_state }),
  ...(row.last_error_code === null ? {} : { lastErrorCode: row.last_error_code }),
  ...(row.next_attempt_at === null ? {} : { nextAttemptAt: row.next_attempt_at }),
});

/**
 * Notification persistence. Booking reads are plain SELECTs without row locks;
 * every write targets `notifications` or `notification_delivery_events` only.
 */
export class PostgresNotificationStore implements NotificationStore {
  constructor(private readonly pool: SqlPool) {}

  async loadBookingContext(bookingId: string): Promise<NotificationBookingContext | undefined> {
    const result = await this.pool.query<{
      readonly id: string;
      readonly public_reference: string;
      readonly customer_id: string;
      readonly owner_id: string;
      readonly status?: string;
      readonly owner_contact_sharing_consent?: boolean | null;
    }>(
      `SELECT b.id, b.public_reference, b.customer_id, b.owner_id, b.status::text AS status,
         op.contact_sharing_consent AS owner_contact_sharing_consent
       FROM public.bookings b
       LEFT JOIN public.user_profiles op ON op.user_id = b.owner_id
       WHERE b.id = $1`,
      [bookingId],
    );
    const row = result.rows[0];
    return row === undefined
      ? undefined
      : Object.freeze({
          bookingId: row.id,
          publicReference: row.public_reference,
          customerId: row.customer_id,
          ownerId: row.owner_id,
          ...(typeof row.status === "string" ? { status: row.status } : {}),
          ownerContactSharingConsent: row.owner_contact_sharing_consent === true,
        });
  }

  async preferredLocales(userIds: readonly string[]): Promise<ReadonlyMap<string, string>> {
    if (userIds.length === 0) return new Map();
    const result = await this.pool.query<{ readonly user_id: string; readonly preferred_locale: string }>(
      "SELECT user_id, preferred_locale FROM public.user_profiles WHERE user_id = ANY($1::uuid[])",
      [[...userIds]],
    );
    return new Map(result.rows.map((row) => [row.user_id, row.preferred_locale]));
  }

  ensureNotification(input: NewNotificationRecord): Promise<NotificationRecord> {
    return withTransaction(this.pool, async (tx) => {
      const createdAt = input.createdAt.toISOString();
      const inserted = await tx.query<NotificationRow>(
        `INSERT INTO public.notifications (
           recipient_user_id, booking_id, channel, status, template_key, template_locale,
           related_entity_type, related_entity_id, outbox_event_id, dedupe_key, created_at, updated_at,
           template_version
         ) VALUES ($1, $2, $3::notification_channel, 'PENDING', $4, $5, $6, $7, $8, $9, $10, $10, $11)
         ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
         RETURNING ${NOTIFICATION_COLUMNS}`,
        [input.recipientUserId, input.bookingId, input.channel, input.templateKey, input.templateLocale,
          input.relatedEntityType, input.relatedEntityId, input.outboxEventId, input.dedupeKey, createdAt,
          input.templateVersion ?? null],
      );
      const created = inserted.rows[0];
      if (created !== undefined) {
        await this.#appendDeliveryEvent(tx, created.id, null, "PENDING", undefined, undefined, input.createdAt);
        return toRecord(created);
      }
      const existing = await tx.query<NotificationRow>(
        `SELECT ${NOTIFICATION_COLUMNS} FROM public.notifications WHERE dedupe_key = $1`,
        [input.dedupeKey],
      );
      const row = existing.rows[0];
      if (row === undefined) throw new Error("Notification was neither created nor found");
      return toRecord(row);
    });
  }

  async findNotification(dedupeKey: string): Promise<NotificationRecord | undefined> {
    const row = (await this.pool.query<NotificationRow>(
      `SELECT ${NOTIFICATION_COLUMNS} FROM public.notifications WHERE dedupe_key = $1`,
      [dedupeKey],
    )).rows[0];
    return row === undefined ? undefined : toRecord(row);
  }

  recordDeliveryAttempt(update: NotificationDeliveryUpdate): Promise<NotificationRecord> {
    return withTransaction(this.pool, async (tx) => {
      const result = await tx.query<NotificationRow>(
        `UPDATE public.notifications
            SET status = $3::notification_status, attempt_count = $4,
                provider_reference = COALESCE($5, provider_reference), last_error_code = $6,
                capability_state = $7, test_only = $8, next_attempt_at = $9,
                version = version + 1, updated_at = $10
          WHERE id = $1 AND version = $2
          RETURNING ${NOTIFICATION_COLUMNS}`,
        [update.notificationId, update.expectedVersion, update.toState, update.attemptCount,
          update.providerReference ?? null, update.errorCode ?? null, update.capabilityState ?? null,
          update.testOnly, update.nextAttemptAt?.toISOString() ?? null, update.occurredAt.toISOString()],
      );
      const row = result.rows[0];
      if (row === undefined) throw new NotificationVersionConflictError();
      await this.#appendDeliveryEvent(tx, row.id, update.fromState, update.toState,
        update.providerReference, update.errorCode, update.occurredAt);
      return toRecord(row);
    });
  }

  async listByRelatedEntity(
    relatedEntityType: string,
    relatedEntityId: string,
    limit: number,
  ): Promise<readonly NotificationRecord[]> {
    const result = await this.pool.query<NotificationRow>(
      `SELECT ${NOTIFICATION_COLUMNS} FROM public.notifications
        WHERE related_entity_type = $1 AND related_entity_id = $2 AND dedupe_key IS NOT NULL
        ORDER BY created_at DESC, id DESC
        LIMIT $3`,
      [relatedEntityType, relatedEntityId, limit],
    );
    return Object.freeze(result.rows.map(toRecord));
  }

  async #appendDeliveryEvent(
    tx: SqlExecutor,
    notificationId: string,
    fromState: NotificationDeliveryState | null,
    toState: NotificationDeliveryState,
    providerReference: string | undefined,
    errorCode: string | undefined,
    occurredAt: Date,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO public.notification_delivery_events
         (notification_id, from_status, to_status, provider_reference, error_code, occurred_at)
       VALUES ($1, $2::notification_status, $3::notification_status, $4, $5, $6)`,
      [notificationId, fromState, toState, providerReference ?? null, errorCode ?? null, occurredAt.toISOString()],
    );
  }
}
