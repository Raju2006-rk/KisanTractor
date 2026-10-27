import type { AuthPrincipal } from "@kisantractor/domain";
import { PaymentRuleError } from "@kisantractor/domain";
import { InMemoryMetrics, OperationalIndicators } from "@kisantractor/observability";
import { describe, expect, it } from "vitest";

import type { BookingProjection, BookingStore, ValidatedBookingTransition } from "./booking/booking.contracts.js";
import { BookingConflictError, BookingService, type BookingConflictReason } from "./booking/booking.service.js";
import type { JobStore, ValidatedJobAction, WorkSessionProjection } from "./job/job.contracts.js";
import { InvalidJobSequenceError, JobConflictError, JobService } from "./job/job.service.js";
import type { PaymentApplicationResult, PaymentStore } from "./payment/payment.contracts.js";
import { PaymentConflictError, PaymentService } from "./payment/payment.service.js";

const owner: AuthPrincipal = { userId: "owner-1", sessionId: "s-1", roles: ["OWNER"] };
const farmer: AuthPrincipal = { userId: "farmer-1", sessionId: "s-2", roles: ["FARMER"] };
const context = { correlationId: "corr-indicators-1", actorChannel: "WEB" as const };
const secrets = { fieldEncryptionKey: new Uint8Array(32).fill(1), lookupHashKey: new Uint8Array(32).fill(2) };
const unused = (): never => {
  throw new Error("not used by this test");
};

/** A booking store whose transitions fail with a scripted conflict reason. */
class ConflictingBookingStore implements BookingStore {
  readonly transitions: ValidatedBookingTransition[] = [];
  constructor(private readonly reason: BookingConflictReason | undefined) {}
  createBooking = unused;
  changeAgreement = unused;
  expirePendingBookings = unused;
  async transitionBooking(input: ValidatedBookingTransition): Promise<BookingProjection> {
    this.transitions.push(input);
    if (this.reason === undefined) return { id: input.bookingId } as unknown as BookingProjection;
    throw new BookingConflictError("conflict", this.reason);
  }
}

/** Validates: Requirements 18.2 */
describe("operational indicators in domain services", () => {
  it("counts Owner acceptance conflicts by reason without counting other refusals", async () => {
    const metrics = new InMemoryMetrics();
    const indicators = new OperationalIndicators(metrics);
    const command = { bookingId: "booking-1", expectedVersion: 1 };
    for (const reason of ["OVERLAP", "CONCURRENT_RESERVATION", "VERSION_CONFLICT", "OTHER"] as const) {
      const service = new BookingService(new ConflictingBookingStore(reason), secrets, undefined, indicators);
      await expect(service.acceptBooking(owner, command, context)).rejects.toBeInstanceOf(BookingConflictError);
    }
    // A conflicting rejection is not an acceptance conflict.
    const rejecting = new BookingService(new ConflictingBookingStore("VERSION_CONFLICT"), secrets, undefined, indicators);
    await expect(rejecting.rejectBooking(owner, { ...command, reason: "Busy" }, context)).rejects.toThrow();
    // A successful acceptance records nothing.
    await new BookingService(new ConflictingBookingStore(undefined), secrets, undefined, indicators)
      .acceptBooking(owner, command, context);

    expect(metrics.value("kt_booking_acceptance_conflicts_total", { reason: "OVERLAP" })).toBe(1);
    expect(metrics.value("kt_booking_acceptance_conflicts_total", { reason: "CONCURRENT_RESERVATION" })).toBe(1);
    expect(metrics.value("kt_booking_acceptance_conflicts_total", { reason: "VERSION_CONFLICT" })).toBe(1);
    expect(metrics.total("kt_booking_acceptance_conflicts_total")).toBe(3);
    expect(metrics.total("kt_invalid_transitions_total")).toBe(0);
  });

  it("counts invalid booking and work transitions by aggregate and action", async () => {
    const metrics = new InMemoryMetrics();
    const indicators = new OperationalIndicators(metrics);
    const bookings = new BookingService(new ConflictingBookingStore("INVALID_TRANSITION"), secrets, undefined, indicators);
    await expect(bookings.transitionLifecycle(farmer, { bookingId: "booking-1", expectedVersion: 3, reason: "Wrong bill" }, context, "DISPUTE"))
      .rejects.toBeInstanceOf(BookingConflictError);

    let failure: Error = new InvalidJobSequenceError("Cannot pause work", "NOT_STARTED", ["START"]);
    const jobStore: JobStore = {
      loadWorkSession: unused,
      correctWorkEvent: unused,
      correctWorkMeasurement: unused,
      recordAction: async (_input: ValidatedJobAction): Promise<WorkSessionProjection> => {
        throw failure;
      },
    };
    const jobs = new JobService(jobStore, () => new Date("2026-03-01T10:00:00.000Z"), indicators);
    await expect(jobs.pauseJob(owner, { bookingId: "booking-1", idempotencyKey: "job-key-1" }, context))
      .rejects.toBeInstanceOf(InvalidJobSequenceError);
    failure = new JobConflictError("changed concurrently");
    await expect(jobs.startJob(owner, { bookingId: "booking-1", idempotencyKey: "job-key-2" }, context))
      .rejects.toBeInstanceOf(JobConflictError);

    expect(metrics.value("kt_invalid_transitions_total", { aggregate: "BOOKING", action: "DISPUTE" })).toBe(1);
    expect(metrics.value("kt_invalid_transitions_total", { aggregate: "WORK", action: "PAUSE" })).toBe(1);
    expect(metrics.total("kt_invalid_transitions_total")).toBe(2);
  });

  it("counts cash payment verification failures by rule code and ignores successes", async () => {
    const metrics = new InMemoryMetrics();
    const failures: Error[] = [
      new PaymentConflictError("PAYMENT_OVERPAYMENT", "too much"),
      new PaymentRuleError("PAYMENT_SETTLEMENT_BLOCKED", "disputed"),
      new PaymentConflictError("SOMETHING_NEW", "unexpected code"),
    ];
    let next: Error | undefined;
    const store: PaymentStore = {
      loadBookingPayments: unused,
      loadReceiptSource: unused,
      transitionPayment: unused,
      previewPaymentApplication: unused,
      recordProviderEvent: unused,
      applyPayment: async () => {
        if (next !== undefined) throw next;
        return {} as PaymentApplicationResult;
      },
    };
    const payments = new PaymentService(store, () => new Date("2026-03-01T10:00:00.000Z"), new OperationalIndicators(metrics));
    const command = { bookingId: "booking-1", invoiceId: "invoice-1", amountPaise: 120_000, idempotencyKey: "cash-key-1" };
    for (const failure of failures) {
      next = failure;
      await expect(payments.recordCash(owner, command, context)).rejects.toBe(failure);
    }
    next = undefined;
    await payments.recordCash(owner, command, context);

    expect(metrics.value("kt_payment_verification_failures_total", { method: "CASH", reason: "PAYMENT_OVERPAYMENT" })).toBe(1);
    expect(metrics.value("kt_payment_verification_failures_total", { method: "CASH", reason: "PAYMENT_SETTLEMENT_BLOCKED" })).toBe(1);
    // Unknown codes collapse to OTHER instead of creating new series.
    expect(metrics.value("kt_payment_verification_failures_total", { method: "CASH", reason: "OTHER" })).toBe(1);
    expect(metrics.total("kt_payment_verification_failures_total")).toBe(3);
  });
});
