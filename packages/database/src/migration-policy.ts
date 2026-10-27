/**
 * Additive-migration policy (Requirement 18.5).
 *
 * An up migration may add tables, nullable columns, columns with defaults, enum values, indexes,
 * functions, and constraints on new tables. Anything that drops, renames, retypes, or narrows
 * existing schema is an exception and must be listed here with its justification. Two tests hold
 * the list exact in both directions:
 *
 * - `migration-additivity.test.ts` (default suite) scans each up file for destructive or
 *   data-rewriting statements and compares them with `statements`.
 * - `apps/api/src/release/migrations.integration.test.ts` (database suite) diffs the catalog
 *   before and after each up migration and compares the result with `catalogFindings`.
 *
 * From the first production release onward, a narrowing change must ship in steps that existing
 * rows and the previous application release both tolerate: add the constraint `NOT VALID`,
 * backfill, then `VALIDATE CONSTRAINT` in a later release.
 */
export interface AdditivityException {
  readonly migrationId: string;
  /** Statement kinds found by the static scan (see `destructiveStatementKinds`). */
  readonly statements: readonly string[];
  /** `KIND:object` findings from the catalog diff. */
  readonly catalogFindings: readonly string[];
  readonly justification: string;
}

/** Shared reason for constraints added while no production database exists. */
const PRE_RELEASE =
  "Added before any production deployment: the first production release applies 0001-0021 to an empty database, " +
  "so no production row predates the constraint. The representative-data roll-forward test shows Phase 1 data satisfies it.";

const exception = (
  migrationId: string,
  catalogFindings: readonly string[],
  justification: string,
  statements: readonly string[] = [],
): AdditivityException => Object.freeze({
  migrationId,
  statements: Object.freeze([...statements]),
  catalogFindings: Object.freeze([...catalogFindings]),
  justification,
});

