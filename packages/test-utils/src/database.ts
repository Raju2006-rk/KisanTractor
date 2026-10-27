import { readFile } from "node:fs/promises";

import type {
  SqlExecutor,
  SqlMigration,
  SqlPool,
  TransactionOptions,
} from "@kisantractor/database";
import { migrations, withTransaction } from "@kisantractor/database";

export interface TestDatabase {
  readonly pool: SqlPool;
  reset(): Promise<void>;
  transaction<Result>(
    work: Parameters<typeof withTransaction<Result>>[1],
    options?: TransactionOptions,
  ): Promise<Result>;
  dispose(): Promise<void>;
}

export interface TestDatabaseFactoryOptions {
  readonly databaseUrl: string;
  readonly createPool: (databaseUrl: string) => SqlPool | Promise<SqlPool>;
  readonly registeredMigrations?: readonly SqlMigration[];
}

const DATA_TABLES = [
  "support_access_grants",
  "support_case_entries",
  "support_cases",
  "notification_delivery_events",
  "provider_events",
  "payment_events",
  "payments",
  "invoices",
  "work_measurements",
  "work_events",
  "booking_status_history",
  "booking_recipients",
  "booking_agreements",
  "idempotency_records",
  "outbox_events",
  "audit_events",
  "notifications",
  "ivr_sessions",
  "bookings",
  "tractor_availability_history",
  "tractor_availability",
  "documents",
  "tractor_photos",
  "equipment",
  "pricing_rules",
  "service_offerings",
  "equipment_types",
  "services",
  "tractors",
  "owner_profiles",
  "user_profiles",
  "locations",
  "user_role_memberships",
  "auth_sessions",
  "otp_challenges",
  "users",
] as const;

export function assertSafeTestDatabaseUrl(databaseUrl: string): void {
  const parsed = new URL(databaseUrl);
  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    throw new TypeError("Test database URL must use PostgreSQL");
  }
  const databaseName = parsed.pathname.slice(1).toLowerCase();
  if (!databaseName.includes("test")) {
    throw new Error("Refusing to use a database whose name does not contain 'test'");
  }
  const localHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
  if (!localHosts.has(parsed.hostname.toLowerCase())) {
    throw new Error("Refusing to reset a non-local test database");
  }
}

async function applyMigrations(
  pool: SqlPool,
  registeredMigrations: readonly SqlMigration[],
): Promise<void> {
  await pool.query(`CREATE TABLE IF NOT EXISTS public.kisantractor_schema_migrations (
    id text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);

  for (const migration of registeredMigrations) {
    const existing = await pool.query<{ readonly id: string }>(
      "SELECT id FROM public.kisantractor_schema_migrations WHERE id = $1",
      [migration.id],
    );
    if (existing.rowCount > 0) {
      continue;
    }
    const sql = await readFile(migration.up, "utf8");
    await pool.query(sql);
    await pool.query(
      "INSERT INTO public.kisantractor_schema_migrations (id) VALUES ($1)",
      [migration.id],
    );
  }
}

export function createTestDatabaseFactory(
  options: TestDatabaseFactoryOptions,
): () => Promise<TestDatabase> {
  assertSafeTestDatabaseUrl(options.databaseUrl);
  const registeredMigrations = options.registeredMigrations ?? migrations;

  return async () => {
    const pool = await options.createPool(options.databaseUrl);
    await applyMigrations(pool, registeredMigrations);

    const reset = async (): Promise<void> => {
      await pool.query(
        `TRUNCATE TABLE ${DATA_TABLES.map((table) => `public.${table}`).join(", ")} RESTART IDENTITY CASCADE`,
      );
    };

    await reset();
    return {
      pool,
      reset,
      transaction: (work, transactionOptions = {}) =>
        withTransaction(pool, work, transactionOptions),
      dispose: async () => {
        await pool.end?.();
      },
    };
  };
}

export interface FixtureFactory<Input, Row> {
  create(overrides?: Partial<Input>): Promise<Row>;
}

export function createDatabaseFixtureFactory<Input extends object, Row>(
  executor: SqlExecutor,
  defaults: () => Input,
  insert: (executor: SqlExecutor, input: Input) => Promise<Row>,
): FixtureFactory<Input, Row> {
  return {
    create: (overrides = {}) =>
      insert(executor, { ...defaults(), ...overrides }),
  };
}
