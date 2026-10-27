import { randomBytes } from "node:crypto";

import { withTransaction } from "@kisantractor/database";
import {
  REPRESENTATIVE_TABLES,
  createTestDatabaseFactory,
  seedRepresentativeDataset,
  tableChecksums,
  type RepresentativeDataset,
  type TestDatabase,
} from "@kisantractor/test-utils";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ERASED_PROFILE_NAME, REDACTED_RECIPIENT_NAME } from "../account/account-deletion.contracts.js";
import { CLOSED_BOOKING_STATUSES } from "../account/account-deletion.service.js";
import { PostgresAccountDeletionStore } from "../account/postgres-account-deletion-store.js";
import { PostgresMessagingDirectory } from "../notification/messaging-directory.js";
import { PgPoolAdapter } from "../sql-pool.js";

/**
 * Account deletion against PostgreSQL (Requirement 12.5): personal data is erased or anonymized,
 * while bookings, agreements, status history, work evidence, invoices, payments, notifications,
 * and audit events stay byte-for-byte unchanged. Skipped unless
 * ACCOUNT_DELETION_INTEGRATION_DATABASE_URL names a local database whose name contains `test`.
 *
 * Validates: Requirements 12.4, 12.5
 */
const databaseUrl = process.env.ACCOUNT_DELETION_INTEGRATION_DATABASE_URL;
const describeDatabase = databaseUrl === undefined ? describe.skip : describe;

/** Financial, contractual, and audit history kept under the retention policy. */
const RETAINED_TABLES = [
  "bookings", "booking_agreements", "booking_status_history", "work_events", "work_measurements",
  "invoices", "payments", "payment_events", "notifications", "notification_delivery_events",
] as const;

/** Personal data the representative dataset gives the Farmer of ordinal 1 (and its Recipient). */
const farmerPii = (ordinal: number): string[] => [
  "Anita Rao", "Suresh Rao", "Near the water tank", "Behind the cotton market",
  `fixture-phone-farmer-${ordinal}`, `fixture-phone-recipient-${ordinal}`,
  Buffer.from(`fixture-farmer-${ordinal}`).toString("hex"),
  Buffer.from(`fixture-recipient-${ordinal}`).toString("hex"),
];
const ownerPii = (ordinal: number): string[] => [
  "Raju Naik", `fixture-phone-owner-${ordinal}`, `fixture-registration-${ordinal}`, "raju-rc.pdf",
  Buffer.from(`fixture-owner-${ordinal}`).toString("hex"),
  Buffer.from(`fixture-registration-${ordinal}`).toString("hex"),
  Buffer.from(`fixture-photo-key-${ordinal}`).toString("hex"),
];

