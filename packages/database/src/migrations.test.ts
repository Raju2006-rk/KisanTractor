import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { migrations } from "./migrations.js";

const migration = migrations[0];
if (migration === undefined) {
  throw new Error("Initial persistence migration is not registered");
}

const upSql = readFileSync(migration.up, "utf8");
const downSql = readFileSync(migration.down, "utf8");

const tablePattern = (table: string): RegExp =>
  new RegExp(`CREATE TABLE public\\.${table}\\s*\\(`, "i");

const tableBody = (table: string): string => {
  const match = upSql.match(
    new RegExp(`CREATE TABLE public\\.${table}\\s*\\(([\\s\\S]*?)\\n\\);`, "i"),
  );
  if (match?.[1] === undefined) {
    throw new Error(`Missing table definition for ${table}`);
  }
  return match[1];
};

describe("0001 initial persistence migration", () => {
  it("registers one reversible initial migration", () => {
    expect(migration.id).toBe("0001_initial_persistence");
    expect(upSql.trimStart()).toMatch(/^BEGIN;/);
    expect(upSql.trimEnd()).toMatch(/COMMIT;$/);
    expect(downSql.trimStart()).toMatch(/^BEGIN;/);
    expect(downSql.trimEnd()).toMatch(/COMMIT;$/);
  });

  it("creates every task 2.1 persistence area", () => {
    const requiredTables = [
      "users",
      "user_profiles",
      "owner_profiles",
      "roles",
      "user_role_memberships",
      "locations",
      "tractors",
      "documents",
      "equipment",
      "service_offerings",
      "pricing_rules",
      "tractor_availability",
      "bookings",
      "booking_recipients",
      "booking_status_history",
      "work_events",
      "work_measurements",
      "invoices",
      "payments",
      "provider_events",
      "notifications",
      "ivr_sessions",
      "idempotency_records",
      "audit_events",
      "outbox_events",
    ];

    for (const table of requiredTables) {
      expect(upSql, `expected migration to create ${table}`).toMatch(tablePattern(table));
      expect(downSql, `expected rollback to drop ${table}`).toMatch(
        new RegExp(`DROP TABLE IF EXISTS public\\.${table}`, "i"),
      );
    }
  });

  it("uses paise integers, precise quantities, and timezone-aware instants", () => {
    expect(tableBody("pricing_rules")).toMatch(/rate_paise bigint NOT NULL CHECK \(rate_paise > 0\)/i);
    expect(tableBody("booking_agreements")).toMatch(/estimated_total_paise bigint NOT NULL/i);
    expect(tableBody("invoices")).toMatch(/total_paise bigint NOT NULL/i);
    expect(tableBody("payments")).toMatch(/amount_paise bigint NOT NULL/i);
    expect(tableBody("work_measurements")).toMatch(/quantity numeric\(12, 3\) NOT NULL/i);
    expect(upSql).not.toMatch(/\bmoney\b/i);
    expect(upSql).not.toMatch(/\btimestamp(?:\s+without\s+time\s+zone)?\b/i);
    expect((upSql.match(/\btimestamptz\b/gi) ?? []).length).toBeGreaterThan(40);
  });

  it("adds optimistic versions to mutable aggregate records", () => {
    const versionedTables = [
      "users",
      "user_profiles",
      "owner_profiles",
      "tractors",
      "documents",
      "equipment",
      "service_offerings",
      "pricing_rules",
      "tractor_availability",
      "bookings",
      "payments",
      "notifications",
      "ivr_sessions",
      "idempotency_records",
      "outbox_events",
    ];

    for (const table of versionedTables) {
      expect(tableBody(table), `expected ${table} to be versioned`).toMatch(
        /version integer NOT NULL DEFAULT 1 CHECK \(version > 0\)/i,
      );
    }
  });

  it("links owned records with restrictive foreign keys", () => {
    const requiredReferences = [
      ["tractors", "public.users"],
      ["documents", "public.tractors"],
      ["service_offerings", "public.tractors"],
      ["pricing_rules", "public.service_offerings"],
      ["bookings", "public.users"],
      ["bookings", "public.tractors"],
      ["booking_recipients", "public.bookings"],
      ["booking_status_history", "public.bookings"],
      ["work_events", "public.bookings"],
      ["invoices", "public.bookings"],
      ["payments", "public.invoices"],
      ["provider_events", "public.payments"],
      ["notification_delivery_events", "public.notifications"],
    ] as const;

    for (const [table, target] of requiredReferences) {
      expect(tableBody(table), `expected ${table} to reference ${target}`).toMatch(
        new RegExp(`REFERENCES ${target.replace(".", "\\.")}\\(id\\)`, "i"),
      );
    }
  });

  it("enforces append-only recipient, agreement, status, work, invoice, payment, provider, and audit history", () => {
    const appendOnlyTables = [
      "booking_recipients",
      "booking_agreements",
      "booking_status_history",
      "work_events",
      "work_measurements",
      "invoices",
      "payment_events",
      "provider_events",
      "audit_events",
    ];

    expect(upSql).toMatch(/CREATE FUNCTION public\.reject_append_only_mutation\(\)/i);
    for (const table of appendOnlyTables) {
      expect(upSql, `expected append-only trigger on ${table}`).toMatch(
        new RegExp(
          `BEFORE UPDATE OR DELETE ON public\\.${table}[\\s\\S]*?EXECUTE FUNCTION public\\.reject_append_only_mutation\\(\\)`,
          "i",
        ),
      );
    }
  });

  it("leaves task 2.2 uniqueness and scheduling work to a later migration", () => {
    expect(upSql).not.toMatch(/EXCLUDE\s+USING\s+gist/i);
    expect(upSql).not.toMatch(/UNIQUE\s*\(provider,\s*provider_event_id\)/i);
    expect(upSql).not.toMatch(/UNIQUE\s*\(actor_scope,\s*idempotency_key\)/i);
    expect(upSql).not.toMatch(/UNIQUE\s*\(public_reference\)/i);
  });
});

