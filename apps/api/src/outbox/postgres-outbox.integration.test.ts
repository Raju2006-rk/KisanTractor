import { PostgresOutboxLeaseStore, storeOutboxEvent } from "@kisantractor/database";
import { createTestDatabaseFactory, type TestDatabase } from "@kisantractor/test-utils";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PgPoolAdapter } from "../sql-pool.js";
import { Pool } from "pg";
import { OutboxWorker } from "./outbox-worker.js";

const databaseUrl = process.env.OUTBOX_INTEGRATION_DATABASE_URL;
const describeDatabase = databaseUrl === undefined ? describe.skip : describe;
const start = new Date("2026-05-12T04:00:00.000Z");

/** Validates: Requirements 14.6, 18.3 */
describeDatabase("PostgresOutboxLeaseStore database integration", () => {
  let database: TestDatabase;
  let pool: PgPoolAdapter;

  beforeAll(async () => {
    pool = new PgPoolAdapter(new Pool({ connectionString: databaseUrl, max: 6 }));
    database = await createTestDatabaseFactory({ databaseUrl: databaseUrl!, createPool: async () => pool })();
  }, 120_000);

  beforeEach(async () => {
    await database.reset();
  });

  afterAll(async () => {
    await database?.dispose();
  });

  const seed = async (count: number): Promise<void> => {
    for (let index = 0; index < count; index += 1) {
      await storeOutboxEvent(pool, {
        aggregateType: "Booking",
        aggregateId: `70000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        eventType: "BookingAccepted",
        eventVersion: 1,
        payload: { index },
        availableAt: start,
      });
    }
  };

  it("never lets concurrent claims return the same event", async () => {
    await seed(40);
    const stores = ["a", "b", "c", "d"].map(() => new PostgresOutboxLeaseStore(pool));
    const batches = await Promise.all(stores.map((store, index) =>
      store.claim({ workerId: `worker-${index}`, now: start, leaseMs: 60_000, limit: 15 })));
    const ids = batches.flat().map((event) => event.id);
    expect(ids).toHaveLength(40);
    expect(new Set(ids).size).toBe(40);
  });

  it("retries, dead-letters, and reclaims expired leases against real rows", async () => {
    await seed(1);
    const store = new PostgresOutboxLeaseStore(pool);
    let now = start;
    const worker = new OutboxWorker(store, {
      workerId: "worker-a",
      handlers: [{ name: "fail", handles: () => true, handle: async () => { throw Object.assign(new Error("x"), { code: "PROVIDER_TIMEOUT" }); } }],
      retryPolicy: { maxAttempts: 2, baseDelayMs: 1_000, maxDelayMs: 1_000, jitterRatio: 0 },
      now: () => now,
    });

    await worker.runOnce();
    const failed = await pool.query<{ status: string; available_at: Date; attempt_count: number }>(
      "SELECT status, available_at, attempt_count FROM public.outbox_events");
    expect(failed.rows[0]).toMatchObject({ status: "FAILED", attempt_count: 1 });
    expect(failed.rows[0]?.available_at.toISOString()).toBe("2026-05-12T04:00:01.000Z");

    now = new Date(start.getTime() + 1_000);
    await worker.runOnce();
    const dead = await store.listDeadLetters(10);
    expect(dead).toEqual([expect.objectContaining({ attemptCount: 2, lastErrorCode: "PROVIDER_TIMEOUT" })]);

    expect(await store.requeueDeadLetter(dead[0]!.id, now)).toBe(true);
    const [claimed] = await store.claim({ workerId: "crashed", now, leaseMs: 30_000, limit: 1 });
    expect(claimed?.attemptCount).toBe(1);
    const later = new Date(now.getTime() + 30_000);
    const [reclaimed] = await store.claim({ workerId: "rescuer", now: later, leaseMs: 30_000, limit: 1 });
    expect(reclaimed).toMatchObject({ id: claimed?.id, attemptCount: 2, lockedBy: "rescuer" });
    await expect(store.markPublished({ eventId: claimed!.id, workerId: "crashed", attempt: 1 }, later)).resolves.toBe(false);
    await expect(store.markPublished({ eventId: claimed!.id, workerId: "rescuer", attempt: 2 }, later)).resolves.toBe(true);
  });
});
