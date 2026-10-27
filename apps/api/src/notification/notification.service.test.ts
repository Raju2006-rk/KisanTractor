import { createLocalization, defaultCatalogs } from "@kisantractor/i18n";
import {
  CapabilityGatedNotificationDispatcher,
  CapabilityRegistry,
  NotificationChannelError,
  SandboxNotificationAdapter,
  type CapabilityRegistrations,
  type NotificationChannelAdapter,
  type NotificationChannelMessage,
} from "@kisantractor/providers";
import { InMemoryOutboxLeaseStore } from "@kisantractor/test-utils";
import { describe, expect, it } from "vitest";

import { OutboxWorker, type OutboxWorkerLogEvent } from "../outbox/outbox-worker.js";
import {
  NotificationVersionConflictError,
  type NewNotificationRecord,
  type NotificationBookingContext,
  type NotificationDeliveryUpdate,
  type NotificationRecord,
  type NotificationStore,
} from "./notification.contracts.js";
import { NotificationTemplateRenderer } from "./notification-templates.js";
import {
  NotificationOutboxHandler,
  NotificationStatusService,
  type NotificationDeliveryLogEntry,
  type NotificationOutboxHandlerOptions,
} from "./notification.service.js";

const customerId = "10000000-0000-4000-8000-000000000001";
const ownerId = "10000000-0000-4000-8000-000000000002";
const bookingId = "70000000-0000-4000-8000-000000000001";
const start = new Date("2026-05-12T04:00:00.000Z");
const policy = { maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 60_000, jitterRatio: 0 };

interface BookingRow extends NotificationBookingContext {
  readonly status: string;
  readonly version: number;
  readonly ownerContactSharingConsent?: boolean;
}

/** In-memory notification store. It can read bookings but has no way to write them. */
class InMemoryNotificationStore implements NotificationStore {
  readonly bookings = new Map<string, BookingRow>();
  readonly locales = new Map<string, string>();
  readonly records = new Map<string, NotificationRecord>();
  readonly deliveryEvents: Array<{ id: string; from: string | null; to: string; errorCode?: string }> = [];
  #sequence = 0;

  async loadBookingContext(id: string): Promise<NotificationBookingContext | undefined> {
    const row = this.bookings.get(id);
    return row === undefined
      ? undefined
      : {
          bookingId: row.bookingId,
          publicReference: row.publicReference,
          customerId: row.customerId,
          ownerId: row.ownerId,
          status: row.status,
          ownerContactSharingConsent: row.ownerContactSharingConsent === true,
        };
  }

  async preferredLocales(userIds: readonly string[]): Promise<ReadonlyMap<string, string>> {
    return new Map(userIds.flatMap((id) => (this.locales.has(id) ? [[id, this.locales.get(id)!] as const] : [])));
  }

  async findNotification(dedupeKey: string): Promise<NotificationRecord | undefined> {
    return [...this.records.values()].find((record) => record.dedupeKey === dedupeKey);
  }

  async ensureNotification(input: NewNotificationRecord): Promise<NotificationRecord> {
    const existing = [...this.records.values()].find((record) => record.dedupeKey === input.dedupeKey);
    if (existing !== undefined) return existing;
    this.#sequence += 1;
    const record: NotificationRecord = {
      ...input,
      id: `n-${this.#sequence}`,
      state: "PENDING",
      attemptCount: 0,
      testOnly: false,
      version: 1,
      updatedAt: input.createdAt,
    };
    this.records.set(record.id, record);
    this.deliveryEvents.push({ id: record.id, from: null, to: "PENDING" });
    return record;
  }