const integrityMigration = migrations[1];
if (integrityMigration === undefined) {
  throw new Error("Integrity and query indexes migration is not registered");
}

const integrityUpSql = readFileSync(integrityMigration.up, "utf8");
const integrityDownSql = readFileSync(integrityMigration.down, "utf8");

const expectsReversibleIndex = (indexName: string): void => {
  expect(integrityUpSql, `expected ${indexName} to be created`).toMatch(
    new RegExp(`CREATE(?: UNIQUE)? INDEX ${indexName}\\b`, "i"),
  );
  expect(integrityDownSql, `expected ${indexName} to be dropped`).toMatch(
    new RegExp(`DROP INDEX IF EXISTS public\\.${indexName}\\b`, "i"),
  );
};

describe("0002 integrity and query indexes migration", () => {
  it("is registered after the initial migration and is transactional", () => {
    expect(integrityMigration.id).toBe("0002_integrity_and_query_indexes");
    expect(integrityUpSql.trimStart()).toMatch(/^BEGIN;/);
    expect(integrityUpSql.trimEnd()).toMatch(/COMMIT;$/);
    expect(integrityDownSql.trimStart()).toMatch(/^BEGIN;/);
    expect(integrityDownSql.trimEnd()).toMatch(/COMMIT;$/);
  });

  it("enforces lookup, public-reference, provider-event, and idempotency uniqueness", () => {
    const uniqueIndexes = [
      "users_active_phone_lookup_hash_uniq",
      "tractors_registration_lookup_hash_uniq",
      "bookings_public_reference_uniq",
      "provider_events_provider_event_uniq",
      "idempotency_records_scope_key_uniq",
    ];

    for (const indexName of uniqueIndexes) {
      expectsReversibleIndex(indexName);
      expect(integrityUpSql).toMatch(
        new RegExp(`CREATE UNIQUE INDEX ${indexName}\\b`, "i"),
      );
    }

    expect(integrityUpSql).toMatch(
      /ON public\.users \(phone_lookup_hash\)[\s\S]*?WHERE status = 'ACTIVE' AND deleted_at IS NULL/i,
    );
    expect(integrityUpSql).toMatch(
      /ON public\.provider_events \(provider, provider_event_id\)/i,
    );
    expect(integrityUpSql).toMatch(
      /ON public\.idempotency_records \(actor_scope, idempotency_key\)/i,
    );
  });

  it("indexes phone lookups and geospatial discovery filters", () => {
    const discoveryIndexes = [
      "booking_recipients_phone_lookup_idx",
      "ivr_sessions_caller_phone_lookup_idx",
      "locations_coordinates_gist_idx",
      "tractors_discovery_idx",
      "service_offerings_discovery_idx",
      "pricing_rules_active_lookup_idx",
    ];

    for (const indexName of discoveryIndexes) {
      expectsReversibleIndex(indexName);
    }

    expect(integrityUpSql).toMatch(
      /CREATE INDEX locations_coordinates_gist_idx\s+ON public\.locations USING gist \(coordinates\)/i,
    );
    expect(integrityUpSql).toMatch(
      /CREATE INDEX tractors_discovery_idx[\s\S]*?operational_status[\s\S]*?eligibility_status[\s\S]*?location_updated_at DESC[\s\S]*?current_location_id[\s\S]*?id/i,
    );
  });

  it("provides stable cursor indexes for bounded histories and dispatch", () => {
    const cursorIndexes = [
      "bookings_customer_history_cursor_idx",
      "bookings_owner_history_cursor_idx",
      "bookings_tractor_schedule_cursor_idx",
      "booking_status_history_cursor_idx",
      "tractor_availability_history_cursor_idx",
      "invoices_booking_history_cursor_idx",
      "payments_invoice_history_cursor_idx",
      "payment_events_history_cursor_idx",
      "notifications_recipient_history_cursor_idx",
      "audit_events_resource_history_cursor_idx",
      "outbox_events_dispatch_cursor_idx",
    ];

    for (const indexName of cursorIndexes) {
      expectsReversibleIndex(indexName);
    }

    expect(integrityUpSql).toMatch(
      /ON public\.bookings \(customer_id, created_at DESC, id DESC\)/i,
    );
    expect(integrityUpSql).toMatch(
      /ON public\.payments \(invoice_id, created_at DESC, id DESC\)/i,
    );
  });

  it("blocks same-tractor overlap only for blocking statuses with half-open intervals", () => {
    expect(integrityUpSql).toMatch(/CREATE EXTENSION IF NOT EXISTS btree_gist/i);
    expect(integrityUpSql).toMatch(
      /ADD CONSTRAINT bookings_no_overlapping_blocking_intervals\s+EXCLUDE USING gist/i,
    );
    expect(integrityUpSql).toMatch(/tractor_id WITH =/i);
    expect(integrityUpSql).toMatch(
      /tstzrange\(requested_start_at, requested_end_at, '\[\)'\) WITH &&/i,
    );
    expect(integrityUpSql).toMatch(
      /WHERE \(status IN \('ACCEPTED', 'SCHEDULED', 'IN_PROGRESS'\)\)/i,
    );
    expect(integrityDownSql).toMatch(
      /DROP CONSTRAINT IF EXISTS bookings_no_overlapping_blocking_intervals/i,
    );
  });
});

