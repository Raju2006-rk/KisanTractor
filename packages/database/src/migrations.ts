export interface SqlMigration {
  readonly id: string;
  readonly up: URL;
  readonly down: URL;
}

export const migrations: readonly SqlMigration[] = Object.freeze([
  Object.freeze({
    id: "0001_initial_persistence",
    up: new URL("../migrations/0001_initial_persistence.up.sql", import.meta.url),
    down: new URL("../migrations/0001_initial_persistence.down.sql", import.meta.url),
  }),
  Object.freeze({
    id: "0002_integrity_and_query_indexes",
    up: new URL("../migrations/0002_integrity_and_query_indexes.up.sql", import.meta.url),
    down: new URL("../migrations/0002_integrity_and_query_indexes.down.sql", import.meta.url),
  }),
  Object.freeze({
    id: "0003_identity_and_sessions",
    up: new URL("../migrations/0003_identity_and_sessions.up.sql", import.meta.url),
    down: new URL("../migrations/0003_identity_and_sessions.down.sql", import.meta.url),
  }),
  Object.freeze({
    id: "0004_tractor_photos",
    up: new URL("../migrations/0004_tractor_photos.up.sql", import.meta.url),
    down: new URL("../migrations/0004_tractor_photos.down.sql", import.meta.url),
  }),
  Object.freeze({
    id: "0005_catalog_management",
    up: new URL("../migrations/0005_catalog_management.up.sql", import.meta.url),
    down: new URL("../migrations/0005_catalog_management.down.sql", import.meta.url),
  }),
  Object.freeze({
    id: "0006_private_documents",
    up: new URL("../migrations/0006_private_documents.up.sql", import.meta.url),
    down: new URL("../migrations/0006_private_documents.down.sql", import.meta.url),
  }),
  Object.freeze({
    id: "0007_pricing_rule_commands",
    up: new URL("../migrations/0007_pricing_rule_commands.up.sql", import.meta.url),
    down: new URL("../migrations/0007_pricing_rule_commands.down.sql", import.meta.url),
  }),
  Object.freeze({
    id: "0008_versioned_pricing_rules",
    up: new URL("../migrations/0008_versioned_pricing_rules.up.sql", import.meta.url),
    down: new URL("../migrations/0008_versioned_pricing_rules.down.sql", import.meta.url),
  }),
  Object.freeze({
    id: "0009_normalized_locations",
    up: new URL("../migrations/0009_normalized_locations.up.sql", import.meta.url),
    down: new URL("../migrations/0009_normalized_locations.down.sql", import.meta.url),
  }),
  Object.freeze({
    id: "0010_job_tracking_indexes",
    up: new URL("../migrations/0010_job_tracking_indexes.up.sql", import.meta.url),
    down: new URL("../migrations/0010_job_tracking_indexes.down.sql", import.meta.url),
  }),
  Object.freeze({
    id: "0011_invoice_billing_integrity",
    up: new URL("../migrations/0011_invoice_billing_integrity.up.sql", import.meta.url),
    down: new URL("../migrations/0011_invoice_billing_integrity.down.sql", import.meta.url),
  }),
  Object.freeze({
    id: "0012_payment_record_integrity",
    up: new URL("../migrations/0012_payment_record_integrity.up.sql", import.meta.url),
    down: new URL("../migrations/0012_payment_record_integrity.down.sql", import.meta.url),
  }),
  Object.freeze({
    id: "0013_outbox_notification_delivery",
    up: new URL("../migrations/0013_outbox_notification_delivery.up.sql", import.meta.url),
    down: new URL("../migrations/0013_outbox_notification_delivery.down.sql", import.meta.url),
  }),
  Object.freeze({
    id: "0014_outbox_correlation",
    up: new URL("../migrations/0014_outbox_correlation.up.sql", import.meta.url),
    down: new URL("../migrations/0014_outbox_correlation.down.sql", import.meta.url),
  }),
  Object.freeze({
    id: "0015_load_profile_indexes",
    up: new URL("../migrations/0015_load_profile_indexes.up.sql", import.meta.url),
    down: new URL("../migrations/0015_load_profile_indexes.down.sql", import.meta.url),
  }),
  Object.freeze({
    id: "0016_reference_data_identity",
    up: new URL("../migrations/0016_reference_data_identity.up.sql", import.meta.url),
    down: new URL("../migrations/0016_reference_data_identity.down.sql", import.meta.url),
  }),
  Object.freeze({
    id: "0017_account_erasure",
    up: new URL("../migrations/0017_account_erasure.up.sql", import.meta.url),
    down: new URL("../migrations/0017_account_erasure.down.sql", import.meta.url),
  }),
  Object.freeze({
    id: "0018_online_payment_provider_events",
    up: new URL("../migrations/0018_online_payment_provider_events.up.sql", import.meta.url),
    down: new URL("../migrations/0018_online_payment_provider_events.down.sql", import.meta.url),
  }),
  Object.freeze({
    id: "0019_payment_refunds_and_recovery",
    up: new URL("../migrations/0019_payment_refunds_and_recovery.up.sql", import.meta.url),
    down: new URL("../migrations/0019_payment_refunds_and_recovery.down.sql", import.meta.url),
  }),
  Object.freeze({
    id: "0020_messaging_delivery",
    up: new URL("../migrations/0020_messaging_delivery.up.sql", import.meta.url),
    down: new URL("../migrations/0020_messaging_delivery.down.sql", import.meta.url),
  }),
  Object.freeze({
    id: "0021_support_cases",
    up: new URL("../migrations/0021_support_cases.up.sql", import.meta.url),
    down: new URL("../migrations/0021_support_cases.down.sql", import.meta.url),
  }),
  Object.freeze({
    id: "0022_owner_earnings_report_indexes",
    up: new URL("../migrations/0022_owner_earnings_report_indexes.up.sql", import.meta.url),
    down: new URL("../migrations/0022_owner_earnings_report_indexes.down.sql", import.meta.url),
  }),
  Object.freeze({
    id: "0023_expand_notification_locales",
    up: new URL("../migrations/0023_expand_notification_locales.up.sql", import.meta.url),
    down: new URL("../migrations/0023_expand_notification_locales.down.sql", import.meta.url),
  }),
]);
