import type { NotificationChannel, NotificationDeliveryState } from "@kisantractor/domain";
import type { CapabilityState } from "@kisantractor/providers";

/** Read-only booking facts a notification needs; loaded after the domain commit. */
export interface NotificationBookingContext {
  readonly bookingId: string;
  readonly publicReference: string;
  readonly customerId: string;
  readonly ownerId: string;
  /** Current status, read at send time for the contact-sharing policy. */
  readonly status?: string;
  /** The Owner's current contact-sharing consent. */
  readonly ownerContactSharingConsent?: boolean;
}

export interface NewNotificationRecord {
  readonly dedupeKey: string;
  readonly outboxEventId: string;
  readonly recipientUserId: string;
  readonly bookingId: string;
  readonly channel: NotificationChannel;
  readonly templateKey: string;
  readonly templateVersion?: number;
  readonly templateLocale: string;
  readonly relatedEntityType: string;
  readonly relatedEntityId: string;
  readonly createdAt: Date;
}

/**
 * A generated notification: channel, delivery state, template locale, and
 * related entity. It never stores the rendered body or a contact address.
 */
export interface NotificationRecord {
  readonly id: string;
  readonly dedupeKey: string;
  readonly outboxEventId: string;
  readonly recipientUserId: string;
  readonly bookingId: string;
  readonly channel: NotificationChannel;
  readonly state: NotificationDeliveryState;
  readonly templateKey: string;
  /** Absent on rows written before migration 0020. */
  readonly templateVersion?: number;
  readonly templateLocale: string;
  readonly relatedEntityType: string;
  readonly relatedEntityId: string;
  readonly attemptCount: number;
  readonly testOnly: boolean;
  readonly providerReference?: string;
  readonly capabilityState?: CapabilityState;
  readonly lastErrorCode?: string;
  readonly nextAttemptAt?: Date;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface NotificationDeliveryUpdate {
  readonly notificationId: string;
  readonly expectedVersion: number;
  readonly fromState: NotificationDeliveryState;
  readonly toState: NotificationDeliveryState;
  readonly attemptCount: number;
  readonly testOnly: boolean;
  readonly providerReference?: string;
  readonly errorCode?: string;
  readonly capabilityState?: CapabilityState;
  readonly nextAttemptAt?: Date;
  readonly occurredAt: Date;
}

/** Persistence for notification records. It never writes domain tables. */
export interface NotificationStore {
  loadBookingContext(bookingId: string): Promise<NotificationBookingContext | undefined>;
  preferredLocales(userIds: readonly string[]): Promise<ReadonlyMap<string, string>>;
  /** Creates the record once per dedupe key and returns the existing one afterwards. */
  ensureNotification(input: NewNotificationRecord): Promise<NotificationRecord>;
  /** The record for a dedupe key, if one was created; never creates one. */
  findNotification(dedupeKey: string): Promise<NotificationRecord | undefined>;
  recordDeliveryAttempt(update: NotificationDeliveryUpdate): Promise<NotificationRecord>;
  listByRelatedEntity(
    relatedEntityType: string,
    relatedEntityId: string,
    limit: number,
  ): Promise<readonly NotificationRecord[]>;
}

/** Client-safe delivery status. `claimsDelivery` is true only for real, non-sandbox sends. */
export interface NotificationDeliveryStatus {
  readonly notificationId: string;
  readonly recipientUserId: string;
  readonly channel: NotificationChannel;
  readonly state: NotificationDeliveryState;
  readonly templateKey: string;
  readonly templateVersion?: number;
  readonly templateLocale: string;
  readonly relatedEntityType: string;
  readonly relatedEntityId: string;
  readonly testOnly: boolean;
  readonly claimsDelivery: boolean;
  readonly retrying: boolean;
  readonly attemptCount: number;
  readonly nextAttemptAt?: Date;
  readonly lastErrorCode?: string;
  readonly updatedAt: Date;
}

export class NotificationVersionConflictError extends Error {
  readonly code = "NOTIFICATION_VERSION_CONFLICT";

  constructor() {
    super("Notification changed while its delivery attempt was being recorded");
    this.name = "NotificationVersionConflictError";
  }
}
