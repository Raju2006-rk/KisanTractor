import type { SqlConnection, SqlPool, SqlQueryResult } from "@kisantractor/database";
import { describe, expect, it } from "vitest";

import type { PaymentRequestContext, ValidatedPaymentApplication } from "./payment.contracts.js";
import { PaymentCapabilityUnavailableError, PaymentConflictError, PaymentNotFoundError } from "./payment.service.js";
import { PostgresPaymentStore } from "./postgres-payment-store.js";

type Row = Record<string, unknown>;

class PaymentConnection implements SqlConnection {
  booking = {
    id: "booking-1", public_reference: "KT-2026-0001", customer_id: "farmer-1", owner_id: "owner-1",
    status: "FINAL_BILL_GENERATED", version: 7,
  };
  invoices: Row[] = [{
    id: "invoice-1", booking_id: "booking-1", invoice_version: 1, status: "ISSUED", total_paise: "120000", currency: "INR",
  }];
  readonly payments: Row[] = [];
  readonly paymentEvents: Row[] = [];
  readonly statusHistory: Row[] = [];
  readonly outboxTypes: string[] = [];
  readonly auditActions: string[] = [];
  readonly idempotency = new Map<string, { request_digest: string; status: string; response_body: unknown | null }>();
  rollbacks = 0;
  private sequence = 0;