const identityMigration = migrations[2];
if (identityMigration === undefined) {
  throw new Error("Identity and sessions migration is not registered");
}

const identityUpSql = readFileSync(identityMigration.up, "utf8");
const identityDownSql = readFileSync(identityMigration.down, "utf8");

describe("0003 identity and sessions migration", () => {
  it("persists only hashed OTP and session credentials with expiry and revocation", () => {
    expect(identityMigration.id).toBe("0003_identity_and_sessions");
    expect(identityUpSql.trimStart()).toMatch(/^BEGIN;/);
    expect(identityUpSql.trimEnd()).toMatch(/COMMIT;$/);
    expect(identityUpSql).toMatch(/CREATE TABLE public\.otp_challenges/i);
    expect(identityUpSql).toMatch(/code_hash text NOT NULL/i);
    expect(identityUpSql).not.toMatch(/\botp_code\b|\bcode text\b/i);
    expect(identityUpSql).toMatch(/expires_at timestamptz NOT NULL/i);
    expect(identityUpSql).toMatch(/max_attempts integer NOT NULL/i);
    expect(identityUpSql).toMatch(/CREATE TABLE public\.auth_sessions/i);
    expect(identityUpSql).toMatch(/access_token_hash text NOT NULL/i);
    expect(identityUpSql).toMatch(/refresh_token_hash text NOT NULL/i);
    expect(identityUpSql).not.toMatch(/access_token text|refresh_token text/i);
    expect(identityUpSql).toMatch(/revoked_at timestamptz/i);
  });

  it("enforces explicit active roles, throttle indexes, and credential uniqueness", () => {
    expect(identityUpSql).toMatch(
      /CREATE UNIQUE INDEX user_role_memberships_active_role_uniq[\s\S]*?WHERE revoked_at IS NULL/i,
    );
    expect(identityUpSql).toMatch(/otp_challenges_phone_request_window_idx/i);
    expect(identityUpSql).toMatch(/otp_challenges_requester_window_idx/i);
    expect(identityUpSql).toMatch(/auth_sessions_access_token_hash_uniq/i);
    expect(identityUpSql).toMatch(/auth_sessions_refresh_token_hash_uniq/i);
  });

  it("is reversible", () => {
    expect(identityDownSql.trimStart()).toMatch(/^BEGIN;/);
    expect(identityDownSql).toMatch(/DROP TABLE IF EXISTS public\.auth_sessions/i);
    expect(identityDownSql).toMatch(/DROP TABLE IF EXISTS public\.otp_challenges/i);
    expect(identityDownSql).toMatch(/DROP TYPE IF EXISTS otp_purpose/i);
    expect(identityDownSql.trimEnd()).toMatch(/COMMIT;$/);
  });
});

