import { hostname } from "node:os";

import { validateEnvironment } from "@kisantractor/config";

import {
  buildConfiguredMessaging,
  createMessagingDirectory,
  notificationChannelsFor,
  ownerContactSharingEnabled,
  type PostgresMessagingDirectory,
} from "./notification/index.js";
import { createNotificationOutboxWorker } from "./outbox/index.js";
import { PaymentReconciliationJob, PaymentRecoveryService, PostgresPaymentStore } from "./payment/index.js";
import {
  buildCapabilityRegistry,
  buildOnlinePaymentAdapter,
  loadMessagingProviderSecrets,
  loadPaymentProviderSecrets,
  loadRuntimeSecrets,
} from "./runtime-config.js";
import { createSqlPool } from "./sql-pool.js";
import { createProcessTelemetry, registerProcessTelemetry } from "./telemetry.js";

/**
 * Standalone worker process; run one or more next to the API. It delivers outbox events (in-app
 * records always; SMS through MSG91 and push through FCM when MESSAGING is configured) and, when
 * an online payment provider is configured, runs payment reconciliation (task 16.2).
 */
async function main(): Promise<void> {
  const config = validateEnvironment(process.env);
  const telemetry = createProcessTelemetry(config, "outbox-worker");
  const removeTelemetry = registerProcessTelemetry(telemetry, "WORKER");
  const pool = createSqlPool(config.DATABASE_URL);
  const onlinePayment = buildOnlinePaymentAdapter(config, loadPaymentProviderSecrets(config, process.env));
  // Contact-decryption keys are loaded only when a messaging provider or contact sharing needs them.
  let directory: PostgresMessagingDirectory | undefined;
  const messagingDirectory = (): PostgresMessagingDirectory =>
    directory ??= createMessagingDirectory(pool, loadRuntimeSecrets(process.env));
  const messaging = buildConfiguredMessaging(config, loadMessagingProviderSecrets(config, process.env), messagingDirectory);
  const capabilities = buildCapabilityRegistry(config, {}, {
    ...(onlinePayment === undefined ? {} : { ONLINE_PAYMENT: onlinePayment }),
    ...(messaging === undefined ? {} : { MESSAGING: messaging }),
  });
  const worker = createNotificationOutboxWorker(pool, capabilities, {
    notifications: {
      channels: notificationChannelsFor(config),
      indicators: telemetry.indicators,
      // Delivery entries carry identifiers, channel, provider, state, and codes; never recipients or bodies.
      logger: ({ event, ...fields }) => {
        if (fields.state === "DEAD_LETTER") telemetry.logger.error(event, fields);
        else if (fields.state === "FAILED") telemetry.logger.warn(event, fields);
        else telemetry.logger.info(event, fields);
      },
      ...(ownerContactSharingEnabled(config)
        ? { ownerContactSharing: { enabled: true, directory: messagingDirectory() } }
        : {}),
    },
    workerId: `${hostname()}:${process.pid}`,
    // Worker entries carry identifiers, counts, codes, and the event's correlation ID only.
    logger: ({ event, ...fields }) => {
      if (event === "outbox.event.dead_lettered" || event === "outbox.poll.failed") {
        telemetry.logger.error(event, fields);
      } else if (event === "outbox.event.retry_scheduled" || event === "outbox.backlog.sample_failed") {
        telemetry.logger.warn(event, fields);
      } else {
        telemetry.logger.info(event, fields);
      }
    },
    indicators: telemetry.indicators,
    tracer: telemetry.tracer,
  });

  // Reconciliation only runs while a provider handle exists (SANDBOX, LIVE, or DEGRADED in flight).
  const reconciliation = capabilities.getInFlightProvider("ONLINE_PAYMENT") === undefined
    ? undefined
    : new PaymentReconciliationJob(
      new PaymentRecoveryService(new PostgresPaymentStore(pool), undefined, telemetry.indicators, capabilities, undefined,
        ({ event, ...fields }) => {
          if (event === "payment.reconciliation.provider_error" || event === "payment.reconciliation.mismatch") {
            telemetry.logger.warn(event, fields);
          } else {
            telemetry.logger.info(event, fields);
          }
        }),
      { onFailure: (code) => telemetry.logger.error("payment.reconciliation.pass_failed", { errorCode: code }) },
    );

  const shutdown = async (): Promise<void> => {
    await Promise.all([worker.stop(), reconciliation?.stop()]);
    await pool.end?.();
    removeTelemetry();
    telemetry.shutdown();
  };
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());
  worker.start();
  reconciliation?.start();
}

void main();
