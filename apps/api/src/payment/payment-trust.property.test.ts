import { createHash, createHmac, randomUUID } from "node:crypto";

import type { SqlConnection, SqlPool, SqlQueryResult } from "@kisantractor/database";
import type { AuthPrincipal, PaymentRecordStatus } from "@kisantractor/domain";
import { InMemoryMetrics, OperationalIndicators } from "@kisantractor/observability";
import {
  CapabilityRegistry,
  RazorpayPaymentAdapter,
  type PaymentHttpRequest,
  type PaymentHttpResponse,
} from "@kisantractor/providers";
import { createTestDatabaseFactory, seedRepresentativeDataset, type TestDatabase } from "@kisantractor/test-utils";
import fc from "fast-check";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PgPoolAdapter } from "../sql-pool.js";
import type { PaymentRequestContext, PaymentSessionAuthenticator, VerifiedProviderEventRecord } from "./payment.contracts.js";
import { FarmerPaymentController } from "./payment.controller.js";
import { captureEvidence } from "./payment-recovery.service.js";
import { PaymentService, type ProviderWebhookResult } from "./payment.service.js";
import { PostgresPaymentStore } from "./postgres-payment-store.js";

// Feature: kisantractor-platform, Property 12: Payment Trust and Deduplication (task 16.3).
// Service half: signed webhooks, provider API reads, checkout returns, and support refunds run
// through the real PaymentService, RazorpayPaymentAdapter, and PostgresPaymentStore. The unit
// variant runs the store over a transactional SQL double with the store's own dedupe query and the
// provider_events unique index; the PostgreSQL variant adds concurrent duplicate deliveries.
//
// PostgreSQL variant (gated like the other database suites, see src/e2e/README.md):
// PAYMENT_TRUST_PROPERTY_DATABASE_URL=postgresql://kisantractor:kisantractor@127.0.0.1:55432/kisantractor_payment_trust_test
const propertyRuns = 120;
const databaseRuns = 20;
const seeds = { service: 1_603_301, database: 1_603_302 } as const;

// Synthetic credentials for this suite only; no request leaves the process.
const PROVIDER = "razorpay";
const KEY_ID = "rzp_test_Kt0Synthetic01";
const KEY_SECRET = "synthetic-key-secret-for-tests";
const WEBHOOK_SECRET = "synthetic-webhook-secret-for-tests";
/** Contact details a real provider payload carries; they must never be stored. */
const PAYER_EMAIL = "payer.kisan@example.invalid";
const PAYER_CONTACT = "+919812345678";

type Intent = "A" | "B";
type PaymentEventType = "payment.captured" | "order.paid" | "payment.failed" | "payment.authorized";
type RefundEventType = "refund.processed" | "refund.failed";
type WebhookEventType = PaymentEventType | RefundEventType;
type Mismatch = "NONE" | "AMOUNT" | "CURRENCY" | "REFERENCE" | "MALFORMED";
type SignatureMode =
  | "VALID" | "UPPERCASE" | "WRONG_SECRET" | "TAMPERED_BODY" | "TRUNCATED" | "NON_HEX" | "MISSING"
  | "RESERIALIZED" | "CHECKOUT_SIGNATURE" | "NO_RAW_BODY";
type EventIdMode = "FRESH" | "REUSE_LAST" | "NONE";

const VERIFIABLE: ReadonlySet<SignatureMode> = new Set(["VALID", "UPPERCASE"]);
const STRICT_EVENTS: ReadonlySet<WebhookEventType> = new Set(["payment.captured", "order.paid", "refund.processed", "refund.failed"]);
const PAYABLE_BOOKING = new Set(["FINAL_BILL_GENERATED", "PAYMENT_RECORDED"]);
const APPLIED_STATUSES = new Set(["PAID_CASH", "PAID_ONLINE", "REFUND_PENDING"]);
const SETTLED_ONLINE: ReadonlySet<string> = new Set(["PAID_ONLINE", "REFUND_PENDING", "REFUNDED"]);
/** Permitted payment status moves; anything else would undo or double-count money. */
const ALLOWED_MOVES: Readonly<Record<string, readonly string[]>> = {
  PENDING: ["PAID_ONLINE", "PAYMENT_FAILED"],
  PAYMENT_FAILED: ["PAID_ONLINE"],
  PAID_ONLINE: ["REFUND_PENDING"],
  REFUND_PENDING: ["REFUNDED", "PAID_ONLINE"],
  REFUNDED: [],
  PAID_CASH: [],
};
const CONFIRMATION_FOR: Readonly<Record<string, string>> = {
  PENDING: "AWAITING_PROVIDER_CONFIRMATION", PAID_ONLINE: "CONFIRMED", PAYMENT_FAILED: "NOT_COMPLETED",
  REFUND_PENDING: "REFUND_IN_PROGRESS", REFUNDED: "REFUNDED",
};

const sha256 = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
const hmac = (secret: string, bytes: Uint8Array | string): string => createHmac("sha256", secret).update(bytes).digest("hex");
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

async function runSeeded(name: string, seed: number, runs: number, assertion: () => Promise<void>, coverage: () => string): Promise<void> {
  try {
    await assertion();
    console.info(`[PBT] ${name}: seed=${seed} runs=${runs} minimizedCounterexample=none ${coverage()}`);
  } catch (error) {
    console.error(`[PBT] ${name}: seed=${seed} minimizedCounterexample=reported by fast-check below`);
    throw error;
  }
}

// ---- Provider-side identifiers and documented webhook bodies ----

const ids = (nonce: string) => ({
  order: (intent: Intent) => `order_KtPbt${nonce}${intent}`,
  pay: (intent: Intent, second = false) => `pay_KtPbt${nonce}${intent}${second ? "2" : "1"}`,
  refund: (intent: Intent, ordinal: number) => `rfnd_KtPbt${nonce}${intent}R${ordinal}`,
  unknownOrder: `order_KtPbt${nonce}Unknown`,
  unknownPay: `pay_KtPbt${nonce}Unknown`,
});

interface PaymentBodySpec {
  readonly event: PaymentEventType;
  readonly orderId: string;
  readonly paymentId: string;
  readonly amount: number;
  readonly currency: string;
  readonly createdAt: number;
  readonly malformed: boolean;
}

function paymentEventBody(spec: PaymentBodySpec): string {
  const status = spec.event === "payment.failed" ? "failed" : spec.event === "payment.authorized" ? "authorized" : "captured";
  const strict = spec.event === "payment.captured" || spec.event === "order.paid";
  const payment = {
    id: spec.paymentId, entity: "payment",
    // Malformed: a strict event whose entity contradicts it, or a lenient one with an unusable amount.
    amount: spec.malformed && !strict ? "12.50" : spec.amount, currency: spec.currency,
    status: spec.malformed && spec.event === "payment.captured" ? "authorized" : status,
    order_id: spec.orderId, method: "upi", captured: status === "captured", email: PAYER_EMAIL, contact: PAYER_CONTACT,
  };
  const payload = spec.event === "order.paid"
    ? { payment: { entity: payment }, order: { entity: {
      id: spec.malformed ? `${spec.orderId}X` : spec.orderId, entity: "order", status: "paid", amount: spec.amount, currency: spec.currency,
    } } }
    : { payment: { entity: payment } };
  return JSON.stringify({
    entity: "event", account_id: "acc_KtSynthAcct01", event: spec.event, contains: Object.keys(payload), payload, created_at: spec.createdAt,
  });
}

interface RefundBodySpec {
  readonly event: RefundEventType;
  readonly refundId: string;
  readonly paymentId: string;
  readonly receipt: string;
  readonly amount: number;
  readonly currency: string;
  readonly createdAt: number;
  readonly malformed: boolean;
}

function refundEventBody(spec: RefundBodySpec): string {
  const status = spec.malformed ? "pending" : spec.event === "refund.processed" ? "processed" : "failed";
  return JSON.stringify({
    entity: "event", account_id: "acc_KtSynthAcct01", event: spec.event, contains: ["refund"], created_at: spec.createdAt,
    payload: { refund: { entity: {
      id: spec.refundId, entity: "refund", amount: spec.amount, currency: spec.currency, payment_id: spec.paymentId,
      receipt: spec.receipt, status, speed_processed: "normal",
    } } },
  });
}

/** The bytes and headers one delivery carries for a given signature mode. */
function signedDelivery(text: string, mode: SignatureMode, eventId: string | undefined, checkoutPair: string) {
  const signedBytes = encode(text);
  const valid = hmac(WEBHOOK_SECRET, signedBytes);
  let bytes: Uint8Array | undefined = signedBytes;
  let signature: string | undefined = valid;
  switch (mode) {
    case "VALID": break;
    case "UPPERCASE": signature = valid.toUpperCase(); break;
    case "WRONG_SECRET": signature = hmac(`${WEBHOOK_SECRET}-rotated`, signedBytes); break;
    case "TAMPERED_BODY": {
      const copy = Uint8Array.from(signedBytes);
      const index = copy.length >> 1;
      copy[index] = copy[index]! ^ 0x01;
      bytes = copy;
      break;
    }
    case "TRUNCATED": signature = valid.slice(0, 40); break;
    case "NON_HEX": signature = `${valid.slice(0, 63)}g`; break;
    case "MISSING": signature = undefined; break;
    // A framework that parsed and re-serialized the JSON: the signed bytes are gone.
    case "RESERIALIZED": bytes = encode(JSON.stringify(JSON.parse(text), null, 2)); break;
    // What the browser holds after checkout: HMAC(order_id|payment_id) with the API key secret.
    case "CHECKOUT_SIGNATURE": signature = hmac(KEY_SECRET, checkoutPair); break;
    case "NO_RAW_BODY": bytes = undefined; break;
  }
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(signature === undefined ? {} : { "x-razorpay-signature": signature }),
    ...(eventId === undefined ? {} : { "x-razorpay-event-id": eventId }),
  };
  return { bytes, headers };
}

