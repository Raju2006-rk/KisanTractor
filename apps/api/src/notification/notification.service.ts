import type { ClaimedOutboxEvent } from "@kisantractor/database";
import type { NotificationChannel, NotificationDeliveryState } from "@kisantractor/domain";
import {
  canShareOwnerContact,
  claimsRealDelivery,
  isNotificationDispatchSettled,
  nextNotificationDeliveryState,
} from "@kisantractor/domain";
import { noopIndicators, type NotificationDeliveryOutcome, type OperationalIndicators } from "@kisantractor/observability";
import {
  CAPABILITY_DEGRADED_CODE,
  type CapabilityGatedNotificationDispatcher,
  type CapabilityState,
  type NotificationDispatchResult,
} from "@kisantractor/providers";

import {
  NonRetryableOutboxError,
  OutboxDeferredError,
  type OutboxEventHandler,
  type OutboxHandlerContext,
} from "../outbox/outbox-worker.js";
import type { OwnerContactDirectory } from "./messaging-directory.js";
import type {
  NotificationBookingContext,
  NotificationDeliveryStatus,
  NotificationRecord,
  NotificationStore,
} from "./notification.contracts.js";
import {
  defaultNotificationRules,
  type NotificationAudience,
  type NotificationRelatedEntity,
  type NotificationRule,
} from "./notification-rules.js";
import {
  contactTemplateKeys,
  NotificationTemplateRenderer,
  type NotificationTemplateKey,
  type NotificationTemplateVariables,
} from "./notification-templates.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** Thrown so the outbox reschedules the event while a delivery is still retryable. */
export class NotificationDeliveryRetryError extends Error {
  readonly code = "NOTIFICATION_DELIVERY_RETRY";
  readonly retryable = true;

  constructor() {
    super("At least one notification delivery will be retried");
    this.name = "NotificationDeliveryRetryError";
  }
}

/** Consent-aware Owner contact sharing (Requirement 3.4); off unless explicitly enabled. */
export interface OwnerContactSharingOptions {
  readonly enabled: boolean;
  readonly directory: OwnerContactDirectory;
}

/** One recorded delivery attempt: identifiers and codes only, never recipients or bodies. */
export type NotificationDeliveryLogEntry = Readonly<{
  event: "notification.delivery.recorded";
  notificationId: string;
  outboxEventId: string;
  eventType: string;
  channel: NotificationChannel;
  provider: string;
  state: NotificationDeliveryState;
  attempt: number;
  templateKey: string;
  templateVersion: number;
  templateLocale: string;
  testOnly: boolean;
  capabilityState?: CapabilityState;
  errorCode?: string;
}>;

export type NotificationDeliveryLogger = (entry: NotificationDeliveryLogEntry) => void;

export interface NotificationOutboxHandlerOptions {
  readonly rules?: Readonly<Record<string, readonly NotificationRule[]>>;
  /** Channels generated per recipient. Defaults to SMS. */
  readonly channels?: readonly NotificationChannel[];
  readonly renderer?: NotificationTemplateRenderer;
  readonly now?: () => Date;
  readonly indicators?: OperationalIndicators;
  readonly logger?: NotificationDeliveryLogger;
  readonly ownerContactSharing?: OwnerContactSharingOptions;
}

interface NotificationIntent {
  readonly recipientUserId: string;
  readonly templateKey: NotificationTemplateKey;
  readonly channel: NotificationChannel;
  readonly relatedEntity: NotificationRelatedEntity;
  readonly relatedEntityId: string;
  /** True for an Owner-contact intent the sharing policy no longer allows. */
  readonly conditional: boolean;
}

interface DeliveryResult {
  readonly state: NotificationDeliveryState;
  /** True when the attempt failed only because the capability is DEGRADED. */
  readonly degraded: boolean;
}

const recipientFor = (booking: NotificationBookingContext, audience: NotificationAudience): string =>
  audience === "CUSTOMER" ? booking.customerId : booking.ownerId;

const recordedOutcome = (state: NotificationDeliveryState): NotificationDeliveryOutcome | undefined =>
  state === "PENDING" || state === "PROCESSING" ? undefined : state;

