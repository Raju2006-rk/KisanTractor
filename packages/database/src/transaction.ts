import type { SqlConnection, SqlPool } from "./client.js";

export type TransactionIsolation =
  | "READ COMMITTED"
  | "REPEATABLE READ"
  | "SERIALIZABLE";

export interface TransactionOptions {
  readonly isolation?: TransactionIsolation;
  readonly readOnly?: boolean;
  readonly correlationId?: string;
}

export interface TransactionStartEvent {
  readonly correlationId?: string;
  readonly isolation: TransactionIsolation;
  readonly readOnly: boolean;
}

export interface TransactionEndEvent {
  readonly outcome: "COMMITTED" | "ROLLED_BACK";
  readonly durationMs: number;
  /** The failure that rolled the transaction back. Observers must reduce it to a code. */
  readonly error?: unknown;
}

/**
 * Observes transaction boundaries for tracing and metrics. Called when a
 * transaction begins; the returned callback is called once it commits or rolls
 * back. Observer failures are swallowed and never affect the transaction.
 */
export type TransactionObserver = (
  start: TransactionStartEvent,
) => ((end: TransactionEndEvent) => void) | undefined;

const observers = new Set<TransactionObserver>();

/** Registers a process-wide transaction observer; returns a function that unregisters it. */
export function registerTransactionObserver(observer: TransactionObserver): () => void {
  observers.add(observer);
  return () => {
    observers.delete(observer);
  };
}

const startObservers = (start: TransactionStartEvent): Array<(end: TransactionEndEvent) => void> => {
  const finishers: Array<(end: TransactionEndEvent) => void> = [];
  for (const observer of observers) {
    try {
      const finish = observer(start);
      if (finish !== undefined) finishers.push(finish);
    } catch {
      // Telemetry must never change transaction behavior.
    }
  }
  return finishers;
};

const finishObservers = (finishers: ReadonlyArray<(end: TransactionEndEvent) => void>, end: TransactionEndEvent): void => {
  for (const finish of finishers) {
    try {
      finish(end);
    } catch {
      // Telemetry must never change transaction behavior.
    }
  }
};

const transactionStatement = (options: TransactionOptions): string => {
  const isolation = options.isolation ?? "READ COMMITTED";
  const accessMode = options.readOnly === true ? "READ ONLY" : "READ WRITE";
  return `BEGIN ISOLATION LEVEL ${isolation} ${accessMode}`;
};

export async function withTransaction<Result>(
  pool: SqlPool,
  work: (transaction: SqlConnection) => Promise<Result>,
  options: TransactionOptions = {},
): Promise<Result> {
  const connection = await pool.connect();
  let began = false;
  const startedAt = performance.now();
  const finishers = startObservers({
    isolation: options.isolation ?? "READ COMMITTED",
    readOnly: options.readOnly === true,
    ...(options.correlationId === undefined ? {} : { correlationId: options.correlationId.trim() }),
  });
  const elapsed = (): number => Math.round((performance.now() - startedAt) * 1_000) / 1_000;

  try {
    await connection.query(transactionStatement(options));
    began = true;

    if (options.correlationId !== undefined) {
      const correlationId = options.correlationId.trim();
      if (correlationId.length === 0) {
        throw new TypeError("correlationId must not be empty");
      }
      // Transaction-local; outbox rows default their correlation_id from it.
      await connection.query(
        "SELECT set_config('app.correlation_id', $1, true)",
        [correlationId],
      );
    }

    const result = await work(connection);
    await connection.query("COMMIT");
    finishObservers(finishers, { outcome: "COMMITTED", durationMs: elapsed() });
    return result;
  } catch (error) {
    finishObservers(finishers, { outcome: "ROLLED_BACK", durationMs: elapsed(), error });
    if (began) {
      try {
        await connection.query("ROLLBACK");
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "Transaction failed and rollback was unsuccessful",
        );
      }
    }
    throw error;
  } finally {
    connection.release();
  }
}