/** In-process stand-in for the documented Orders API, reporting one captured payment per order. */
function providerApi(captures: Map<string, { readonly paymentId: string; readonly amount: number }>) {
  return async (request: PaymentHttpRequest): Promise<PaymentHttpResponse> => {
    const match = /^\/v1\/orders\/([^/]+)(\/payments)?$/u.exec(new URL(request.url).pathname);
    const orderId = decodeURIComponent(match?.[1] ?? "");
    const capture = captures.get(orderId);
    if (request.method !== "GET" || match === null || capture === undefined) return { status: 404, json: async () => ({}) };
    if (match[2] === undefined) {
      return { status: 200, json: async () => ({ id: orderId, entity: "order", amount: capture.amount, currency: "INR", status: "paid", attempts: 1 }) };
    }
    return { status: 200, json: async () => ({ entity: "collection", count: 1, items: [{
      id: capture.paymentId, entity: "payment", amount: capture.amount, currency: "INR", status: "captured", captured: true,
      order_id: orderId, method: "upi", email: PAYER_EMAIL, contact: PAYER_CONTACT,
    }] }) };
  };
}

// ---- Independent oracle for the store's decision on verified, non-duplicate evidence ----

interface OraclePayment {
  readonly id: string;
  readonly method: string;
  readonly status: string;
  readonly amountPaise: number;
  readonly currency: string;
  readonly providerReference: string | null;
  readonly providerPaymentId: string | null;
}

interface OracleRefund {
  readonly paymentId: string;
  readonly status: string;
  readonly amountPaise: number;
  readonly currency: string;
  readonly providerPaymentId: string;
  readonly providerRefundId: string | null;
  readonly refundKey: string;
}

interface OracleView {
  readonly totalPaise: number;
  readonly bookingStatus: string;
  readonly payments: readonly OraclePayment[];
  readonly refunds: readonly OracleRefund[];
}

type Decision = "APPLIED" | "RECORDED" | `REJECTED:${string}`;

function expectedPaymentDecision(
  view: OracleView,
  event: Readonly<{ confirmed: boolean; reference: string; paymentId: string; amount: number; currency: string }>,
): Decision {
  const target = view.payments.find((payment) => payment.providerReference === event.reference);
  if (target === undefined) return event.confirmed ? "REJECTED:REFERENCE_MISMATCH" : "RECORDED";
  // Attempt failures and informational events never move money.
  if (!event.confirmed) return "RECORDED";
  if (event.currency !== target.currency) return "REJECTED:CURRENCY_MISMATCH";
  if (event.amount !== target.amountPaise) return "REJECTED:AMOUNT_MISMATCH";
  if (target.status === "PENDING") return "APPLIED";
  if (SETTLED_ONLINE.has(target.status)) {
    return target.providerPaymentId !== null && target.providerPaymentId !== event.paymentId
      ? "REJECTED:PAYMENT_LEDGER_INCONSISTENT" : "RECORDED";
  }
  if (target.status === "PAYMENT_FAILED") {
    // A late capture fits only if the bill is still payable and has room next to everything else.
    const others = view.payments.filter((payment) => payment.id !== target.id);
    const reserved = others.filter((payment) => APPLIED_STATUSES.has(payment.status) || payment.status === "PENDING")
      .reduce((sum, payment) => sum + payment.amountPaise, 0);
    const capacity = PAYABLE_BOOKING.has(view.bookingStatus) ? view.totalPaise - reserved : 0;
    return capacity >= target.amountPaise ? "APPLIED" : "REJECTED:PAYMENT_LEDGER_INCONSISTENT";
  }
  return "REJECTED:PAYMENT_LEDGER_INCONSISTENT";
}

function expectedRefundDecision(
  view: OracleView,
  event: Readonly<{ processed: boolean; refundId: string; receipt: string; paymentId: string; amount: number; currency: string }>,
): Decision {
  const refund = view.refunds.find((candidate) => candidate.providerRefundId === event.refundId)
    ?? view.refunds.find((candidate) => candidate.refundKey === event.receipt);
  // A refund the platform never requested (for example one made in the provider dashboard).
  if (refund === undefined) return "REJECTED:PAYMENT_LEDGER_INCONSISTENT";
  if (event.paymentId !== refund.providerPaymentId || (refund.providerRefundId !== null && refund.providerRefundId !== event.refundId)) {
    return "REJECTED:REFERENCE_MISMATCH";
  }
  if (event.currency !== refund.currency) return "REJECTED:CURRENCY_MISMATCH";
  if (event.amount !== refund.amountPaise) return "REJECTED:AMOUNT_MISMATCH";
  if (refund.status === "PROCESSED") return "RECORDED";
  if (refund.status === "FAILED") return event.processed ? "REJECTED:PAYMENT_LEDGER_INCONSISTENT" : "RECORDED";
  const payment = view.payments.find((candidate) => candidate.id === refund.paymentId);
  return payment?.status === "REFUND_PENDING" ? "APPLIED" : "REJECTED:PAYMENT_LEDGER_INCONSISTENT";
}

/** What the service returns for a store decision. */
function expectWebhookResult(result: ProviderWebhookResult, decision: Decision): void {
  if (decision.startsWith("REJECTED:")) {
    expect(result).toMatchObject({ outcome: "REJECTED_PAYLOAD", httpStatus: 200, reasonCode: decision.slice("REJECTED:".length) });
  } else {
    expect(result).toMatchObject({ outcome: "ACCEPTED", httpStatus: 200 });
    expect(result.reasonCode).toBeUndefined();
  }
}

// ---- Generated commands ----

interface WebhookCommand {
  readonly kind: "WEBHOOK";
  readonly intent: Intent;
  readonly event: WebhookEventType;
  readonly mismatch: Mismatch;
  readonly second: boolean;
  readonly signature: SignatureMode;
  readonly eventId: EventIdMode;
  readonly delta: number;
}

type Command =
  | WebhookCommand
  | { readonly kind: "REDELIVER"; readonly mode: "SAME_ID" | "NEW_ID" | "NO_ID"; readonly back: number }
  | { readonly kind: "API_CAPTURE"; readonly intent: Intent }
  | { readonly kind: "RELEASE"; readonly intent: Intent }
  | { readonly kind: "DISPUTE" }
  | { readonly kind: "REQUEST_REFUND"; readonly intent: Intent }
  | { readonly kind: "CASH_FILL" }
  | { readonly kind: "CHECKOUT_RETURN"; readonly intent: Intent; readonly claimedStatus: string; readonly claimedPayment: "REAL" | "FORGED";
    readonly claimedSignature: "CHECKOUT" | "RANDOM" | "NONE"; readonly alsoToWebhook: boolean };

const intentArbitrary = fc.constantFrom<Intent>("A", "B");
const signatureArbitrary = fc.oneof(
  { weight: 10, arbitrary: fc.constantFrom<SignatureMode>("VALID") },
  { weight: 1, arbitrary: fc.constantFrom<SignatureMode>("UPPERCASE") },
  { weight: 4, arbitrary: fc.constantFrom<SignatureMode>("WRONG_SECRET", "TAMPERED_BODY", "TRUNCATED", "NON_HEX", "MISSING",
    "RESERIALIZED", "CHECKOUT_SIGNATURE", "NO_RAW_BODY") },
);
const webhookArbitrary = (events: readonly WebhookEventType[], mismatches: readonly Mismatch[]): fc.Arbitrary<WebhookCommand> => fc.record({
  kind: fc.constant("WEBHOOK" as const),
  intent: intentArbitrary,
  event: fc.constantFrom(...events),
  mismatch: fc.oneof({ weight: 6, arbitrary: fc.constant<Mismatch>("NONE") }, { weight: 3, arbitrary: fc.constantFrom(...mismatches) }),
  second: fc.oneof({ weight: 6, arbitrary: fc.constant(false) }, { weight: 1, arbitrary: fc.constant(true) }),
  signature: signatureArbitrary,
  eventId: fc.constantFrom<EventIdMode>("FRESH", "FRESH", "FRESH", "REUSE_LAST", "NONE"),
  delta: fc.oneof(fc.integer({ min: 1, max: 10_000 }), fc.integer({ min: -10_000, max: -1 })),
});

const commandArbitrary: fc.Arbitrary<Command> = fc.oneof(
  { weight: 8, arbitrary: webhookArbitrary(["payment.captured", "payment.captured", "order.paid", "payment.failed", "payment.authorized"],
    ["AMOUNT", "CURRENCY", "REFERENCE", "MALFORMED"]) },
  { weight: 4, arbitrary: webhookArbitrary(["refund.processed", "refund.failed"], ["AMOUNT", "CURRENCY", "REFERENCE", "MALFORMED"]) },
  { weight: 4, arbitrary: fc.record({ kind: fc.constant("REDELIVER" as const), mode: fc.constantFrom("SAME_ID" as const, "NEW_ID" as const, "NO_ID" as const),
    back: fc.nat({ max: 4 }) }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("API_CAPTURE" as const), intent: intentArbitrary }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("RELEASE" as const), intent: intentArbitrary }) },
  { weight: 1, arbitrary: fc.constant({ kind: "DISPUTE" as const }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant("REQUEST_REFUND" as const), intent: intentArbitrary }) },
  { weight: 1, arbitrary: fc.constant({ kind: "CASH_FILL" as const }) },
  { weight: 2, arbitrary: fc.record({
    kind: fc.constant("CHECKOUT_RETURN" as const), intent: intentArbitrary,
    claimedStatus: fc.constantFrom("success", "captured", "paid", "PAID_ONLINE", "failed", ""),
    claimedPayment: fc.constantFrom("REAL" as const, "FORGED" as const),
    claimedSignature: fc.constantFrom("CHECKOUT" as const, "RANDOM" as const, "NONE" as const),
    alsoToWebhook: fc.boolean(),
  }) },
);