/**
 * Outbox subscriber that turns committed domain events into notification
 * records and delivers them through capability-gated channels. It reads booking
 * facts but writes only notification tables, so delivery success or failure
 * never changes domain state.
 *
 * Recovery: a DEGRADED capability contacts no provider; the record stays FAILED
 * (never dead-lettered for the outage) and the event is deferred without using
 * its retry budget. After roll-forward the next attempt sends it once: records
 * are unique per event, template, channel, and recipient, and settled records
 * are never dispatched again.
 */
export class NotificationOutboxHandler implements OutboxEventHandler {
  readonly name = "notifications";
  readonly #rules: Readonly<Record<string, readonly NotificationRule[]>>;
  readonly #channels: readonly NotificationChannel[];
  readonly #renderer: NotificationTemplateRenderer;
  readonly #now: () => Date;
  readonly #indicators: OperationalIndicators;
  readonly #log: NotificationDeliveryLogger;
  readonly #contactSharing: OwnerContactSharingOptions | undefined;

  constructor(
    private readonly store: NotificationStore,
    private readonly dispatcher: CapabilityGatedNotificationDispatcher,
    options: NotificationOutboxHandlerOptions = {},
  ) {
    this.#rules = options.rules ?? defaultNotificationRules;
    this.#channels = Object.freeze([...new Set<NotificationChannel>(options.channels ?? ["SMS"])]);
    if (this.#channels.length === 0) throw new TypeError("At least one notification channel is required");
    this.#renderer = options.renderer ?? new NotificationTemplateRenderer();
    this.#now = options.now ?? (() => new Date());
    this.#indicators = options.indicators ?? noopIndicators;
    this.#log = options.logger ?? (() => undefined);
    this.#contactSharing = options.ownerContactSharing;
  }

  handles(eventType: string): boolean {
    return (this.#rules[eventType]?.length ?? 0) > 0;
  }

  async handle(event: ClaimedOutboxEvent, context: OutboxHandlerContext): Promise<void> {
    const rules = this.#rules[event.eventType] ?? [];
    if (rules.length === 0) return;

    const bookingId = event.payload["bookingId"];
    if (typeof bookingId !== "string" || !UUID.test(bookingId)) {
      throw new NonRetryableOutboxError("INVALID_NOTIFICATION_PAYLOAD");
    }
    const booking = await this.store.loadBookingContext(bookingId);
    if (booking === undefined) throw new NonRetryableOutboxError("RELATED_ENTITY_NOT_FOUND");

    const dedupeKey = (intent: NotificationIntent): string =>
      `${event.id}:${intent.templateKey}:${intent.channel}:${intent.recipientUserId}`;
    const intents: NotificationIntent[] = [];
    for (const intent of this.#intents(rules, booking, event)) {
      // A contact message that is no longer shareable is never created; one created earlier is
      // still settled (as NOT_SENT) so it does not stay "retrying" forever.
      if (intent.conditional && await this.store.findNotification(dedupeKey(intent)) === undefined) continue;
      intents.push(intent);
    }
    const locales = await this.store.preferredLocales([...new Set(intents.map((intent) => intent.recipientUserId))]);
    const results: DeliveryResult[] = [];

    for (const intent of intents) {
      const record = await this.store.ensureNotification({
        dedupeKey: dedupeKey(intent),
        outboxEventId: event.id,
        recipientUserId: intent.recipientUserId,
        bookingId: booking.bookingId,
        channel: intent.channel,
        templateKey: intent.templateKey,
        templateVersion: this.#renderer.version(intent.templateKey),
        templateLocale: this.#renderer.templateLocale(intent.templateKey, locales.get(intent.recipientUserId)),
        relatedEntityType: intent.relatedEntity,
        relatedEntityId: intent.relatedEntityId,
        createdAt: this.#now(),
      });
      results.push(await this.#deliver(record, intent, booking, event, context));
    }

    const failed = results.filter((result) => result.state === "FAILED");
    if (failed.length > 0) {
      // Nothing was attempted for an unavailable capability: wait without spending retries.
      if (failed.every((result) => result.degraded)) throw new OutboxDeferredError(CAPABILITY_DEGRADED_CODE);
      throw new NotificationDeliveryRetryError();
    }
    if (results.some((result) => result.state === "DEAD_LETTER")) throw new NonRetryableOutboxError("NOTIFICATION_DEAD_LETTERED");
  }

  #contactShareable(booking: NotificationBookingContext): boolean {
    return canShareOwnerContact({
      viewerRole: "FARMER",
      ownerConsented: booking.ownerContactSharingConsent === true,
      bookingStatus: booking.status,
      sharingEnabled: this.#contactSharing?.enabled === true,
    });
  }

  #intents(
    rules: readonly NotificationRule[],
    booking: NotificationBookingContext,
    event: ClaimedOutboxEvent,
  ): readonly NotificationIntent[] {
    const seen = new Set<string>();
    const intents: NotificationIntent[] = [];
    for (const rule of rules) {
      const conditional = rule.requires === "OWNER_CONTACT" && !this.#contactShareable(booking);
      const relatedEntity = rule.relatedEntity ?? "Booking";
      const relatedEntityId = relatedEntity === "Payment" ? event.payload["paymentId"] : booking.bookingId;
      if (typeof relatedEntityId !== "string" || !UUID.test(relatedEntityId)) {
        throw new NonRetryableOutboxError("INVALID_NOTIFICATION_PAYLOAD");
      }
      const contact = contactTemplateKeys.has(rule.templateKey);
      for (const audience of rule.audience) {
        // A phone number goes only to the booking's Farmer, and only by SMS.
        if (contact && audience !== "CUSTOMER") continue;
        const recipientUserId = recipientFor(booking, audience);
        for (const channel of this.#channels) {
          if (rule.channels !== undefined && !rule.channels.includes(channel)) continue;
          if (contact && channel !== "SMS") continue;
          const key = `${rule.templateKey}:${channel}:${recipientUserId}`;
          if (seen.has(key)) continue;
          seen.add(key);
          intents.push({ recipientUserId, templateKey: rule.templateKey, channel, relatedEntity, relatedEntityId, conditional });
        }
      }
    }
    return intents;
  }

  /** Template variables for this send, or a not-sent reason when sharing no longer applies. */
  async #variables(
    intent: NotificationIntent,
    booking: NotificationBookingContext,
  ): Promise<NotificationTemplateVariables | { readonly notSent: string }> {
    if (!contactTemplateKeys.has(intent.templateKey)) return { reference: booking.publicReference };
    // Consent or booking state may have changed since the event was committed.
    if (!this.#contactShareable(booking) || this.#contactSharing === undefined) return { notSent: "CONTACT_SHARING_WITHDRAWN" };
    const ownerPhone = await this.#contactSharing.directory.ownerPhone(booking.ownerId);
    return ownerPhone === undefined
      ? { notSent: "OWNER_CONTACT_UNAVAILABLE" }
      : { reference: booking.publicReference, ownerPhone };
  }

  async #deliver(
    record: NotificationRecord,
    intent: NotificationIntent,
    booking: NotificationBookingContext,
    event: ClaimedOutboxEvent,
    context: OutboxHandlerContext,
  ): Promise<DeliveryResult> {
    // Settled records are never dispatched again, so retries, reclaims, and roll-forward are idempotent.
    if (isNotificationDispatchSettled(record.state)) return { state: record.state, degraded: false };

    const variables = await this.#variables(intent, booking);
    const templateVersion = record.templateVersion ?? this.#renderer.version(intent.templateKey);
    let result: NotificationDispatchResult;
    if ("notSent" in variables) {
      result = Object.freeze({
        outcome: Object.freeze({ kind: "NOT_SENT", reasonCode: variables.notSent }),
        testOnly: false,
        provider: "none",
      });
    } else {
      const rendered = this.#renderer.render(intent.templateKey, record.templateLocale, variables);
      result = await this.dispatcher.dispatch({
        notificationId: record.id,
        idempotencyKey: record.id,
        channel: record.channel,
        recipientUserId: record.recipientUserId,
        locale: rendered.locale,
        templateKey: rendered.templateKey,
        templateVersion,
        variables: rendered.variables,
        body: rendered.body,
      }, context.signal);
    }

    const outcome = result.outcome;
    const degraded = outcome.kind === "FAILED" && outcome.errorCode === CAPABILITY_DEGRADED_CODE;
    // An outage never exhausts a notification: it stays FAILED until the capability recovers.
    const toState = nextNotificationDeliveryState(outcome, degraded ? false : context.retryPlan.isFinalAttempt);
    const errorCode = outcome.kind === "FAILED"
      ? outcome.errorCode
      : outcome.kind === "NOT_SENT" ? outcome.reasonCode : undefined;
    const providerReference = outcome.kind === "ACCEPTED" ? outcome.providerReference : undefined;
    const nextAttemptAt = toState !== "FAILED"
      ? undefined
      : degraded
        ? context.deferredUntil ?? (context.retryPlan.kind === "RETRY" ? context.retryPlan.nextAttemptAt : undefined)
        : context.retryPlan.kind === "RETRY" ? context.retryPlan.nextAttemptAt : undefined;

    const updated = await this.store.recordDeliveryAttempt({
      notificationId: record.id,
      expectedVersion: record.version,
      fromState: record.state,
      toState,
      attemptCount: record.attemptCount + 1,
      testOnly: result.testOnly,
      occurredAt: this.#now(),
      ...(providerReference === undefined ? {} : { providerReference }),
      ...(errorCode === undefined ? {} : { errorCode }),
      ...(result.capabilityState === undefined ? {} : { capabilityState: result.capabilityState }),
      ...(nextAttemptAt === undefined ? {} : { nextAttemptAt }),
    });

    const recorded = recordedOutcome(updated.state);
    if (recorded !== undefined) this.#indicators.notificationDeliveryRecorded(record.channel, result.provider, recorded, errorCode);
    this.#log(Object.freeze({
      event: "notification.delivery.recorded",
      notificationId: record.id,
      outboxEventId: event.id,
      eventType: event.eventType,
      channel: record.channel,
      provider: result.provider,
      state: updated.state,
      attempt: context.attempt,
      templateKey: record.templateKey,
      templateVersion,
      templateLocale: record.templateLocale,
      testOnly: result.testOnly,
      ...(result.capabilityState === undefined ? {} : { capabilityState: result.capabilityState }),
      ...(errorCode === undefined ? {} : { errorCode }),
    }));
    return { state: updated.state, degraded };
  }
}

