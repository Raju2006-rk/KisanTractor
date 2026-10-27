import { createHash } from "node:crypto";

import type { SqlConnection, SqlPool, SqlQueryResult } from "@kisantractor/database";
import type { AuthPrincipal, PaymentActorRole, PaymentMethod } from "@kisantractor/domain";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { PaymentApplicationResult, PaymentRequestContext } from "./payment.contracts.js";
import {
  PaymentCapabilityUnavailableError,
  PaymentConflictError,
  PaymentNotFoundError,
  PaymentService,
  PaymentValidationError,
} from "./payment.service.js";
import { PostgresPaymentStore } from "./postgres-payment-store.js";

// Feature: kisantractor-platform, Property 13 invoice-payment conservation through the cash command and store (task 12.3):
// generated invoices, partial/full cash, online intents, cash refund request/confirm, and repeated commands.
const propertyRuns = 150;
const seeds = { storeConservation: 1_203_404, zeroTotalBill: 1_203_505 } as const;

const OWNER_ID = "owner-1";
const FARMER_ID = "farmer-1";
const BOOKING_ID = "booking-1";
const INVOICE_ID = "invoice-1";
const baseTime = Date.UTC(2026, 2, 1, 12, 0, 0);
const context: PaymentRequestContext = { correlationId: "payment-property", actorChannel: "WEB" };
const owner: AuthPrincipal = { userId: OWNER_ID, sessionId: "s-owner", roles: ["OWNER"] };
const otherOwner: AuthPrincipal = { userId: "owner-2", sessionId: "s-owner-2", roles: ["OWNER"] };
const farmer: AuthPrincipal = { userId: FARMER_ID, sessionId: "s-farmer", roles: ["FARMER"] };

type Row = Record<string, unknown>;

interface LedgerState {
  booking: { id: string; public_reference: string; customer_id: string; owner_id: string; status: string; version: number };
  invoices: Row[];
  payments: Row[];
  paymentEvents: Row[];
  statusHistory: Row[];
  outboxTypes: string[];
  auditActions: string[];
  idempotency: Map<string, { request_digest: string; status: string; response_body: unknown | null }>;
  sequence: number;
}

/**
 * In-memory SQL double for the payment store with real transaction semantics: state is
 * snapshotted at BEGIN and restored on ROLLBACK, so rejected commands are checked for
 * leaving no partial state, exactly as PostgreSQL would.
 */
class TransactionalPaymentConnection implements SqlConnection {
  state: LedgerState;
  private snapshot: LedgerState | undefined;

  constructor(totalPaise: number, bookingStatus = "FINAL_BILL_GENERATED") {
    this.state = {
      booking: {
        id: BOOKING_ID, public_reference: "KT-2026-0001", customer_id: FARMER_ID, owner_id: OWNER_ID,
        status: bookingStatus, version: 7,
      },
      invoices: [{
        id: INVOICE_ID, booking_id: BOOKING_ID, invoice_version: 1, status: "ISSUED", total_paise: String(totalPaise), currency: "INR",
      }],
      payments: [],
      paymentEvents: [],
      statusHistory: [],
      outboxTypes: [],
      auditActions: [],
      idempotency: new Map(),
      sequence: 0,
    };
  }

