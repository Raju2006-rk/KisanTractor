import {
  createTestDatabaseFactory,
  seedRepresentativeDataset,
  type RepresentativeDataset,
  type TestDatabase,
} from "@kisantractor/test-utils";
import type { AuthPrincipal } from "@kisantractor/domain";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { CLOSED_BOOKING_STATUSES } from "../account/account-deletion.service.js";
import { PostgresAccountDeletionStore } from "../account/postgres-account-deletion-store.js";
import { PostgresBookingStore } from "../booking/postgres-booking-store.js";
import { PgPoolAdapter } from "../sql-pool.js";
import { PostgresSupportAccessPolicy } from "./support-access-policy.js";
import { grantSupportAccess, revokeSupportAccess } from "./support-admin.js";
import { PostgresSupportCaseStore } from "./postgres-support-case-store.js";
import { SupportCaseService } from "./support-case.service.js";

/**
 * Support access, dispute cases, and resolutions against PostgreSQL (task 16.5). Skipped unless
 * SUPPORT_INTEGRATION_DATABASE_URL names a local database whose name contains `test`.
 *
 * Validates: Requirements 1.4, 10.8, 12.4, 12.5
 */
const databaseUrl = process.env.SUPPORT_INTEGRATION_DATABASE_URL;
const describeDatabase = databaseUrl === undefined ? describe.skip : describe;

const DISPUTE_REASON = "Only 90 minutes of work were done near Kazipet";
const OWNER_STATEMENT = "The tractor worked the full two hours";