export function projectNotificationDeliveryStatus(record: NotificationRecord): NotificationDeliveryStatus {
  return Object.freeze({
    notificationId: record.id,
    recipientUserId: record.recipientUserId,
    channel: record.channel,
    state: record.state,
    templateKey: record.templateKey,
    ...(record.templateVersion === undefined ? {} : { templateVersion: record.templateVersion }),
    templateLocale: record.templateLocale,
    relatedEntityType: record.relatedEntityType,
    relatedEntityId: record.relatedEntityId,
    testOnly: record.testOnly,
    claimsDelivery: !record.testOnly && claimsRealDelivery(record.state),
    retrying: record.state === "FAILED",
    attemptCount: record.attemptCount,
    updatedAt: record.updatedAt,
    ...(record.nextAttemptAt === undefined ? {} : { nextAttemptAt: record.nextAttemptAt }),
    ...(record.lastErrorCode === undefined ? {} : { lastErrorCode: record.lastErrorCode }),
  });
}

/** Exposes delivery status for a related entity, optionally for one recipient. */
export class NotificationStatusService {
  constructor(private readonly store: NotificationStore) {}

  async listDeliveryStatus(
    relatedEntityType: string,
    relatedEntityId: string,
    options: Readonly<{ recipientUserId?: string; limit?: number }> = {},
  ): Promise<readonly NotificationDeliveryStatus[]> {
    const limit = options.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new RangeError("limit must be an integer from 1 to 100");
    }
    const records = await this.store.listByRelatedEntity(relatedEntityType, relatedEntityId, limit);
    return Object.freeze(records
      .filter((record) => options.recipientUserId === undefined || record.recipientUserId === options.recipientUserId)
      .map(projectNotificationDeliveryStatus));
  }
}