  async query<Result extends object>(sql: string, values: readonly unknown[] = []): Promise<SqlQueryResult<Result>> {
    const text = sql.replace(/\s+/gu, " ").trim();
    const s = this.state;
    if (text.startsWith("BEGIN")) { this.snapshot = structuredClone(this.state); return this.result([]); }
    if (text === "COMMIT") { this.snapshot = undefined; return this.result([]); }
    if (text === "ROLLBACK") {
      if (this.snapshot !== undefined) this.state = this.snapshot;
      this.snapshot = undefined;
      return this.result([]);
    }
    if (text.startsWith("SELECT set_config")) return this.result([]);

    if (text.startsWith("INSERT INTO public.idempotency_records")) {
      const key = `${values[0]}:${values[1]}`;
      if (!s.idempotency.has(key)) {
        s.idempotency.set(key, { request_digest: String(values[2]), status: "IN_PROGRESS", response_body: null });
      }
      return this.result([]);
    }
    if (text.startsWith("SELECT request_digest, status, response_body FROM public.idempotency_records")) {
      const row = s.idempotency.get(`${values[0]}:${values[1]}`);
      return this.result(row === undefined ? [] : [{ ...row }]);
    }
    if (text.startsWith("UPDATE public.idempotency_records SET status")) {
      const key = `${values[0]}:${values[1]}`;
      s.idempotency.set(key, {
        request_digest: s.idempotency.get(key)!.request_digest, status: "COMPLETED", response_body: JSON.parse(String(values[2])),
      });
      return this.result([]);
    }
    if (text.startsWith("SELECT id, public_reference")) {
      return this.result(values[0] === s.booking.id ? [{ ...s.booking }] : []);
    }
    if (text.startsWith("SELECT id, booking_id, invoice_version") && text.includes("WHERE booking_id = $1")) {
      const latest = s.invoices.filter((row) => row.booking_id === values[0])
        .sort((a, b) => Number(b.invoice_version) - Number(a.invoice_version))[0];
      return this.result(latest === undefined ? [] : [{ ...latest }]);
    }
    if (text.startsWith("SELECT id, booking_id, invoice_version") && text.includes("WHERE id = $1")) {
      return this.result(s.invoices.filter((row) => row.id === values[0]).map((row) => ({ ...row })));
    }
    if (text.startsWith("SELECT id, invoice_id, method") && text.includes("WHERE invoice_id = $1")) {
      return this.result(s.payments.filter((row) => row.invoice_id === values[0]).map((row) => ({ ...row })));
    }
    if (text.startsWith("SELECT id, invoice_id, method") && text.includes("WHERE id = $1")) {
      return this.result(s.payments.filter((row) => row.id === values[0]).map((row) => ({ ...row })));
    }
    if (text.startsWith("SELECT i.booking_id FROM public.payments")) {
      const payment = s.payments.find((row) => row.id === values[0]);
      const invoice = s.invoices.find((row) => row.id === payment?.invoice_id);
      return this.result(invoice === undefined ? [] : [{ booking_id: invoice.booking_id }]);
    }
    if (text.startsWith("INSERT INTO public.payments")) {
      const row = {
        id: `payment-${++s.sequence}`, invoice_id: values[0], method: values[1], status: values[2],
        amount_paise: String(values[3]), currency: values[4], provider: values[5], provider_reference: values[6],
        recorded_by_user_id: values[7], received_at: values[8] === null ? null : new Date(String(values[8])),
        verified_at: null, created_at: new Date(String(values[9])), version: 1,
      };
      s.payments.push(row);
      return this.result([{ ...row }]);
    }
    if (text.startsWith("UPDATE public.payments SET status")) {
      const row = s.payments.find((item) => item.id === values[0] && item.version === values[3]);
      if (row === undefined) return this.result([]);
      row.status = values[1];
      row.version = Number(row.version) + 1;
      return this.result([{ ...row }]);
    }
    if (text.startsWith("INSERT INTO public.payment_events")) {
      s.paymentEvents.push({ payment_id: values[0], event_type: values[1] });
      return this.result([]);
    }
    if (text.startsWith("UPDATE public.bookings SET status")) {
      if (Number(values[3]) !== s.booking.version) return this.result([]);
      s.booking.status = String(values[1]);
      s.booking.version += 1;
      return this.result([{ version: s.booking.version }]);
    }
    if (text.startsWith("INSERT INTO public.booking_status_history")) {
      s.statusHistory.push({ from: values[1], to: values[2], actor: values[3], channel: values[4] });
      return this.result([]);
    }
    if (text.startsWith("INSERT INTO public.outbox_events")) {
      s.outboxTypes.push(String(values[2]));
      return this.result([{
        id: `outbox-${s.outboxTypes.length}`, aggregate_type: values[0], aggregate_id: values[1], event_type: values[2],
        event_version: values[3], payload: JSON.parse(String(values[4])), status: "PENDING",
        available_at: new Date(), created_at: new Date(),
      }]);
    }
    if (text.startsWith("INSERT INTO public.audit_events")) {
      s.auditActions.push(String(values[2]));
      return this.result([{
        id: `audit-${s.auditActions.length}`, correlation_id: values[7],
        pii_safe_metadata: JSON.parse(String(values[8])), occurred_at: new Date(String(values[9])),
      }]);
    }
    throw new Error(`Unexpected SQL in test: ${text}`);
  }

  release() {}

  private result<Result extends object>(rows: readonly object[]): SqlQueryResult<Result> {
    return { rows: rows as readonly Result[], rowCount: rows.length };
  }
}

class TransactionalPaymentPool implements SqlPool {
  constructor(readonly connection: TransactionalPaymentConnection) {}
  async connect() { return this.connection; }
  async query<Result extends object>(): Promise<SqlQueryResult<Result>> { throw new Error("transaction required"); }
}

async function outcome<Value>(run: () => Promise<Value>): Promise<{ value?: Value; error?: unknown }> {
  try {
    return { value: await run() };
  } catch (error) {
    return { error };
  }
}

