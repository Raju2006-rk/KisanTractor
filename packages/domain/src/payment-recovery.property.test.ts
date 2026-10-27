import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  evaluatePaymentApplication,
  evaluateRefundRequest,
  lateConfirmationCapacity,
  planPaymentTransition,
  summarizeInvoiceSettlement,
  type PayableInvoice,
  type PaymentLedgerEntry,
  type PaymentMethod,
  type PaymentRecordStatus,
} from "./payments.js";
import {
  evaluateProviderPaymentEvent,
  evaluateProviderRefundEvent,
  type PaymentRefundStatus,
} from "./provider-payment-events.js";

// Feature: kisantractor-platform, Property 13 invoice-payment conservation (task 16.2): releases of
// stale intents, late provider confirmations, and refund outcomes keep applied money within the bill.
const propertyRuns = 200;
const seed = 1_602_131;
const parties = { customerId: "farmer-1", ownerId: "owner-1" } as const;
const APPLIED: ReadonlySet<PaymentRecordStatus> = new Set(["PAID_CASH", "PAID_ONLINE", "REFUND_PENDING"]);

type Command =
  | { readonly kind: "PAY"; readonly method: PaymentMethod; readonly share: number }
  | { readonly kind: "CONFIRM"; readonly target: number }
  | { readonly kind: "RELEASE"; readonly target: number }
  | { readonly kind: "DISPUTE"; readonly disputed: boolean }
  | { readonly kind: "REFUND"; readonly target: number }
  | { readonly kind: "REFUND_OUTCOME"; readonly target: number; readonly processed: boolean };

// Weighted toward online payments that get confirmed, so disputes, refunds, and refund outcomes
// are reached often enough to be exercised in every run.
const commandArbitrary: fc.Arbitrary<Command> = fc.oneof(
  { weight: 4, arbitrary: fc.record({
    kind: fc.constant("PAY" as const), method: fc.constantFrom<PaymentMethod>("ONLINE", "ONLINE", "CASH"), share: fc.integer({ min: 1, max: 3 }),
  }) },
  { weight: 4, arbitrary: fc.record({ kind: fc.constant("CONFIRM" as const), target: fc.nat(5) }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("RELEASE" as const), target: fc.nat(5) }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("DISPUTE" as const), disputed: fc.constantFrom(true, true, false) }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant("REFUND" as const), target: fc.nat(5) }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant("REFUND_OUTCOME" as const), target: fc.nat(5), processed: fc.boolean() }) },
);

interface Refund { readonly paymentId: string; readonly amountPaise: number; status: PaymentRefundStatus }

const attempt = <T>(run: () => T): T | undefined => {
  try {
    return run();
  } catch {
    return undefined;
  }
};