export const additivityExceptions: readonly AdditivityException[] = Object.freeze([
  exception("0002_integrity_and_query_indexes", [
    "CONSTRAINT_ADDED_TO_EXISTING_TABLE:bookings.bookings_no_overlapping_blocking_intervals",
    "UNIQUE_INDEX_ADDED_TO_EXISTING_TABLE:bookings_public_reference_uniq",
    "UNIQUE_INDEX_ADDED_TO_EXISTING_TABLE:idempotency_records_scope_key_uniq",
    "UNIQUE_INDEX_ADDED_TO_EXISTING_TABLE:provider_events_provider_event_uniq",
    "UNIQUE_INDEX_ADDED_TO_EXISTING_TABLE:tractors_registration_lookup_hash_uniq",
    "UNIQUE_INDEX_ADDED_TO_EXISTING_TABLE:users_active_phone_lookup_hash_uniq",
  ], `Requirement 12.3 uniqueness and the Tractor no-overlap exclusion. ${PRE_RELEASE}`),
  exception("0003_identity_and_sessions", [
    "UNIQUE_INDEX_ADDED_TO_EXISTING_TABLE:user_role_memberships_active_role_uniq",
  ], `One active membership per user and role, needed for idempotent role grants at sign-in. ${PRE_RELEASE}`),
  exception("0005_catalog_management", [
    "UNIQUE_INDEX_ADDED_TO_EXISTING_TABLE:service_offerings_tractor_service_equipment_uniq",
  ], `One Service Offering per Tractor, Service, and Equipment item. ${PRE_RELEASE}`),
  exception("0006_private_documents", [
    "CONSTRAINT_ADDED_TO_EXISTING_TABLE:documents.documents_private_metadata_consistency",
    "UNIQUE_INDEX_ADDED_TO_EXISTING_TABLE:documents_private_object_key_uniq",
  ], `Accepted documents must carry scan and encryption evidence; object keys are unique. An ACCEPTED row written before 0006 would violate the check, which is safe only because none exists. ${PRE_RELEASE}`),
  exception("0007_pricing_rule_commands", [
    "UNIQUE_INDEX_ADDED_TO_EXISTING_TABLE:pricing_rules_offering_method_unique_idx",
  ], `One Pricing Rule per offering and method; relaxed by 0008. ${PRE_RELEASE}`),
  exception("0008_versioned_pricing_rules", [
    "INDEX_DROPPED:pricing_rules_offering_method_unique_idx",
    "UNIQUE_INDEX_ADDED_TO_EXISTING_TABLE:pricing_rules_current_offering_method_unique_idx",
  ], "Relaxes 0007: the full unique index becomes a partial one over current versions (valid_to IS NULL), so closed historical versions can coexist with the current rule. The replacement accepts every row the old index accepted, and both statements run in one transaction.", ["DROP INDEX"]),
  exception("0009_normalized_locations", [
    "CONSTRAINT_ADDED_TO_EXISTING_TABLE:locations.locations_administrative_parts_check",
    "CONSTRAINT_ADDED_TO_EXISTING_TABLE:locations.locations_consent_time_check",
    "CONSTRAINT_ADDED_TO_EXISTING_TABLE:locations.locations_coordinate_metadata_check",
    "CONSTRAINT_ADDED_TO_EXISTING_TABLE:locations.locations_optional_parts_check",
  ], `Normalized location parts and GPS consent evidence (Requirements 7.1, 12.6). The UPDATE backfills the new collection_purpose column before SET NOT NULL applies to that new column only. ${PRE_RELEASE}`, ["UPDATE", "SET NOT NULL"]),
  exception("0010_job_tracking_indexes", [
    "UNIQUE_INDEX_ADDED_TO_EXISTING_TABLE:work_events_booking_actor_key_uniq",
    "UNIQUE_INDEX_ADDED_TO_EXISTING_TABLE:work_measurements_one_original_completion_uniq",
  ], `Idempotent work events and one original completion measurement per booking. ${PRE_RELEASE}`),
  exception("0011_invoice_billing_integrity", [
    "CONSTRAINT_ADDED_TO_EXISTING_TABLE:invoices.invoices_agreement_same_booking_fk",
    "CONSTRAINT_ADDED_TO_EXISTING_TABLE:invoices.invoices_rounding_trace_reproducible_chk",
    "CONSTRAINT_ADDED_TO_EXISTING_TABLE:invoices.invoices_supersession_chk",
    "UNIQUE_INDEX_ADDED_TO_EXISTING_TABLE:booking_agreements_id_booking_uniq",
    "UNIQUE_INDEX_ADDED_TO_EXISTING_TABLE:invoices_supersedes_once_uniq",
  ], `Reproducible invoices bound to an agreement of the same booking (Requirement 10). ${PRE_RELEASE}`),
  exception("0012_payment_record_integrity", [
    "CONSTRAINT_ADDED_TO_EXISTING_TABLE:payment_events.payment_events_status_change_chk",
    "CONSTRAINT_ADDED_TO_EXISTING_TABLE:payments.payments_currency_inr_chk",
    "CONSTRAINT_ADDED_TO_EXISTING_TABLE:payments.payments_method_status_chk",
    "CONSTRAINT_ADDED_TO_EXISTING_TABLE:payments.payments_online_verification_chk",
  ], `Cash and online payments never share statuses, and online money counts only after verification (Requirement 11). ${PRE_RELEASE}`),
  exception("0013_outbox_notification_delivery", [
    "CONSTRAINT_ADDED_TO_EXISTING_TABLE:notifications.notifications_template_locale_chk",
    "CONSTRAINT_ADDED_TO_EXISTING_TABLE:outbox_events.outbox_events_lease_chk",
    "UNIQUE_INDEX_ADDED_TO_EXISTING_TABLE:notifications_dedupe_key_uniq",
  ], `Supported template locales, named outbox leases, and one notification per dedupe key (partial index on a new column). ${PRE_RELEASE}`),
  exception("0016_reference_data_identity", [
    "UNIQUE_INDEX_ADDED_TO_EXISTING_TABLE:equipment_types_stable_code_uniq",
    "UNIQUE_INDEX_ADDED_TO_EXISTING_TABLE:services_stable_code_uniq",
  ], `A stable code names one reference row for the life of the platform (Requirement 18.5). ${PRE_RELEASE}`),
  exception("0017_account_erasure", [
    "TRIGGER_CHANGED:booking_recipients.booking_recipients_append_only",
  ], "Relaxes the booking_recipients append-only trigger for one case: the account-erasure redaction of name, phone, and directions inside a transaction flagged app.account_erasure. Every other UPDATE and every DELETE is still refused (covered by the account-deletion integration test). No column or row changes.", ["CREATE OR REPLACE TRIGGER"]),
  exception("0018_online_payment_provider_events", [
    "UNIQUE_INDEX_ADDED_TO_EXISTING_TABLE:payments_provider_reference_uniq",
  ], `One provider intent reference names one payment record, so a verified provider event settles at most one payment (Requirements 11.6, 12.3). Partial over non-null references; Phase 1 cash rows carry none. ${PRE_RELEASE}`),
  exception("0023_expand_notification_locales", [
    "CONSTRAINT_CHANGED:notifications.notifications_template_locale_chk",
  ], "Widens the notification locale check to include Marathi and Bengali while retaining every previously valid locale and row; the temporary drop and same-name replacement are atomic in one transaction.", ["DROP CONSTRAINT"]),
]);
