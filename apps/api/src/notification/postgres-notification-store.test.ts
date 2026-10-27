import type { SqlConnection, SqlPool, SqlQueryResult } from "@kisantractor/database";
import { CapabilityGatedNotificationDispatcher, CapabilityRegistry } from "@kisantractor/providers";
import { describe, expect, it } from "vitest";

import { NotificationOutboxHandler } from "./notification.service.js";
import { PostgresNotificationStore } from "./postgres-notification-store.js";

const bookingId = "70000000-0000-4000-8000-000000000001";
const customerId = "10000000-0000-4000-8000-000000000001";
const ownerId = "10000000-0000-4000-8000-000000000002";
const now = new Date("2026-05-12T04:00:00.000Z");

class FakeNotificationDatabase implements SqlPool, SqlConnection {
  readonly calls: Array<{ text: string; values: readonly unknown[] }> = [];
  readonly notifications = new Map<string, Record<string, unknown>>();

  async connect(): Promise<SqlConnection> {
    return this;
  }

  release(): void {}

  async query<Row extends object = Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<SqlQueryResult<Row>> {
    this.calls.push({ text, values });
    const result = (rows: Record<string, unknown>[]) => ({ rows: rows as unknown as Row[], rowCount: rows.length });
    if (text.includes("FROM public.bookings")) {
      return result([{ id: bookingId, public_reference: "KT-ABCDEF123456", customer_id: customerId, owner_id: ownerId }]);
    }
    if (text.includes("FROM public.user_profiles")) {
      return result([{ user_id: customerId, preferred_locale: "hi" }]);
    }
    if (text.startsWith("INSERT INTO public.notifications")) {
      const dedupeKey = String(values[8]);
      if ([...this.notifications.values()].some((row) => row["dedupe_key"] === dedupeKey)) return result([]);
      const row = {
        id: `9000000${this.notifications.size}-0000-4000-8000-000000000001`,
        recipient_user_id: values[0], booking_id: values[1], channel: values[2], status: "PENDING",
        template_key: values[3], template_locale: values[4], related_entity_type: values[5],
        related_entity_id: values[6], outbox_event_id: values[7], dedupe_key: dedupeKey,
        attempt_count: 0, test_only: false, provider_reference: null, capability_state: null,
        last_error_code: null, next_attempt_at: null, version: 1, created_at: now, updated_at: now,
      };
      this.notifications.set(row.id, row);
      return result([row]);
    }
    if (text.includes("FROM public.notifications WHERE dedupe_key")) {
      return result([...this.notifications.values()].filter((row) => row["dedupe_key"] === values[0]));
    }
    if (text.startsWith("UPDATE public.notifications")) {
      const row = this.notifications.get(String(values[0]));
      if (row === undefined || row["version"] !== values[1]) return result([]);
      Object.assign(row, {
        status: values[2], attempt_count: values[3], last_error_code: values[5], capability_state: values[6],
        test_only: values[7], next_attempt_at: values[8], version: Number(row["version"]) + 1,
      });
      return result([row]);
    }
    return result([]);
  }
}

const claimedEvent = {
  id: "20000000-0000-4000-8000-000000000001",
  aggregateType: "Booking",
  aggregateId: bookingId,
  eventType: "BookingCancelled",
  eventVersion: 3,
  payload: { bookingId },
  status: "PROCESSING" as const,
  availableAt: now,
  createdAt: now,
  attemptCount: 1,
  lockedAt: now,
  lockedBy: "worker-a",
};
const context = {
  attempt: 1,
  now,
  retryPlan: { kind: "RETRY" as const, attempt: 1, isFinalAttempt: false as const, delayMs: 1_000, nextAttemptAt: now },
};

/** Validates: Requirements 14.6, 17.6 */
describe("PostgresNotificationStore", () => {
  it("writes only notification tables and reads bookings without locking them", async () => {
    const database = new FakeNotificationDatabase();
    const handler = new NotificationOutboxHandler(
      new PostgresNotificationStore(database),
      new CapabilityGatedNotificationDispatcher(new CapabilityRegistry()),
      { now: () => now },
    );

    await handler.handle(claimedEvent, context);

    const writes = database.calls
      .map((call) => call.text)
      .filter((text) => /^\s*(INSERT|UPDATE|DELETE)\b/iu.test(text));
    expect(writes.length).toBeGreaterThan(0);
    for (const text of writes) {
      expect(text).toMatch(/^\s*(INSERT INTO|UPDATE) public\.(notifications|notification_delivery_events)\b/u);
    }
    const bookingRead = database.calls.find((call) => call.text.includes("FROM public.bookings"));
    expect(bookingRead?.text).not.toMatch(/FOR (UPDATE|SHARE)/u);

    const rows = [...database.notifications.values()];
    expect(rows.map((row) => [row["recipient_user_id"], row["template_locale"], row["status"], row["capability_state"]]))
      .toEqual([
        [customerId, "hi", "NOT_SENT", "UNCONFIGURED"],
        [ownerId, "en", "NOT_SENT", "UNCONFIGURED"],
      ]);
    expect(database.calls.map((call) => call.text).join("\n")).not.toContain("KisanTractor:");
  });

  it("returns the existing record for a repeated dedupe key and does not dispatch it again", async () => {
    const database = new FakeNotificationDatabase();
    const store = new PostgresNotificationStore(database);
    const handler = new NotificationOutboxHandler(
      store,
      new CapabilityGatedNotificationDispatcher(new CapabilityRegistry()),
      { now: () => now },
    );
    await handler.handle(claimedEvent, context);
    const updatesAfterFirst = database.calls.filter((call) => call.text.startsWith("UPDATE public.notifications")).length;

    await handler.handle({ ...claimedEvent, attemptCount: 2 }, { ...context, attempt: 2 });

    expect(database.notifications.size).toBe(2);
    expect(database.calls.filter((call) => call.text.startsWith("UPDATE public.notifications"))).toHaveLength(updatesAfterFirst);
    const insert = database.calls.find((call) => call.text.startsWith("INSERT INTO public.notifications"));
    expect(insert?.text).toContain("ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING");
  });

  it("raises a version conflict instead of overwriting a concurrent delivery update", async () => {
    const database = new FakeNotificationDatabase();
    await expect(new PostgresNotificationStore(database).recordDeliveryAttempt({
      notificationId: "missing",
      expectedVersion: 1,
      fromState: "PENDING",
      toState: "SENT",
      attemptCount: 1,
      testOnly: false,
      occurredAt: now,
    })).rejects.toMatchObject({ code: "NOTIFICATION_VERSION_CONFLICT" });
    expect(database.calls.map((call) => call.text)).toContain("ROLLBACK");
  });
});
