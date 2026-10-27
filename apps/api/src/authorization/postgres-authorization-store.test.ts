import { describe, expect, it } from "vitest";

import type { SqlPool, SqlQueryResult } from "@kisantractor/database";

import { PostgresAuthorizationStore } from "./postgres-authorization-store.js";

class RecordingPool implements SqlPool {
  readonly calls: { text: string; values?: readonly unknown[] }[] = [];
  rows: readonly Record<string, unknown>[] = [];

  async query<Row extends object>(
    text: string,
    values?: readonly unknown[],
  ): Promise<SqlQueryResult<Row>> {
    this.calls.push({ text, ...(values === undefined ? {} : { values }) });
    return {
      rows: this.rows as readonly Row[],
      rowCount: this.rows.length,
    };
  }

  async connect(): Promise<never> {
    throw new Error("not needed");
  }
}

describe("PostgresAuthorizationStore", () => {
  it("loads booking ownership using a parameterized exact-id query", async () => {
    const pool = new RecordingPool();
    pool.rows = [{ id: "booking-1", customer_id: "farmer-1", owner_id: "owner-1" }];
    const store = new PostgresAuthorizationStore(pool);

    await expect(store.findBookingResource("booking-1' OR TRUE--")).resolves.toEqual({
      kind: "BOOKING",
      id: "booking-1",
      customerId: "farmer-1",
      ownerId: "owner-1",
    });
    expect(pool.calls[0]?.text).toContain("WHERE b.id = $1");
    expect(pool.calls[0]?.text).toContain("INNER JOIN public.tractors");
    expect(pool.calls[0]?.text).not.toContain("OR TRUE");
    expect(pool.calls[0]?.values).toEqual(["booking-1' OR TRUE--"]);
  });

  it("loads Tractor and document ownership without exposing private metadata", async () => {
    const pool = new RecordingPool();
    const store = new PostgresAuthorizationStore(pool);

    pool.rows = [{ id: "tractor-1", owner_id: "owner-1" }];
    await expect(store.findTractorResource("tractor-1")).resolves.toEqual({
      kind: "TRACTOR",
      id: "tractor-1",
      ownerId: "owner-1",
    });

    pool.rows = [{ id: "document-1", owner_id: "owner-1", tractor_id: "tractor-1" }];
    await expect(store.findDocumentResource("document-1")).resolves.toEqual({
      kind: "DOCUMENT",
      id: "document-1",
      ownerId: "owner-1",
      tractorId: "tractor-1",
    });
    expect(pool.calls[1]?.text).not.toMatch(/object_key|mime|digest|phone/iu);
  });

  it("returns undefined for unknown resources", async () => {
    const pool = new RecordingPool();
    const store = new PostgresAuthorizationStore(pool);

    await expect(store.findDocumentResource("missing")).resolves.toBeUndefined();
  });
});