  async recordDeliveryAttempt(update: NotificationDeliveryUpdate): Promise<NotificationRecord> {
    const current = this.records.get(update.notificationId);
    if (current === undefined || current.version !== update.expectedVersion) {
      throw new NotificationVersionConflictError();
    }
    const { providerReference: _p, lastErrorCode: _e, capabilityState: _c, nextAttemptAt: _n, ...rest } = current;
    const next: NotificationRecord = {
      ...rest,
      state: update.toState,
      attemptCount: update.attemptCount,
      testOnly: update.testOnly,
      version: current.version + 1,
      updatedAt: update.occurredAt,
      ...(update.providerReference ?? current.providerReference
        ? { providerReference: (update.providerReference ?? current.providerReference)! }
        : {}),
      ...(update.errorCode === undefined ? {} : { lastErrorCode: update.errorCode }),
      ...(update.capabilityState === undefined ? {} : { capabilityState: update.capabilityState }),
      ...(update.nextAttemptAt === undefined ? {} : { nextAttemptAt: update.nextAttemptAt }),
    };
    this.records.set(next.id, next);
    this.deliveryEvents.push({
      id: next.id,
      from: update.fromState,
      to: update.toState,
      ...(update.errorCode === undefined ? {} : { errorCode: update.errorCode }),
    });
    return next;
  }

  async listByRelatedEntity(type: string, id: string, limit: number): Promise<readonly NotificationRecord[]> {
    return [...this.records.values()]
      .filter((record) => record.relatedEntityType === type && record.relatedEntityId === id)
      .slice(0, limit);
  }
}

class ScriptedAdapter implements NotificationChannelAdapter {
  readonly channels = ["SMS", "PUSH"] as const;
  readonly calls: NotificationChannelMessage[] = [];

  constructor(private readonly outcomes: Array<"OK" | "RETRYABLE" | "PERMANENT">) {}

  async send(message: NotificationChannelMessage) {
    this.calls.push(message);
    const outcome = this.outcomes.shift() ?? "OK";
    if (outcome === "RETRYABLE") throw new NotificationChannelError("PROVIDER_TIMEOUT", true);
    if (outcome === "PERMANENT") throw new NotificationChannelError("INVALID_RECIPIENT", false);
    return { providerReference: `live-${this.calls.length}` };
  }
}

const harness = (
  registrations: CapabilityRegistrations,
  options: { renderer?: NotificationTemplateRenderer; handler?: NotificationOutboxHandlerOptions; maxAttempts?: number } = {},
) => {
  const notifications = new InMemoryNotificationStore();
  notifications.bookings.set(bookingId, {
    bookingId,
    publicReference: "KT-ABCDEF123456",
    customerId,
    ownerId,
    status: "PENDING_OWNER_RESPONSE",
    version: 1,
  });
  const outbox = new InMemoryOutboxLeaseStore();
  let now = start;
  const logs: OutboxWorkerLogEvent[] = [];
  const handler = new NotificationOutboxHandler(
    notifications,
    new CapabilityGatedNotificationDispatcher(new CapabilityRegistry(registrations)),
    { now: () => now, ...options.handler, ...(options.renderer === undefined ? {} : { renderer: options.renderer }) },
  );
  const worker = new OutboxWorker(outbox, {
    workerId: "worker-a",
    handlers: [handler],
    retryPolicy: options.maxAttempts === undefined ? policy : { ...policy, maxAttempts: options.maxAttempts },
    now: () => now,
    random: () => 0,
    logger: (entry) => logs.push(entry),
  });
  /** Simulates a committed domain transaction: booking mutation plus its outbox event. */
  const commitDomainChange = (eventType: string, status: string) => {
    const booking = notifications.bookings.get(bookingId)!;
    notifications.bookings.set(bookingId, { ...booking, status, version: booking.version + 1 });
    return outbox.append({ aggregateId: bookingId, eventType, payload: { bookingId }, availableAt: now });
  };
  const advance = (ms: number) => {
    now = new Date(now.getTime() + ms);
  };
  return { notifications, outbox, worker, logs, commitDomainChange, advance, handler };
};

