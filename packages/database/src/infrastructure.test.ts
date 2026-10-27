import { describe, expect, it } from "vitest";

import type {
  SqlConnection,
  SqlPool,
  SqlQueryResult,
} from "./client.js";
import { withDomainTransaction } from "./domain-transaction.js";
import {
  OptimisticConcurrencyError,
  updateWithOptimisticLock,
} from "./optimistic-concurrency.js";
import { sanitizeAuditMetadata } from "./audit.js";
import { withTransaction } from "./transaction.js";

interface PlannedResult {
  readonly rows?: readonly Record<string, unknown>[];
  readonly rowCount?: number;
}

class RecordingConnection implements SqlConnection {
  readonly calls: Array<{ text: string; values: readonly unknown[] }> = [];
  released = false;

  constructor(private readonly planned: PlannedResult[] = []) {}

  async query<Row extends object = Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<SqlQueryResult<Row>> {
    this.calls.push({ text, values });
    const next = this.planned.shift();
    return {
      rows: (next?.rows ?? []) as readonly Row[],
      rowCount: next?.rowCount ?? 0,
    };
  }

  release(): void {
    this.released = true;
  }
}

class SingleConnectionPool implements SqlPool {
  constructor(readonly connection: RecordingConnection) {}

  async connect(): Promise<SqlConnection> {
    return this.connection;
  }

  async query<Row extends object = Record<string, unknown>>(): Promise<
    SqlQueryResult<Row>
  > {
    throw new Error("Queries must use a transaction connection");
  }
}

const outboxRow = {
  id: "20000000-0000-4000-8000-000000000001",
  aggregate_type: "Tractor",
  aggregate_id: "10000000-0000-4000-8000-000000000001",
  event_type: "TractorAvailabilityChanged",
  event_version: 2,
  payload: { status: "OFFLINE" },
  status: "PENDING",
  available_at: new Date("2026-01-01T00:00:00.000Z"),
  created_at: new Date("2026-01-01T00:00:00.000Z"),
};

const auditRow = {
  id: "30000000-0000-4000-8000-000000000001",
  correlation_id: "request-42",
  pii_safe_metadata: { source: "owner-dashboard" },
  occurred_at: new Date("2026-01-01T00:00:00.000Z"),
};

describe("transaction helpers", () => {
  it("commits work and binds the correlation identifier locally", async () => {
    const connection = new RecordingConnection();
    const pool = new SingleConnectionPool(connection);

    await expect(
      withTransaction(
        pool,
        async (transaction) => {
          await transaction.query("UPDATE public.tractors SET version = version + 1");
          return "committed";
        },
        { isolation: "SERIALIZABLE", correlationId: "request-42" },
      ),
    ).resolves.toBe("committed");

    expect(connection.calls.map(({ text }) => text)).toEqual([
      "BEGIN ISOLATION LEVEL SERIALIZABLE READ WRITE",
      "SELECT set_config('app.correlation_id', $1, true)",
      "UPDATE public.tractors SET version = version + 1",
      "COMMIT",
    ]);
    expect(connection.released).toBe(true);
  });

  it("rolls back every write when a required record fails", async () => {
    const connection = new RecordingConnection();
    const pool = new SingleConnectionPool(connection);

    await expect(
      withTransaction(pool, async (transaction) => {
        await transaction.query("UPDATE public.bookings SET status = 'ACCEPTED'");
        await transaction.query("INSERT INTO public.booking_status_history DEFAULT VALUES");
        throw new Error("outbox unavailable");
      }),
    ).rejects.toThrow("outbox unavailable");

    expect(connection.calls.at(-1)?.text).toBe("ROLLBACK");
    expect(connection.calls.some(({ text }) => text === "COMMIT")).toBe(false);
    expect(connection.released).toBe(true);
  });

  it("stores a mutation, outbox event, and PII-safe audit on one connection", async () => {
    const connection = new RecordingConnection([
      {},
      {},
      {},
      { rows: [outboxRow], rowCount: 1 },
      { rows: [auditRow], rowCount: 1 },
      {},
    ]);
    const pool = new SingleConnectionPool(connection);

    await withDomainTransaction(
      pool,
      { correlationId: "request-42" },
      async (transaction) => {
        await transaction.sql.query(
          "UPDATE public.tractors SET operational_status = 'OFFLINE'",
        );
        await transaction.appendOutbox({
          aggregateType: "Tractor",
          aggregateId: "10000000-0000-4000-8000-000000000001",
          eventType: "TractorAvailabilityChanged",
          eventVersion: 2,
          payload: { status: "OFFLINE" },
        });
        await transaction.appendAudit({
          actorChannel: "WEB",
          action: "tractor.availability.changed",
          resourceType: "Tractor",
          resourceId: "10000000-0000-4000-8000-000000000001",
          outcome: "SUCCESS",
          metadata: {
            source: "owner-dashboard",
            phone: "+91 9876543210",
          },
        });
      },
    );

    const texts = connection.calls.map(({ text }) => text);
    expect(texts.at(0)).toContain("BEGIN");
    expect(texts.at(-1)).toBe("COMMIT");
    expect(texts.some((text) => text.includes("outbox_events"))).toBe(true);
    expect(texts.some((text) => text.includes("audit_events"))).toBe(true);
    const auditCall = connection.calls.find(({ text }) =>
      text.includes("audit_events"),
    );
    expect(auditCall?.values.join(" ")).not.toContain("9876543210");
    expect(auditCall?.values.join(" ")).toContain("[REDACTED]");
  });
});