async function runSeededProperty(name: string, seed: number, assertion: () => Promise<void>): Promise<void> {
  try {
    await assertion();
    console.info(`[PBT] ${name}: seed=${seed} runs=${propertyRuns} minimizedCounterexample=none`);
  } catch (error) {
    console.error(`[PBT] ${name}: seed=${seed} minimizedCounterexample=reported by fast-check below`);
    throw error;
  }
}

const APPLIED = new Set(["PAID_CASH", "PAID_ONLINE", "REFUND_PENDING"]);

/** Exact BigInt sums over the committed payment rows. */
function ledgerSums(state: LedgerState) {
  let applied = 0n;
  let pending = 0n;
  for (const row of state.payments) {
    if (APPLIED.has(String(row.status))) applied += BigInt(String(row.amount_paise));
    else if (row.status === "PENDING") pending += BigInt(String(row.amount_paise));
  }
  return { applied, pending };
}

/** Comparable view of committed state; Maps are not visible to JSON.stringify. */
const fingerprint = (state: LedgerState): string =>
  JSON.stringify({ ...state, idempotency: [...state.idempotency.entries()] });

const sha = (value: Readonly<Record<string, unknown>>): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

type AmountSpec =
  | { readonly mode: "remaining"; readonly delta: -1 | 0 | 1 }
  | { readonly mode: "share"; readonly divisor: number }
  | { readonly mode: "fixed"; readonly value: number };

const amountSpecArbitrary: fc.Arbitrary<AmountSpec> = fc.oneof(
  { weight: 3, arbitrary: fc.record({ mode: fc.constant("remaining" as const), delta: fc.constantFrom(-1 as const, 0 as const, 1 as const) }) },
  { weight: 3, arbitrary: fc.record({ mode: fc.constant("share" as const), divisor: fc.integer({ min: 2, max: 4 }) }) },
  { weight: 2, arbitrary: fc.record({
    mode: fc.constant("fixed" as const),
    value: fc.oneof(fc.integer({ min: 1, max: 200_000 }), fc.constantFrom(0, -1, 1.5)),
  }) },
);

const resolveAmount = (spec: AmountSpec, capacity: bigint): number =>
  spec.mode === "fixed" ? spec.value
    : spec.mode === "share" ? Number(capacity / BigInt(spec.divisor))
      : Number(capacity + BigInt(spec.delta));

/** Receipt times come from a small fixed set so equal retries really share a request digest. */
const receivedAtChoices = [undefined, 0, 10, 14 * 24 * 60] as const;

type StoreCommand =
  | { readonly kind: "CASH"; readonly actor: "assigned" | "otherOwner" | "farmer"; readonly key: number;
    readonly amount: AmountSpec; readonly receivedAt: (typeof receivedAtChoices)[number] }
  | { readonly kind: "ONLINE_INTENT"; readonly key: number; readonly amount: AmountSpec }
  | { readonly kind: "CONFIRM_ONLINE"; readonly target: number }
  | { readonly kind: "FAIL_ONLINE"; readonly target: number }
  | { readonly kind: "DISPUTE" }
  | { readonly kind: "REPEAT" }
  | { readonly kind: "REFUND"; readonly step: "REQUEST" | "CONFIRM"; readonly target: number; readonly aim: boolean;
    readonly actorRole: PaymentActorRole; readonly reason: string | undefined }
  | { readonly kind: "REPEAT_REFUND" };

/** Refund commands: mostly the permitted support/system actor, sometimes a party or the provider. */
const refundCommandArbitrary: fc.Arbitrary<StoreCommand> = fc.record({
  kind: fc.constant("REFUND" as const),
  step: fc.constantFrom("REQUEST" as const, "CONFIRM" as const),
  target: fc.nat({ max: 31 }),
  // Usually aim at a payment in the step's source state (paid cash / refund pending), else any payment.
  aim: fc.oneof({ weight: 3, arbitrary: fc.constant(true) }, { weight: 1, arbitrary: fc.constant(false) }),
  actorRole: fc.oneof({ weight: 4, arbitrary: fc.constant("PERMITTED" as const) },
    { weight: 1, arbitrary: fc.constantFrom<PaymentActorRole>("SUPPORT", "SYSTEM", "OWNER", "FARMER", "PROVIDER") }),
  reason: fc.oneof({ weight: 4, arbitrary: fc.constantFrom("Duplicate cash entry", "Dispute upheld") },
    { weight: 1, arbitrary: fc.constantFrom<string | undefined>(undefined, "", "   ") }),
}).map((command) => command.actorRole !== "PERMITTED" ? { ...command, actorRole: command.actorRole }
  // The permitted cash-refund actor: support or system may request, only support records the refund.
  : { ...command, actorRole: command.step === "CONFIRM" || command.target % 2 === 0 ? "SUPPORT" as const : "SYSTEM" as const });