/** Validates: Requirements 14.6, 17.6 */
describe("notification delivery through the outbox", () => {
  it("never alters committed domain state when delivery fails, retries, and dead-letters", async () => {
    const adapter = new ScriptedAdapter(["RETRYABLE", "RETRYABLE", "RETRYABLE"]);
    const { notifications, outbox, worker, commitDomainChange, advance } = harness({
      MESSAGING: { state: "LIVE", provider: adapter },
    });
    const event = commitDomainChange("BookingAccepted", "ACCEPTED");
    const committed = structuredClone(notifications.bookings.get(bookingId));

    await worker.runOnce();
    const [record] = [...notifications.records.values()];
    expect(record).toMatchObject({
      channel: "SMS",
      state: "FAILED",
      recipientUserId: customerId,
      templateKey: "notification.booking.accepted",
      templateLocale: "en",
      relatedEntityType: "Booking",
      relatedEntityId: bookingId,
      attemptCount: 1,
      lastErrorCode: "PROVIDER_TIMEOUT",
      nextAttemptAt: new Date(start.getTime() + 1_000),
    });
    expect(outbox.rows.get(event.id)).toMatchObject({ status: "FAILED", lastErrorCode: "NOTIFICATION_DELIVERY_RETRY" });

    advance(1_000);
    await worker.runOnce();
    advance(2_000);
    await worker.runOnce();

    expect(adapter.calls).toHaveLength(3);
    expect(new Set(adapter.calls.map((call) => call.idempotencyKey))).toEqual(new Set([record!.id]));
    expect(notifications.records.get(record!.id)).toMatchObject({ state: "DEAD_LETTER", attemptCount: 3 });
    expect(outbox.rows.get(event.id)).toMatchObject({ status: "DEAD_LETTER", attemptCount: 3 });
    expect(notifications.bookings.get(bookingId)).toEqual(committed);
    expect(notifications.deliveryEvents.map((entry) => entry.to)).toEqual(["PENDING", "FAILED", "FAILED", "DEAD_LETTER"]);
  });

  it("does not resend a settled notification when the event is retried", async () => {
    const adapter = new ScriptedAdapter(["OK", "RETRYABLE", "OK"]);
    const { notifications, worker, commitDomainChange, advance, outbox } = harness({
      MESSAGING: { state: "LIVE", provider: adapter },
    });
    const event = commitDomainChange("BookingCancelled", "CANCELLED");

    await worker.runOnce();
    const states = () => [...notifications.records.values()].map((record) => [record.recipientUserId, record.state]);
    expect(states()).toEqual([[customerId, "SENT"], [ownerId, "FAILED"]]);

    advance(1_000);
    await worker.runOnce();
    expect(states()).toEqual([[customerId, "SENT"], [ownerId, "SENT"]]);
    expect(adapter.calls.map((call) => call.recipientUserId)).toEqual([customerId, ownerId, ownerId]);
    expect(outbox.rows.get(event.id)?.status).toBe("PUBLISHED");
    expect([...notifications.records.values()][0]?.providerReference).toBe("live-1");
  });

  it("records an unconfigured channel as not sent and never claims delivery", async () => {
    const { notifications, outbox, worker, commitDomainChange } = harness({});
    const event = commitDomainChange("BookingRequested", "PENDING_OWNER_RESPONSE");

    await worker.runOnce();
    const records = [...notifications.records.values()];
    expect(records).toEqual([
      expect.objectContaining({
        recipientUserId: ownerId,
        channel: "SMS",
        state: "NOT_SENT",
        capabilityState: "UNCONFIGURED",
        lastErrorCode: "CHANNEL_UNCONFIGURED",
        testOnly: false,
        attemptCount: 1,
      }),
    ]);
    expect(outbox.rows.get(event.id)?.status).toBe("PUBLISHED");

    const status = await new NotificationStatusService(notifications).listDeliveryStatus("Booking", bookingId);
    expect(status).toEqual([expect.objectContaining({ state: "NOT_SENT", claimsDelivery: false, retrying: false })]);
  });

  it("labels sandbox sends as test-only and never as delivered", async () => {
    const sandbox = new SandboxNotificationAdapter({ environment: "test" });
    const { notifications, worker, commitDomainChange } = harness({
      MESSAGING: { state: "SANDBOX", provider: sandbox },
    });
    commitDomainChange("BookingAccepted", "ACCEPTED");
    await worker.runOnce();

    const [record] = [...notifications.records.values()];
    expect(record).toMatchObject({ state: "SANDBOX_SENT", testOnly: true, capabilityState: "SANDBOX" });
    expect(sandbox.sent).toHaveLength(1);
    expect(sandbox.sent[0]?.body).toBe("KisanTractor: Your booking KT-ABCDEF123456 was accepted by the Owner.");
    const [status] = await new NotificationStatusService(notifications).listDeliveryStatus("Booking", bookingId);
    expect(status).toMatchObject({ testOnly: true, claimsDelivery: false });
  });

  it("dead-letters a permanent provider failure without retrying it", async () => {
    const adapter = new ScriptedAdapter(["PERMANENT"]);
    const { notifications, outbox, worker, commitDomainChange, advance } = harness({
      MESSAGING: { state: "LIVE", provider: adapter },
    });
    const event = commitDomainChange("BookingAccepted", "ACCEPTED");
    await worker.runOnce();
    advance(60_000);
    await worker.runOnce();

    expect(adapter.calls).toHaveLength(1);
    expect([...notifications.records.values()][0]).toMatchObject({ state: "DEAD_LETTER", lastErrorCode: "INVALID_RECIPIENT" });
    expect(outbox.rows.get(event.id)).toMatchObject({ status: "DEAD_LETTER", lastErrorCode: "NOTIFICATION_DEAD_LETTERED" });
  });

  it("records the recipient's template locale and falls back to English when the template is missing", async () => {
    const localization = createLocalization({
      catalogs: {
        te: { ...defaultCatalogs.te, "notification.booking.cancelled": "KisanTractor: బుకింగ్ {reference} రద్దు చేయబడింది." },
      },
    });
    const sandbox = new SandboxNotificationAdapter({ environment: "test" });
    const { notifications, worker, commitDomainChange } = harness(
      { MESSAGING: { state: "SANDBOX", provider: sandbox } },
      { renderer: new NotificationTemplateRenderer(localization) },
    );
    notifications.locales.set(customerId, "te");
    notifications.locales.set(ownerId, "mr");
    commitDomainChange("BookingCancelled", "CANCELLED");
    await worker.runOnce();

    const byRecipient = new Map([...notifications.records.values()].map((record) => [record.recipientUserId, record]));
    expect(byRecipient.get(customerId)?.templateLocale).toBe("te");
    expect(byRecipient.get(ownerId)?.templateLocale).toBe("en");
    expect(sandbox.sent.map((message) => [message.locale, message.body])).toEqual([
      ["te", "KisanTractor: బుకింగ్ KT-ABCDEF123456 రద్దు చేయబడింది."],
      ["en", "KisanTractor: Booking KT-ABCDEF123456 was cancelled."],
    ]);
  });

  it("dead-letters events whose payload or related booking is invalid", async () => {
    const { outbox, worker } = harness({});
    const malformed = outbox.append({ aggregateId: bookingId, eventType: "BookingAccepted", payload: {}, availableAt: start });
    const missing = outbox.append({
      aggregateId: bookingId,
      eventType: "BookingAccepted",
      payload: { bookingId: "70000000-0000-4000-8000-000000000999" },
      availableAt: start,
    });
    await worker.runOnce();
    expect(outbox.rows.get(malformed.id)).toMatchObject({ status: "DEAD_LETTER", lastErrorCode: "INVALID_NOTIFICATION_PAYLOAD" });
    expect(outbox.rows.get(missing.id)).toMatchObject({ status: "DEAD_LETTER", lastErrorCode: "RELATED_ENTITY_NOT_FOUND" });
  });

  it("keeps message bodies, phone numbers, and names out of worker logs", async () => {
    const adapter = new ScriptedAdapter(["RETRYABLE"]);
    const { worker, logs, commitDomainChange } = harness({ MESSAGING: { state: "LIVE", provider: adapter } });
    commitDomainChange("BookingAccepted", "ACCEPTED");
    await worker.runOnce();
    const serialized = JSON.stringify(logs);
    expect(logs).toHaveLength(1);
    expect(serialized).not.toContain("KT-ABCDEF123456");
    expect(serialized).not.toContain("accepted by the Owner");
    expect(serialized).not.toContain(customerId);
  });

  it("ignores events without notification rules", () => {
    const { handler } = harness({});
    expect(handler.handles("TractorAvailabilityChanged")).toBe(false);
    expect(handler.handles("BookingRequested")).toBe(true);
  });
});

