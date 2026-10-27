import { describe, expect, it } from "vitest";

import type { SqlPool, SqlQueryResult } from "@kisantractor/database";

import {
  assertSafeTestDatabaseUrl,
  createDatabaseFixtureFactory,
  createTestDatabaseFactory,
} from "./database.js";

class TestPool implements SqlPool {
  readonly calls: Array<{ text: string; values: readonly unknown[] }> = [];
  ended = false;

  async query<Row extends object = Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<SqlQueryResult<Row>> {
    this.calls.push({ text, values });
    return { rows: [], rowCount: 0 };
  }

  async connect(): Promise<never> {
    throw new Error("not needed by this test");
  }

  async end(): Promise<void> {
    this.ended = true;
  }
}

describe("test database factory", () => {
  it("refuses production-like and remote database URLs", () => {
    expect(() =>
      assertSafeTestDatabaseUrl(
        "postgresql://user:secret@localhost:5432/kisantractor",
      ),
    ).toThrow("does not contain 'test'");
    expect(() =>
      assertSafeTestDatabaseUrl(
        "postgresql://user:secret@database.example.com:5432/kisantractor_test",
      ),
    ).toThrow("non-local");
  });

  it("applies supplied migrations, resets data, and disposes the pool", async () => {
    const pool = new TestPool();
    const factory = createTestDatabaseFactory({
      databaseUrl:
        "postgresql://test-user:test-password@localhost:5432/kisantractor_test",
      createPool: () => pool,
      registeredMigrations: [],
    });

    const database = await factory();
    expect(pool.calls[0]?.text).toContain("kisantractor_schema_migrations");
    expect(pool.calls[1]?.text).toContain("TRUNCATE TABLE");
    expect(pool.calls[1]?.text).toContain("public.audit_events");
    expect(pool.calls[1]?.text).toContain("public.outbox_events");

    await database.reset();
    expect(pool.calls.filter(({ text }) => text.includes("TRUNCATE"))).toHaveLength(2);
    await database.dispose();
    expect(pool.ended).toBe(true);
  });
});

describe("database fixture factory", () => {
  it("creates real inserted fixtures with deterministic defaults and overrides", async () => {
    const pool = new TestPool();
    const users: Array<{ name: string; role: string }> = [];
    const factory = createDatabaseFixtureFactory(
      pool,
      () => ({ name: "Test Farmer", role: "FARMER" }),
      async (_executor, input) => {
        users.push(input);
        return { id: `user-${users.length}`, ...input };
      },
    );

    await expect(factory.create()).resolves.toEqual({
      id: "user-1",
      name: "Test Farmer",
      role: "FARMER",
    });
    await expect(factory.create({ role: "OWNER" })).resolves.toEqual({
      id: "user-2",
      name: "Test Farmer",
      role: "OWNER",
    });
  });
});