const tractorPhotosMigration = migrations[3];

if (tractorPhotosMigration === undefined) {
  throw new Error("Tractor photos migration is not registered");
}

const tractorPhotosUpSql = readFileSync(tractorPhotosMigration.up, "utf8");
const tractorPhotosDownSql = readFileSync(tractorPhotosMigration.down, "utf8");

describe("0004 tractor photos migration", () => {
  it("stores only encrypted private object keys with bounded ordered metadata", () => {
    expect(tractorPhotosMigration.id).toBe("0004_tractor_photos");
    expect(tractorPhotosUpSql).toContain("object_key_ciphertext bytea NOT NULL");
    expect(tractorPhotosUpSql).not.toMatch(/\bobject_key\s+text\b/iu);
    expect(tractorPhotosUpSql).toContain("UNIQUE (tractor_id, sort_order)");
    expect(tractorPhotosUpSql).toContain("sort_order BETWEEN 0 AND 7");
    expect(tractorPhotosDownSql).toContain("DROP TABLE IF EXISTS public.tractor_photos");
  });
});


const catalogManagementMigration = migrations[4];

if (catalogManagementMigration === undefined) {
  throw new Error("Catalog management migration is not registered");
}

const catalogManagementUpSql = readFileSync(catalogManagementMigration.up, "utf8");
const catalogManagementDownSql = readFileSync(catalogManagementMigration.down, "utf8");

