export { sanitizeAuditMetadata, writeAuditEvent } from "./audit.js";
export type {
  AuditActorChannel,
  AuditEventInput,
  StoredAuditEvent,
} from "./audit.js";
export type {
  SqlConnection,
  SqlExecutor,
  SqlPool,
  SqlQueryResult,
} from "./client.js";
export { withDomainTransaction } from "./domain-transaction.js";
export type {
  DomainTransaction,
  DomainTransactionOptions,
} from "./domain-transaction.js";
export type { JsonObject, JsonPrimitive, JsonValue } from "./json.js";
export { migrations } from "./migrations.js";
export { additivityExceptions } from "./migration-policy.js";
export {
  MIGRATION_LEDGER_TABLE,
  MigrationFailedError,
  MigrationHistoryError,
  applyPendingMigrations,
  migrationBody,
  migrationChecksum,
  readMigrationStatus,
} from "./schema-migrations.js";
export type { AppliedMigration, MigrationRunResult, MigrationStatus } from "./schema-migrations.js";
export { APPEND_ONLY_TRIGGERS, verifyDatabaseIntegrity } from "./database-integrity.js";
export type { IntegrityReport } from "./database-integrity.js";
export {
  additivityFindings,
  captureSchemaSnapshot,
  columnsByTable,
  comparableSchema,
  findingKey,
  tableChecksums,
} from "./schema-snapshot.js";
export type { AdditivityFinding, ColumnShape, SchemaSnapshot, TableChecksum } from "./schema-snapshot.js";
export type { AdditivityException } from "./migration-policy.js";
export {
  REFERENCE_DATA_VERSION,
  ReferenceDataDriftError,
  canonicalEquipmentTypes,
  canonicalServices,
  seedReferenceData,
} from "./reference-data.js";
export type { ReferenceRow, ReferenceSeedResult } from "./reference-data.js";
export type { SqlMigration } from "./migrations.js";
export {
  OptimisticConcurrencyError,
  updateWithOptimisticLock,
} from "./optimistic-concurrency.js";
export type { OptimisticUpdateInput } from "./optimistic-concurrency.js";
export { PostgresOutboxLeaseStore, storeOutboxEvent } from "./outbox.js";
export type {
  ClaimedOutboxEvent,
  DeadLetteredOutboxEvent,
  OutboxBacklogReader,
  OutboxBacklogSnapshot,
  OutboxClaimRequest,
  OutboxEventInput,
  OutboxLease,
  OutboxLeaseStore,
  OutboxStatus,
  StoredOutboxEvent,
} from "./outbox.js";
export { registerTransactionObserver, withTransaction } from "./transaction.js";
export type {
  TransactionEndEvent,
  TransactionIsolation,
  TransactionObserver,
  TransactionOptions,
  TransactionStartEvent,
} from "./transaction.js";