/** Validates: Requirements 14.2, 14.4, 14.6, 18.7 */
describe("messaging capability rollback", () => {
  it("keeps in-flight notifications honest across LIVE -> DEGRADED -> UNCONFIGURED without contacting the provider", async () => {
    const adapter = new ScriptedAdapter(["RETRYABLE"]);
    // One database (stores) shared by three worker processes with different capability configuration.
    const { notifications, outbox, commitDomainChange, advance, worker: liveWorker } = harness({
      MESSAGING: { state: "LIVE", provider: adapter },
    });
    let now = start;
    const restartWith = (registrations: CapabilityRegistrations) => new OutboxWorker(outbox, {
      workerId: "worker-after-rollback",
      handlers: [new NotificationOutboxHandler(notifications,
        new CapabilityGatedNotificationDispatcher(new CapabilityRegistry(registrations)), { now: () => now })],
      retryPolicy: { ...policy, maxAttempts: 5 },
      now: () => now,
      random: () => 0,
    });
    const tick = (ms: number) => {
      advance(ms);
      now = new Date(now.getTime() + ms);
    };

    const event = commitDomainChange("BookingAccepted", "ACCEPTED");
    const committed = structuredClone(notifications.bookings.get(bookingId));
    await liveWorker.runOnce();
    expect(adapter.calls).toHaveLength(1);
    const [record] = [...notifications.records.values()];
    expect(record).toMatchObject({ state: "FAILED", lastErrorCode: "PROVIDER_TIMEOUT" });

    // Rollback 1: the provider misbehaves, operations set MESSAGING=DEGRADED and restart the worker.
    tick(1_000);
    await restartWith({ MESSAGING: { state: "DEGRADED" } }).runOnce();
    expect(adapter.calls).toHaveLength(1);
    expect(notifications.records.get(record!.id)).toMatchObject({
      state: "FAILED", lastErrorCode: "CAPABILITY_DEGRADED", capabilityState: "DEGRADED", attemptCount: 2,
    });
    // The event is kept for a later retry rather than dropped.
    expect(outbox.rows.get(event.id)).toMatchObject({ status: "FAILED" });

    // Rollback 2: the provider is withdrawn entirely (MESSAGING=UNCONFIGURED).
    tick(60_000);
    await restartWith({}).runOnce();
    expect(adapter.calls).toHaveLength(1);
    expect(notifications.records.get(record!.id)).toMatchObject({
      state: "NOT_SENT", capabilityState: "UNCONFIGURED", lastErrorCode: "CHANNEL_UNCONFIGURED", testOnly: false,
    });
    expect(outbox.rows.get(event.id)?.status).toBe("PUBLISHED");
    const [status] = await new NotificationStatusService(notifications).listDeliveryStatus("Booking", bookingId);
    expect(status).toMatchObject({ state: "NOT_SENT", claimsDelivery: false });

    // Delivery outcomes never touched the committed booking.
    expect(notifications.bookings.get(bookingId)).toEqual(committed);
  });
});