describe("0005 catalog management migration", () => {
  it("prevents duplicate Service Offering identities and indexes eligibility inputs", () => {
    expect(catalogManagementMigration.id).toBe("0005_catalog_management");
    expect(catalogManagementUpSql).toMatch(
      /CREATE UNIQUE INDEX service_offerings_tractor_service_equipment_uniq[\s\S]*?tractor_id[\s\S]*?service_id[\s\S]*?COALESCE\(equipment_id/iu,
    );
    expect(catalogManagementUpSql).toContain("equipment_owner_inventory_idx");
    expect(catalogManagementUpSql).toContain("documents_tractor_eligibility_idx");
    expect(catalogManagementDownSql).toContain(
      "DROP INDEX IF EXISTS public.service_offerings_tractor_service_equipment_uniq",
    );
  });
});

const privateDocumentsMigration = migrations[5];

if (privateDocumentsMigration === undefined) {
  throw new Error("Private documents migration is not registered");
}

const privateDocumentsUpSql = readFileSync(privateDocumentsMigration.up, "utf8");
const privateDocumentsDownSql = readFileSync(privateDocumentsMigration.down, "utf8");

describe("0006 private documents migration", () => {
  it("persists inspection, encryption, scan, acceptance, rejection, and grant metadata", () => {
    expect(privateDocumentsMigration.id).toBe("0006_private_documents");
    expect(privateDocumentsUpSql.trimStart()).toMatch(/^BEGIN;/u);
    expect(privateDocumentsUpSql).toContain("uploaded_size_bytes bigint");
    expect(privateDocumentsUpSql).toContain("object_encryption_algorithm text");
    expect(privateDocumentsUpSql).toContain("upload_grant_expires_at timestamptz");
    expect(privateDocumentsUpSql).toContain("scan_completed_at timestamptz");
    expect(privateDocumentsUpSql).toContain("accepted_at timestamptz");
    expect(privateDocumentsUpSql).toContain("rejection_code text");
    expect(privateDocumentsUpSql).toContain("documents_private_metadata_consistency");
    expect(privateDocumentsUpSql).toContain("documents_private_object_key_uniq");
    expect(privateDocumentsUpSql.trimEnd()).toMatch(/COMMIT;$/u);
  });

  it("reverses every added private-document field and index", () => {
    expect(privateDocumentsDownSql).toContain("DROP INDEX IF EXISTS public.documents_private_object_key_uniq");
    for (const column of [
      "original_file_name",
      "uploaded_size_bytes",
      "object_encryption_algorithm",
      "upload_grant_expires_at",
      "scan_completed_at",
      "accepted_at",
      "rejection_code",
    ]) {
      expect(privateDocumentsDownSql).toContain(`DROP COLUMN IF EXISTS ${column}`);
    }
    expect(privateDocumentsDownSql.trimEnd()).toMatch(/COMMIT;$/u);
  });
});

/** Validates: Requirements 6.1, 6.2 */
describe("0007 Pricing Rule command integrity", () => {
  const pricingMigration = migrations.find(({ id }) => id === "0007_pricing_rule_commands");

  it("keeps one command target per Service Offering and pricing method", () => {
    expect(pricingMigration).toBeDefined();
    const pricingUpSql = readFileSync(pricingMigration!.up, "utf8");
    const pricingDownSql = readFileSync(pricingMigration!.down, "utf8");
    expect(pricingUpSql).toMatch(/CREATE UNIQUE INDEX pricing_rules_offering_method_unique_idx[\s\S]*service_offering_id, method/iu);
    expect(pricingDownSql).toMatch(/DROP INDEX IF EXISTS public\.pricing_rules_offering_method_unique_idx/iu);
  });
});
/** Validates: Requirements 18.3, 18.4 */
describe("0015 load-profile indexes", () => {
  const loadMigration = migrations.find(({ id }) => id === "0015_load_profile_indexes");

  it("is registered after 0014 and adds only reversible indexes", () => {
    const ids = migrations.map(({ id }) => id);
    expect(ids.indexOf("0015_load_profile_indexes")).toBe(ids.indexOf("0014_outbox_correlation") + 1);
    const upSql = readFileSync(loadMigration!.up, "utf8");
    const downSql = readFileSync(loadMigration!.down, "utf8");
    expect(upSql.trimStart()).toMatch(/^BEGIN;/u);
    expect(upSql.trimEnd()).toMatch(/COMMIT;$/u);
    expect(upSql).not.toMatch(/\b(ALTER|DROP|UPDATE|DELETE)\b/iu);
    for (const [name, definition] of [
      ["tractors_current_location_idx", /ON public\.tractors \(current_location_id\)/u],
      ["booking_recipients_booking_idx", /ON public\.booking_recipients \(booking_id\)/u],
      ["tractors_owner_inventory_idx", /ON public\.tractors \(owner_id, created_at DESC, id DESC\)/u],
    ] as const) {
      expect(upSql).toMatch(new RegExp(`CREATE INDEX ${name}\\s+${definition.source}`, "u"));
      expect(downSql).toContain(`DROP INDEX IF EXISTS public.${name};`);
    }
  });
});

/** Validates: Requirements 7.1, 7.7, 12.6 */
describe("0009 normalized Location records", () => {
  const locationMigration = migrations.find(({ id }) => id === "0009_normalized_locations");

  it("stores disclosed purpose and enforces normalized manual administrative fields", () => {
    expect(locationMigration).toBeDefined();
    const locationUpSql = readFileSync(locationMigration!.up, "utf8");
    expect(locationUpSql).toContain("collection_purpose text");
    expect(locationUpSql).toContain("locations_collection_purpose_check");
    expect(locationUpSql).toContain("locations_administrative_parts_check");
    expect(locationUpSql).toContain("locations_optional_parts_check");
    expect(locationUpSql).toContain("locations_manual_admin_lookup_idx");
  });

  it("requires coordinates, accuracy, and recorded consent for device GPS", () => {
    const locationUpSql = readFileSync(locationMigration!.up, "utf8");
    expect(locationUpSql).toMatch(/source <> 'DEVICE_GPS'[\s\S]*?coordinates IS NOT NULL[\s\S]*?accuracy_meters IS NOT NULL[\s\S]*?location_consent_at IS NOT NULL/iu);
    expect(locationUpSql).toMatch(/location_consent_at IS NULL OR location_consent_at <= captured_at/iu);
  });

  it("reverses the location constraints, index, and purpose column", () => {
    const locationDownSql = readFileSync(locationMigration!.down, "utf8");
    expect(locationDownSql).toContain("DROP INDEX IF EXISTS public.locations_manual_admin_lookup_idx");
    expect(locationDownSql).toContain("DROP CONSTRAINT IF EXISTS locations_coordinate_metadata_check");
    expect(locationDownSql).toContain("DROP COLUMN IF EXISTS collection_purpose");
  });
});

/** Validates: Requirements 18.5 */
describe("0016 reference-data identity", () => {
  const migration = migrations.find(({ id }) => id === "0016_reference_data_identity");

  it("makes each stable code name one Service and one Equipment Type, reversibly", () => {
    const upSql = readFileSync(migration!.up, "utf8");
    const downSql = readFileSync(migration!.down, "utf8");
    expect(upSql).toMatch(/CREATE UNIQUE INDEX services_stable_code_uniq\s+ON public\.services \(stable_code\)/u);
    expect(upSql).toMatch(/CREATE UNIQUE INDEX equipment_types_stable_code_uniq\s+ON public\.equipment_types \(stable_code\)/u);
    expect(upSql).not.toMatch(/\b(ALTER|DROP|UPDATE|DELETE|INSERT)\b/iu);
    expect(downSql).toContain("DROP INDEX IF EXISTS public.services_stable_code_uniq;");
    expect(downSql).toContain("DROP INDEX IF EXISTS public.equipment_types_stable_code_uniq;");
  });
});

/** Validates: Requirements 12.4, 12.5 */
describe("0017 account erasure", () => {
  const migration = migrations.find(({ id }) => id === "0017_account_erasure");

  it("is registered after 0016 and relaxes booking_recipients only for erasure redaction", () => {
    const ids = migrations.map(({ id }) => id);
    expect(ids.indexOf("0017_account_erasure")).toBe(ids.indexOf("0016_reference_data_identity") + 1);
    const upSql = readFileSync(migration!.up, "utf8");
    expect(upSql).toContain("current_setting('app.account_erasure', true) = 'on'");
    for (const unchanged of ["id", "booking_id", "coordination_consent", "service_location_snapshot", "created_at"]) {
      expect(upSql).toContain(`NEW.${unchanged} = OLD.${unchanged}`);
    }
    expect(upSql).toMatch(/TG_OP = 'UPDATE'/u);
    expect(upSql).toMatch(/CREATE OR REPLACE TRIGGER booking_recipients_append_only[\s\S]*guard_booking_recipient_mutation\(\)/u);
    expect(upSql).not.toMatch(/\bDROP\b/iu);
  });

  it("restores the strict append-only trigger on rollback", () => {
    const downSql = readFileSync(migration!.down, "utf8");
    expect(downSql).toMatch(/CREATE OR REPLACE TRIGGER booking_recipients_append_only[\s\S]*reject_append_only_mutation\(\)/u);
    expect(downSql).toContain("DROP FUNCTION IF EXISTS public.guard_booking_recipient_mutation();");
  });
});

/** Validates: Requirements 11.5, 11.6, 12.3 */
describe("0018 online payment provider events", () => {
  const migration = migrations.find(({ id }) => id === "0018_online_payment_provider_events");

  it("is registered after 0017 and adds only reversible provider lookup indexes", () => {
    const ids = migrations.map(({ id }) => id);
    expect(ids.indexOf("0018_online_payment_provider_events")).toBe(ids.indexOf("0017_account_erasure") + 1);
    const upSql = readFileSync(migration!.up, "utf8");
    const downSql = readFileSync(migration!.down, "utf8");
    expect(upSql.trimStart()).toMatch(/^BEGIN;/u);
    expect(upSql.trimEnd()).toMatch(/COMMIT;$/u);
    expect(upSql).not.toMatch(/\b(ALTER|DROP|UPDATE|DELETE|INSERT)\b/iu);
    expect(upSql).toMatch(
      /CREATE UNIQUE INDEX payments_provider_reference_uniq\s+ON public\.payments \(provider, provider_reference\)\s+WHERE provider_reference IS NOT NULL;/u,
    );
    expect(upSql).toMatch(/CREATE INDEX provider_events_payload_digest_idx\s+ON public\.provider_events \(provider, payload_digest\);/u);
    expect(downSql).toContain("DROP INDEX IF EXISTS public.payments_provider_reference_uniq;");
    expect(downSql).toContain("DROP INDEX IF EXISTS public.provider_events_payload_digest_idx;");
  });
});

/** Validates: Requirements 11.1, 11.6, 11.7, 12.3, 12.4 */
describe("0019 payment refunds and recovery", () => {
  const migration = migrations.find(({ id }) => id === "0019_payment_refunds_and_recovery");

  it("is registered after 0018 and only adds nullable or defaulted columns, a refund table, and indexes", () => {
    const ids = migrations.map(({ id }) => id);
    expect(ids.indexOf("0019_payment_refunds_and_recovery")).toBe(ids.indexOf("0018_online_payment_provider_events") + 1);
    const upSql = readFileSync(migration!.up, "utf8");
    expect(upSql.trimStart()).toMatch(/^BEGIN;/u);
    expect(upSql.trimEnd()).toMatch(/COMMIT;$/u);
    expect(upSql).not.toMatch(/\bDROP\b|\bUPDATE\s+public\.|\bDELETE\s+FROM\b|\bINSERT\b|\bRENAME\b/iu);
    expect(upSql).toMatch(/ALTER TABLE public\.payments ADD COLUMN provider_payment_id text;/u);
    expect(upSql).toMatch(/CREATE UNIQUE INDEX payments_provider_payment_id_uniq\s+ON public\.payments \(provider_payment_id\)/u);
    expect(upSql).toMatch(/CREATE TABLE public\.payment_refunds \(/u);
    expect(upSql).toMatch(/amount_paise bigint NOT NULL CHECK \(amount_paise > 0\)/u);
    // Full refunds only: one refund per payment can be in flight or processed.
    expect(upSql).toMatch(/CREATE UNIQUE INDEX payment_refunds_one_open_or_processed_uniq\s+ON public\.payment_refunds \(payment_id\)\s+WHERE status IN \('REQUESTED', 'SUBMITTED', 'PROCESSED'\);/u);
    expect(upSql).toMatch(/ADD COLUMN evidence_source provider_evidence_source NOT NULL DEFAULT 'WEBHOOK';/u);
    // Refund reasons are codes; no free-text column can carry personal data.
    expect(upSql).toMatch(/reason_code text NOT NULL CHECK \(reason_code IN \(/u);
  });

  it("rolls back every added object", () => {
    const downSql = readFileSync(migration!.down, "utf8");
    for (const statement of [
      "DROP TABLE IF EXISTS public.payment_refunds;",
      "ALTER TABLE public.payments DROP COLUMN IF EXISTS provider_payment_id;",
      "ALTER TABLE public.payments DROP COLUMN IF EXISTS provider_mode;",
      "ALTER TABLE public.payments DROP COLUMN IF EXISTS reconciled_at;",
      "ALTER TABLE public.provider_events DROP COLUMN IF EXISTS evidence_source;",
      "ALTER TABLE public.provider_events DROP COLUMN IF EXISTS payment_refund_id;",
      "DROP TYPE IF EXISTS payment_refund_status;",
      "DROP TYPE IF EXISTS provider_evidence_source;",
    ]) {
      expect(downSql).toContain(statement);
    }
  });
});

/** Validates: Requirements 12.1, 12.5, 17.6, 18.5 */
describe("0020 messaging delivery", () => {
  const migration = migrations.find(({ id }) => id === "0020_messaging_delivery");

  it("is registered after 0019 and only adds a push-device table, its indexes, and a nullable column", () => {
    const ids = migrations.map(({ id }) => id);
    expect(ids.indexOf("0020_messaging_delivery")).toBe(ids.indexOf("0019_payment_refunds_and_recovery") + 1);
    const upSql = readFileSync(migration!.up, "utf8");
    expect(upSql.trimStart()).toMatch(/^BEGIN;/u);
    expect(upSql.trimEnd()).toMatch(/COMMIT;$/u);
    expect(upSql).not.toMatch(/\bDROP\b|\bUPDATE\s+public\.|\bDELETE\s+FROM\b|\bINSERT\b|\bRENAME\b|SET NOT NULL/iu);
    expect(upSql).toMatch(/CREATE TABLE public\.push_device_registrations \(/u);
    // Tokens are stored encrypted and found by keyed hash; there is no plaintext token column.
    expect(upSql).toMatch(/token_ciphertext bytea NOT NULL/u);
    expect(upSql).not.toMatch(/\btoken text\b/u);
    expect(upSql).toMatch(/CREATE UNIQUE INDEX push_device_registrations_token_uniq\s+ON public\.push_device_registrations \(token_lookup_hash\);/u);
    expect(upSql).toMatch(/ALTER TABLE public\.notifications ADD COLUMN template_version integer;/u);
  });

  it("rolls back every added object", () => {
    const downSql = readFileSync(migration!.down, "utf8");
    for (const statement of [
      "ALTER TABLE public.notifications DROP COLUMN IF EXISTS template_version;",
      "DROP TABLE IF EXISTS public.push_device_registrations;",
    ]) {
      expect(downSql).toContain(statement);
    }
  });
});

/** Validates: Requirements 1.4, 10.8, 12.4, 18.5 */
describe("0021 support cases", () => {
  const migration = migrations.find(({ id }) => id === "0021_support_cases");

  it("is registered before later additive migrations and only adds support tables and their indexes", () => {
    expect(migrations.findIndex(({ id }) => id === "0021_support_cases")).toBeLessThan(
      migrations.findIndex(({ id }) => id === "0022_owner_earnings_report_indexes"),
    );
    const upSql = readFileSync(migration!.up, "utf8");
    expect(upSql.trimStart()).toMatch(/^BEGIN;/u);
    expect(upSql.trimEnd()).toMatch(/COMMIT;$/u);
    expect(upSql).not.toMatch(/\bDROP\b|\bUPDATE\s+public\.|\bDELETE\s+FROM\b|\bINSERT\b|\bRENAME\b|SET NOT NULL|ALTER TABLE/iu);
    for (const table of ["support_cases", "support_case_entries", "support_access_grants"]) {
      expect(upSql).toMatch(new RegExp(`CREATE TABLE public\\.${table} \\(`, "u"));
    }
    // At most one open case per booking; grants are time-bounded (7 days at most) and bound to one case's booking.
    expect(upSql).toMatch(/CREATE UNIQUE INDEX support_cases_one_open_per_booking_uniq\s+ON public\.support_cases \(booking_id\)\s+WHERE status = 'OPEN';/u);
    expect(upSql).toMatch(/expires_at > valid_from AND expires_at <= valid_from \+ interval '7 days'/u);
    expect(upSql).toMatch(/FOREIGN KEY \(case_id, booking_id\) REFERENCES public\.support_cases \(id, booking_id\)/u);
    // Outcomes and reasons are codes; the only free text is an erasable, bounded statement.
    expect(upSql).toMatch(/resolution_reason_code text CHECK \(resolution_reason_code ~ '\^\[A-Z0-9_\]\{1,64\}\$'\)/u);
    expect(upSql).toMatch(/statement_text text CHECK \(statement_text IS NULL OR char_length\(statement_text\) BETWEEN 1 AND 500\)/u);
    expect(upSql).not.toMatch(/ON DELETE CASCADE/u);
  });

  it("rolls back every added table", () => {
    const downSql = readFileSync(migration!.down, "utf8");
    for (const statement of [
      "DROP TABLE IF EXISTS public.support_access_grants;",
      "DROP TABLE IF EXISTS public.support_case_entries;",
      "DROP TABLE IF EXISTS public.support_cases;",
    ]) {
      expect(downSql).toContain(statement);
    }
  });
});
