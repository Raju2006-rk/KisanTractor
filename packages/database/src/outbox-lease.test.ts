import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { SqlExecutor, SqlQueryResult } from "./client.js";
import { migrations } from "./migrations.js";
import { PostgresOutboxLeaseStore } from "./outbox.js";

class RecordingExecutor implements SqlExecutor {
  readonly calls: Array<{ text: string; values: readonly unknown[] }> = [];

  constructor(private readonly rowCount = 1, private readonly rows: readonly Record<string, unknown>[] = []) {}

  async query<Row extends object = Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<SqlQueryResult<Row>> {
    this.calls.push({ text, values });
    return { rows: this.rows as readonly Row[], rowCount: this.rowCount };
  }
}

const now = new Date("2026-05-12T04:00:00.000Z");
const lease = { eventId: "20000000-0000-4000-8000-000000000001", workerId: "worker-a", attempt: 2 };

/** Validates: Requirements 14.6, 18.3 */
describe("PostgresOutboxLeaseStore", () => {
  it("claims a bounded batch with SKIP LOCKED and reclaims only expired leases", async () => {
    const executor = new RecordingExecutor(0);
    await new PostgresOutboxLeaseStore(executor).claim({ workerId: "worker-a", now, leaseMs: 60_000, limit: 10 });

    const call = executor.calls[0]!;
    expect(call.text).toMatch(/FOR UPDATE SKIP LOCKED/u);
    expect(call.text).toMatch(/status IN \('PENDING', 'FAILED'\) AND available_at <= \$1/u);
    expect(call.text).toMatch(/status = 'PROCESSING' AND locked_at <= \$2/u);
    expect(call.text).toMatch(/attempt_count = e\.attempt_count \+ 1/u);
    expect(call.values).toEqual([now.toISOString(), "2026-05-12T03:59:00.000Z", 10, "worker-a"]);
  });

  it("rejects unbounded claims", async () => {
    const store = new PostgresOutboxLeaseStore(new RecordingExecutor());
    await expect(store.claim({ workerId: "w", now, leaseMs: 1, limit: 0 })).rejects.toThrow(RangeError);
    await expect(store.claim({ workerId: "w", now, leaseMs: 1, limit: 501 })).rejects.toThrow(RangeError);
    await expect(store.claim({ workerId: " ", now, leaseMs: 1, limit: 1 })).rejects.toThrow(TypeError);
  });

  it("guards every completion by status, lease holder, and attempt", async () => {
    const executor = new RecordingExecutor(1);
    const store = new PostgresOutboxLeaseStore(executor);
    await store.markPublished(lease, now);
    await store.reschedule(lease, new Date(now.getTime() + 5_000), "PROVIDER_TIMEOUT");
    await store.deadLetter(lease, now, "MAX_ATTEMPTS_EXCEEDED");

    for (const call of executor.calls) {
      expect(call.text).toMatch(/WHERE id = \$1 AND status = 'PROCESSING' AND locked_by = \$2 AND attempt_count = \$3/u);
      expect(call.values.slice(0, 3)).toEqual([lease.eventId, lease.workerId, lease.attempt]);
      expect(call.text).toMatch(/locked_at = NULL, locked_by = NULL/u);
      expect(call.text).not.toMatch(/public\.(bookings|invoices|payments)/u);
    }
    expect(executor.calls[1]?.text).toContain("status = 'FAILED'");
    expect(executor.calls[2]?.text).toContain("status = 'DEAD_LETTER'");
  });

  it("reports a lost lease when the guarded update changes no row", async () => {
    const store = new PostgresOutboxLeaseStore(new RecordingExecutor(0));
    await expect(store.markPublished(lease, now)).resolves.toBe(false);
    await expect(store.deadLetter(lease, now, "HANDLER_ERROR")).resolves.toBe(false);
  });

  it("stores only code-shaped errors, never free text", async () => {
    const store = new PostgresOutboxLeaseStore(new RecordingExecutor());
    await expect(store.reschedule(lease, now, "failed for +919876543210")).rejects.toThrow(TypeError);
  });

  it("requeues only dead-lettered events with a fresh attempt budget", async () => {
    const executor = new RecordingExecutor(1);
    await expect(new PostgresOutboxLeaseStore(executor).requeueDeadLetter(lease.eventId, now)).resolves.toBe(true);
    expect(executor.calls[0]?.text).toMatch(/attempt_count = 0/u);
    expect(executor.calls[0]?.text).toMatch(/WHERE id = \$1 AND status = 'DEAD_LETTER'/u);
  });
});

/** Validates: Requirements 14.6, 17.6 */
describe("0013 outbox notification delivery migration", () => {
  const migration = migrations.find(({ id }) => id === "0013_outbox_notification_delivery");
  if (migration === undefined) throw new Error("Outbox notification delivery migration is not registered");
  const up = readFileSync(migration.up, "utf8");
  const down = readFileSync(migration.down, "utf8");

  it("is registered after 0012, transactional, and reversible", () => {
    const ids = migrations.map(({ id }) => id);
    expect(ids.indexOf("0013_outbox_notification_delivery")).toBe(ids.indexOf("0012_payment_record_integrity") + 1);
    for (const sql of [up, down]) {
      expect(sql.trimStart()).toMatch(/^BEGIN;/u);
      expect(sql.trimEnd()).toMatch(/COMMIT;$/u);
    }
    for (const name of [
      "notifications_dedupe_key_uniq",
      "notifications_related_entity_cursor_idx",
      "outbox_events_expired_lease_idx",
      "notifications_sandbox_test_only_chk",
      "outbox_events_lease_chk",
    ]) {
      expect(up).toContain(name);
      expect(down).toContain(name);
    }
  });

  it("adds honest delivery states and labels sandbox records as test-only", () => {
    for (const state of ["SENT", "SANDBOX_SENT", "NOT_SENT"]) {
      expect(up).toContain(`ADD VALUE IF NOT EXISTS '${state}'`);
    }
    expect(up).toMatch(/test_only = \(capability_state IS NOT DISTINCT FROM 'SANDBOX'\)/u);
    expect(up).toMatch(/template_locale IN \('en', 'hi', 'te', 'kn', 'ta'\)/u);
    // New enum values cannot be referenced in the transaction that adds them.
    expect(up.split("ADD VALUE").slice(1).join("")).not.toMatch(/'(SENT|SANDBOX_SENT|NOT_SENT)'::/u);
  });

  it("never maps a rolled-back state into a delivery claim", () => {
    expect(down).toMatch(/IN \('SENT', 'SANDBOX_SENT', 'NOT_SENT'\) THEN 'FAILED'/u);
    expect(down).not.toMatch(/THEN 'DELIVERED'/u);
  });
});
