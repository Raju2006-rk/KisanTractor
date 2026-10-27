import { PostgresOutboxLeaseStore, type SqlPool } from "@kisantractor/database";
import { CapabilityGatedNotificationDispatcher, type CapabilityRegistry } from "@kisantractor/providers";

import { NotificationOutboxHandler, type NotificationOutboxHandlerOptions } from "../notification/notification.service.js";
import { PostgresNotificationStore } from "../notification/postgres-notification-store.js";
import { OutboxWorker, type OutboxWorkerOptions } from "./outbox-worker.js";

export interface NotificationOutboxWorkerOptions extends Omit<OutboxWorkerOptions, "handlers"> {
  readonly notifications?: NotificationOutboxHandlerOptions;
}

/** Wires the Postgres outbox lease store, notification store, and gated dispatcher. */
export function createNotificationOutboxWorker(
  pool: SqlPool,
  capabilities: CapabilityRegistry,
  options: NotificationOutboxWorkerOptions,
): OutboxWorker {
  const { notifications, ...workerOptions } = options;
  const handler = new NotificationOutboxHandler(
    new PostgresNotificationStore(pool),
    new CapabilityGatedNotificationDispatcher(capabilities),
    notifications ?? {},
  );
  const store = new PostgresOutboxLeaseStore(pool);
  return new OutboxWorker(store, { backlog: store, ...workerOptions, handlers: [handler] });
}