  async query<Result extends object>(sql: string, values: readonly unknown[] = []): Promise<SqlQueryResult<Result>> {
    const text = sql.replace(/\s+/gu, " ").trim();
    if (text.startsWith("BEGIN") || text === "COMMIT" || text.startsWith("SELECT set_config")) return this.result([]);
    if (text === "ROLLBACK") { this.rollbacks += 1; return this.result([]); }

    if (text.startsWith("INSERT INTO public.idempotency_records")) {
      const key = `${values[0]}:${values[1]}`;
      if (!this.idempotency.has(key)) {
        this.idempotency.set(key, { request_digest: String(values[2]), status: "IN_PROGRESS", response_body: null });
      }
      return this.result([]);
    }
    if (text.startsWith("SELECT request_digest, status, response_body FROM public.idempotency_records")) {
      const row = this.idempotency.get(`${values[0]}:${values[1]}`);
      return this.result(row === undefined ? [] : [row]);
    }
    if (text.startsWith("UPDATE public.idempotency_records SET status")) {
      const key = `${values[0]}:${values[1]}`;
      this.idempotency.set(key, {
        request_digest: this.idempotency.get(key)!.request_digest,
        status: "COMPLETED",
        response_body: JSON.parse(String(values[2])),
      });
      return this.result([]);
    }
    if (text.startsWith("SELECT id, public_reference")) {
      return this.result(values[0] === this.booking.id ? [{ ...this.booking }] : []);
    }
    if (text.startsWith("SELECT id, booking_id, invoice_version") && text.includes("WHERE booking_id = $1")) {
      const latest = this.invoices.filter((row) => row.booking_id === values[0])
        .sort((a, b) => Number(b.invoice_version) - Number(a.invoice_version))[0];
      return this.result(latest === undefined ? [] : [{ ...latest }]);
    }
    if (text.startsWith("SELECT id, booking_id, invoice_version") && text.includes("WHERE id = $1")) {
      return this.result(this.invoices.filter((row) => row.id === values[0]));
    }
    if (text.startsWith("SELECT id, invoice_id, method") && text.includes("WHERE invoice_id = $1")) {
      return this.result(this.payments.filter((row) => row.invoice_id === values[0]).map((row) => ({ ...row })));
    }
    if (text.startsWith("SELECT id, invoice_id, method") && text.includes("WHERE id = $1")) {
      return this.result(this.payments.filter((row) => row.id === values[0]).map((row) => ({ ...row })));
    }
    if (text.startsWith("SELECT i.booking_id FROM public.payments")) {
      const payment = this.payments.find((row) => row.id === values[0]);
      const invoice = this.invoices.find((row) => row.id === payment?.invoice_id);
      return this.result(invoice === undefined ? [] : [{ booking_id: invoice.booking_id }]);
    }
    if (text.startsWith("INSERT INTO public.payments")) {
      const row = {
        id: `payment-${++this.sequence}`, invoice_id: values[0], method: values[1], status: values[2],
        amount_paise: String(values[3]), currency: values[4], provider: values[5], provider_reference: values[6],
        recorded_by_user_id: values[7], received_at: values[8] === null ? null : new Date(String(values[8])),
        verified_at: null, created_at: new Date(String(values[9])), version: 1,
      };
      this.payments.push(row);
      return this.result([{ ...row }]);
    }
    if (text.startsWith("UPDATE public.payments SET status")) {
      const row = this.payments.find((item) => item.id === values[0] && item.version === values[3]);
      if (row === undefined) return this.result([]);
      row.status = values[1];
      row.version = Number(row.version) + 1;
      return this.result([{ ...row }]);
    }
    if (text.startsWith("INSERT INTO public.payment_events")) {
      this.paymentEvents.push({ payment_id: values[0], event_type: values[1], text });
      return this.result([]);
    }
    if (text.startsWith("UPDATE public.bookings SET status")) {
      if (Number(values[3]) !== this.booking.version) return this.result([]);
      this.booking.status = String(values[1]);
      this.booking.version += 1;
      return this.result([{ version: this.booking.version }]);
    }
    if (text.startsWith("INSERT INTO public.booking_status_history")) {
      this.statusHistory.push({ from: values[1], to: values[2], actor: values[3], channel: values[4] });
      return this.result([]);
    }
    if (text.startsWith("INSERT INTO public.outbox_events")) {
      this.outboxTypes.push(String(values[2]));
      return this.result([{
        id: `outbox-${this.outboxTypes.length}`, aggregate_type: values[0], aggregate_id: values[1], event_type: values[2],
        event_version: values[3], payload: JSON.parse(String(values[4])), status: "PENDING",
        available_at: new Date(), created_at: new Date(),
      }]);
    }
    if (text.startsWith("INSERT INTO public.audit_events")) {
      this.auditActions.push(String(values[2]));
      return this.result([{
        id: `audit-${this.auditActions.length}`, correlation_id: values[7],
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

class PaymentPool implements SqlPool {
  constructor(readonly connection: PaymentConnection) {}
  async connect() { return this.connection; }
  async query<Result extends object>(): Promise<SqlQueryResult<Result>> { throw new Error("transaction required"); }
}

const context: PaymentRequestContext = { correlationId: "corr-1", actorChannel: "WEB" };
const cash = (overrides: Partial<ValidatedPaymentApplication> = {}): ValidatedPaymentApplication => ({
  bookingId: "booking-1",
  invoiceId: "invoice-1",
  method: "CASH",
  amountPaise: 50_000,
  currency: "INR",
  actorId: "owner-1",
  actorRole: "OWNER",
  receivedAt: new Date("2026-03-01T11:55:00.000Z"),
  idempotencyKey: "cash-key-1",
  requestDigest: "digest-1",
  occurredAt: new Date("2026-03-01T12:00:00.000Z"),
  ...overrides,
});

const setup = () => {
  const connection = new PaymentConnection();
  return { connection, store: new PostgresPaymentStore(new PaymentPool(connection)) };
};

/** Validates: Requirements 11.1, 11.2, 11.7, 8.10, 12.4 */
describe("PostgresPaymentStore.applyPayment", () => {
  it("applies Owner-confirmed cash, records payment history, and moves the booking to payment-recorded once", async () => {
    const { connection, store } = setup();

    const first = await store.applyPayment(cash(), context);
    expect(first.payment).toMatchObject({ method: "CASH", status: "PAID_CASH", amountPaise: 50_000, confirmedBy: "OWNER" });
    expect(first.payment.paidAt).toEqual(new Date("2026-03-01T11:55:00.000Z"));
    expect(first.settlement).toMatchObject({
      bookingStatus: "PAYMENT_RECORDED", invoiceId: "invoice-1",
      settlement: { status: "PAYMENT_DUE", appliedPaise: 50_000, outstandingPaise: 70_000, settled: false },
    });
    expect(connection.payments[0]).toMatchObject({ recorded_by_user_id: "owner-1", provider: null, provider_reference: null });
    expect(connection.statusHistory).toEqual([
      { from: "FINAL_BILL_GENERATED", to: "PAYMENT_RECORDED", actor: null, channel: "SYSTEM" },
    ]);

    const second = await store.applyPayment(cash({ amountPaise: 70_000, idempotencyKey: "cash-key-2", requestDigest: "digest-2" }), context);
    expect(second.settlement.settlement).toMatchObject({ status: "PAID_CASH", settled: true, outstandingPaise: 0 });
    expect(second.settlement.bookingStatus).toBe("COMPLETED");
    expect(second.settlement.payments).toHaveLength(2);
    expect(connection.statusHistory).toEqual([
      { from: "FINAL_BILL_GENERATED", to: "PAYMENT_RECORDED", actor: null, channel: "SYSTEM" },
      { from: "PAYMENT_RECORDED", to: "COMPLETED", actor: null, channel: "SYSTEM" },
    ]);
    expect(connection.paymentEvents.map((event) => event.event_type)).toEqual(["CASH_PAYMENT_RECORDED", "CASH_PAYMENT_RECORDED"]);
    expect(connection.auditActions).toEqual(["CASH_PAYMENT_RECORDED", "CASH_PAYMENT_RECORDED"]);
    expect(connection.outboxTypes).toEqual([
      "BookingPaymentRecorded", "CashPaymentRecorded", "BookingCompleted", "CashPaymentRecorded",
    ]);

    // A settled, completed booking accepts no further payment.
    await expect(store.applyPayment(cash({ amountPaise: 1, idempotencyKey: "cash-key-3", requestDigest: "digest-3" }), context))
      .rejects.toMatchObject({ code: "PAYMENT_BOOKING_NOT_PAYABLE" });
    expect(connection.payments).toHaveLength(2);
  });

  it("completes the booking in the same transaction when one cash payment settles the whole bill", async () => {
    const { connection, store } = setup();
    const result = await store.applyPayment(cash({ amountPaise: 120_000 }), context);

    expect(result.settlement).toMatchObject({
      bookingStatus: "COMPLETED",
      settlement: { status: "PAID_CASH", settled: true, appliedPaise: 120_000, outstandingPaise: 0 },
    });
    expect(connection.booking).toMatchObject({ status: "COMPLETED", version: 9 });
    expect(connection.statusHistory.map((entry) => entry.to)).toEqual(["PAYMENT_RECORDED", "COMPLETED"]);
    expect(connection.payments[0]).toMatchObject({ method: "CASH", status: "PAID_CASH", recorded_by_user_id: "owner-1" });
  });

  it("replays the same idempotent result without a second financial effect", async () => {
    const { connection, store } = setup();
    const first = await store.applyPayment(cash(), context);
    const replay = await store.applyPayment(cash(), context);

    expect(replay).toEqual(first);
    expect(replay.payment.recordedAt).toBeInstanceOf(Date);
    expect(connection.payments).toHaveLength(1);
    expect(connection.outboxTypes.filter((type) => type === "CashPaymentRecorded")).toHaveLength(1);
    await expect(store.applyPayment(cash({ requestDigest: "different" }), context))
      .rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
  });

  it("rejects overpayment, disputed settlement, superseded bills, and unrelated recorders without mutation", async () => {
    const { connection, store } = setup();
    await expect(store.applyPayment(cash({ amountPaise: 120_001 }), context))
      .rejects.toMatchObject({ code: "PAYMENT_OVERPAYMENT" });
    // An unrelated Owner is told the booking is unavailable, revealing nothing about its state.
    await expect(store.applyPayment(cash({ actorId: "owner-2", idempotencyKey: "k-2" }), context))
      .rejects.toBeInstanceOf(PaymentNotFoundError);
    // The booking Farmer cannot confirm cash; only the assigned Owner can.
    await expect(store.applyPayment(cash({ actorId: "farmer-1", actorRole: "FARMER", idempotencyKey: "k-2b" }), context))
      .rejects.toMatchObject({ code: "PAYMENT_ACTOR_NOT_PERMITTED" });

    connection.invoices.push({ ...connection.invoices[0]!, id: "invoice-2", invoice_version: 2 });
    await expect(store.applyPayment(cash({ idempotencyKey: "k-3" }), context)).rejects.toBeInstanceOf(PaymentConflictError);

    connection.booking.status = "DISPUTED";
    await expect(store.applyPayment(cash({ invoiceId: "invoice-2", idempotencyKey: "k-4" }), context))
      .rejects.toMatchObject({ code: "PAYMENT_SETTLEMENT_BLOCKED" });
    connection.booking.status = "IN_PROGRESS";
    await expect(store.applyPayment(cash({ invoiceId: "invoice-2", idempotencyKey: "k-5" }), context))
      .rejects.toMatchObject({ code: "PAYMENT_BOOKING_NOT_PAYABLE" });

    expect(connection.payments).toHaveLength(0);
    expect(connection.paymentEvents).toHaveLength(0);
    expect(connection.rollbacks).toBe(6);
  });

  it("creates online intents only as pending and refuses provider-confirmed changes it cannot verify", async () => {
    const { connection, store } = setup();
    await expect(store.applyPayment(cash({ method: "ONLINE", receivedAt: undefined, actorId: "farmer-1", actorRole: "FARMER" }), context))
      .rejects.toMatchObject({ field: "provider" });

    const intent = await store.applyPayment({
      ...cash({ method: "ONLINE", actorId: "farmer-1", actorRole: "FARMER", amountPaise: 120_000 }),
      receivedAt: undefined, provider: "sandbox-gateway", providerReference: "order_1",
    }, context);
    expect(intent.payment).toMatchObject({ method: "ONLINE", status: "PENDING" });
    expect(intent.payment.paidAt).toBeUndefined();
    expect(intent.settlement.settlement).toMatchObject({ status: "PENDING", settled: false, pendingPaise: 120_000 });
    expect(intent.settlement.bookingStatus).toBe("FINAL_BILL_GENERATED");

    await expect(store.transitionPayment({
      paymentId: intent.payment.id, toStatus: "PAID_ONLINE", expectedVersion: 1, actorRole: "PROVIDER",
      evidence: { kind: "VERIFIED_PROVIDER_EVENT", providerEventId: "evt_1" }, occurredAt: new Date("2026-03-01T12:01:00.000Z"),
    }, context)).rejects.toBeInstanceOf(PaymentCapabilityUnavailableError);
    expect(connection.payments[0]?.status).toBe("PENDING");
  });
});

/** Validates: Requirements 11.1, 12.4 */
describe("PostgresPaymentStore.transitionPayment", () => {
  it("moves a cash payment to the refund-pending placeholder with an appended event and version check", async () => {
    const { connection, store } = setup();
    const applied = await store.applyPayment(cash({ amountPaise: 120_000 }), context);
    const occurredAt = new Date("2026-03-02T09:00:00.000Z");

    await expect(store.transitionPayment({
      paymentId: applied.payment.id, toStatus: "REFUND_PENDING", expectedVersion: 1, actorRole: "SUPPORT",
      actorId: "support-1", occurredAt,
    }, context)).rejects.toMatchObject({ code: "PAYMENT_REASON_REQUIRED" });

    const moved = await store.transitionPayment({
      paymentId: applied.payment.id, toStatus: "REFUND_PENDING", expectedVersion: 1, actorRole: "SUPPORT",
      actorId: "support-1", reason: "Dispute upheld after review", occurredAt,
    }, context);
    expect(moved).toMatchObject({ version: 2, payment: { status: "REFUND_PENDING", method: "CASH" } });
    expect(connection.paymentEvents.at(-1)).toMatchObject({ event_type: "REFUND_REQUESTED" });
    expect(connection.outboxTypes.at(-1)).toBe("PaymentRefundRequested");

    await expect(store.transitionPayment({
      paymentId: applied.payment.id, toStatus: "REFUND_PENDING", expectedVersion: 1, actorRole: "SUPPORT",
      reason: "Retry", occurredAt,
    }, context)).rejects.toMatchObject({ code: "PAYMENT_CONFLICT" });
  });
});

/** Validates: Requirements 11.8, 12.2 */
describe("PostgresPaymentStore reads", () => {
  it("loads the current invoice ledger and a receipt source with supersession state", async () => {
    const { store } = setup();
    expect(await store.loadBookingPayments("missing", context)).toBeUndefined();
    const applied = await store.applyPayment(cash({ amountPaise: 120_000 }), context);

    const source = await store.loadBookingPayments("booking-1", context);
    expect(source).toMatchObject({
      booking: { id: "booking-1", reference: "KT-2026-0001", status: "COMPLETED" },
      invoice: { id: "invoice-1", totalPaise: 120_000, currency: "INR" },
    });
    expect(source?.payments).toHaveLength(1);

    const receipt = await store.loadReceiptSource(applied.payment.id, context);
    expect(receipt).toMatchObject({ invoiceSuperseded: false, payment: { id: applied.payment.id, amountPaise: 120_000 } });
    expect(await store.loadReceiptSource("payment-missing", context)).toBeUndefined();
  });
});