describeDatabase("account deletion (PostgreSQL)", () => {
  let database: TestDatabase;
  let pool: PgPoolAdapter;
  let store: PostgresAccountDeletionStore;

  const erase = (userId: string, correlationId = `account-delete-${userId.slice(0, 8)}`) =>
    store.eraseAccount({ userId, actorChannel: "WEB", correlationId, closedBookingStatuses: CLOSED_BOOKING_STATUSES });

  /** Rows of a table as JSON, keyed by `keyColumn`, optionally restricted to `keys`. */
  const rows = async (table: string, keyColumn = "id", keys?: readonly string[]): Promise<Record<string, unknown>> => {
    const result = await pool.query<{ key: string; row: unknown }>(
      `SELECT ${keyColumn}::text AS key, to_jsonb(t) AS row FROM public.${table} t
       ${keys === undefined ? "" : `WHERE ${keyColumn}::text = ANY($1::text[])`} ORDER BY 1`,
      keys === undefined ? [] : [keys],
    );
    return Object.fromEntries(result.rows.map(({ key, row }) => [key, row]));
  };

  /** Tables (application schema) whose row text still contains `needle`. */
  const tablesContaining = async (needle: string): Promise<string[]> => {
    const found: string[] = [];
    for (const table of [...REPRESENTATIVE_TABLES]) {
      const hit = await pool.query<{ hit: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM public.${table} t WHERE strpos(t::text, $1) > 0) AS hit`, [needle]);
      if (hit.rows[0]?.hit) found.push(table);
    }
    return found;
  };

  /** Everything that belongs to one dataset's people, for an unchanged-state check. */
  const datasetRows = async (data: RepresentativeDataset) => ({
    users: await rows("users", "id", [data.customerId, data.ownerId]),
    profiles: await rows("user_profiles", "user_id", [data.customerId, data.ownerId]),
    owners: await rows("owner_profiles", "user_id", [data.ownerId]),
    roles: await rows("user_role_memberships", "user_id", [data.customerId, data.ownerId]),
    locations: await rows("locations", "id", [data.customerLocationId, data.ownerLocationId]),
    tractors: await rows("tractors", "id", [data.tractorId]),
    availability: await rows("tractor_availability", "tractor_id", [data.tractorId]),
    photos: await rows("tractor_photos", "id", [data.tractorPhotoId]),
    equipment: await rows("equipment", "id", [data.equipmentId]),
    documents: await rows("documents", "id", [data.documentId]),
    offerings: await rows("service_offerings", "id", [data.serviceOfferingId]),
    recipients: await rows("booking_recipients", "id", [data.recipientId]),
    sessions: await rows("auth_sessions", "id", [data.sessionId]),
    otp: await rows("otp_challenges", "id", [data.otpChallengeId]),
    ivr: await rows("ivr_sessions", "id", [data.ivrSessionId]),
    idempotency: await rows("idempotency_records", "actor_scope", [data.idempotencyScope]),
    pushDevices: await rows("push_device_registrations", "user_id", [data.customerId, data.ownerId]),
  });

  /** One push registration (migration 0020); the ciphertext is a recognizable fixture value. */
  const registerPushDevice = (userId: string, label: string) => pool.query(
    `INSERT INTO public.push_device_registrations (user_id, platform, token_ciphertext, token_lookup_hash)
     VALUES ($1, 'WEB', $2, encode(sha256($2), 'hex'))`,
    [userId, Buffer.from(`fixture-push-token-${label}`)]);

  beforeAll(async () => {
    pool = new PgPoolAdapter(new Pool({ connectionString: databaseUrl, max: 6 }));
    database = await createTestDatabaseFactory({ databaseUrl: databaseUrl!, createPool: async () => pool })();
    store = new PostgresAccountDeletionStore(pool);
  }, 120_000);

  beforeEach(async () => {
    await database.reset();
  });

  afterAll(async () => {
    await database?.dispose();
  });

  it("erases a Farmer's personal data and keeps financial and audit records unchanged", async () => {
    // One dataset only, so the whole-database scan below can search for its names.
    const farmer = await seedRepresentativeDataset(pool, { ordinal: 1 });
    await registerPushDevice(farmer.customerId, "farmer-1");
    const retainedBefore = Object.fromEntries(await Promise.all(RETAINED_TABLES.map(async (table) => [table, await rows(table)] as const)));
    const auditBefore = await rows("audit_events");
    const outboxBefore = await rows("outbox_events");
    for (const needle of farmerPii(1)) expect(await tablesContaining(needle), needle).not.toEqual([]);

    const result = await erase(farmer.customerId);

    expect(result).toMatchObject({
      status: "ERASED",
      userId: farmer.customerId,
      erased: {
        sessionsRevoked: 1, rolesRevoked: 1, profileAnonymized: true, locationsDeleted: 1, locationsCoarsened: 0,
        privateFilesDeleted: 0, tractorPhotosDeleted: 0, tractorsWithdrawn: 0, recipientSnapshotsRedacted: 1,
        otpChallengesDeleted: 1, idempotencyRecordsDeleted: 1, ivrSessionsRedacted: 1, pushDevicesDeleted: 1,
      },
      retained: { bookings: 1, invoices: 1, payments: 1, auditEvents: 1 },
    });
    // Push registration tokens of the erased account are gone, so no push can reach its devices.
    expect((await pool.query("SELECT 1 FROM public.push_device_registrations WHERE user_id = $1", [farmer.customerId])).rowCount).toBe(0);

    // No trace of the Farmer's or Recipient's name, phone, directions, or ciphertext remains anywhere.
    for (const needle of farmerPii(1)) expect(await tablesContaining(needle), needle).toEqual([]);

    const user = (await pool.query<{ status: string; deleted_at: Date | null; phone: Buffer; phone_lookup_hash: string }>(
      "SELECT status, deleted_at, normalized_phone_ciphertext AS phone, phone_lookup_hash FROM public.users WHERE id = $1",
      [farmer.customerId])).rows[0]!;
    expect(user.status).toBe("DELETED");
    expect(user.deleted_at).toBeInstanceOf(Date);
    expect(user.phone.length).toBe(0);
    expect(user.phone_lookup_hash).toBe(`erased:${farmer.customerId}`);
    expect((await pool.query("SELECT full_name, contact_sharing_consent, default_location_id FROM public.user_profiles WHERE user_id = $1",
      [farmer.customerId])).rows[0]).toEqual({ full_name: ERASED_PROFILE_NAME, contact_sharing_consent: false, default_location_id: null });
    expect((await pool.query("SELECT revocation_reason FROM public.auth_sessions WHERE user_id = $1 AND revoked_at IS NOT NULL",
      [farmer.customerId])).rows).toEqual([{ revocation_reason: "ACCOUNT_DELETED" }]);
    expect((await pool.query("SELECT 1 FROM public.user_role_memberships WHERE user_id = $1 AND revoked_at IS NULL",
      [farmer.customerId])).rowCount).toBe(0);
    expect((await pool.query("SELECT 1 FROM public.locations WHERE id = $1", [farmer.customerLocationId])).rowCount).toBe(0);

    // The Recipient snapshot keeps only what the agreement needs: where the work happened.
    const recipient = (await pool.query<{ name: string; phone_ciphertext: Buffer | null; landmark_or_directions: string | null; service_location_snapshot: unknown }>(
      "SELECT name, phone_ciphertext, landmark_or_directions, service_location_snapshot FROM public.booking_recipients WHERE id = $1",
      [farmer.recipientId])).rows[0]!;
    expect(recipient).toMatchObject({ name: REDACTED_RECIPIENT_NAME, phone_ciphertext: null, landmark_or_directions: null });
    expect(recipient.service_location_snapshot).toMatchObject({ village: "Kazipet" });

    // Financial, contractual, and audit history: identical rows, plus one PII-free audit record.
    for (const table of RETAINED_TABLES) expect(await rows(table), table).toEqual(retainedBefore[table]);
    const auditAfter = await rows("audit_events");
    for (const [id, row] of Object.entries(auditBefore)) expect(auditAfter[id], `audit ${id}`).toEqual(row);
    const added = Object.keys(auditAfter).filter((id) => !(id in auditBefore));
    expect(added).toHaveLength(1);
    expect(auditAfter[added[0]!]).toMatchObject({
      actor_id: farmer.customerId, action: "account.delete", resource_type: "User", outcome: "SUCCESS",
      pii_safe_metadata: { profileAnonymized: true, retainedBookings: 1, retainedInvoices: 1 },
    });
    const outboxAfter = await rows("outbox_events");
    for (const [id, row] of Object.entries(outboxBefore)) expect(outboxAfter[id], `outbox ${id}`).toEqual(row);
    const erasedEvents = Object.values(outboxAfter).filter((row) => (row as { event_type: string }).event_type === "AccountErased");
    expect(erasedEvents).toEqual([expect.objectContaining({
      aggregate_type: "User", aggregate_id: farmer.customerId, status: "PENDING",
      payload: { userId: farmer.customerId, erasedAt: expect.any(String), privateObjects: [] },
    })]);

    // The phone number is free to register a new, unlinked account.
    await expect(pool.query(
      "INSERT INTO public.users (normalized_phone_ciphertext, phone_lookup_hash) VALUES ($1, $2)",
      [Buffer.from("new-account"), "fixture-phone-farmer-1"])).resolves.toMatchObject({ rowCount: 1 });
  });

  it("stores push tokens encrypted through the messaging directory, moves re-registered ones, and erases them", async () => {
    const first = await seedRepresentativeDataset(pool, { ordinal: 1 });
    const second = await seedRepresentativeDataset(pool, { ordinal: 2 });
    // Synthetic per-run keys; real keys come from the secret store.
    const directory = new PostgresMessagingDirectory(pool, {
      phoneEncryptionKey: randomBytes(32), fieldEncryptionKey: randomBytes(32), lookupHashKey: randomBytes(32),
    });
    const tokenA = "fcm-registration-token-A:APA91bSyntheticFixture";
    const tokenB = "fcm-registration-token-B:APA91bSyntheticFixture";
    const tokensOf = async (userId: string) => (await directory.pushTokens(userId, 5)).map(({ token }) => token);

    await directory.registerPushDevice(first.customerId, tokenA, "WEB", new Date("2026-05-12T04:00:00.000Z"));
    await directory.registerPushDevice(first.customerId, tokenB, "ANDROID", new Date("2026-05-12T05:00:00.000Z"));
    expect(await tokensOf(first.customerId)).toEqual([tokenB, tokenA]);
    // No plaintext token is stored anywhere in the table.
    for (const token of [tokenA, tokenB]) {
      expect((await pool.query(
        `SELECT 1 FROM public.push_device_registrations
         WHERE position(convert_to($1, 'UTF8') IN token_ciphertext) > 0 OR strpos(token_lookup_hash, $1) > 0`, [token])).rowCount, token).toBe(0);
    }

    // Re-registering a token moves it to the registering account; only its holder can remove it.
    await directory.registerPushDevice(second.customerId, tokenA, "WEB", new Date("2026-05-12T06:00:00.000Z"));
    expect(await tokensOf(first.customerId)).toEqual([tokenB]);
    expect(await tokensOf(second.customerId)).toEqual([tokenA]);
    expect(await directory.unregisterPushDevice(first.customerId, tokenA)).toBe(false);
    expect(await tokensOf(second.customerId)).toEqual([tokenA]);

    // An FCM UNREGISTERED answer revokes the registration.
    const [registration] = await directory.pushTokens(first.customerId, 5);
    await directory.revokePushToken(registration!.registrationId);
    expect(await tokensOf(first.customerId)).toEqual([]);

    // Account deletion removes the account's devices and leaves other people's alone.
    await directory.registerPushDevice(first.customerId, tokenB, "ANDROID", new Date("2026-05-12T07:00:00.000Z"));
    expect(await erase(first.customerId)).toMatchObject({ status: "ERASED", erased: { pushDevicesDeleted: 1 } });
    expect(await tokensOf(first.customerId)).toEqual([]);
    expect(await tokensOf(second.customerId)).toEqual([tokenA]);
    expect(await directory.unregisterPushDevice(second.customerId, tokenA)).toBe(true);
    expect(await tokensOf(second.customerId)).toEqual([]);
  });

  it("changes nothing that belongs to other people", async () => {
    const erased = await seedRepresentativeDataset(pool, { ordinal: 1 });
    const unrelated = await seedRepresentativeDataset(pool, { ordinal: 2 });
    await registerPushDevice(erased.customerId, "farmer-1");
    await registerPushDevice(unrelated.customerId, "farmer-2");
    const unrelatedBefore = await datasetRows(unrelated);
    expect(await erase(erased.customerId)).toMatchObject({ status: "ERASED" });
    expect(await erase(erased.ownerId)).toMatchObject({ status: "ERASED" });
    expect(await datasetRows(unrelated)).toEqual(unrelatedBefore);
    for (const needle of [`fixture-phone-farmer-2`, `fixture-phone-owner-2`, `fixture-phone-recipient-2`]) {
      expect(await tablesContaining(needle), needle).not.toEqual([]);
    }
  });

  it("withdraws an Owner's Tractors, deletes private files, and coarsens operating locations", async () => {
    const data = await seedRepresentativeDataset(pool, { ordinal: 1 });
    const retainedBefore = Object.fromEntries(await Promise.all(RETAINED_TABLES.map(async (table) => [table, await rows(table)] as const)));

    const result = await erase(data.ownerId);

    expect(result).toMatchObject({
      status: "ERASED",
      erased: {
        sessionsRevoked: 0, rolesRevoked: 1, profileAnonymized: true, locationsDeleted: 0, locationsCoarsened: 1,
        privateFilesDeleted: 1, tractorPhotosDeleted: 1, tractorsWithdrawn: 1, recipientSnapshotsRedacted: 0,
      },
      retained: { bookings: 1, invoices: 1, payments: 1 },
    });
    for (const needle of ownerPii(1)) expect(await tablesContaining(needle), needle).toEqual([]);

    expect((await pool.query("SELECT operational_status, eligibility_status, registration_lookup_hash FROM public.tractors WHERE id = $1",
      [data.tractorId])).rows[0]).toEqual({
      operational_status: "OFFLINE", eligibility_status: "INELIGIBLE", registration_lookup_hash: `erased:${data.tractorId}`,
    });
    expect((await pool.query("SELECT operational_status, reason FROM public.tractor_availability WHERE tractor_id = $1",
      [data.tractorId])).rows[0]).toEqual({ operational_status: "OFFLINE", reason: "ACCOUNT_DELETED" });
    expect((await pool.query(
      "SELECT from_status, to_status, reason FROM public.tractor_availability_history WHERE tractor_id = $1 ORDER BY occurred_at DESC, id LIMIT 1",
      [data.tractorId])).rows[0]).toEqual({ from_status: "ONLINE", to_status: "OFFLINE", reason: "ACCOUNT_DELETED" });
    expect((await pool.query("SELECT enabled FROM public.service_offerings WHERE id = $1", [data.serviceOfferingId])).rows[0]).toEqual({ enabled: false });
    expect((await pool.query("SELECT availability_status FROM public.equipment WHERE id = $1", [data.equipmentId])).rows[0])
      .toEqual({ availability_status: "UNAVAILABLE" });
    expect((await pool.query("SELECT 1 FROM public.documents WHERE owner_id = $1", [data.ownerId])).rowCount).toBe(0);
    expect((await pool.query("SELECT 1 FROM public.tractor_photos WHERE tractor_id = $1", [data.tractorId])).rowCount).toBe(0);
    // The operating location keeps only its administrative area.
    expect((await pool.query(
      "SELECT coordinates, accuracy_meters, postal_code, landmark, source, location_consent_at, village FROM public.locations WHERE id = $1",
      [data.ownerLocationId])).rows[0]).toEqual({
      coordinates: null, accuracy_meters: null, postal_code: null, landmark: null, source: "MANUAL_ADDRESS",
      location_consent_at: null, village: "Hanamkonda",
    });

    // Private object references go to the storage purge through the outbox, not through logs.
    const event = (await pool.query<{ payload: { privateObjects: Array<{ kind: string }> } }>(
      "SELECT payload FROM public.outbox_events WHERE event_type = 'AccountErased' AND aggregate_id = $1", [data.ownerId])).rows;
    expect(event).toHaveLength(1);
    expect(event[0]!.payload.privateObjects.map(({ kind }) => kind).sort()).toEqual(["DOCUMENT", "TRACTOR_PHOTO"]);

    for (const table of RETAINED_TABLES) expect(await rows(table), table).toEqual(retainedBefore[table]);
    // The Farmer's account is untouched.
    expect((await pool.query("SELECT status FROM public.users WHERE id = $1", [data.customerId])).rows[0]).toEqual({ status: "ACTIVE" });
  });

  it("refuses while a booking is still open and changes nothing but the audit trail", async () => {
    const data = await seedRepresentativeDataset(pool, { ordinal: 3, bookingStatus: "DISPUTED" });
    const tables = Object.fromEntries(REPRESENTATIVE_TABLES.filter((table) => table !== "audit_events").map((table) => [table, null]));
    const columns = Object.fromEntries((await pool.query<{ table_name: string; columns: string[] }>(
      `SELECT table_name, array_agg(column_name::text ORDER BY column_name) AS columns FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = ANY($1::text[]) GROUP BY table_name`, [Object.keys(tables)]))
      .rows.map(({ table_name, columns: names }) => [table_name, names]));
    const before = await tableChecksums(pool, columns);

    for (const userId of [data.customerId, data.ownerId]) {
      expect(await erase(userId)).toEqual({ status: "REFUSED", reason: "OPEN_BOOKINGS", openBookings: 1 });
    }

    expect(await tableChecksums(pool, columns)).toEqual(before);
    expect((await pool.query("SELECT outcome, reason_code, pii_safe_metadata FROM public.audit_events WHERE action = 'account.delete' ORDER BY occurred_at, id"))
      .rows).toEqual([
      { outcome: "REJECTED", reason_code: "OPEN_BOOKINGS", pii_safe_metadata: { openBookings: 1 } },
      { outcome: "REJECTED", reason_code: "OPEN_BOOKINGS", pii_safe_metadata: { openBookings: 1 } },
    ]);
  });

  it("erases an account exactly once under concurrent requests", async () => {
    const data = await seedRepresentativeDataset(pool, { ordinal: 4 });
    const results = await Promise.all([erase(data.customerId, "account-delete-a"), erase(data.customerId, "account-delete-b")]);
    expect(results.map(({ status }) => status).sort()).toEqual(["ERASED", "REFUSED"]);
    expect(results.find(({ status }) => status === "REFUSED")).toEqual({ status: "REFUSED", reason: "ACCOUNT_NOT_ACTIVE" });
    expect((await pool.query("SELECT 1 FROM public.outbox_events WHERE event_type = 'AccountErased'")).rowCount).toBe(1);
    expect(await erase("a9000000-0000-4000-8000-000000000009")).toEqual({ status: "REFUSED", reason: "ACCOUNT_NOT_ACTIVE" });
  });

  it("keeps booking_recipients append-only except for the exact erasure redaction", async () => {
    const data = await seedRepresentativeDataset(pool, { ordinal: 5 });
    const redaction = `UPDATE public.booking_recipients
      SET name = 'Redacted recipient', phone_ciphertext = NULL, phone_lookup_hash = NULL, landmark_or_directions = NULL
      WHERE id = $1`;
    // Without the erasure flag even the exact redaction is refused.
    await expect(pool.query(redaction, [data.recipientId])).rejects.toMatchObject({ code: "55000" });
    const flagged = (statement: string, values: readonly unknown[]) => withTransaction(pool, async (sql) => {
      await sql.query("SELECT set_config('app.account_erasure', 'on', true)");
      return sql.query(statement, values);
    });
    for (const [statement, values] of [
      ["UPDATE public.booking_recipients SET name = 'Someone else' WHERE id = $1", [data.recipientId]],
      [`UPDATE public.booking_recipients SET name = 'Redacted recipient', phone_ciphertext = NULL, phone_lookup_hash = NULL,
         landmark_or_directions = NULL, service_location_snapshot = '{"village":"Elsewhere"}'::jsonb WHERE id = $1`, [data.recipientId]],
      [`UPDATE public.booking_recipients SET name = 'Redacted recipient', phone_ciphertext = NULL, phone_lookup_hash = NULL,
         landmark_or_directions = NULL, coordination_consent = false WHERE id = $1`, [data.recipientId]],
      ["DELETE FROM public.booking_recipients WHERE id = $1", [data.recipientId]],
    ] as const) {
      await expect(flagged(statement, values), statement).rejects.toMatchObject({ code: "55000" });
    }
    await expect(flagged(redaction, [data.recipientId])).resolves.toMatchObject({ rowCount: 1 });
    // The flag is transaction-local: it does not leak to later statements on the same pool.
    await expect(pool.query(redaction, [data.recipientId])).rejects.toMatchObject({ code: "55000" });
    // Other append-only tables are unaffected by the flag.
    await expect(flagged("UPDATE public.invoices SET total_paise = total_paise WHERE id = $1", [data.invoiceId]))
      .rejects.toMatchObject({ code: "55000" });
  });
});