const OWNER_PHONE = "+919876543210";

/** Owner directory double that records lookups; the phone is a synthetic fixture. */
/** `null` means the Owner has no shareable number (an explicit `undefined` would pick the default). */
const ownerDirectory = (phone: string | null = OWNER_PHONE) => {
  const lookups: string[] = [];
  return { lookups, ownerPhone: async (id: string) => { lookups.push(id); return phone ?? undefined; } };
};

/** Validates: Requirements 3.4, 12.1, 12.2, 17.6 */
describe("consent-aware Owner contact sharing in messages", () => {
  const shareWith = (consent: boolean, enabled = true, directory = ownerDirectory()) => {
    const sandbox = new SandboxNotificationAdapter({ environment: "test" });
    const logs: NotificationDeliveryLogEntry[] = [];
    const setup = harness({ MESSAGING: { state: "SANDBOX", provider: sandbox } }, {
      handler: {
        channels: ["IN_APP", "SMS", "PUSH"],
        ownerContactSharing: { enabled, directory },
        logger: (entry) => logs.push(entry),
      },
    });
    const booking = setup.notifications.bookings.get(bookingId)!;
    setup.notifications.bookings.set(bookingId, { ...booking, ownerContactSharingConsent: consent });
    return { ...setup, sandbox, logs, directory };
  };

  it("sends the Owner's number to the booking Farmer by SMS only, after acceptance, with consent", async () => {
    const { notifications, worker, commitDomainChange, sandbox, logs, directory } = shareWith(true);
    commitDomainChange("BookingAccepted", "ACCEPTED");
    await worker.runOnce();

    const contact = [...notifications.records.values()].filter((record) => record.templateKey === "notification.booking.ownerContact");
    expect(contact).toEqual([expect.objectContaining({ recipientUserId: customerId, channel: "SMS", state: "SANDBOX_SENT", templateVersion: 1 })]);
    const sent = sandbox.sent.filter((message) => message.templateKey === "notification.booking.ownerContact");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ channel: "SMS", recipientUserId: customerId, variables: { reference: "KT-ABCDEF123456", ownerPhone: OWNER_PHONE } });
    expect(sent[0]!.body).toContain(OWNER_PHONE);
    // The number is never sent to the Owner, by push, or in-app, and never reaches records or logs.
    expect(sandbox.sent.filter((message) => message !== sent[0]).some((message) => message.body.includes(OWNER_PHONE))).toBe(false);
    expect(JSON.stringify([...notifications.records.values()])).not.toContain(OWNER_PHONE);
    expect(JSON.stringify(logs)).not.toContain(OWNER_PHONE);
    expect(directory.lookups).toEqual([ownerId]);
  });

  it("generates no contact message without consent, while sharing is switched off, or before acceptance", async () => {
    for (const [consent, enabled, eventType, status] of [
      [false, true, "BookingAccepted", "ACCEPTED"],
      [true, false, "BookingAccepted", "ACCEPTED"],
      // The rule is attached to acceptance only; a request never carries the number.
      [true, true, "BookingRequested", "PENDING_OWNER_RESPONSE"],
    ] as const) {
      const { notifications, worker, commitDomainChange, sandbox, directory } = shareWith(consent, enabled);
      commitDomainChange(eventType, status);
      await worker.runOnce();
      const label = `${consent}/${enabled}/${eventType}`;
      expect([...notifications.records.values()].some((record) => record.templateKey === "notification.booking.ownerContact"), label).toBe(false);
      expect(sandbox.sent.some((message) => message.body.includes(OWNER_PHONE)), label).toBe(false);
      expect(directory.lookups, label).toEqual([]);
    }
  });

  it("re-checks consent and booking state before a retried send and records NOT_SENT once withdrawn", async () => {
    const adapter = new ScriptedAdapter(["OK", "RETRYABLE"]);
    const directory = ownerDirectory();
    const { notifications, worker, commitDomainChange, advance } = harness({ MESSAGING: { state: "LIVE", provider: adapter } }, {
      handler: { channels: ["SMS"], ownerContactSharing: { enabled: true, directory } },
    });
    notifications.bookings.set(bookingId, { ...notifications.bookings.get(bookingId)!, ownerContactSharingConsent: true });
    commitDomainChange("BookingAccepted", "ACCEPTED");
    await worker.runOnce();
    const contact = () => [...notifications.records.values()].find((record) => record.templateKey === "notification.booking.ownerContact")!;
    expect(contact()).toMatchObject({ state: "FAILED" });

    // The Owner withdraws consent before the retry.
    notifications.bookings.set(bookingId, { ...notifications.bookings.get(bookingId)!, ownerContactSharingConsent: false });
    advance(1_000);
    await worker.runOnce();
    expect(contact()).toMatchObject({ state: "NOT_SENT", lastErrorCode: "CONTACT_SHARING_WITHDRAWN" });
    expect(adapter.calls.filter((call) => call.templateKey === "notification.booking.ownerContact")).toHaveLength(1);
    expect(adapter.calls.some((call) => call.body.includes(OWNER_PHONE) && call.recipientUserId !== customerId)).toBe(false);
  });

  it("records NOT_SENT when the Owner has no shareable number", async () => {
    const { notifications, worker, commitDomainChange, sandbox } = shareWith(true, true, ownerDirectory(null));
    commitDomainChange("BookingAccepted", "ACCEPTED");
    await worker.runOnce();
    expect([...notifications.records.values()].find((record) => record.templateKey === "notification.booking.ownerContact"))
      .toMatchObject({ state: "NOT_SENT", lastErrorCode: "OWNER_CONTACT_UNAVAILABLE" });
    expect(sandbox.sent.some((message) => message.templateKey === "notification.booking.ownerContact")).toBe(false);
  });
});