/**
 * Independent oracle for a refund transition, in the order the store evaluates it: optimistic
 * version, then the refund rules (cash refunds are support-recorded with a reason; online refunds
 * need a verified provider event, which this command never carries).
 */
function expectedRefund(
  row: { readonly method: PaymentMethod; readonly status: string; readonly version: number },
  toStatus: "REFUND_PENDING" | "REFUNDED",
  actorRole: PaymentActorRole,
  reason: string | undefined,
  expectedVersion: number,
): string {
  if (row.version !== expectedVersion) return "PAYMENT_CONFLICT";
  const from = toStatus === "REFUND_PENDING" ? (row.method === "CASH" ? "PAID_CASH" : "PAID_ONLINE") : "REFUND_PENDING";
  if (row.status !== from) return "PAYMENT_TRANSITION_NOT_ALLOWED";
  const roles: readonly PaymentActorRole[] = toStatus === "REFUND_PENDING" ? ["SUPPORT", "SYSTEM"]
    : row.method === "CASH" ? ["SUPPORT"] : ["PROVIDER"];
  if (!roles.includes(actorRole)) return "PAYMENT_ACTOR_NOT_PERMITTED";
  if (toStatus === "REFUNDED" && row.method === "ONLINE") return "PAYMENT_EVIDENCE_REQUIRED";
  if ((reason ?? "").trim().length === 0) return "PAYMENT_REASON_REQUIRED";
  return "ACCEPTED";
}

const storeCommandArbitrary: fc.Arbitrary<StoreCommand> = fc.oneof(
  { weight: 8, arbitrary: fc.record({
    kind: fc.constant("CASH" as const),
    actor: fc.oneof({ weight: 6, arbitrary: fc.constant("assigned" as const) },
      { weight: 1, arbitrary: fc.constantFrom("otherOwner" as const, "farmer" as const) }),
    key: fc.nat({ max: 4 }),
    amount: amountSpecArbitrary,
    receivedAt: fc.constantFrom(...receivedAtChoices),
  }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant("ONLINE_INTENT" as const), key: fc.nat({ max: 3 }), amount: amountSpecArbitrary }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("CONFIRM_ONLINE" as const), target: fc.nat({ max: 31 }) }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("FAIL_ONLINE" as const), target: fc.nat({ max: 31 }) }) },
  { weight: 1, arbitrary: fc.constant({ kind: "DISPUTE" as const }) },
  { weight: 2, arbitrary: fc.constant({ kind: "REPEAT" as const }) },
  { weight: 6, arbitrary: refundCommandArbitrary },
  { weight: 1, arbitrary: fc.constant({ kind: "REPEAT_REFUND" as const }) },
);

const storeTotalArbitrary = fc.oneof(
  { weight: 1, arbitrary: fc.constant(0) },
  { weight: 5, arbitrary: fc.integer({ min: 1, max: 300_000 }) },
  { weight: 2, arbitrary: fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }) },
);

/** A resolved application command, kept so REPEAT can resend exactly the same request. */
type ResolvedApplication =
  | { readonly kind: "CASH"; readonly actor: "assigned" | "otherOwner" | "farmer"; readonly key: string;
    readonly amount: number; readonly receivedAt: Date | undefined }
  | { readonly kind: "ONLINE_INTENT"; readonly key: string; readonly amount: number };

