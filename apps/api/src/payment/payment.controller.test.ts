import { projectPaymentRecord, type AuthPrincipal, type PaymentRecordSource } from "@kisantractor/domain";
import { HttpException } from "@nestjs/common";
import { describe, expect, it } from "vitest";

import type {
  BookingPaymentsSource,
  PaymentApplicationResult,
  PaymentReceiptRecordSource,
  PaymentSessionAuthenticator,
  PaymentStore,
  ValidatedPaymentApplication,
} from "./payment.contracts.js";
import { FarmerPaymentController, OwnerPaymentController } from "./payment.controller.js";
import { PaymentService, toSettlementProjection } from "./payment.service.js";

const booking = {
  id: "70000000-0000-4000-8000-000000000001", reference: "KT-2026-0001", customerId: "farmer-1", ownerId: "owner-1",
  status: "PAYMENT_RECORDED" as const, version: 8,
};
const invoice = { id: "90000000-0000-4000-8000-000000000001", bookingId: "70000000-0000-4000-8000-000000000001", invoiceVersion: 1, status: "ISSUED" as const, totalPaise: 120_000, currency: "INR" };
const cash = (id: string, amountPaise: number): PaymentRecordSource => ({
  id, invoiceId: "90000000-0000-4000-8000-000000000001", method: "CASH", status: "PAID_CASH", amountPaise, currency: "INR",
  recordedByUserId: "owner-1", receivedAt: new Date("2026-03-01T11:55:00.000Z"),
  createdAt: new Date("2026-03-01T12:00:00.000Z"),
});

class MemoryStore implements PaymentStore {
  payments: PaymentRecordSource[] = [cash("a0000000-0000-4000-8000-000000000001", 50_000)];
  readonly applied: ValidatedPaymentApplication[] = [];
  async loadBookingPayments(bookingId: string): Promise<BookingPaymentsSource | undefined> {
    return bookingId === booking.id ? { booking, invoice, payments: this.payments } : undefined;
  }
  async loadReceiptSource(paymentId: string): Promise<PaymentReceiptRecordSource | undefined> {
    const payment = this.payments.find((item) => item.id === paymentId);
    return payment === undefined ? undefined : {
      booking, invoice, invoiceSuperseded: false, payment, invoicePayments: this.payments,
    };
  }
  async applyPayment(input: ValidatedPaymentApplication): Promise<PaymentApplicationResult> {
    this.applied.push(input);
    const payment = { ...cash(`payment-${this.payments.length + 1}`, input.amountPaise), receivedAt: input.receivedAt ?? input.occurredAt };
    // Settlement math is real; the ledger itself is left unchanged so each call is evaluated alone.
    return {
      payment: projectPaymentRecord(payment, booking),
      settlement: toSettlementProjection({ booking, invoice, payments: [...this.payments, payment] }),
    };
  }
  async transitionPayment(): Promise<never> { throw new Error("not used"); }
  async previewPaymentApplication(): Promise<never> { throw new Error("not used"); }
  async recordProviderEvent(): Promise<never> { throw new Error("not used"); }
}

class FixedAuthenticator implements PaymentSessionAuthenticator {
  constructor(private readonly principal: AuthPrincipal) {}
  async authenticateAccessCredential(credential: string): Promise<AuthPrincipal> {
    if (credential !== "access-token") throw new HttpException({ code: "UNAUTHENTICATED" }, 401);
    return this.principal;
  }
}

const request = { headers: { authorization: "Bearer access-token" } };
const farmer: AuthPrincipal = { userId: "farmer-1", sessionId: "s-1", roles: ["FARMER"] };
const owner: AuthPrincipal = { userId: "owner-1", sessionId: "s-2", roles: ["OWNER", "FARMER"] };
const stranger: AuthPrincipal = { userId: "farmer-9", sessionId: "s-3", roles: ["FARMER", "OWNER"] };

const status = async (promise: Promise<unknown>): Promise<number> => {
  const error = await promise.then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(HttpException);
  return (error as HttpException).getStatus();
};

/** Validates: Requirements 2.3, 2.4, 2.5, 11.1, 11.8, 12.2 */
describe("payment controllers", () => {
  it("show the same authoritative settlement to the booking Farmer and the assigned Owner", async () => {
    const store = new MemoryStore();
    const farmerView = await new FarmerPaymentController(new FixedAuthenticator(farmer), new PaymentService(store))
      .settlement(request, "70000000-0000-4000-8000-000000000001");
    const ownerView = await new OwnerPaymentController(new FixedAuthenticator(owner), new PaymentService(store))
      .settlement(request, "70000000-0000-4000-8000-000000000001");

    expect(farmerView).toEqual(ownerView);
    expect(farmerView).toMatchObject({
      bookingReference: "KT-2026-0001", invoiceId: "90000000-0000-4000-8000-000000000001",
      settlement: { status: "PAYMENT_DUE", appliedPaise: 50_000, outstandingPaise: 70_000, settled: false },
    });
    expect(farmerView.payments[0]).toEqual({
      id: "a0000000-0000-4000-8000-000000000001", invoiceId: "90000000-0000-4000-8000-000000000001", method: "CASH", status: "PAID_CASH", amountPaise: 50_000,
      currency: "INR", recordedAt: new Date("2026-03-01T12:00:00.000Z"),
      paidAt: new Date("2026-03-01T11:55:00.000Z"), confirmedBy: "OWNER",
    });
    expect(JSON.stringify(farmerView)).not.toMatch(/recordedByUserId|provider/u);
  });

  it("returns a receipt only after settlement and hides payments from unrelated principals", async () => {
    const store = new MemoryStore();
    const farmerController = new FarmerPaymentController(new FixedAuthenticator(farmer), new PaymentService(store));

    expect(await status(farmerController.receipt(request, "a0000000-0000-4000-8000-000000000001"))).toBe(409);
    store.payments.push(cash("a0000000-0000-4000-8000-000000000002", 70_000));
    await expect(farmerController.receipt(request, "a0000000-0000-4000-8000-000000000002")).resolves.toMatchObject({
      bookingId: "70000000-0000-4000-8000-000000000001", invoiceId: "90000000-0000-4000-8000-000000000001", paymentId: "a0000000-0000-4000-8000-000000000002", method: "CASH",
      status: "PAID_CASH", settlementStatus: "PAID_CASH", amountPaise: 70_000,
    });

    const strangerFarmer = new FarmerPaymentController(new FixedAuthenticator(stranger), new PaymentService(store));
    const strangerOwner = new OwnerPaymentController(new FixedAuthenticator(stranger), new PaymentService(store));
    expect(await status(strangerFarmer.settlement(request, "70000000-0000-4000-8000-000000000001"))).toBe(404);
    expect(await status(strangerOwner.receipt(request, "a0000000-0000-4000-8000-000000000002"))).toBe(404);
    // A Farmer-only account cannot read through the Owner route even for its own booking.
    const farmerAsOwner = new OwnerPaymentController(new FixedAuthenticator(farmer), new PaymentService(store));
    expect(await status(farmerAsOwner.settlement(request, "70000000-0000-4000-8000-000000000001"))).toBe(404);
    expect(await status(farmerController.settlement(request, "70000000-0000-4000-8000-000000000404"))).toBe(404);
    expect(await status(farmerController.settlement({ headers: {} }, "70000000-0000-4000-8000-000000000001"))).toBe(401);
  });
});