describe("optimistic concurrency", () => {
  it("updates only the expected version and increments it atomically", async () => {
    const row = { id: "tractor-1", version: 4, operational_status: "OFFLINE" };
    const executor = new RecordingConnection([{ rows: [row], rowCount: 1 }]);

    await expect(
      updateWithOptimisticLock<typeof row>(executor, {
        table: "tractors",
        entityType: "Tractor",
        entityId: "tractor-1",
        expectedVersion: 3,
        changes: { operational_status: "OFFLINE" },
        updatedAtColumn: "updated_at",
      }),
    ).resolves.toEqual(row);

    expect(executor.calls[0]?.text).toContain(
      'WHERE "id" = $2 AND "version" = $3 RETURNING *',
    );
    expect(executor.calls[0]?.values).toEqual(["OFFLINE", "tractor-1", 3]);
  });

  it("returns a typed conflict without a second mutation when the version is stale", async () => {
    const executor = new RecordingConnection([{ rows: [], rowCount: 0 }]);

    await expect(
      updateWithOptimisticLock(executor, {
        table: "bookings",
        entityType: "Booking",
        entityId: "booking-1",
        expectedVersion: 2,
        changes: { status: "ACCEPTED" },
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<OptimisticConcurrencyError>>({
        code: "OPTIMISTIC_CONCURRENCY_CONFLICT",
        entityId: "booking-1",
        expectedVersion: 2,
      }),
    );
    expect(executor.calls).toHaveLength(1);
  });

  it("rejects unsafe dynamic identifiers before querying", async () => {
    const executor = new RecordingConnection();
    await expect(
      updateWithOptimisticLock(executor, {
        table: "tractors; DROP TABLE users",
        entityType: "Tractor",
        entityId: "tractor-1",
        expectedVersion: 1,
        changes: { status: "OFFLINE" },
      }),
    ).rejects.toThrow("Unsafe SQL identifier");
    expect(executor.calls).toHaveLength(0);
  });
});

describe("PII-safe audit metadata", () => {
  it("recursively redacts sensitive keys and recognizable PII values", () => {
    expect(
      sanitizeAuditMetadata({
        source: "web",
        actorPhone: "+919876543210",
        nested: {
          email: "farmer@example.com",
          note: "call 9876543210",
          status: "SUCCESS",
        },
      }),
    ).toEqual({
      source: "web",
      actorPhone: "[REDACTED]",
      nested: {
        email: "[REDACTED]",
        note: "[REDACTED]",
        status: "SUCCESS",
      },
    });
  });
});
