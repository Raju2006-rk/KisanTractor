import type {
  SqlConnection,
  SqlPool,
  SqlQueryResult,
} from "@kisantractor/database";
import { Pool, type PoolClient } from "pg";

/** Adapts a pooled pg client to the database package's SqlConnection contract. */
class PgConnectionAdapter implements SqlConnection {
  constructor(private readonly client: PoolClient) {}

  async query<Row extends object = Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<SqlQueryResult<Row>> {
    const result = await this.client.query<Row>(text, [...values]);
    return { rows: result.rows, rowCount: result.rowCount ?? 0 };
  }

  release(): void {
    this.client.release();
  }
}

/** Adapts a pg Pool to the database package's SqlPool contract. */
export class PgPoolAdapter implements SqlPool {
  constructor(private readonly pool: Pool) {}

  async query<Row extends object = Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<SqlQueryResult<Row>> {
    const result = await this.pool.query<Row>(text, [...values]);
    return { rows: result.rows, rowCount: result.rowCount ?? 0 };
  }

  async connect(): Promise<SqlConnection> {
    return new PgConnectionAdapter(await this.pool.connect());
  }

  async end(): Promise<void> {
    await this.pool.end();
  }
}

/**
 * Creates the single application SqlPool from a PostgreSQL connection URL.
 * The pool is lazily connected by pg on first query, so construction does not
 * require a reachable database.
 */
export function createSqlPool(databaseUrl: string): SqlPool {
  if (databaseUrl.trim().length === 0) {
    throw new Error("A PostgreSQL connection URL is required to create the SQL pool");
  }
  return new PgPoolAdapter(new Pool({ connectionString: databaseUrl }));
}