const scenarioArbitrary = fc.record({
  totalPaise: fc.integer({ min: 300, max: 5_000_000 }),
  shareA: fc.double({ min: 0.1, max: 0.9, noNaN: true }),
  fillB: fc.boolean(),
});

// ---- Transactional SQL double running the real PostgresPaymentStore ----

type Row = Record<string, unknown>;

interface LedgerState {
  booking: { id: string; public_reference: string; customer_id: string; owner_id: string; status: string; version: number };
  invoice: { id: string; booking_id: string; invoice_version: number; status: string; total_paise: string; currency: string };
  payments: Row[];
  paymentEvents: Row[];
  providerEvents: Row[];
  refunds: Row[];
  statusHistory: Row[];
  outbox: Row[];
  audit: Row[];
  idempotency: Array<[string, { request_digest: string; status: string; response_body: unknown | null }]>;
  sequence: number;
}

const uuidFor = (prefix: string, sequence: number) => `${prefix}000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
const BOOKING_ID = uuidFor("70", 1);
const INVOICE_ID = uuidFor("90", 1);
const FARMER_ID = "farmer-1";
const OWNER_ID = "owner-1";

const uniqueViolation = () => Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" });
const at = (value: unknown): Date | null => value === null || value === undefined ? null : new Date(String(value));

/**
 * In-memory PostgreSQL stand-in for the payment store's statements, with snapshot-and-restore
 * transactions and the provider_events (provider, provider_event_id) and payments
 * (provider, provider_reference) unique indexes, so rejected work leaves no partial state.
 */
class LedgerConnection implements SqlConnection {
  state: LedgerState;
  private snapshot: LedgerState | undefined;

  constructor(totalPaise: number) {
    this.state = {
      booking: { id: BOOKING_ID, public_reference: "KT-PBT00001", customer_id: FARMER_ID, owner_id: OWNER_ID, status: "FINAL_BILL_GENERATED", version: 7 },
      invoice: { id: INVOICE_ID, booking_id: BOOKING_ID, invoice_version: 1, status: "ISSUED", total_paise: String(totalPaise), currency: "INR" },
      payments: [], paymentEvents: [], providerEvents: [], refunds: [], statusHistory: [], outbox: [], audit: [], idempotency: [], sequence: 0,
    };
  }

  async query<Result extends object>(sql: string, values: readonly unknown[] = []): Promise<SqlQueryResult<Result>> {
    const text = sql.replace(/\s+/gu, " ").trim();
    const s = this.state;
    const rows = (list: readonly object[]) => this.result<Result>(list.map((row) => ({ ...row })));
    if (text.startsWith("BEGIN")) { this.snapshot = structuredClone(this.state); return rows([]); }
    if (text === "COMMIT") { this.snapshot = undefined; return rows([]); }
    if (text === "ROLLBACK") {
      if (this.snapshot !== undefined) this.state = this.snapshot;
      this.snapshot = undefined;
      return rows([]);
    }
    if (text.startsWith("SELECT set_config")) return rows([]);

    // Idempotency records.
    const idempotencyKey = `${values[0]}|${values[1]}`;
    if (text.startsWith("INSERT INTO public.idempotency_records")) {
      if (!s.idempotency.some(([key]) => key === idempotencyKey)) {
        s.idempotency.push([idempotencyKey, { request_digest: String(values[2]), status: "IN_PROGRESS", response_body: null }]);
      }
      return rows([]);
    }
    if (text.startsWith("SELECT request_digest, status, response_body FROM public.idempotency_records")) {
      const found = s.idempotency.find(([key]) => key === idempotencyKey);
      return rows(found === undefined ? [] : [found[1]]);
    }
    if (text.startsWith("UPDATE public.idempotency_records SET status")) {
      const found = s.idempotency.find(([key]) => key === idempotencyKey)!;
      found[1] = { ...found[1], status: "COMPLETED", response_body: JSON.parse(String(values[2])) };
      return rows([]);
    }

    // Booking and invoice.
    if (text.startsWith("SELECT id, public_reference, customer_id, owner_id, status, version FROM public.bookings WHERE id = $1")) {
      return rows(values[0] === s.booking.id ? [s.booking] : []);
    }
    if (text.startsWith("UPDATE public.bookings SET status = $2")) {
      if (values[0] !== s.booking.id || Number(values[3]) !== s.booking.version) return rows([]);
      s.booking.status = String(values[1]);
      s.booking.version += 1;
      return rows([{ version: s.booking.version }]);
    }
    if (text.startsWith("INSERT INTO public.booking_status_history")) {
      s.statusHistory.push({ from: values[1], to: values[2] });
      return rows([]);
    }
    if (text.startsWith("SELECT id, booking_id, invoice_version, status, total_paise, currency FROM public.invoices")) {
      const key = text.includes("WHERE booking_id = $1") ? s.invoice.booking_id : s.invoice.id;
      return rows(values[0] === key ? [s.invoice] : []);
    }

    // Payments.
    if (text.startsWith("SELECT id, invoice_id, method")) {
      if (text.includes("WHERE invoice_id = $1")) return rows(s.payments.filter((row) => row.invoice_id === values[0]));
      if (text.includes("WHERE id = $1")) return rows(s.payments.filter((row) => row.id === values[0]));
    }
    if (text.startsWith("SELECT p.invoice_id, i.booking_id FROM public.payments p")) {
      const payment = s.payments.find((row) => row.id === values[0]);
      return rows(payment === undefined ? [] : [{ invoice_id: payment.invoice_id, booking_id: s.invoice.booking_id }]);
    }
    if (text.startsWith("SELECT p.id FROM public.payments p WHERE p.provider = $1 AND p.provider_reference = $2")) {
      return rows(s.payments.filter((row) => row.provider === values[0] && row.provider_reference === values[1]).map((row) => ({ id: row.id })));
    }
    if (text.startsWith("SELECT id FROM public.payments WHERE provider = $1 AND provider_payment_id = $2")) {
      return rows(s.payments.filter((row) => row.provider === values[0] && row.provider_payment_id === values[1]).map((row) => ({ id: row.id })));
    }
    if (text.startsWith("INSERT INTO public.payments")) {
      if (values[5] !== null && s.payments.some((row) => row.provider === values[5] && row.provider_reference === values[6])) throw uniqueViolation();
      const row: Row = {
        id: uuidFor("a0", ++s.sequence), invoice_id: values[0], method: values[1], status: values[2], amount_paise: String(values[3]),
        currency: values[4], provider: values[5], provider_reference: values[6], recorded_by_user_id: values[7], received_at: at(values[8]),
        verified_at: null, created_at: at(values[9]), version: 1, provider_payment_id: null, provider_mode: values[10], reconciled_at: null,
      };
      s.payments.push(row);
      return rows([row]);
    }
    if (text.startsWith("UPDATE public.payments SET status = $2")) {
      const row = s.payments.find((candidate) => candidate.id === values[0]);
      if (row === undefined) return rows([]);
      if (text.includes("verified_at = COALESCE")) {
        // [id, toStatus, verifiedAt, updatedAt, version, providerPaymentId, fromStatus]
        if (Number(row.version) !== Number(values[4]) || row.status !== values[6]) return rows([]);
        row.verified_at = values[2] === null ? row.verified_at : at(values[2]);
        row.provider_payment_id = row.provider_payment_id ?? values[5];
      } else {
        // [id, toStatus, updatedAt, version, fromStatus?]
        if (Number(row.version) !== Number(values[3])) return rows([]);
        if (text.includes("AND status = 'PENDING'") && row.status !== "PENDING") return rows([]);
        if (text.includes("AND status = 'REFUND_PENDING'") && row.status !== "REFUND_PENDING") return rows([]);
        if (text.includes("AND status = $5") && row.status !== values[4]) return rows([]);
        if (text.includes("reconciled_at = $3")) row.reconciled_at = at(values[2]);
      }
      row.status = values[1];
      row.version = Number(row.version) + 1;
      return rows([row]);
    }
    if (text.startsWith("INSERT INTO public.payment_events")) {
      if (text.includes("'PROVIDER'")) {
        s.paymentEvents.push({ payment_id: values[0], event_type: values[1], from_status: values[2], to_status: values[3], channel: "PROVIDER" });
      } else if (text.includes("VALUES ($1, $2, NULL, $3")) {
        s.paymentEvents.push({ payment_id: values[0], event_type: values[1], from_status: null, to_status: values[2], channel: values[5] });
      } else {
        s.paymentEvents.push({ payment_id: values[0], event_type: values[1], from_status: values[2], to_status: values[3], channel: values[6] });
      }
      return rows([]);
    }

    // Provider evidence: the store's own dedupe query, and the unique (provider, event id) index.
    if (text.startsWith("SELECT provider_event_id FROM public.provider_events WHERE provider = $1 AND (provider_event_id = $2 OR payload_digest = $3)")) {
      const matches = s.providerEvents
        .map((row, index) => ({ row, index }))
        .filter(({ row }) => row.provider === values[0] && (row.provider_event_id === values[1] || row.payload_digest === values[2]))
        .sort((left, right) => (left.row.received_at as Date).getTime() - (right.row.received_at as Date).getTime() || left.index - right.index);
      return rows(matches.slice(0, 1).map(({ row }) => ({ provider_event_id: row.provider_event_id })));
    }
    if (text.startsWith("INSERT INTO public.provider_events")) {
      const release = text.includes("'api.intent.unpaid'");
      const row: Row = release
        ? { id: uuidFor("e0", ++s.sequence), payment_id: values[0], provider: values[1], provider_event_id: values[2], provider_reference: values[3],
          event_type: "api.intent.unpaid", status: "APPLIED", signature_verified: false, amount_paise: values[4], currency: values[5],
          payload_digest: values[6], received_at: at(values[7]), evidence_source: "PROVIDER_API", payment_refund_id: null }
        : { id: uuidFor("e0", ++s.sequence), payment_id: values[0], provider: values[1], provider_event_id: values[2], provider_reference: values[3],
          event_type: values[4], status: values[5], signature_verified: values[6], amount_paise: values[7], currency: values[8],
          payload_digest: values[9], received_at: at(values[11]), evidence_source: values[13], payment_refund_id: values[14] };
      if (s.providerEvents.some((existing) => existing.provider === row.provider && existing.provider_event_id === row.provider_event_id)) {
        throw uniqueViolation();
      }
      s.providerEvents.push(row);
      return rows([{ id: row.id }]);
    }

    // Refund requests.
    if (text.startsWith("SELECT r.id, r.payment_id") && text.includes("FROM public.payment_refunds r WHERE")) {
      const clause = text.slice(text.indexOf(" WHERE ") + 7);
      const match = (row: Row) => clause.startsWith("r.id = $1 AND r.provider = $2") ? row.id === values[0] && row.provider === values[1]
        : clause.startsWith("r.provider = $1 AND r.provider_refund_id = $2") ? row.provider === values[0] && row.provider_refund_id === values[1]
          : clause.startsWith("r.provider = $1 AND r.refund_key = $2") ? row.provider === values[0] && row.refund_key === values[1]
            : clause.startsWith("r.id = $1") ? row.id === values[0] : (() => { throw new Error(`Unexpected refund clause: ${clause}`); })();
      return rows(s.refunds.filter(match));
    }
    if (text.startsWith("INSERT INTO public.payment_refunds AS r")) {
      const row: Row = {
        id: values[0], payment_id: values[1], provider: values[2], provider_payment_id: values[3], provider_refund_id: null, refund_key: values[4],
        amount_paise: String(values[5]), currency: values[6], status: "REQUESTED", reason_code: values[7], submit_attempts: 0,
        requested_at: at(values[10]), resolved_at: null, version: 1,
      };
      s.refunds.push(row);
      return rows([row]);
    }
    if (text.startsWith("UPDATE public.payment_refunds SET provider_refund_id = $2, status = 'SUBMITTED'")) {
      const row = s.refunds.find((candidate) => candidate.id === values[0] && candidate.provider_refund_id === null);
      if (row !== undefined) Object.assign(row, { provider_refund_id: values[1], status: "SUBMITTED", version: Number(row.version) + 1 });
      return rows([]);
    }
    if (text.startsWith("UPDATE public.payment_refunds AS r SET status = $2")) {
      const row = s.refunds.find((candidate) => candidate.id === values[0] && (candidate.status === "REQUESTED" || candidate.status === "SUBMITTED"));
      if (row === undefined) return rows([]);
      Object.assign(row, { status: values[1], provider_refund_id: row.provider_refund_id ?? values[2], resolved_at: at(values[3]), version: Number(row.version) + 1 });
      return rows([row]);
    }

    if (text.startsWith("INSERT INTO public.outbox_events")) {
      const row = {
        id: uuidFor("0b", ++s.sequence), aggregate_type: values[0], aggregate_id: values[1], event_type: values[2], event_version: values[3],
        payload: JSON.parse(String(values[4])), status: "PENDING", available_at: new Date(0), created_at: new Date(0),
      };
      s.outbox.push(row);
      return rows([row]);
    }
    if (text.startsWith("INSERT INTO public.audit_events")) {
      const row = {
        id: uuidFor("ad", ++s.sequence), action: values[2], resource_type: values[3], outcome: values[5], reason_code: values[6],
        correlation_id: values[7], pii_safe_metadata: JSON.parse(String(values[8])), occurred_at: at(values[9]) ?? new Date(0),
      };
      s.audit.push(row);
      return rows([row]);
    }
    throw new Error(`Unexpected SQL in test: ${text}`);
  }

  release() {}

  private result<Result extends object>(list: readonly object[]): SqlQueryResult<Result> {
    return { rows: list as readonly Result[], rowCount: list.length };
  }

  view(): OracleView {
    return {
      totalPaise: Number(this.state.invoice.total_paise),
      bookingStatus: this.state.booking.status,
      payments: this.state.payments.map((row) => ({
        id: String(row.id), method: String(row.method), status: String(row.status), amountPaise: Number(row.amount_paise),
        currency: String(row.currency), providerReference: (row.provider_reference as string | null) ?? null,
        providerPaymentId: (row.provider_payment_id as string | null) ?? null,
      })),
      refunds: this.state.refunds.map((row) => ({
        paymentId: String(row.payment_id), status: String(row.status), amountPaise: Number(row.amount_paise), currency: String(row.currency),
        providerPaymentId: String(row.provider_payment_id), providerRefundId: (row.provider_refund_id as string | null) ?? null,
        refundKey: String(row.refund_key),
      })),
    };
  }
}

class LedgerPool implements SqlPool {
  constructor(readonly connection: LedgerConnection) {}
  async connect() { return this.connection; }
  async query<Result extends object>(): Promise<SqlQueryResult<Result>> { throw new Error("transaction required"); }
}

const fingerprint = (state: LedgerState): string => JSON.stringify(state);
const slice = (state: LedgerState, ...keys: Array<keyof LedgerState>): string => JSON.stringify(keys.map((key) => state[key]));

const farmer: AuthPrincipal = { userId: FARMER_ID, sessionId: "s-farmer", roles: ["FARMER"] };
const farmerAuthenticator: PaymentSessionAuthenticator = {
  async authenticateAccessCredential(credential: string) {
    if (credential !== "farmer-access") throw new Error("unexpected credential");
    return farmer;
  },
};
const webhookContext: PaymentRequestContext = { correlationId: "pbt-provider-webhook", actorChannel: "PROVIDER" };
const systemContext: PaymentRequestContext = { correlationId: "pbt-reconciliation", actorChannel: "SYSTEM" };
const farmerContext: PaymentRequestContext = { correlationId: "pbt-farmer", actorChannel: "WEB" };
const supportContext: PaymentRequestContext = { correlationId: "pbt-support", actorChannel: "OPERATOR" };

/** The metric reason a webhook outcome must count, if any. */
const failureMetric = (metrics: InMemoryMetrics, reason: string) =>
  metrics.value("kt_payment_verification_failures_total", { method: "ONLINE", reason });

describe("Property 12: Payment Trust and Deduplication — webhook, API evidence, and checkout return through the payment store", () => {
  /** **Validates: Requirements 11.4, 11.5, 11.6** */
  it("never lets unverifiable evidence or browser claims move money, and applies each verified fact exactly once", async () => {
    const coverage: Record<string, number> = {};
    const count = (key: string) => { coverage[key] = (coverage[key] ?? 0) + 1; };

    await runSeeded("payment-trust-service", seeds.service, propertyRuns, async () => {
      await fc.assert(fc.asyncProperty(scenarioArbitrary, fc.array(commandArbitrary, { minLength: 4, maxLength: 30, size: "max" }), async (scenario, commands) => {
        const connection = new LedgerConnection(scenario.totalPaise);
        const store = new PostgresPaymentStore(new LedgerPool(connection));
        const metrics = new InMemoryMetrics();
        let clock = Date.UTC(2026, 2, 1, 12, 0, 0);
        const providerCaptures = new Map<string, { paymentId: string; amount: number }>();
        const adapter = new RazorpayPaymentAdapter({
          environment: "test", keyId: KEY_ID, keySecret: KEY_SECRET, webhookSecret: WEBHOOK_SECRET, http: providerApi(providerCaptures),
        });
        const service = new PaymentService(store, () => new Date(clock), new OperationalIndicators(metrics),
          new CapabilityRegistry({ ONLINE_PAYMENT: { state: "SANDBOX", provider: adapter } }));
        const controller = new FarmerPaymentController(farmerAuthenticator, service);
        const id = ids("M");

        // Two server-created intents on one bill; the second may fill it exactly.
        const amountA = Math.max(1, Math.floor(scenario.totalPaise * scenario.shareA));
        const room = scenario.totalPaise - amountA;
        const amounts: Record<Intent, number> = { A: amountA, B: scenario.fillB ? room : Math.max(1, Math.floor(room / 2)) };
        const paymentIds = {} as Record<Intent, string>;
        for (const intent of ["A", "B"] as const) {
          const created = await store.applyPayment({
            bookingId: BOOKING_ID, invoiceId: INVOICE_ID, method: "ONLINE", amountPaise: amounts[intent], currency: "INR",
            actorId: FARMER_ID, actorRole: "FARMER", provider: PROVIDER, providerReference: id.order(intent), providerMode: "SANDBOX",
            idempotencyKey: `intent-${intent}`, requestDigest: `intent-${intent}`, occurredAt: new Date(clock),
          }, farmerContext);
          paymentIds[intent] = created.payment.id;
        }
        const refundOrdinals: Record<Intent, number> = { A: 0, B: 0 };
        const refundIdFor = new Map<string, string>(); // refund key → provider refund id
        let eventSequence = 0;
        let lastHeaderEventId: string | undefined;
        const verifiedDeliveries: Array<{ readonly text: string; readonly headers: Record<string, string> }> = [];
        let cashSequence = 0;

        const rowOf = (intent: Intent) => connection.state.payments.find((row) => row.id === paymentIds[intent])!;
        const latestRefund = (intent: Intent) => connection.state.refunds.filter((row) => row.payment_id === paymentIds[intent]).at(-1);

        /** Delivers one webhook and checks the outcome against signature, dedupe, and the oracle. */
        const deliver = async (
          text: string,
          mode: SignatureMode,
          eventId: string | undefined,
          expectDecision: () => Decision | "PAYLOAD_INVALID" | "MUST_BE_DUPLICATE",
        ) => {
          const before = structuredClone(connection.state);
          const metricsBefore = metrics.total("kt_payment_verification_failures_total");
          const delivery = signedDelivery(text, mode, eventId, `${id.order("A")}|${id.pay("A")}`);
          const result = await service.handleProviderWebhook(PROVIDER, delivery.bytes, delivery.headers, webhookContext);

          if (mode === "NO_RAW_BODY") {
            count("rejected.rawBody");
            expect(result).toMatchObject({ outcome: "REJECTED_PAYLOAD", httpStatus: 400, reasonCode: "RAW_BODY_UNAVAILABLE" });
            expect(fingerprint(connection.state)).toBe(fingerprint(before));
            expect(failureMetric(metrics, "PAYMENT_EVIDENCE_REQUIRED")).toBeGreaterThan(0);
            return;
          }
          if (!VERIFIABLE.has(mode)) {
            // Requirement 11.4/11.5: an unverifiable delivery never reaches the store.
            count(`rejected.signature.${mode}`);
            expect(result).toMatchObject({
              outcome: "REJECTED_SIGNATURE", httpStatus: 401, reasonCode: mode === "MISSING" ? "SIGNATURE_MISSING" : "SIGNATURE_INVALID",
              payloadDigest: sha256(delivery.bytes!),
            });
            expect(fingerprint(connection.state)).toBe(fingerprint(before));
            expect(metrics.total("kt_payment_verification_failures_total")).toBe(metricsBefore + 1);
            return;
          }
          const expected = expectDecision();
          if (expected === "PAYLOAD_INVALID") {
            count("rejected.payload");
            expect(result).toMatchObject({ outcome: "REJECTED_PAYLOAD", httpStatus: 400, reasonCode: "PAYLOAD_INVALID" });
            expect(fingerprint(connection.state)).toBe(fingerprint(before));
            return;
          }
          const digest = sha256(encode(text));
          const providerEventId = eventId ?? `sha256:${digest}`;
          const prior = before.providerEvents
            .map((row, index) => ({ row, index }))
            .filter(({ row }) => row.provider === PROVIDER && (row.provider_event_id === providerEventId || row.payload_digest === digest))
            .sort((left, right) => (left.row.received_at as Date).getTime() - (right.row.received_at as Date).getTime() || left.index - right.index)[0];
          // Only bytes the store actually recorded can be redelivered as a known duplicate; a different
          // body under a reused event id is dropped by id and its bytes are never stored.
          if (prior === undefined) verifiedDeliveries.push({ text, headers: delivery.headers });
          if (prior !== undefined) {
            // Requirement 11.6: a repeated delivery is acknowledged and changes nothing.
            const replayed = prior.row.provider_event_id !== providerEventId;
            count(replayed ? "duplicate.replayed" : "duplicate.sameId");
            expect(result).toMatchObject({ outcome: "DUPLICATE", httpStatus: 200 });
            expect(fingerprint(connection.state)).toBe(fingerprint(before));
            expect(metrics.total("kt_payment_verification_failures_total")).toBe(metricsBefore + (replayed ? 1 : 0));
            return;
          }
          if (expected === "MUST_BE_DUPLICATE") throw new Error("a redelivery of recorded bytes must be a duplicate");
          count(`decision.${expected}`);
          expectWebhookResult(result, expected);
          expectRecorded(before, providerEventId, expected, digest);
        };

        /** One verified, non-duplicate evidence record was stored, with exactly the oracle's effect. */
        const expectRecorded = (before: LedgerState, providerEventId: string, expected: Decision, digest: string) => {
          const after = connection.state;
          const added = after.providerEvents.slice(before.providerEvents.length);
          expect(added).toHaveLength(1);
          expect(added[0]).toMatchObject({
            provider_event_id: providerEventId, payload_digest: digest,
            status: expected === "APPLIED" ? "APPLIED" : expected === "RECORDED" ? "VERIFIED" : "REJECTED",
          });
          if (expected === "APPLIED") {
            const effects = after.paymentEvents.slice(before.paymentEvents.length);
            expect(effects).toHaveLength(1);
            expect(effects[0]).toMatchObject({ channel: "PROVIDER" });
            const changed = after.payments.filter((row, index) => row.status !== before.payments[index]!.status);
            expect(changed).toHaveLength(1);
          } else {
            // No financial effect: payments, payment events, refunds, and the booking are untouched.
            expect(slice(after, "payments", "paymentEvents", "refunds", "booking", "outbox"))
              .toBe(slice(before, "payments", "paymentEvents", "refunds", "booking", "outbox"));
            if (expected.startsWith("REJECTED:")) {
              const audits = after.audit.slice(before.audit.length);
              expect(audits).toHaveLength(1);
              expect(audits[0]).toMatchObject({ outcome: "REJECTED", reason_code: expected.slice("REJECTED:".length) });
            } else {
              expect(after.audit).toHaveLength(before.audit.length);
            }
          }
        };

        for (const command of commands) {
          clock += 60_000;
          const statusesBefore = new Map(connection.state.payments.map((row) => [String(row.id), String(row.status)]));
          const createdAt = Math.floor(clock / 1_000);

          if (command.kind === "WEBHOOK") {
            const nextId = command.eventId === "NONE" ? undefined
              : command.eventId === "REUSE_LAST" && lastHeaderEventId !== undefined ? lastHeaderEventId : `KtPbtEvt${++eventSequence}`;
            if (nextId !== undefined) lastHeaderEventId = nextId;
            const row = rowOf(command.intent);
            const target = connection.view();
            const amountFor = (base: number) => command.mismatch === "AMOUNT" ? (base + command.delta > 0 ? base + command.delta : base + Math.abs(command.delta)) : base;
            const currency = command.mismatch === "CURRENCY" ? "USD" : "INR";
            if (command.event.startsWith("refund.")) {
              const refund = latestRefund(command.intent);
              const receipt = refund === undefined ? `ktrf${"0".repeat(31)}${command.intent === "A" ? "a" : "b"}` : String(refund.refund_key);
              const refundId = refund === undefined ? id.refund(command.intent, 9) : refundIdFor.get(receipt)!;
              const paymentId = command.mismatch === "REFERENCE" ? id.unknownPay : String(row.provider_payment_id ?? id.pay(command.intent));
              const amount = amountFor(refund === undefined ? Number(row.amount_paise) : Number(refund.amount_paise));
              const processed = command.event === "refund.processed";
              const text = refundEventBody({
                event: command.event as RefundEventType, refundId, paymentId, receipt, amount, currency, createdAt, malformed: command.mismatch === "MALFORMED",
              });
              await deliver(text, command.signature, nextId, () => {
                if (command.mismatch === "MALFORMED") return "PAYLOAD_INVALID";
                const decision = expectedRefundDecision(target, { processed, refundId, receipt, paymentId, amount, currency });
                count(`refund.${refund === undefined ? "unrequested" : "requested"}.${decision}`);
                return decision;
              });
            } else {
              const event = command.event as PaymentEventType;
              const reference = command.mismatch === "REFERENCE" ? id.unknownOrder : id.order(command.intent);
              const paymentId = id.pay(command.intent, command.second);
              const amount = amountFor(Number(row.amount_paise));
              const text = paymentEventBody({ event, orderId: reference, paymentId, amount, currency, createdAt, malformed: command.mismatch === "MALFORMED" });
              const confirmed = event === "payment.captured" || event === "order.paid";
              await deliver(text, command.signature, nextId, () => command.mismatch === "MALFORMED" && STRICT_EVENTS.has(event) ? "PAYLOAD_INVALID"
                : expectedPaymentDecision(target, { confirmed, reference, paymentId, amount, currency }));
            }
          } else if (command.kind === "REDELIVER") {
            const previous = verifiedDeliveries[verifiedDeliveries.length - 1 - (command.back % Math.max(1, verifiedDeliveries.length))];
            if (previous === undefined) continue;
            const eventId = command.mode === "NO_ID" ? undefined
              : command.mode === "NEW_ID" ? `KtPbtEvt${++eventSequence}` : previous.headers["x-razorpay-event-id"];
            // The same signed bytes again: already recorded, so only the dedupe answer is possible.
            await deliver(previous.text, "VALID", eventId, () => "MUST_BE_DUPLICATE");
          } else if (command.kind === "API_CAPTURE") {
            const row = rowOf(command.intent);
            providerCaptures.set(id.order(command.intent), { paymentId: id.pay(command.intent), amount: Number(row.amount_paise) });
            const read = await adapter.fetchIntentStatus(id.order(command.intent));
            const evidence: VerifiedProviderEventRecord = captureEvidence({ provider: PROVIDER, providerReference: id.order(command.intent) },
              { providerPaymentId: id.pay(command.intent), amountPaise: Number(row.amount_paise), currency: "INR" }, read, new Date(clock));
            const before = structuredClone(connection.state);
            const expected = expectedPaymentDecision(connection.view(), {
              confirmed: true, reference: id.order(command.intent), paymentId: id.pay(command.intent), amount: Number(row.amount_paise), currency: "INR",
            });
            const outcome = await store.recordProviderEvent(evidence, systemContext);
            const duplicate = before.providerEvents.some((event) => event.provider_event_id === evidence.providerEventId || event.payload_digest === evidence.payloadDigest);
            if (duplicate) {
              count("api.duplicate");
              expect(outcome.disposition).toBe("DUPLICATE");
              expect(fingerprint(connection.state)).toBe(fingerprint(before));
            } else {
              count(`api.${expected}`);
              expect(outcome.disposition).toBe(expected.startsWith("REJECTED:") ? "REJECTED" : expected);
              if (expected.startsWith("REJECTED:")) expect(outcome.rejectionCode).toBe(expected.slice("REJECTED:".length));
              expectRecorded(before, evidence.providerEventId, expected, evidence.payloadDigest);
            }
          } else if (command.kind === "RELEASE") {
            const row = rowOf(command.intent);
            const pending = row.status === "PENDING";
            const result = await store.releasePendingIntent({
              paymentId: String(row.id), reason: "EXPIRED", provider: PROVIDER,
              providerEvidenceDigest: `api:${sha256(`unpaid|${id.order(command.intent)}|${clock}`)}`, occurredAt: new Date(clock),
            }, systemContext);
            expect(result.released).toBe(pending);
            if (pending) count("release");
          } else if (command.kind === "DISPUTE") {
            if (PAYABLE_BOOKING.has(connection.state.booking.status)) {
              connection.state.booking.status = "DISPUTED";
              connection.state.booking.version += 1;
            }
          } else if (command.kind === "REQUEST_REFUND") {
            const row = rowOf(command.intent);
            // Refunds resolve a disputed bill: the Farmer disputes a paid bill before support refunds it.
            if (row.status === "PAID_ONLINE" && PAYABLE_BOOKING.has(connection.state.booking.status)) {
              connection.state.booking.status = "DISPUTED";
              connection.state.booking.version += 1;
            }
            const before = fingerprint(connection.state);
            const statusBefore = String(row.status);
            try {
              const result = await store.requestRefund({
                paymentId: String(row.id), reasonCode: "DISPUTE_RESOLVED", actorId: "support-1", actorRole: "SUPPORT", provider: PROVIDER,
                idempotencyKey: `refund-${command.intent}-${refundOrdinals[command.intent]}-${clock}`, requestDigest: `refund-${clock}`,
                occurredAt: new Date(clock),
              }, supportContext);
              expect(statusBefore).toBe("PAID_ONLINE");
              expect(result.payment.status).toBe("REFUND_PENDING");
              const refund = latestRefund(command.intent)!;
              refundIdFor.set(String(refund.refund_key), id.refund(command.intent, refundOrdinals[command.intent]++));
              count("refund.requested");
            } catch {
              // A refused request leaves nothing behind.
              expect(fingerprint(connection.state)).toBe(before);
            }
          } else if (command.kind === "CASH_FILL") {
            const view = connection.view();
            const reserved = view.payments.filter((payment) => APPLIED_STATUSES.has(payment.status) || payment.status === "PENDING")
              .reduce((sum, payment) => sum + payment.amountPaise, 0);
            const cash = scenario.totalPaise - reserved;
            if (cash <= 0) continue;
            const before = fingerprint(connection.state);
            try {
              await store.applyPayment({
                bookingId: BOOKING_ID, invoiceId: INVOICE_ID, method: "CASH", amountPaise: cash, currency: "INR", actorId: OWNER_ID, actorRole: "OWNER",
                idempotencyKey: `cash-${++cashSequence}`, requestDigest: `cash-${cashSequence}`, occurredAt: new Date(clock),
              }, { correlationId: "pbt-owner", actorChannel: "WEB" });
              count("cash");
            } catch {
              expect(fingerprint(connection.state)).toBe(before);
            }
          } else {
            // Requirement 11.4: whatever the browser claims, the return only reads stored state.
            const row = rowOf(command.intent);
            const claimedPaymentId = command.claimedPayment === "REAL" ? id.pay(command.intent) : id.unknownPay;
            const claimedSignature = command.claimedSignature === "CHECKOUT" ? hmac(KEY_SECRET, `${id.order(command.intent)}|${claimedPaymentId}`)
              : command.claimedSignature === "RANDOM" ? sha256(`forged|${clock}`) : undefined;
            const claim = JSON.stringify({
              razorpay_payment_id: claimedPaymentId, razorpay_order_id: id.order(command.intent), status: command.claimedStatus,
              ...(claimedSignature === undefined ? {} : { razorpay_signature: claimedSignature }),
            });
            const before = fingerprint(connection.state);
            const view = await controller.checkoutReturn({
              headers: {
                authorization: "Bearer farmer-access", "content-type": "application/json",
                ...(claimedSignature === undefined ? {} : { "x-razorpay-signature": claimedSignature }),
              },
              rawBody: encode(claim),
            }, String(row.id), "pbt-checkout-return");
            expect(view.payment.status).toBe(row.status);
            expect(view.confirmation).toBe(CONFIRMATION_FOR[String(row.status)]);
            expect(view.testMode).toBe(true);
            expect(fingerprint(connection.state)).toBe(before);
            count(`return.${String(row.status)}`);
            if (command.alsoToWebhook) {
              // The browser's checkout response posted to the webhook is not provider evidence either.
              const result = await service.handleProviderWebhook(PROVIDER, encode(claim), {
                "content-type": "application/json", ...(claimedSignature === undefined ? {} : { "x-razorpay-signature": claimedSignature }),
              }, webhookContext);
              expect(result).toMatchObject({ outcome: "REJECTED_SIGNATURE", httpStatus: 401 });
              expect(fingerprint(connection.state)).toBe(before);
            }
          }

          // ---- Invariants over committed state after every command ----
          const state = connection.state;
          for (const row of state.payments) {
            const previous = statusesBefore.get(String(row.id));
            // Settled money is never undone or re-applied out of order.
            if (previous !== undefined && previous !== row.status) expect(ALLOWED_MOVES[previous]).toContain(row.status);
            if (row.method === "ONLINE" && row.status === "PAID_ONLINE") {
              // Paid online only on verified provider evidence (Requirement 11.4).
              expect(row.verified_at).not.toBeNull();
              expect(state.paymentEvents.some((event) => event.payment_id === row.id && event.channel === "PROVIDER" && event.to_status === "PAID_ONLINE"))
                .toBe(true);
            }
            const confirmations = state.paymentEvents.filter((event) => event.payment_id === row.id && event.to_status === "PAID_ONLINE"
              && (event.from_status === "PENDING" || event.from_status === "PAYMENT_FAILED"));
            expect(confirmations.length).toBeLessThanOrEqual(1);
            expect(state.refunds.filter((refund) => refund.payment_id === row.id && refund.status === "PROCESSED").length).toBeLessThanOrEqual(1);
          }
          // Exactly once: one stored row per provider event id, and one financial effect per applied row.
          const eventIds = state.providerEvents.map((event) => `${event.provider}|${event.provider_event_id}`);
          expect(new Set(eventIds).size).toBe(eventIds.length);
          const appliedEvidence = state.providerEvents.filter((event) => event.status === "APPLIED" && event.event_type !== "api.intent.unpaid");
          expect(state.paymentEvents.filter((event) => event.channel === "PROVIDER")).toHaveLength(appliedEvidence.length);
          // Invoice-payment conservation.
          const applied = state.payments.filter((row) => APPLIED_STATUSES.has(String(row.status))).reduce((sum, row) => sum + Number(row.amount_paise), 0);
          expect(applied).toBeLessThanOrEqual(scenario.totalPaise);
          if (state.booking.status === "COMPLETED") expect(applied).toBe(scenario.totalPaise);
          if (applied === scenario.totalPaise) expect(PAYABLE_BOOKING.has(state.booking.status)).toBe(false);
          // PII-safe storage: payer contact details and secrets never reach any stored row.
          const stored = fingerprint(state);
          for (const secret of [PAYER_EMAIL, PAYER_CONTACT, WEBHOOK_SECRET, KEY_SECRET]) expect(stored).not.toContain(secret);
        }
      }), { seed: seeds.service, numRuns: propertyRuns });
    }, () => Object.entries(coverage).sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => `${key}=${value}`).join(" "));

    // Every generated family was exercised.
    for (const key of ["decision.APPLIED", "decision.RECORDED", "decision.REJECTED:AMOUNT_MISMATCH", "decision.REJECTED:CURRENCY_MISMATCH",
      "decision.REJECTED:REFERENCE_MISMATCH", "decision.REJECTED:PAYMENT_LEDGER_INCONSISTENT", "duplicate.sameId", "duplicate.replayed",
      "rejected.payload", "rejected.rawBody", "rejected.signature.WRONG_SECRET", "rejected.signature.RESERIALIZED",
      "rejected.signature.CHECKOUT_SIGNATURE", "api.APPLIED", "api.RECORDED", "release", "refund.requested", "return.PAID_ONLINE",
      "refund.requested.APPLIED", "refund.unrequested.REJECTED:PAYMENT_LEDGER_INCONSISTENT"]) {
      expect(coverage[key] ?? 0, key).toBeGreaterThan(0);
    }
  }, 300_000);
});

// ---- PostgreSQL variant: the real store, including concurrent duplicate deliveries ----

const databaseUrl = process.env.PAYMENT_TRUST_PROPERTY_DATABASE_URL;
const describeDatabase = databaseUrl === undefined ? describe.skip : describe;

type DatabaseCommand =
  | WebhookCommand
  | { readonly kind: "REDELIVER"; readonly mode: "SAME_ID" | "NEW_ID" | "NO_ID"; readonly back: number }
  | { readonly kind: "API_CAPTURE"; readonly intent: Intent }
  | { readonly kind: "BURST"; readonly intent: Intent; readonly mode: "SAME_EVENT" | "NEW_IDS" | "WEBHOOK_AND_API"; readonly copies: number };

const databaseCommandArbitrary: fc.Arbitrary<DatabaseCommand> = fc.oneof(
  { weight: 6, arbitrary: webhookArbitrary(["payment.captured", "order.paid", "payment.failed"], ["AMOUNT", "CURRENCY", "REFERENCE"])
    .map((command) => ({ ...command, signature: (["VALID", "UPPERCASE"].includes(command.signature) ? command.signature
      : ["WRONG_SECRET", "TAMPERED_BODY", "MISSING"][command.delta % 3 < 0 ? -(command.delta % 3) : command.delta % 3]) as SignatureMode })) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant("REDELIVER" as const), mode: fc.constantFrom("SAME_ID" as const, "NEW_ID" as const, "NO_ID" as const),
    back: fc.nat({ max: 3 }) }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("API_CAPTURE" as const), intent: intentArbitrary }) },
  { weight: 4, arbitrary: fc.record({ kind: fc.constant("BURST" as const), intent: intentArbitrary,
    mode: fc.constantFrom("SAME_EVENT" as const, "NEW_IDS" as const, "WEBHOOK_AND_API" as const), copies: fc.integer({ min: 2, max: 6 }) }) },
);

describeDatabase("Property 12: Payment Trust and Deduplication — PostgreSQL store with concurrent deliveries", () => {
  let pool: PgPoolAdapter;
  let database: TestDatabase;
  let ordinal = 600;

  beforeAll(async () => {
    pool = new PgPoolAdapter(new Pool({ connectionString: databaseUrl, max: 16 }));
    database = await createTestDatabaseFactory({ databaseUrl: databaseUrl!, createPool: async () => pool })();
  }, 120_000);

  afterAll(async () => {
    await database?.dispose();
  });

  /** **Validates: Requirements 11.4, 11.5, 11.6** */
  it("records each verified fact once and applies one financial effect per capture under concurrent duplicates", async () => {
    const coverage: Record<string, number> = {};
    const count = (key: string) => { coverage[key] = (coverage[key] ?? 0) + 1; };

    await runSeeded("payment-trust-postgresql", seeds.database, databaseRuns, async () => {
      await fc.assert(fc.asyncProperty(scenarioArbitrary, fc.array(databaseCommandArbitrary, { minLength: 4, maxLength: 14, size: "max" }), async (scenario, commands) => {
        ordinal += 1;
        const nonce = String(ordinal);
        const id = ids(nonce);
        const dataset = await seedRepresentativeDataset(pool, { ordinal });
        const bookingId = randomUUID();
        const agreementId = randomUUID();
        const invoiceId = randomUUID();
        let clock = Date.now() + 10 * 60_000;
        const start = new Date(clock + 3 * 86_400_000).toISOString();
        const end = new Date(clock + 3 * 86_400_000 + 90 * 60_000).toISOString();
        await pool.query(
          `INSERT INTO public.bookings (id, public_reference, customer_id, owner_id, tractor_id, service_offering_id,
             requested_start_at, requested_end_at, expected_quantity, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1.500, 'FINAL_BILL_GENERATED')`,
          [bookingId, `KT-PT${nonce.padStart(6, "0")}`, dataset.customerId, dataset.ownerId, dataset.tractorId, dataset.serviceOfferingId, start, end],
        );
        await pool.query(
          `INSERT INTO public.booking_agreements (id, booking_id, agreement_version, pricing_rule_id, pricing_rule_version, method,
             rate_paise, rounding_policy, estimated_quantity, estimated_total_paise, service_location_snapshot, approved_by_customer_at, disclosed_at)
           VALUES ($1, $2, 1, $3, 1, 'HOURLY', 80000, 'PROPORTIONAL_MINUTE', 1.500, $4,
             '{"state":"Telangana","district":"Warangal","mandalOrTaluk":"Hanamkonda","village":"Kazipet","source":"MANUAL_ADDRESS"}'::jsonb,
             CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [agreementId, bookingId, dataset.pricingRuleId, scenario.totalPaise],
        );
        await pool.query("UPDATE public.bookings SET current_agreement_id = $2 WHERE id = $1", [bookingId, agreementId]);
        await pool.query(
          `INSERT INTO public.invoices (id, booking_id, agreement_id, invoice_version, status, rate_paise, billable_quantity,
             subtotal_paise, adjustments_paise, total_paise, evidence_references, calculation_formula, rounding_trace)
           VALUES ($1, $2, $3, 1, 'ISSUED', 80000, 1.500, $4, 0, $4, '[]'::jsonb, 'property bill',
             '{"rawSubtotalNumerator":"0","rawSubtotalDenominator":"1","minorUnitRounding":"HALF_UP"}'::jsonb)`,
          [invoiceId, bookingId, agreementId, scenario.totalPaise],
        );

        const store = new PostgresPaymentStore(pool);
        const providerCaptures = new Map<string, { paymentId: string; amount: number }>();
        const adapter = new RazorpayPaymentAdapter({
          environment: "test", keyId: KEY_ID, keySecret: KEY_SECRET, webhookSecret: WEBHOOK_SECRET, http: providerApi(providerCaptures),
        });
        const service = new PaymentService(store, () => new Date(clock), new OperationalIndicators(new InMemoryMetrics()),
          new CapabilityRegistry({ ONLINE_PAYMENT: { state: "SANDBOX", provider: adapter } }));

        const amountA = Math.max(1, Math.floor(scenario.totalPaise * scenario.shareA));
        const room = scenario.totalPaise - amountA;
        const amounts: Record<Intent, number> = { A: amountA, B: scenario.fillB ? room : Math.max(1, Math.floor(room / 2)) };
        const paymentIds = {} as Record<Intent, string>;
        for (const intent of ["A", "B"] as const) {
          const created = await store.applyPayment({
            bookingId, invoiceId, method: "ONLINE", amountPaise: amounts[intent], currency: "INR", actorId: dataset.customerId, actorRole: "FARMER",
            provider: PROVIDER, providerReference: id.order(intent), providerMode: "SANDBOX",
            idempotencyKey: `pbt-intent-${intent}`, requestDigest: `pbt-intent-${intent}`, occurredAt: new Date(clock),
          }, farmerContext);
          paymentIds[intent] = created.payment.id;
        }

        // Model of what was recorded in this run (event ids and digests are unique to the run).
        const recorded: Array<{ readonly eventId: string; readonly digest: string }> = [];
        const verified: Array<{ readonly text: string; readonly eventId: string | undefined }> = [];
        let eventSequence = 0;
        let lastHeaderEventId: string | undefined;

        const loadView = async (): Promise<OracleView> => {
          const payments = await pool.query<{ id: string; method: string; status: string; amount_paise: string; currency: string;
            provider_reference: string | null; provider_payment_id: string | null }>(
            `SELECT id, method, status, amount_paise, currency, provider_reference, provider_payment_id FROM public.payments
             WHERE invoice_id = $1 ORDER BY created_at, id`, [invoiceId]);
          const booking = await pool.query<{ status: string }>("SELECT status FROM public.bookings WHERE id = $1", [bookingId]);
          return {
            totalPaise: scenario.totalPaise, bookingStatus: booking.rows[0]!.status, refunds: [],
            payments: payments.rows.map((row) => ({
              id: row.id, method: row.method, status: row.status, amountPaise: Number(row.amount_paise), currency: row.currency.trim(),
              providerReference: row.provider_reference, providerPaymentId: row.provider_payment_id,
            })),
          };
        };
        const isRecorded = (eventId: string, digest: string) => recorded.some((entry) => entry.eventId === eventId || entry.digest === digest);
        const webhookText = (intent: Intent, event: PaymentEventType, mismatch: Mismatch, second: boolean, delta: number, view: OracleView) => {
          const amount = view.payments.find((payment) => payment.id === paymentIds[intent])!.amountPaise;
          return {
            text: paymentEventBody({
              event, orderId: mismatch === "REFERENCE" ? id.unknownOrder : id.order(intent), paymentId: id.pay(intent, second),
              amount: mismatch === "AMOUNT" ? (amount + delta > 0 ? amount + delta : amount + Math.abs(delta)) : amount,
              currency: mismatch === "CURRENCY" ? "USD" : "INR", createdAt: Math.floor(clock / 1_000), malformed: false,
            }),
            amount: mismatch === "AMOUNT" ? (amount + delta > 0 ? amount + delta : amount + Math.abs(delta)) : amount,
          };
        };
        /** Provider at-least-once delivery: a conflict answer (5xx) is retried until the store answers. */
        const deliverWithRetry = async (text: string, mode: SignatureMode, eventId: string | undefined) => {
          const delivery = signedDelivery(text, mode, eventId, `${id.order("A")}|${id.pay("A")}`);
          for (let attempt = 1; ; attempt += 1) {
            try {
              return await service.handleProviderWebhook(PROVIDER, delivery.bytes, delivery.headers, webhookContext);
            } catch (error) {
              if ((error as { code?: string }).code !== "PAYMENT_CONFLICT" || attempt >= 5) throw error;
              count("burst.providerRetry");
            }
          }
        };

        for (const command of commands) {
          clock += 60_000;
          const view = await loadView();
          if (command.kind === "WEBHOOK") {
            const eventId = command.eventId === "NONE" ? undefined
              : command.eventId === "REUSE_LAST" && lastHeaderEventId !== undefined ? lastHeaderEventId : `KtPbt${nonce}E${++eventSequence}`;
            if (eventId !== undefined) lastHeaderEventId = eventId;
            const event = command.event as PaymentEventType;
            const { text, amount } = webhookText(command.intent, event, command.mismatch, command.second, command.delta, view);
            const result = await deliverWithRetry(text, command.signature, eventId);
            if (!VERIFIABLE.has(command.signature)) {
              count("db.rejected.signature");
              expect(result).toMatchObject({ outcome: "REJECTED_SIGNATURE", httpStatus: 401 });
              expect(await loadView()).toEqual(view);
              continue;
            }
            const digest = sha256(encode(text));
            const providerEventId = eventId ?? `sha256:${digest}`;
            verified.push({ text, eventId });
            if (isRecorded(providerEventId, digest)) {
              count("db.duplicate");
              expect(result).toMatchObject({ outcome: "DUPLICATE", httpStatus: 200 });
              expect(await loadView()).toEqual(view);
              continue;
            }
            const expected = expectedPaymentDecision(view, {
              confirmed: event !== "payment.failed", reference: command.mismatch === "REFERENCE" ? id.unknownOrder : id.order(command.intent),
              paymentId: id.pay(command.intent, command.second), amount, currency: command.mismatch === "CURRENCY" ? "USD" : "INR",
            });
            count(`db.${expected}`);
            expectWebhookResult(result, expected);
            recorded.push({ eventId: providerEventId, digest });
          } else if (command.kind === "REDELIVER") {
            const previous = verified[verified.length - 1 - (command.back % Math.max(1, verified.length))];
            if (previous === undefined) continue;
            const eventId = command.mode === "NO_ID" ? undefined : command.mode === "NEW_ID" ? `KtPbt${nonce}E${++eventSequence}` : previous.eventId;
            const result = await deliverWithRetry(previous.text, "VALID", eventId);
            count("db.redelivery");
            expect(result).toMatchObject({ outcome: "DUPLICATE", httpStatus: 200 });
            expect(await loadView()).toEqual(view);
          } else if (command.kind === "API_CAPTURE") {
            const amount = amounts[command.intent];
            providerCaptures.set(id.order(command.intent), { paymentId: id.pay(command.intent), amount });
            const read = await adapter.fetchIntentStatus(id.order(command.intent));
            const evidence = captureEvidence({ provider: PROVIDER, providerReference: id.order(command.intent) },
              { providerPaymentId: id.pay(command.intent), amountPaise: amount, currency: "INR" }, read, new Date(clock));
            const outcome = await store.recordProviderEvent(evidence, systemContext);
            if (isRecorded(evidence.providerEventId, evidence.payloadDigest)) {
              expect(outcome.disposition).toBe("DUPLICATE");
            } else {
              const expected = expectedPaymentDecision(view, { confirmed: true, reference: id.order(command.intent), paymentId: id.pay(command.intent), amount, currency: "INR" });
              count(`db.api.${expected}`);
              expect(outcome.disposition).toBe(expected.startsWith("REJECTED:") ? "REJECTED" : expected);
              recorded.push({ eventId: evidence.providerEventId, digest: evidence.payloadDigest });
            }
          } else {
            // Concurrent duplicate deliveries of one capture (Requirement 11.6).
            const { text, amount } = webhookText(command.intent, "payment.captured", "NONE", false, 1, view);
            const digest = sha256(encode(text));
            const baseId = `KtPbt${nonce}E${++eventSequence}`;
            const deliveries: Array<Promise<{ readonly eventId: string; readonly digest: string; readonly disposition: string }>> = [];
            const burstIds: string[] = [];
            for (let copy = 0; copy < command.copies; copy += 1) {
              const eventId = command.mode === "SAME_EVENT" ? baseId : `${baseId}C${copy}`;
              burstIds.push(eventId);
              deliveries.push(deliverWithRetry(text, "VALID", eventId).then((result) => ({ eventId, digest, disposition: result.outcome })));
            }
            let apiEvidence: VerifiedProviderEventRecord | undefined;
            if (command.mode === "WEBHOOK_AND_API") {
              providerCaptures.set(id.order(command.intent), { paymentId: id.pay(command.intent), amount });
              const read = await adapter.fetchIntentStatus(id.order(command.intent));
              apiEvidence = captureEvidence({ provider: PROVIDER, providerReference: id.order(command.intent) },
                { providerPaymentId: id.pay(command.intent), amountPaise: amount, currency: "INR" }, read, new Date(clock));
              const evidence = apiEvidence;
              deliveries.push((async () => {
                for (let attempt = 1; ; attempt += 1) {
                  try {
                    const outcome = await store.recordProviderEvent(evidence, systemContext);
                    return { eventId: evidence.providerEventId, digest: evidence.payloadDigest, disposition: outcome.disposition };
                  } catch (error) {
                    if ((error as { code?: string }).code !== "PAYMENT_CONFLICT" || attempt >= 5) throw error;
                    count("burst.providerRetry");
                  }
                }
              })());
            }
            const results = await Promise.all(deliveries);
            count(`db.burst.${command.mode}`);
            const webhookResults = results.slice(0, command.copies);
            const alreadyRecorded = isRecorded(command.mode === "SAME_EVENT" ? baseId : `${baseId}C0`, digest);
            // Every delivery is answered 2xx; the signed body is recorded at most once, whatever its event id.
            expect(webhookResults.every((result) => result.disposition === "ACCEPTED" || result.disposition === "DUPLICATE")).toBe(true);
            const stored = await pool.query<{ provider_event_id: string }>(
              "SELECT provider_event_id FROM public.provider_events WHERE provider = $1 AND provider_event_id = ANY($2::text[])", [PROVIDER, burstIds]);
            expect(stored.rows.length).toBe(alreadyRecorded ? 0 : 1);
            expect(webhookResults.filter((result) => result.disposition !== "DUPLICATE").length).toBe(alreadyRecorded ? 0 : 1);
            if (!alreadyRecorded) recorded.push({ eventId: stored.rows[0]!.provider_event_id, digest });
            if (apiEvidence !== undefined && results.at(-1)!.disposition !== "DUPLICATE") {
              recorded.push({ eventId: apiEvidence.providerEventId, digest: apiEvidence.payloadDigest });
            }
            const after = await loadView();
            const target = after.payments.find((payment) => payment.id === paymentIds[command.intent])!;
            const before = view.payments.find((payment) => payment.id === paymentIds[command.intent])!;
            // A pending intent is confirmed by the burst; an already-settled one is untouched.
            expect(target.status).toBe(before.status === "PENDING" ? "PAID_ONLINE" : before.status);
            if (before.status === "PENDING") count(`db.burst.${command.mode}.confirmedPending`);
          }

          // ---- Invariants over committed rows after every command ----
          const effects = await pool.query<{ id: string; status: string; amount_paise: string; effects: string; applied: string; confirmed: string }>(
            `SELECT p.id, p.status, p.amount_paise,
               (SELECT count(*) FROM public.payment_events e WHERE e.payment_id = p.id AND e.actor_channel = 'PROVIDER') AS effects,
               (SELECT count(*) FROM public.provider_events pe WHERE pe.payment_id = p.id AND pe.status = 'APPLIED') AS applied,
               (SELECT count(*) FROM public.outbox_events o WHERE o.aggregate_id::text = p.id::text AND o.event_type = 'OnlinePaymentConfirmed') AS confirmed
             FROM public.payments p WHERE p.invoice_id = $1`, [invoiceId]);
          let applied = 0;
          for (const row of effects.rows) {
            const paid = row.status === "PAID_ONLINE";
            expect(Number(row.effects)).toBe(paid ? 1 : 0);
            expect(Number(row.applied)).toBe(paid ? 1 : 0);
            expect(Number(row.confirmed)).toBe(paid ? 1 : 0);
            expect(["PENDING", "PAID_ONLINE"]).toContain(row.status);
            if (paid) applied += Number(row.amount_paise);
          }
          expect(applied).toBeLessThanOrEqual(scenario.totalPaise);
          const booking = (await pool.query<{ status: string }>("SELECT status FROM public.bookings WHERE id = $1", [bookingId])).rows[0]!.status;
          expect(booking).toBe(applied === scenario.totalPaise ? "COMPLETED" : applied > 0 ? "PAYMENT_RECORDED" : "FINAL_BILL_GENERATED");
        }

        // No duplicate event rows, and no payer contact detail stored for this run.
        const dump = await pool.query<{ dump: string | null }>(`SELECT concat_ws('|',
            (SELECT json_agg(pe)::text FROM public.provider_events pe WHERE pe.provider_reference LIKE $1),
            (SELECT json_agg(a)::text FROM public.audit_events a WHERE a.resource_id::text = ANY($2::text[])),
            (SELECT json_agg(o)::text FROM public.outbox_events o WHERE o.aggregate_id::text = ANY($2::text[]))) AS dump`,
          [`order_KtPbt${nonce}%`, Object.values(paymentIds)]);
        for (const secret of [PAYER_EMAIL, PAYER_CONTACT, WEBHOOK_SECRET, KEY_SECRET]) expect(dump.rows[0]!.dump ?? "").not.toContain(secret);
      }), { seed: seeds.database, numRuns: databaseRuns });
    }, () => Object.entries(coverage).sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => `${key}=${value}`).join(" "));

    for (const key of ["db.APPLIED", "db.duplicate", "db.redelivery", "db.burst.SAME_EVENT.confirmedPending",
      "db.burst.NEW_IDS.confirmedPending", "db.burst.WEBHOOK_AND_API.confirmedPending"]) {
      expect(coverage[key] ?? 0, key).toBeGreaterThan(0);
    }
  }, 600_000);
});
