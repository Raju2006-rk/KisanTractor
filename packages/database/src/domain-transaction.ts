import type { AuditEventInput, StoredAuditEvent } from "./audit.js";
import { writeAuditEvent } from "./audit.js";
import type { SqlConnection, SqlPool } from "./client.js";
import type {
  OptimisticUpdateInput,
} from "./optimistic-concurrency.js";
import { updateWithOptimisticLock } from "./optimistic-concurrency.js";
import type { OutboxEventInput, StoredOutboxEvent } from "./outbox.js";
import { storeOutboxEvent } from "./outbox.js";
import type { TransactionOptions } from "./transaction.js";
import { withTransaction } from "./transaction.js";

export interface DomainTransactionOptions extends TransactionOptions {
  readonly correlationId: string;
}

export interface DomainTransaction {
  readonly sql: SqlConnection;
  update<Row extends object>(input: OptimisticUpdateInput): Promise<Row>;
  appendOutbox(input: OutboxEventInput): Promise<StoredOutboxEvent>;
  appendAudit(
    input: Omit<AuditEventInput, "correlationId">,
  ): Promise<StoredAuditEvent>;
}

export async function withDomainTransaction<Result>(
  pool: SqlPool,
  options: DomainTransactionOptions,
  work: (transaction: DomainTransaction) => Promise<Result>,
): Promise<Result> {
  const correlationId = options.correlationId.trim();
  if (correlationId.length === 0) {
    throw new TypeError("correlationId must not be empty");
  }

  return withTransaction(
    pool,
    async (sql) =>
      work({
        sql,
        update: <Row extends object>(input: OptimisticUpdateInput) =>
          updateWithOptimisticLock<Row>(sql, input),
        appendOutbox: (input) =>
          storeOutboxEvent(sql, { ...input, correlationId: input.correlationId ?? correlationId }),
        appendAudit: (input) =>
          writeAuditEvent(sql, { ...input, correlationId }),
      }),
    { ...options, correlationId },
  );
}