describeDatabase("support disputes (PostgreSQL)", () => {
  let database: TestDatabase;
  let pool: PgPoolAdapter;
  // Real time: idempotency records must expire after the database clock.
  let clock = new Date();
  const now = () => clock;
  /** Moves the clock on, so timeline entries have a definite order. */
  const tick = () => { clock = new Date(clock.getTime() + 1_000); };
  const context = { correlationId: "support-integration", actorChannel: "WEB" as const };

  const createOperator = async (ordinal: number, withRole = true): Promise<string> => {
    const id = `e${String(ordinal).padStart(7, "0")}-0000-4000-8000-000000000001`;
    await pool.query("INSERT INTO public.users (id, normalized_phone_ciphertext, phone_lookup_hash) VALUES ($1, $2, $3)",
      [id, Buffer.from(`fixture-operator-${ordinal}`), `fixture-operator-${ordinal}`]);
    if (withRole) await pool.query("INSERT INTO public.user_role_memberships (user_id, role_code) VALUES ($1, 'FUTURE_OPERATOR')", [id]);
    return id;
  };

  /** A paid booking the Farmer disputes through the booking store, which opens the case. */
  const disputedBooking = async (ordinal: number): Promise<{ data: RepresentativeDataset; caseId: string }> => {
    const data = await seedRepresentativeDataset(pool, { ordinal, bookingStatus: "DISPUTED" });
    const current = (await pool.query<{ version: number }>(
      "UPDATE public.bookings SET status = 'PAYMENT_RECORDED' WHERE id = $1 RETURNING version", [data.bookingId])).rows[0]!;
    await new PostgresBookingStore(pool).transitionBooking({
      bookingId: data.bookingId, expectedVersion: current.version, actorId: data.customerId, actorRole: "FARMER",
      action: "DISPUTE", reason: DISPUTE_REASON, occurredAt: clock,
    }, { correlationId: `dispute-${ordinal}`, actorChannel: "WEB" });
    const caseRow = (await pool.query<{ id: string }>("SELECT id FROM public.support_cases WHERE booking_id = $1", [data.bookingId])).rows[0]!;
    return { data, caseId: caseRow.id };
  };

  const service = () => new SupportCaseService(new PostgresSupportCaseStore(pool), new PostgresSupportAccessPolicy(pool, now), {
    requestRefund: async () => { throw new Error("no online payment in this suite"); },
  }, now);

  const principal = (userId: string, role: AuthPrincipal["roles"][number]): AuthPrincipal => ({ userId, sessionId: `s-${userId}`, roles: [role] });

  beforeAll(async () => {
    pool = new PgPoolAdapter(new Pool({ connectionString: databaseUrl, max: 6 }));
    database = await createTestDatabaseFactory({ databaseUrl: databaseUrl!, createPool: async () => pool })();
  }, 120_000);

  beforeEach(async () => {
    clock = new Date(Math.floor(Date.now() / 1_000) * 1_000);
    await database.reset();
  });

  afterAll(async () => {
    await database?.dispose();
  });

  it("opens a case with the dispute and grants access only through explicit, time-bounded, audited grants", async () => {
    const { data, caseId } = await disputedBooking(1);
    expect((await pool.query("SELECT status, disputed_invoice_id, version FROM public.support_cases WHERE id = $1", [caseId])).rows[0])
      .toEqual({ status: "OPEN", disputed_invoice_id: data.invoiceId, version: 1 });
    expect((await pool.query(
      "SELECT entry_type, author_role, author_user_id, statement_code, statement_text, evidence_kind, evidence_id FROM public.support_case_entries WHERE case_id = $1",
      [caseId])).rows).toEqual([{
      entry_type: "OPENED", author_role: "FARMER", author_user_id: data.customerId, statement_code: "BILL_DISPUTED",
      statement_text: DISPUTE_REASON, evidence_kind: "INVOICE", evidence_id: data.invoiceId,
    }]);

    const operatorId = await createOperator(1);
    const strangerId = await createOperator(2, false);
    const policy = new PostgresSupportAccessPolicy(pool, now);
    const booking = { kind: "BOOKING" as const, id: data.bookingId, customerId: data.customerId, ownerId: data.ownerId };
    const check = (action: "booking:read" | "booking:command", userId = operatorId) =>
      policy.hasExplicitAccess({ principal: principal(userId, "FUTURE_OPERATOR"), action, resource: booking, correlationId: "check" });

    // No grant: role membership alone grants nothing.
    expect(await check("booking:read")).toBe(false);
    await expect(grantSupportAccess(pool, { operatorUserId: strangerId, caseId, scope: "READ", ticketReference: "SUP-1",
      durationMs: 3_600_000, correlationId: "grant", now: clock })).rejects.toMatchObject({ code: "OPERATOR_NOT_ELIGIBLE" });
    await expect(grantSupportAccess(pool, { operatorUserId: operatorId, caseId, scope: "RESOLVE", ticketReference: "SUP-1",
      durationMs: 8 * 24 * 3_600_000, correlationId: "grant", now: clock })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });

    const read = await grantSupportAccess(pool, { operatorUserId: operatorId, caseId, scope: "READ", ticketReference: "SUP-1",
      durationMs: 3_600_000, correlationId: "grant", now: clock });
    expect(await check("booking:read")).toBe(true);
    expect(await check("booking:command")).toBe(false);
    expect(await policy.hasExplicitAccess({ principal: principal(operatorId, "FUTURE_OPERATOR"), action: "document:read",
      resource: { kind: "DOCUMENT", id: data.documentId, ownerId: data.ownerId } as never })).toBe(false);
    // A Farmer holding a grant row would still be refused: the role is required.
    expect(await policy.hasExplicitAccess({ principal: principal(operatorId, "FARMER"), action: "booking:read", resource: booking })).toBe(false);

    await grantSupportAccess(pool, { operatorUserId: operatorId, caseId, scope: "RESOLVE", ticketReference: "SUP-2",
      durationMs: 3_600_000, correlationId: "grant", now: clock });
    expect(await check("booking:command")).toBe(true);
    clock = new Date(clock.getTime() + 3_600_000);
    expect(await check("booking:read")).toBe(false);
    clock = new Date(clock.getTime() - 60_000);
    await revokeSupportAccess(pool, { grantId: read.grantId, correlationId: "revoke", now: clock });
    expect(await check("booking:read")).toBe(true); // the RESOLVE grant still covers reads
    // Revoking the operator's membership removes access at once.
    await pool.query("UPDATE public.user_role_memberships SET revoked_at = CURRENT_TIMESTAMP WHERE user_id = $1", [operatorId]);
    expect(await check("booking:read")).toBe(false);

    const audits = (await pool.query<{ action: string; outcome: string; reason_code: string | null; pii_safe_metadata: object }>(
      `SELECT action, outcome, reason_code, pii_safe_metadata FROM public.audit_events WHERE action LIKE 'support.%'`)).rows;
    // Every operator check is audited (the Farmer-role check never reaches support access).
    expect(audits.map(({ action, outcome, reason_code }) => `${action}:${outcome}:${reason_code ?? ""}`).sort()).toEqual([
      "support.access.check:ALLOWED:", "support.access.check:ALLOWED:", "support.access.check:ALLOWED:",
      "support.access.check:DENIED:NO_ACTIVE_GRANT", "support.access.check:DENIED:NO_ACTIVE_GRANT",
      "support.access.check:DENIED:NO_ACTIVE_GRANT", "support.access.check:DENIED:NO_ACTIVE_GRANT",
      "support.access.check:DENIED:RESOURCE_NOT_SUPPORTED",
      "support.grant.issue:SUCCEEDED:", "support.grant.issue:SUCCEEDED:", "support.grant.revoke:SUCCEEDED:",
    ]);
    expect(JSON.stringify(audits)).not.toContain("Kazipet");
  });

  it("records statements, upholds a paid bill to completion once, and notifies both parties", async () => {
    const { data, caseId } = await disputedBooking(2);
    const operatorId = await createOperator(3);
    await grantSupportAccess(pool, { operatorUserId: operatorId, caseId, scope: "RESOLVE", ticketReference: "SUP-3",
      durationMs: 3_600_000, correlationId: "grant", now: clock });
    const cases = service();
    const operator = principal(operatorId, "FUTURE_OPERATOR");

    tick();
    const ownerView = await cases.addPartyStatement(principal(data.ownerId, "OWNER"), "OWNER", data.bookingId, {
      expectedVersion: 1, statementCode: "WORK_RECORD_CORRECT", statementText: OWNER_STATEMENT,
      evidence: { kind: "INVOICE", id: data.invoiceId }, idempotencyKey: "owner-statement-1",
    }, context);
    expect(ownerView.version).toBe(2);
    // Each party sees its own text only; support sees all.
    const farmerView = await cases.getPartyCase(principal(data.customerId, "FARMER"), "FARMER", data.bookingId);
    expect(farmerView.entries.map((entry) => entry.statementText)).toEqual([DISPUTE_REASON, undefined]);
    expect(farmerView.refundablePayments).toBeUndefined();
    await expect(cases.getPartyCase(principal(data.ownerId, "FARMER"), "FARMER", data.bookingId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const supportView = await cases.getCase(operator, caseId, context);
    expect(supportView.entries.map((entry) => entry.statementText)).toEqual([DISPUTE_REASON, OWNER_STATEMENT]);
    expect(supportView).toMatchObject({ bookingStatus: "DISPUTED", currentInvoiceTotalPaise: 160_000, appliedPaise: 160_000 });

    // A stale version or an outcome the money does not allow changes nothing.
    await expect(cases.resolve(operator, caseId, { expectedVersion: 1, expectedBookingVersion: supportView.bookingVersion,
      outcome: "UPHOLD", reasonCode: "EVIDENCE_SUPPORTS_BILL", idempotencyKey: "resolve-stale" }, context)).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    await expect(cases.resolve(operator, caseId, { expectedVersion: 2, expectedBookingVersion: supportView.bookingVersion,
      outcome: "CANCEL", reasonCode: "PARTIES_AGREED", idempotencyKey: "resolve-cancel" }, context)).rejects.toMatchObject({ code: "PAYMENT_APPLIED" });
    await expect(cases.resolve(operator, caseId, { expectedVersion: 2, expectedBookingVersion: supportView.bookingVersion,
      outcome: "ADJUST", reasonCode: "EVIDENCE_CORRECTED", idempotencyKey: "resolve-adjust" }, context)).rejects.toMatchObject({ code: "ADJUSTED_INVOICE_REQUIRED" });

    const command = { expectedVersion: 2, expectedBookingVersion: supportView.bookingVersion, outcome: "UPHOLD",
      reasonCode: "EVIDENCE_SUPPORTS_BILL", idempotencyKey: "resolve-uphold" };
    tick();
    const resolved = await cases.resolve(operator, caseId, command, context);
    expect(resolved).toMatchObject({
      status: "RESOLVED", bookingStatus: "COMPLETED",
      resolution: { outcome: "UPHOLD", rulesVersion: 1, reasonCode: "EVIDENCE_SUPPORTS_BILL", resolvedInvoiceId: data.invoiceId },
    });
    // The same request again is a replay; a new request on the closed case is refused.
    await cases.resolve(operator, caseId, command, context);
    await expect(cases.resolve(operator, caseId, { ...command, idempotencyKey: "resolve-again" }, context))
      .rejects.toMatchObject({ code: "CASE_NOT_OPEN" });
    await expect(cases.addPartyStatement(principal(data.customerId, "FARMER"), "FARMER", data.bookingId, {
      expectedVersion: 3, statementCode: "OTHER", idempotencyKey: "late-statement",
    }, context)).rejects.toMatchObject({ code: "CASE_CLOSED" });

    const history = (await pool.query("SELECT from_status, to_status, actor_id, actor_channel FROM public.booking_status_history WHERE booking_id = $1 ORDER BY occurred_at DESC, id DESC LIMIT 1",
      [data.bookingId])).rows;
    expect(history).toEqual([{ from_status: "DISPUTED", to_status: "COMPLETED", actor_id: operatorId, actor_channel: "OPERATOR" }]);
    const outbox = (await pool.query<{ event_type: string; payload: Record<string, unknown> }>(
      "SELECT event_type, payload FROM public.outbox_events WHERE aggregate_id = $1", [data.bookingId])).rows;
    // CashPaymentRecorded comes from the seeded dataset.
    expect(outbox.map(({ event_type }) => event_type).sort())
      .toEqual(["BookingCompleted", "BookingDisputed", "CashPaymentRecorded", "DisputeResolved"]);
    expect(outbox.find(({ event_type }) => event_type === "DisputeResolved")?.payload)
      .toEqual({ bookingId: data.bookingId, caseId, outcome: "UPHOLD", rulesVersion: 1 });
    // Statement text never reaches audit events or the outbox.
    const leaks = await pool.query(
      `SELECT 1 FROM public.audit_events WHERE strpos(pii_safe_metadata::text, $1) > 0 OR strpos(pii_safe_metadata::text, $2) > 0
       UNION ALL SELECT 1 FROM public.outbox_events WHERE strpos(payload::text, $1) > 0 OR strpos(payload::text, $2) > 0`,
      [OWNER_STATEMENT, DISPUTE_REASON]);
    expect(leaks.rowCount).toBe(0);
    const resolveAudit = (await pool.query("SELECT outcome, reason_code FROM public.audit_events WHERE action = 'support.case.resolve'")).rows;
    expect(resolveAudit).toEqual([{ outcome: "SUCCEEDED", reason_code: "EVIDENCE_SUPPORTS_BILL" }]);
    expect((await pool.query("SELECT 1 FROM public.audit_events WHERE action = 'support.case.read'")).rowCount).toBe(1);
  });

  it("refuses an adjusted outcome while money sits on the superseded bill", async () => {
    const { data, caseId } = await disputedBooking(3);
    const operatorId = await createOperator(4);
    await grantSupportAccess(pool, { operatorUserId: operatorId, caseId, scope: "RESOLVE", ticketReference: "SUP-4",
      durationMs: 3_600_000, correlationId: "grant", now: clock });
    // A corrected bill version, as the job store issues after an evidence correction.
    await pool.query(
      `INSERT INTO public.invoices (booking_id, supersedes_invoice_id, agreement_id, invoice_version, status, rate_paise, billable_quantity,
         subtotal_paise, adjustments_paise, total_paise, evidence_references, calculation_formula, rounding_trace)
       VALUES ($1, $2, $3, 2, 'ISSUED', 80000, 1.500, 120000, 0, 120000, '[]'::jsonb, '90 min x ₹800.00/h = ₹1,200.00',
         '{"rawSubtotalNumerator":"120000","rawSubtotalDenominator":"1","minorUnitRounding":"HALF_UP"}'::jsonb)`,
      [data.bookingId, data.invoiceId, data.agreementId]);
    const cases = service();
    const operator = principal(operatorId, "FUTURE_OPERATOR");
    const view = await cases.getCase(operator, caseId, context);
    expect(view).toMatchObject({ disputedInvoiceVersion: 1, currentInvoiceVersion: 2, currentInvoiceTotalPaise: 120_000, appliedPaise: 0 });
    await expect(cases.resolve(operator, caseId, { expectedVersion: 1, expectedBookingVersion: view.bookingVersion, outcome: "UPHOLD",
      reasonCode: "EVIDENCE_SUPPORTS_BILL", idempotencyKey: "resolve-uphold-2" }, context)).rejects.toMatchObject({ code: "INVOICE_CHANGED" });
    await expect(cases.resolve(operator, caseId, { expectedVersion: 1, expectedBookingVersion: view.bookingVersion, outcome: "ADJUST",
      reasonCode: "EVIDENCE_CORRECTED", idempotencyKey: "resolve-adjust-2" }, context)).rejects.toMatchObject({ code: "SUPERSEDED_PAYMENT_APPLIED" });
    expect((await pool.query("SELECT status FROM public.bookings WHERE id = $1", [data.bookingId])).rows[0]).toEqual({ status: "DISPUTED" });
  });

  it("keeps dispute cases on account deletion, erases the person's statement text, and revokes operator grants", async () => {
    const { data, caseId } = await disputedBooking(4);
    const operatorId = await createOperator(5);
    await grantSupportAccess(pool, { operatorUserId: operatorId, caseId, scope: "RESOLVE", ticketReference: "SUP-5",
      durationMs: 3_600_000, correlationId: "grant", now: clock });
    const cases = service();
    tick();
    await cases.addPartyStatement(principal(data.ownerId, "OWNER"), "OWNER", data.bookingId, {
      expectedVersion: 1, statementCode: "WORK_RECORD_CORRECT", statementText: OWNER_STATEMENT, idempotencyKey: "owner-statement-2",
    }, context);
    const view = await cases.getCase(principal(operatorId, "FUTURE_OPERATOR"), caseId, context);
    tick();
    await cases.resolve(principal(operatorId, "FUTURE_OPERATOR"), caseId, { expectedVersion: 2, expectedBookingVersion: view.bookingVersion,
      outcome: "UPHOLD", reasonCode: "EVIDENCE_SUPPORTS_BILL", idempotencyKey: "resolve-before-erasure" }, context);

    const store = new PostgresAccountDeletionStore(pool);
    const erase = (userId: string) => store.eraseAccount({ userId, actorChannel: "WEB", correlationId: `erase-${userId.slice(0, 8)}`,
      closedBookingStatuses: CLOSED_BOOKING_STATUSES });
    expect(await erase(data.customerId)).toMatchObject({
      status: "ERASED", erased: { disputeStatementsRedacted: 1, supportGrantsRevoked: 0 }, retained: { disputeCases: 1 },
    });
    expect(await erase(operatorId)).toMatchObject({ status: "ERASED", erased: { supportGrantsRevoked: 1 } });

    const entries = (await pool.query<{ author_role: string; statement_code: string; statement_text: string | null; redacted: boolean }>(
      `SELECT author_role, statement_code, statement_text, statement_redacted_at IS NOT NULL AS redacted
       FROM public.support_case_entries WHERE case_id = $1 ORDER BY occurred_at, id`, [caseId])).rows;
    expect(entries).toEqual([
      { author_role: "FARMER", statement_code: "BILL_DISPUTED", statement_text: null, redacted: true },
      { author_role: "OWNER", statement_code: "WORK_RECORD_CORRECT", statement_text: OWNER_STATEMENT, redacted: false },
      { author_role: "SUPPORT", statement_code: "EVIDENCE_SUPPORTS_BILL", statement_text: null, redacted: false },
    ]);
    expect((await pool.query("SELECT status, resolution_outcome FROM public.support_cases WHERE id = $1", [caseId])).rows[0])
      .toEqual({ status: "RESOLVED", resolution_outcome: "UPHOLD" });
    expect((await pool.query("SELECT 1 FROM public.support_access_grants WHERE operator_user_id = $1 AND revoked_at IS NULL", [operatorId])).rowCount).toBe(0);
  });
});