describe("payment recovery and refund conservation", () => {
  /** **Validates: Requirements 11.1, 11.7, 12.4** */
  it("never lets released, late-confirmed, or refunded money exceed the bill or be refunded twice", () => {
    let releases = 0;
    let lateConfirmations = 0;
    let refundsProcessed = 0;
    try {
      fc.assert(fc.property(
        fc.integer({ min: 100, max: 500_000 }),
        fc.array(commandArbitrary, { minLength: 4, maxLength: 30, size: "max" }),
        (totalPaise, commands) => {
          const invoice: PayableInvoice = { id: "invoice-1", totalPaise, currency: "INR", status: "ISSUED", superseded: false };
          const ledger: PaymentLedgerEntry[] = [];
          const refunds: Refund[] = [];
          let disputed = false;
          let clock = 0;
          const at = () => new Date(Date.UTC(2026, 2, 1) + (clock += 60_000));

          for (const command of commands) {
            const pick = (target: number) => (ledger.length === 0 ? undefined : ledger[target % ledger.length]!);
            const replace = (entry: PaymentLedgerEntry, status: PaymentRecordStatus) => {
              ledger[ledger.indexOf(entry)] = { ...entry, status };
            };
            if (command.kind === "PAY") {
              const settlement = summarizeInvoiceSettlement(invoice, ledger, { disputed });
              const room = settlement.outstandingPaise - settlement.pendingPaise;
              const amountPaise = Math.max(1, Math.ceil(room / command.share));
              const online = command.method === "ONLINE";
              const decision = attempt(() => evaluatePaymentApplication(invoice, ledger, {
                method: command.method, amountPaise, currency: "INR",
                actorId: online ? parties.customerId : parties.ownerId, actorRole: online ? "FARMER" : "OWNER",
              }, parties, { disputed }));
              if (decision !== undefined) {
                ledger.push({ id: `p${ledger.length}`, method: command.method, status: decision.initialStatus, amountPaise, currency: "INR", createdAt: at() });
              }
            } else if (command.kind === "CONFIRM") {
              const entry = pick(command.target);
              if (entry === undefined || entry.method !== "ONLINE") continue;
              const capacity = lateConfirmationCapacity(invoice, ledger, entry.id, { currentInvoice: true, bookingPayable: !disputed, disputed });
              const decision = evaluateProviderPaymentEvent(
                { method: "ONLINE", status: entry.status, amountPaise: entry.amountPaise, currency: "INR", providerReference: `order_${entry.id}` },
                { kind: "PAYMENT_CONFIRMED", providerEventId: `evt_${clock}`, providerReference: `order_${entry.id}`, amountPaise: entry.amountPaise, currency: "INR" },
                { lateConfirmationCapacityPaise: capacity },
              );
              if (decision.outcome === "APPLY") {
                if (entry.status === "PAYMENT_FAILED") lateConfirmations += 1;
                replace(entry, decision.toStatus);
              }
            } else if (command.kind === "RELEASE") {
              const entry = pick(command.target);
              if (entry === undefined) continue;
              const rule = attempt(() => planPaymentTransition(entry, "PAYMENT_FAILED", "SYSTEM", { reason: "No successful payment at the provider" }));
              if (rule !== undefined) {
                releases += 1;
                replace(entry, rule.to);
              }
            } else if (command.kind === "DISPUTE") {
              disputed = command.disputed;
            } else if (command.kind === "REFUND") {
              const entry = pick(command.target);
              if (entry === undefined) continue;
              const decision = attempt(() => evaluateRefundRequest({
                payment: entry, providerPaymentId: `pay_${entry.id}`, bookingStatus: disputed ? "DISPUTED" : "PAYMENT_RECORDED",
                actorRole: "SUPPORT", reasonCode: "DISPUTE_RESOLVED",
              }));
              if (decision !== undefined) {
                expect(decision.refundPaise).toBe(entry.amountPaise);
                refunds.push({ paymentId: entry.id, amountPaise: decision.refundPaise, status: "SUBMITTED" });
                replace(entry, decision.rule.to);
              }
            } else {
              if (refunds.length === 0) continue;
              const refund = refunds[command.target % refunds.length]!;
              const entry = ledger.find((candidate) => candidate.id === refund.paymentId)!;
              const decision = evaluateProviderRefundEvent({
                status: refund.status, amountPaise: refund.amountPaise, currency: "INR", providerPaymentId: `pay_${entry.id}`,
                payment: { method: entry.method, status: entry.status },
              }, {
                kind: command.processed ? "REFUND_CONFIRMED" : "REFUND_FAILED", providerEventId: `evt_${clock}`,
                providerPaymentId: `pay_${entry.id}`, amountPaise: refund.amountPaise, currency: "INR",
              });
              if (decision.outcome === "APPLY") {
                if (decision.refundStatus === "PROCESSED") refundsProcessed += 1;
                refund.status = decision.refundStatus;
                replace(entry, decision.paymentStatus);
              }
            }

            // Conservation: applied money fits the bill, and the bill is settled exactly when it is full.
            const settlement = summarizeInvoiceSettlement(invoice, ledger, { disputed });
            const applied = ledger.filter((entry) => APPLIED.has(entry.status)).reduce((sum, entry) => sum + entry.amountPaise, 0);
            expect(settlement.appliedPaise).toBe(applied);
            expect(applied).toBeLessThanOrEqual(totalPaise);
            expect(settlement.settled).toBe(applied === totalPaise);
            for (const entry of ledger) {
              if (entry.method === "CASH") expect(["PAID_CASH", "REFUND_PENDING", "REFUNDED"]).toContain(entry.status);
              const ofPayment = refunds.filter((refund) => refund.paymentId === entry.id);
              // At most one refund in flight or processed per payment, never more than was paid.
              expect(ofPayment.filter((refund) => refund.status !== "FAILED").length).toBeLessThanOrEqual(1);
              const refunded = ofPayment.filter((refund) => refund.status === "PROCESSED").reduce((sum, refund) => sum + refund.amountPaise, 0);
              expect(refunded).toBeLessThanOrEqual(entry.amountPaise);
              expect(entry.status === "REFUNDED").toBe(refunded > 0);
            }
          }
        },
      ), { seed, numRuns: propertyRuns, verbose: 2 });
      console.info(`[PBT] payment-recovery-conservation: seed=${seed} runs=${propertyRuns} minimizedCounterexample=none `
        + `releases=${releases} lateConfirmations=${lateConfirmations} refundsProcessed=${refundsProcessed}`);
    } catch (error) {
      console.error(`[PBT] payment-recovery-conservation: seed=${seed} minimizedCounterexample=reported by fast-check below`);
      throw error;
    }
    expect(releases).toBeGreaterThan(0);
    expect(lateConfirmations).toBeGreaterThan(0);
    expect(refundsProcessed).toBeGreaterThan(0);
  });
});