describe("Property 13: Invoice-Payment Conservation — cash command and payment store", () => {
  /** **Validates: Requirements 11.2, 11.7** */
  it("conserves the invoice total through cash, refunds, and retries, never labels cash paid-online, and leaves no partial state on refusal", async () => {
    /** Accepted refund transitions across all runs, so the refund path is shown to be exercised. */
    const refundCoverage = { REFUND_PENDING: 0, REFUNDED: 0 };
    await runSeededProperty("store-invoice-payment-conservation", seeds.storeConservation, async () => {
      await fc.assert(fc.asyncProperty(
        storeTotalArbitrary,
        fc.array(storeCommandArbitrary, { minLength: 1, maxLength: 40 }),
        async (totalPaise, commands) => {
          const connection = new TransactionalPaymentConnection(totalPaise);
          let clock = baseTime + 60 * 60_000;
          const service = new PaymentService(new PostgresPaymentStore(new TransactionalPaymentPool(connection)), () => new Date(clock));
          const store = new PostgresPaymentStore(new TransactionalPaymentPool(connection));
          const total = BigInt(totalPaise);
          /** Model of completed idempotency keys: scope|key → digest identity and stored result. */
          const completed = new Map<string, { readonly identity: string; readonly result: PaymentApplicationResult }>();
          let disputed = false;
          let transitions = 0;
          let previous: ResolvedApplication | undefined;
          let previousRefund: { readonly paymentId: string; readonly toStatus: "REFUND_PENDING" | "REFUNDED";
            readonly actorRole: PaymentActorRole; readonly reason: string | undefined; readonly expectedVersion: number } | undefined;
          /** Booking status model: payments move it forward; refunds (placeholders) leave it unchanged. */
          let modelStatus = "FINAL_BILL_GENERATED";

          for (const generated of commands) {
            clock += 60_000;
            const before = fingerprint(connection.state);
            const { applied, pending } = ledgerSums(connection.state);
            const bookingStatus = connection.state.booking.status;
            const refundPending = connection.state.payments.some((row) => row.status === "REFUND_PENDING");

            if (generated.kind === "DISPUTE") {
              // The booking's own lifecycle allows a dispute from these states (DISPUTE action, Farmer).
              if (bookingStatus === "FINAL_BILL_GENERATED" || bookingStatus === "PAYMENT_RECORDED") {
                connection.state.booking.status = "DISPUTED";
                connection.state.booking.version += 1;
                disputed = true;
                modelStatus = "DISPUTED";
              }
            } else if (generated.kind === "REFUND" || generated.kind === "REPEAT_REFUND") {
              const rows = connection.state.payments;
              let request = previousRefund;
              if (generated.kind === "REFUND") {
                if (rows.length === 0) request = undefined;
                else {
                  const source = generated.step === "REQUEST" ? "PAID_CASH" : "REFUND_PENDING";
                  const aimed = rows.filter((item) => item.status === source);
                  const pool = generated.aim && aimed.length > 0 ? aimed : rows;
                  const row = pool[generated.target % pool.length]!;
                  request = {
                    paymentId: String(row.id), toStatus: generated.step === "REQUEST" ? "REFUND_PENDING" : "REFUNDED",
                    actorRole: generated.actorRole, reason: generated.reason, expectedVersion: Number(row.version),
                  };
                }
              }
              if (request !== undefined) {
                previousRefund = request;
                const row = rows.find((item) => item.id === request.paymentId)!;
                const priorStatus = String(row.status);
                const expected = expectedRefund(
                  { method: row.method as PaymentMethod, status: priorStatus, version: Number(row.version) },
                  request.toStatus, request.actorRole, request.reason, request.expectedVersion,
                );
                const result = await outcome(() => store.transitionPayment({
                  paymentId: request.paymentId, toStatus: request.toStatus, expectedVersion: request.expectedVersion,
                  actorId: "support-1", actorRole: request.actorRole,
                  ...(request.reason === undefined ? {} : { reason: request.reason }), occurredAt: new Date(clock),
                }, context));
                if (expected === "ACCEPTED") {
                  expect(result.error).toBeUndefined();
                  const moved = result.value!;
                  transitions += 1;
                  expect(moved.version).toBe(request.expectedVersion + 1);
                  // A refund changes only the status: cash stays cash, Owner-confirmed, with its receipt time.
                  expect(moved.payment).toMatchObject({ id: request.paymentId, method: "CASH", status: request.toStatus,
                    confirmedBy: "OWNER", paidAt: row.received_at });
                  expect(moved.payment.status).not.toBe("PAID_ONLINE");
                  refundCoverage[request.toStatus] += 1;
                  // Refunds are placeholders: they never move the booking.
                  expect(connection.state.booking.status).toBe(bookingStatus);
                } else {
                  expect(result.error).toMatchObject({ code: expected });
                  expect(fingerprint(connection.state)).toBe(before);
                }
              }
            } else if (generated.kind === "CONFIRM_ONLINE" || generated.kind === "FAIL_ONLINE") {
              const rows = connection.state.payments;
              if (rows.length > 0) {
                const row = rows[generated.target % rows.length]!;
                const id = String(row.id);
                const expectedVersion = Number(row.version);
                const pendingOnline = row.method === "ONLINE" && row.status === "PENDING";
                const result = await outcome(() => store.transitionPayment(generated.kind === "CONFIRM_ONLINE"
                  ? { paymentId: id, toStatus: "PAID_ONLINE", expectedVersion, actorRole: "PROVIDER",
                    evidence: { kind: "VERIFIED_PROVIDER_EVENT", providerEventId: `evt_${clock}` }, occurredAt: new Date(clock) }
                  : { paymentId: id, toStatus: "PAYMENT_FAILED", expectedVersion, actorRole: "SYSTEM",
                    reason: "Gateway reported failure", occurredAt: new Date(clock) }, context));
                if (generated.kind === "CONFIRM_ONLINE") {
                  // Paid-online is never simulated: a pending intent is refused as unavailable, others as not allowed.
                  if (pendingOnline) expect(result.error).toBeInstanceOf(PaymentCapabilityUnavailableError);
                  else expect(result.error).toMatchObject({ code: "PAYMENT_TRANSITION_NOT_ALLOWED" });
                  expect(fingerprint(connection.state)).toBe(before);
                } else if (pendingOnline) {
                  expect(result.error).toBeUndefined();
                  expect(result.value?.payment.status).toBe("PAYMENT_FAILED");
                  expect(result.value?.version).toBe(expectedVersion + 1);
                  transitions += 1;
                } else {
                  expect(result.error).toMatchObject({ code: "PAYMENT_TRANSITION_NOT_ALLOWED" });
                  expect(fingerprint(connection.state)).toBe(before);
                }
              }
            } else {
              const resolved: ResolvedApplication | undefined = generated.kind === "REPEAT" ? previous
                : generated.kind === "CASH"
                  ? {
                    kind: "CASH", actor: generated.actor, key: `cash-${generated.key}`,
                    amount: resolveAmount(generated.amount, total - applied - pending),
                    receivedAt: generated.receivedAt === undefined ? undefined : new Date(baseTime + generated.receivedAt * 60_000),
                  }
                  : { kind: "ONLINE_INTENT", key: `online-${generated.key}`, amount: resolveAmount(generated.amount, total - applied - pending) };
              if (resolved === undefined) continue;
              previous = resolved;

              const actorId = resolved.kind === "ONLINE_INTENT" ? FARMER_ID
                : resolved.actor === "assigned" ? OWNER_ID : resolved.actor === "otherOwner" ? "owner-2" : FARMER_ID;
              const identity = resolved.kind === "CASH"
                ? sha({ bookingId: BOOKING_ID, invoiceId: INVOICE_ID, method: "CASH", amountPaise: resolved.amount, currency: "INR",
                  receivedAt: resolved.receivedAt?.toISOString() ?? null })
                : `online:${resolved.amount}`;
              const scopeKey = `${actorId}|${resolved.key}`;

              const result = await outcome(() => resolved.kind === "CASH"
                ? service.recordCash(resolved.actor === "assigned" ? owner : resolved.actor === "otherOwner" ? otherOwner : farmer, {
                  bookingId: BOOKING_ID, invoiceId: INVOICE_ID, amountPaise: resolved.amount, idempotencyKey: resolved.key,
                  ...(resolved.receivedAt === undefined ? {} : { receivedAt: resolved.receivedAt }),
                }, context)
                : store.applyPayment({
                  bookingId: BOOKING_ID, invoiceId: INVOICE_ID, method: "ONLINE", amountPaise: resolved.amount, currency: "INR",
                  actorId: FARMER_ID, actorRole: "FARMER", provider: "sandbox-gateway", providerReference: `order_${resolved.key}`,
                  idempotencyKey: resolved.key, requestDigest: identity, occurredAt: new Date(clock),
                }, context));

              // Independent expected outcome, in the order the command and store evaluate it.
              const isCash = resolved.kind === "CASH";
              const prior = completed.get(scopeKey);
              let expected: string;
              if (isCash && resolved.actor === "farmer") expected = "NOT_FOUND";
              else if (!Number.isSafeInteger(resolved.amount) || resolved.amount <= 0) expected = "VALIDATION";
              else if (isCash && resolved.receivedAt !== undefined && resolved.receivedAt.getTime() > clock) expected = "VALIDATION";
              else if (prior !== undefined) expected = prior.identity === identity ? "REPLAY" : "IDEMPOTENCY_KEY_REUSED";
              else if (isCash && resolved.actor === "otherOwner") expected = "NOT_FOUND";
              else if (disputed) expected = "PAYMENT_SETTLEMENT_BLOCKED";
              else if (modelStatus === "COMPLETED") expected = "PAYMENT_BOOKING_NOT_PAYABLE";
              else if (refundPending) expected = "PAYMENT_INVOICE_NOT_PAYABLE";
              else if (BigInt(resolved.amount) > total - applied - pending) expected = "PAYMENT_OVERPAYMENT";
              else expected = "ACCEPTED";

              if (expected === "ACCEPTED") {
                expect(result.error).toBeUndefined();
                const value = result.value!;
                completed.set(scopeKey, { identity, result: value });
                expect(value.payment).toMatchObject({
                  method: isCash ? "CASH" : "ONLINE", status: isCash ? "PAID_CASH" : "PENDING", amountPaise: resolved.amount,
                });
                if (isCash) {
                  expect(value.payment.confirmedBy).toBe("OWNER");
                  expect(value.payment.paidAt).toEqual(resolved.receivedAt ?? new Date(clock));
                } else {
                  expect(value.payment.paidAt).toBeUndefined();
                }
                const newApplied = applied + (isCash ? BigInt(resolved.amount) : 0n);
                expect(BigInt(value.settlement.settlement.appliedPaise)).toBe(newApplied);
                expect(value.settlement.settlement.settled).toBe(newApplied === total);
                if (isCash) {
                  if (modelStatus === "FINAL_BILL_GENERATED") modelStatus = "PAYMENT_RECORDED";
                  if (newApplied === total && modelStatus === "PAYMENT_RECORDED") modelStatus = "COMPLETED";
                }
              } else if (expected === "REPLAY") {
                expect(result.error).toBeUndefined();
                expect(result.value).toEqual(prior!.result);
                expect(fingerprint(connection.state)).toBe(before);
              } else {
                const error = result.error;
                if (expected === "NOT_FOUND") expect(error).toBeInstanceOf(PaymentNotFoundError);
                else if (expected === "VALIDATION") expect(error).toBeInstanceOf(PaymentValidationError);
                else {
                  expect(error instanceof PaymentConflictError || (error as { name?: string }).name === "PaymentRuleError").toBe(true);
                  expect(error).toMatchObject({ code: expected });
                }
                expect(fingerprint(connection.state)).toBe(before);
              }
            }

            // Invariants over committed state after every command.
            const state = connection.state;
            const sums = ledgerSums(state);
            expect(sums.applied <= total).toBe(true);
            expect(sums.applied + sums.pending <= total).toBe(true);
            for (const row of state.payments) {
              if (row.method === "CASH") {
                // Cash is born paid-cash and can only move along the refund path; never paid-online.
                expect(["PAID_CASH", "REFUND_PENDING", "REFUNDED"]).toContain(row.status);
                expect(row.recorded_by_user_id).toBe(OWNER_ID);
                expect(row.provider).toBeNull();
                expect(row.received_at).toBeInstanceOf(Date);
              } else {
                expect(["PENDING", "PAYMENT_FAILED"]).toContain(row.status);
                expect(row.recorded_by_user_id).toBeNull();
                expect(row.received_at).toBeNull();
              }
            }
            // One payment event and one payment outbox event per stored payment; replays add none.
            expect(state.paymentEvents).toHaveLength(state.payments.length + transitions);
            expect(state.outboxTypes.filter((type) => type === "CashPaymentRecorded"))
              .toHaveLength(state.payments.filter((row) => row.method === "CASH").length);
            expect(state.outboxTypes.filter((type) => type === "OnlinePaymentInitiated"))
              .toHaveLength(state.payments.filter((row) => row.method === "ONLINE").length);

            const view = await service.getBookingSettlement(owner, BOOKING_ID, "OWNER", context);
            expect(BigInt(view.settlement.appliedPaise)).toBe(sums.applied);
            expect(BigInt(view.settlement.pendingPaise)).toBe(sums.pending);
            expect(view.settlement.settled).toBe(sums.applied === total);
            // No verified online payment can exist yet, so the bill is never reported as paid online.
            expect(view.settlement.status).not.toBe("PAID_ONLINE");
            expect(view.settlement.settlementMethods).not.toContain("ONLINE");
            if (state.payments.some((row) => row.status === "REFUND_PENDING")) expect(view.settlement.status).toBe("REFUND_PENDING");

            // The booking follows its bill: payment recorded on first applied money, completed on settlement.
            expect(state.booking.status).toBe(modelStatus);
            const refundTouched = state.payments.some((row) => row.status === "REFUND_PENDING" || row.status === "REFUNDED");
            if (!refundTouched) {
              const expectedStatus = disputed ? "DISPUTED"
                : sums.applied === 0n ? "FINAL_BILL_GENERATED"
                  : sums.applied < total ? "PAYMENT_RECORDED" : "COMPLETED";
              expect(state.booking.status).toBe(expectedStatus);
              // Zero-total bills are auto-completed at bill issuance (the job store), not by the payment store,
              // so in this payment-only model a 0 bill stays FINAL_BILL_GENERATED; guard the equivalence to total > 0.
              if (total > 0n && !disputed) expect(state.booking.status === "COMPLETED").toBe(view.settlement.settled);
            }
            expect(state.statusHistory.filter((entry) => entry.to === "PAYMENT_RECORDED").length).toBeLessThanOrEqual(1);
            expect(state.statusHistory.filter((entry) => entry.to === "COMPLETED").length).toBeLessThanOrEqual(1);
          }

          // Receipts: available to both parties for every cash payment iff the bill is settled.
          const settled = ledgerSums(connection.state).applied === total;
          for (const row of connection.state.payments) {
            for (const [principal, role] of [[farmer, "FARMER"], [owner, "OWNER"]] as const) {
              const receipt = await outcome(() => service.getReceipt(principal, String(row.id), role, context));
              if (settled && APPLIED.has(String(row.status))) {
                expect(receipt.value).toMatchObject({ method: "CASH", status: row.status, confirmedBy: "OWNER" });
                expect(receipt.value?.status).not.toBe("PAID_ONLINE");
              } else {
                expect(receipt.error).toMatchObject({ code: "PAYMENT_RECEIPT_UNAVAILABLE" });
              }
            }
          }
        },
      ), { seed: seeds.storeConservation, numRuns: propertyRuns, verbose: 2 });
    });
    console.info(`[PBT] store-invoice-payment-conservation: refundsRequested=${refundCoverage.REFUND_PENDING} `
      + `refundsRecorded=${refundCoverage.REFUNDED}`);
    expect(refundCoverage.REFUND_PENDING).toBeGreaterThan(0);
    expect(refundCoverage.REFUNDED).toBeGreaterThan(0);
  });

  /**
   * Zero-total auto-completion (new behaviour): a 0 paise final bill is auto-completed to COMPLETED
   * at bill issuance (the job store), because no payment can ever be recorded against it. This
   * property models the resulting state: the booking is COMPLETED, no cash can be recorded, there are
   * no payment rows, the settlement still reads NOTHING_DUE / settled, and no receipt exists because a
   * receipt requires an applied payment and there are none.
   *
   * **Validates: Requirements 8.8, 11.7, 11.8**
   */
  it("auto-completed zero-total bill: completes with no payments, refuses further cash, and issues no receipt", async () => {
    await runSeededProperty("zero-total-bill-auto-completed", seeds.zeroTotalBill, async () => {
      await fc.assert(fc.asyncProperty(
        fc.array(fc.record({
          amount: fc.oneof(fc.integer({ min: 1, max: 1_000_000 }), fc.constantFrom(0, -1, 1.5)),
          key: fc.nat({ max: 3 }),
        }), { minLength: 1, maxLength: 8 }),
        async (attempts) => {
          // Seeded as the job store leaves it once a zero-total bill is issued: already COMPLETED.
          const connection = new TransactionalPaymentConnection(0, "COMPLETED");
          const service = new PaymentService(new PostgresPaymentStore(new TransactionalPaymentPool(connection)),
            () => new Date(baseTime + 60 * 60_000));
          const initial = fingerprint(connection.state);

          for (const attempt of attempts) {
            const result = await outcome(() => service.recordCash(owner, {
              bookingId: BOOKING_ID, invoiceId: INVOICE_ID, amountPaise: attempt.amount, idempotencyKey: `zero-${attempt.key}`,
            }, context));
            // Invalid amounts are rejected first; otherwise the completed booking cannot receive payment.
            if (!Number.isSafeInteger(attempt.amount) || attempt.amount <= 0) {
              expect(result.error).toBeInstanceOf(PaymentValidationError);
            } else {
              expect(result.error).toMatchObject({ code: "PAYMENT_BOOKING_NOT_PAYABLE" });
            }
            expect(fingerprint(connection.state)).toBe(initial);
          }

          // The ledger: settled with nothing due and no payment rows, and the booking is COMPLETED.
          const view = await service.getBookingSettlement(farmer, BOOKING_ID, "FARMER", context);
          expect(view.settlement).toMatchObject({ status: "NOTHING_DUE", settled: true, appliedPaise: 0, outstandingPaise: 0 });
          expect(view.payments).toHaveLength(0);
          expect(view.bookingStatus).toBe("COMPLETED");
          // No payment was recorded in the payment store, so it adds no status history of its own.
          expect(connection.state.statusHistory).toHaveLength(0);
          // No receipt exists: a receipt requires an applied payment, and there are none to request.
          expect(connection.state.payments).toHaveLength(0);
        },
      ), { seed: seeds.zeroTotalBill, numRuns: propertyRuns, verbose: 2 });
    });
  });
});