/** Validates: Requirements 1.4, 11.4, 17.6 */
describe("receipt and refund notifications from payment outbox events", () => {
  const paymentId = "80000000-0000-4000-8000-000000000001";

  it("records online receipts against the payment for both parties and refunds for the Farmer", async () => {
    const sandbox = new SandboxNotificationAdapter({ environment: "test" });
    const { notifications, outbox, worker } = harness({ MESSAGING: { state: "SANDBOX", provider: sandbox } });
    for (const eventType of ["OnlinePaymentConfirmed", "OnlinePaymentFailed", "OnlinePaymentReleased",
      "PaymentRefundRequested", "PaymentRefundProcessed", "PaymentRefundFailed"]) {
      outbox.append({ aggregateId: paymentId, eventType, payload: { bookingId, paymentId, amountPaise: 120_000 }, availableAt: start });
    }
    await worker.runOnce();

    const records = [...notifications.records.values()];
    expect(records.map((record) => [record.templateKey, record.recipientUserId])).toEqual([
      ["notification.payment.onlineConfirmed", customerId],
      ["notification.payment.onlineReceived", ownerId],
      ["notification.payment.onlineFailed", customerId],
      ["notification.payment.onlineReleased", customerId],
      ["notification.refund.requested", customerId],
      ["notification.refund.processed", customerId],
      ["notification.refund.failed", customerId],
    ]);
    for (const record of records) {
      expect(record).toMatchObject({ relatedEntityType: "Payment", relatedEntityId: paymentId, bookingId, state: "SANDBOX_SENT", templateVersion: 1 });
    }
    // PII-minimal: the booking reference only; amounts and names never enter a message.
    for (const message of sandbox.sent) {
      expect(message.variables).toEqual({ reference: "KT-ABCDEF123456" });
      expect(message.body).not.toMatch(/1,?200|120000/u);
    }
  });

  it("dead-letters a payment event without a payment id instead of guessing the related entity", async () => {
    const { outbox, worker } = harness({});
    const event = outbox.append({ aggregateId: bookingId, eventType: "PaymentRefundProcessed", payload: { bookingId }, availableAt: start });
    await worker.runOnce();
    expect(outbox.rows.get(event.id)).toMatchObject({ status: "DEAD_LETTER", lastErrorCode: "INVALID_NOTIFICATION_PAYLOAD" });
  });
});