/** Validates: Requirements 2.3, 11.2, 11.7, 17.4 */
describe("Owner cash recording endpoint", () => {
  const serverNow = new Date("2026-03-01T12:30:00.000Z");
  const ownerController = (store: MemoryStore, principal: AuthPrincipal = owner) =>
    new OwnerPaymentController(new FixedAuthenticator(principal), new PaymentService(store, () => serverNow));
  const keyed = { headers: { authorization: "Bearer access-token", "idempotency-key": "cash-key-0001" } };

  it("records cash as the assigned Owner with a server timestamp, recorder, and stable request digest", async () => {
    const store = new MemoryStore();
    const result = await ownerController(store).recordCash(keyed, "70000000-0000-4000-8000-000000000001", {
      invoiceId: "90000000-0000-4000-8000-000000000001", amountPaise: "70000", receivedAt: "2026-03-01T12:10:00.000Z",
    });

    expect(store.applied[0]).toMatchObject({
      bookingId: "70000000-0000-4000-8000-000000000001", invoiceId: "90000000-0000-4000-8000-000000000001", method: "CASH", amountPaise: 70_000, currency: "INR",
      actorId: "owner-1", actorRole: "OWNER", receivedAt: new Date("2026-03-01T12:10:00.000Z"),
      idempotencyKey: "cash-key-0001", occurredAt: serverNow,
    });
    expect(result.payment).toMatchObject({ method: "CASH", status: "PAID_CASH", confirmedBy: "OWNER" });
    expect(result.settlement.settlement).toMatchObject({ status: "PAID_CASH", settled: true });

    // The same confirmation produces the same digest, so the store can replay it; a changed one cannot reuse the key.
    await ownerController(store).recordCash(keyed, "70000000-0000-4000-8000-000000000001", {
      invoiceId: "90000000-0000-4000-8000-000000000001", amountPaise: 70_000, receivedAt: "2026-03-01T12:10:00.000Z",
    });
    await ownerController(store).recordCash(keyed, "70000000-0000-4000-8000-000000000001", { invoiceId: "90000000-0000-4000-8000-000000000001", amountPaise: 69_999 });
    expect(store.applied[1]!.requestDigest).toBe(store.applied[0]!.requestDigest);
    expect(store.applied[2]!.requestDigest).not.toBe(store.applied[0]!.requestDigest);
    expect(store.applied[2]!.receivedAt).toBeUndefined();
  });

  it("rejects fractional or nonpositive paise, future receipt times, and missing keys without applying anything", async () => {
    const store = new MemoryStore();
    const controller = ownerController(store);
    for (const body of [
      { invoiceId: "90000000-0000-4000-8000-000000000001", amountPaise: 100.5 },
      { invoiceId: "90000000-0000-4000-8000-000000000001", amountPaise: 0 },
      { invoiceId: "90000000-0000-4000-8000-000000000001", amountPaise: "12.00" },
      { invoiceId: "90000000-0000-4000-8000-000000000001", amountPaise: 1_000, receivedAt: "2026-03-01T12:30:00.001Z" },
      { invoiceId: "90000000-0000-4000-8000-000000000001", amountPaise: 1_000, receivedAt: "not-a-time" },
      { amountPaise: 1_000 },
    ]) {
      expect(await status(controller.recordCash(keyed, "70000000-0000-4000-8000-000000000001", body))).toBe(422);
    }
    expect(await status(controller.recordCash(request, "70000000-0000-4000-8000-000000000001", { invoiceId: "90000000-0000-4000-8000-000000000001", amountPaise: 1_000 }))).toBe(422);
    expect(store.applied).toHaveLength(0);
  });

  it("does not let a Farmer-only account record cash", async () => {
    const store = new MemoryStore();
    expect(await status(ownerController(store, farmer).recordCash(keyed, "70000000-0000-4000-8000-000000000001", { invoiceId: "90000000-0000-4000-8000-000000000001", amountPaise: 1_000 })))
      .toBe(404);
    expect(store.applied).toHaveLength(0);
  });
});