/** Validates: Requirements 14.4, 14.6, 17.5, 17.6, 18.7 */
describe("degraded-provider recovery", () => {
  it("keeps in-app delivery, waits through a long outage without spending retries, and sends once after roll-forward", async () => {
    const live = new ScriptedAdapter([]);
    const { notifications, outbox, commitDomainChange, advance } = harness({});
    let now = start;
    const workerWith = (registrations: CapabilityRegistrations) => new OutboxWorker(outbox, {
      workerId: "worker-recovery",
      handlers: [new NotificationOutboxHandler(notifications,
        new CapabilityGatedNotificationDispatcher(new CapabilityRegistry(registrations)),
        { now: () => now, channels: ["IN_APP", "SMS", "PUSH"] })],
      retryPolicy: policy,
      now: () => now,
      random: () => 0,
      deferralDelayMs: 60_000,
    });
    const tick = (ms: number) => { advance(ms); now = new Date(now.getTime() + ms); };

    const event = commitDomainChange("BookingAccepted", "ACCEPTED");
    const degraded = workerWith({ MESSAGING: { state: "DEGRADED", provider: live } });
    // Ten degraded passes: more than maxAttempts (3), yet nothing is dead-lettered.
    for (let pass = 0; pass < 10; pass += 1) {
      await degraded.runOnce();
      tick(60_000);
    }
    expect(live.calls).toEqual([]);
    const byChannel = () => new Map([...notifications.records.values()].map((record) => [record.channel, record]));
    expect(byChannel().get("IN_APP")).toMatchObject({ state: "DELIVERED", attemptCount: 1 });
    expect(byChannel().get("SMS")).toMatchObject({ state: "FAILED", lastErrorCode: "CAPABILITY_DEGRADED", capabilityState: "DEGRADED" });
    expect(byChannel().get("PUSH")).toMatchObject({ state: "FAILED", lastErrorCode: "CAPABILITY_DEGRADED" });
    expect(outbox.rows.get(event.id)).toMatchObject({ status: "FAILED", lastErrorCode: "CAPABILITY_DEGRADED", attemptCount: 0 });
    const [smsStatus] = (await new NotificationStatusService(notifications).listDeliveryStatus("Booking", bookingId))
      .filter((status) => status.channel === "SMS");
    expect(smsStatus).toMatchObject({ retrying: true, claimsDelivery: false });

    // Roll forward: MESSAGING back to LIVE. Each channel is sent once; in-app is not repeated.
    const recovered = workerWith({ MESSAGING: { state: "LIVE", provider: live } });
    await recovered.runOnce();
    tick(60_000);
    await recovered.runOnce();
    expect(live.calls.map((call) => call.channel).sort()).toEqual(["PUSH", "SMS"]);
    expect(new Set(live.calls.map((call) => call.idempotencyKey)).size).toBe(2);
    expect(byChannel().get("SMS")).toMatchObject({ state: "SENT", providerReference: expect.stringMatching(/^live-/u) });
    expect(byChannel().get("IN_APP")).toMatchObject({ state: "DELIVERED", attemptCount: 1 });
    expect(outbox.rows.get(event.id)?.status).toBe("PUBLISHED");
    expect(notifications.records.size).toBe(3);
  });

  it("records PII-safe delivery telemetry per channel, provider, and outcome", async () => {
    const metrics: Array<readonly [string, string, string, string | undefined]> = [];
    const indicators = { notificationDeliveryRecorded: (...args: [string, string, string, string | undefined]) => { metrics.push(args); } };
    const logs: NotificationDeliveryLogEntry[] = [];
    const { worker, commitDomainChange } = harness({ MESSAGING: { state: "DEGRADED" } }, {
      handler: {
        channels: ["IN_APP", "SMS"],
        indicators: indicators as unknown as NonNullable<NotificationOutboxHandlerOptions["indicators"]>,
        logger: (entry) => logs.push(entry),
      },
    });
    commitDomainChange("BookingAccepted", "ACCEPTED");
    await worker.runOnce();
    expect(metrics).toEqual([
      ["IN_APP", "in_app", "DELIVERED", undefined],
      ["SMS", "none", "FAILED", "CAPABILITY_DEGRADED"],
    ]);
    expect(logs.map((entry) => [entry.channel, entry.provider, entry.state, entry.capabilityState])).toEqual([
      ["IN_APP", "in_app", "DELIVERED", undefined],
      ["SMS", "none", "FAILED", "DEGRADED"],
    ]);
    const serialized = JSON.stringify(logs);
    for (const forbidden of [customerId, ownerId, "KT-ABCDEF123456", "accepted by the Owner"]) expect(serialized).not.toContain(forbidden);
  });
});
