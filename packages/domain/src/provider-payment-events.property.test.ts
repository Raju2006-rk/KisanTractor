import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  lateConfirmationCapacity,
  paymentRecordStatuses,
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
  paymentRefundStatuses,
  providerPaymentEventKinds,
  type PaymentRefundStatus,
  type ProviderEventPaymentTarget,
  type ProviderEventRefundTarget,
  type ProviderPaymentEventFacts,
  type ProviderPaymentEventKind,
} from "./provider-payment-events.js";

// Feature: kisantractor-platform, Property 12: Payment Trust and Deduplication (task 16.3).
// Domain half: verified provider facts whose reference, amount, or currency differ from the
// server-created intent never apply, and a verified event applies its financial effect at most once
// however often and in whatever order it (and its siblings) arrive.
const propertyRuns = 300;
const seeds = { paymentMismatch: 1_603_101, refundMismatch: 1_603_102, exactlyOnce: 1_603_103 } as const;

function runSeeded(name: string, seed: number, assertion: () => void, coverage?: () => string): void {
  try {
    assertion();
    console.info(`[PBT] ${name}: seed=${seed} runs=${propertyRuns} minimizedCounterexample=none${coverage === undefined ? "" : ` ${coverage()}`}`);
  } catch (error) {
    console.error(`[PBT] ${name}: seed=${seed} minimizedCounterexample=reported by fast-check below`);
    throw error;
  }
}

const REJECTION_MESSAGES_MUST_NOT_CONTAIN = (event: ProviderPaymentEventFacts): readonly string[] => [
  event.providerEventId,
  ...(event.providerReference === undefined ? [] : [event.providerReference]),
  ...(event.providerPaymentId === undefined ? [] : [event.providerPaymentId]),
  ...(event.providerRefundId === undefined ? [] : [event.providerRefundId]),
  ...(event.amountPaise === undefined ? [] : [String(event.amountPaise)]),
];

type PaymentPerturbation =
  | "NONE" | "UNKNOWN_TARGET" | "REFERENCE" | "REFERENCE_MISSING"
  | "CURRENCY" | "CURRENCY_MISSING" | "AMOUNT" | "AMOUNT_MISSING" | "AMOUNT_FRACTION";

const paymentTargetArbitrary = fc.record({
  method: fc.constantFrom<PaymentMethod>("ONLINE", "ONLINE", "ONLINE", "CASH"),
  // Weighted toward the statuses a provider event can move, so applied outcomes are reached often.
  status: fc.constantFrom<PaymentRecordStatus>("PENDING", "PENDING", "PENDING", "PAYMENT_FAILED", "PAYMENT_FAILED", ...paymentRecordStatuses),
  amountPaise: fc.integer({ min: 1, max: 1_000_000_000 }),
  /** Online intents always carry their server-created reference; a missing one is a broken record. */
  hasReference: fc.oneof({ weight: 9, arbitrary: fc.constant(true) }, { weight: 1, arbitrary: fc.constant(false) }),
  providerPaymentId: fc.option(fc.constantFrom("pay_KtPbtPayment01", "pay_KtPbtPayment02"), { nil: undefined }),
});

describe("Property 12: Payment Trust and Deduplication — domain evaluator", () => {
  /** **Validates: Requirements 11.5** */
  it("rejects payment events whose reference, currency, or amount differ from the intent, with a PII-safe code, and never applies them", () => {
    const applied = { confirmed: 0, failed: 0, late: 0 };
    runSeeded("provider-payment-event-mismatch", seeds.paymentMismatch, () => {
      fc.assert(fc.property(
        paymentTargetArbitrary,
        fc.constantFrom<ProviderPaymentEventKind>("PAYMENT_CONFIRMED", "PAYMENT_CONFIRMED", "PAYMENT_FAILED", "PAYMENT_FAILED",
          ...providerPaymentEventKinds),
        fc.constantFrom<PaymentPerturbation>("NONE", "NONE", "NONE", "UNKNOWN_TARGET", "REFERENCE", "REFERENCE_MISSING",
          "CURRENCY", "CURRENCY_MISSING", "AMOUNT", "AMOUNT_MISSING", "AMOUNT_FRACTION"),
        fc.integer({ min: -1_000_000, max: 1_000_000 }).filter((delta) => delta !== 0),
        fc.constantFrom("USD", "EUR", "inr", "INR "),
        fc.option(fc.integer({ min: 0, max: 2_000_000_000 }), { nil: undefined }),
        fc.constantFrom("pay_KtPbtPayment01", "pay_KtPbtPayment02"),
        (spec, kind, perturbation, delta, otherCurrency, capacity, eventPaymentId) => {
          const reference = "order_KtPbtIntent01";
          const target: ProviderEventPaymentTarget | undefined = perturbation === "UNKNOWN_TARGET" ? undefined : {
            method: spec.method, status: spec.status, amountPaise: spec.amountPaise, currency: "INR",
            ...(spec.hasReference ? { providerReference: reference } : {}),
            ...(spec.providerPaymentId === undefined ? {} : { providerPaymentId: spec.providerPaymentId }),
          };
          const event: ProviderPaymentEventFacts = {
            kind,
            providerEventId: "KtPbtEvent000001",
            ...(perturbation === "REFERENCE_MISSING" ? {}
              : { providerReference: perturbation === "REFERENCE" ? "order_KtPbtIntent99" : reference }),
            providerPaymentId: eventPaymentId,
            ...(perturbation === "AMOUNT_MISSING" ? {} : {
              amountPaise: perturbation === "AMOUNT" ? spec.amountPaise + delta
                : perturbation === "AMOUNT_FRACTION" ? spec.amountPaise + 0.5 : spec.amountPaise,
            }),
            ...(perturbation === "CURRENCY_MISSING" ? {} : { currency: perturbation === "CURRENCY" ? otherCurrency : "INR" }),
          };
          const decision = evaluateProviderPaymentEvent(target, event,
            capacity === undefined ? {} : { lateConfirmationCapacityPaise: capacity });

          const financial = kind === "PAYMENT_CONFIRMED" || kind === "PAYMENT_FAILED";
          const refundKind = kind === "REFUND_CONFIRMED" || kind === "REFUND_FAILED";
          let expected: string | undefined;
          if (refundKind) expected = "RECORD_ONLY:INFORMATIONAL";
          else if (target === undefined) expected = financial ? "REJECT:REFERENCE_MISMATCH" : "RECORD_ONLY:UNMATCHED";
          else if (target.method !== "ONLINE" || !spec.hasReference || perturbation === "REFERENCE" || perturbation === "REFERENCE_MISSING") {
            expected = "REJECT:REFERENCE_MISMATCH";
          } else if (kind === "PAYMENT_ATTEMPT_FAILED") expected = "RECORD_ONLY:ATTEMPT_FAILED";
          else if (kind === "INFORMATIONAL") expected = "RECORD_ONLY:INFORMATIONAL";
          else if (perturbation === "CURRENCY" || perturbation === "CURRENCY_MISSING") expected = "REJECT:CURRENCY_MISMATCH";
          else if (perturbation === "AMOUNT" || perturbation === "AMOUNT_MISSING" || perturbation === "AMOUNT_FRACTION") {
            expected = "REJECT:AMOUNT_MISMATCH";
          }

          const actual = decision.outcome === "APPLY" ? `APPLY:${decision.toStatus}`
            : decision.outcome === "REJECT" ? `REJECT:${decision.code}` : `RECORD_ONLY:${decision.note}`;
          if (expected !== undefined) {
            expect(actual).toBe(expected);
          } else {
            // A matching verified event: only a pending (or, with room on the bill, a closed) intent moves.
            const status = spec.status;
            if (kind === "PAYMENT_CONFIRMED") {
              const paid = status === "PAID_ONLINE" || status === "REFUND_PENDING" || status === "REFUNDED";
              if (status === "PENDING") expect(actual).toBe("APPLY:PAID_ONLINE");
              else if (paid) {
                expect(actual).toBe(spec.providerPaymentId !== undefined && spec.providerPaymentId !== eventPaymentId
                  ? "REJECT:PAYMENT_LEDGER_INCONSISTENT" : "RECORD_ONLY:ALREADY_APPLIED");
              } else if (status === "PAYMENT_FAILED") {
                expect(actual).toBe((capacity ?? 0) >= spec.amountPaise ? "APPLY:PAID_ONLINE" : "REJECT:PAYMENT_LEDGER_INCONSISTENT");
              } else {
                expect(actual).toBe("REJECT:PAYMENT_LEDGER_INCONSISTENT");
              }
            } else {
              // A failure never undoes settled money and never re-fails a closed intent.
              expect(actual).toBe(status === "PENDING" ? "APPLY:PAYMENT_FAILED" : "RECORD_ONLY:ALREADY_FINAL");
            }
          }
          if (decision.outcome === "APPLY") {
            expect(perturbation).toBe("NONE");
            if (decision.toStatus === "PAYMENT_FAILED") applied.failed += 1;
            else if (spec.status === "PAYMENT_FAILED") applied.late += 1;
            else applied.confirmed += 1;
          }
          if (decision.outcome === "REJECT") {
            // Rejection reasons are stable codes with fixed text: no provider identifier or amount is echoed.
            for (const fragment of REJECTION_MESSAGES_MUST_NOT_CONTAIN(event)) expect(decision.message).not.toContain(fragment);
          }
        },
      ), { seed: seeds.paymentMismatch, numRuns: propertyRuns });
    }, () => `confirmed=${applied.confirmed} failed=${applied.failed} late=${applied.late}`);
    expect(applied.confirmed).toBeGreaterThan(0);
    expect(applied.failed).toBeGreaterThan(0);
    expect(applied.late).toBeGreaterThan(0);
  });

  /** **Validates: Requirements 11.5, 11.6** */
  it("rejects refund events that do not match the requested refund and applies a matching one only to a refund in flight", () => {
    let appliedCount = 0;
    type RefundPerturbation = "NONE" | "UNKNOWN_REFUND" | "PAYMENT_ID" | "REFUND_ID" | "CURRENCY" | "AMOUNT" | "AMOUNT_MISSING";
    runSeeded("provider-refund-event-mismatch", seeds.refundMismatch, () => {
      fc.assert(fc.property(
        fc.record({
          status: fc.constantFrom<PaymentRefundStatus>(...paymentRefundStatuses),
          amountPaise: fc.integer({ min: 100, max: 1_000_000_000 }),
          hasRefundId: fc.boolean(),
          paymentMethod: fc.constantFrom<PaymentMethod>("ONLINE", "ONLINE", "ONLINE", "CASH"),
          paymentStatus: fc.constantFrom<PaymentRecordStatus>("REFUND_PENDING", "REFUND_PENDING", ...paymentRecordStatuses),
        }),
        fc.constantFrom<ProviderPaymentEventKind>("REFUND_CONFIRMED", "REFUND_FAILED", "REFUND_CONFIRMED", "REFUND_FAILED",
          "PAYMENT_CONFIRMED", "INFORMATIONAL"),
        fc.constantFrom<RefundPerturbation>("NONE", "NONE", "NONE", "UNKNOWN_REFUND", "PAYMENT_ID", "REFUND_ID", "CURRENCY",
          "AMOUNT", "AMOUNT_MISSING"),
        fc.integer({ min: -100_000, max: 100_000 }).filter((delta) => delta !== 0),
        (spec, kind, perturbation, delta) => {
          const target: ProviderEventRefundTarget | undefined = perturbation === "UNKNOWN_REFUND" ? undefined : {
            status: spec.status, amountPaise: spec.amountPaise, currency: "INR", providerPaymentId: "pay_KtPbtPayment01",
            ...(spec.hasRefundId ? { providerRefundId: "rfnd_KtPbtRefund01" } : {}),
            payment: { method: spec.paymentMethod, status: spec.paymentStatus },
          };
          const event: ProviderPaymentEventFacts = {
            kind,
            providerEventId: "KtPbtEvent000002",
            providerPaymentId: perturbation === "PAYMENT_ID" ? "pay_KtPbtPayment99" : "pay_KtPbtPayment01",
            providerRefundId: perturbation === "REFUND_ID" ? "rfnd_KtPbtRefund99" : "rfnd_KtPbtRefund01",
            ...(perturbation === "AMOUNT_MISSING" ? {} : { amountPaise: perturbation === "AMOUNT" ? spec.amountPaise + delta : spec.amountPaise }),
            currency: perturbation === "CURRENCY" ? "USD" : "INR",
          };
          const decision = evaluateProviderRefundEvent(target, event);
          const actual = decision.outcome === "APPLY" ? `APPLY:${decision.refundStatus}`
            : decision.outcome === "REJECT" ? `REJECT:${decision.code}` : `RECORD_ONLY:${decision.note}`;
          const refundKind = kind === "REFUND_CONFIRMED" || kind === "REFUND_FAILED";
          const processed = kind === "REFUND_CONFIRMED";

          let expected: string;
          if (!refundKind) expected = "RECORD_ONLY:INFORMATIONAL";
          else if (target === undefined) expected = "REJECT:PAYMENT_LEDGER_INCONSISTENT";
          else if (perturbation === "PAYMENT_ID" || (perturbation === "REFUND_ID" && spec.hasRefundId)) expected = "REJECT:REFERENCE_MISMATCH";
          else if (perturbation === "CURRENCY") expected = "REJECT:CURRENCY_MISMATCH";
          else if (perturbation === "AMOUNT" || perturbation === "AMOUNT_MISSING") expected = "REJECT:AMOUNT_MISMATCH";
          else if (spec.status === "PROCESSED") expected = processed ? "RECORD_ONLY:ALREADY_APPLIED" : "RECORD_ONLY:ALREADY_FINAL";
          else if (spec.status === "FAILED") expected = processed ? "REJECT:PAYMENT_LEDGER_INCONSISTENT" : "RECORD_ONLY:ALREADY_APPLIED";
          else if (spec.paymentMethod !== "ONLINE" || spec.paymentStatus !== "REFUND_PENDING") expected = "REJECT:PAYMENT_LEDGER_INCONSISTENT";
          else expected = processed ? "APPLY:PROCESSED" : "APPLY:FAILED";
          expect(actual).toBe(expected);

          if (decision.outcome === "APPLY") {
            appliedCount += 1;
            // A failed refund keeps the money applied; a processed one refunds it. Nothing else.
            expect(decision.paymentStatus).toBe(processed ? "REFUNDED" : "PAID_ONLINE");
          }
          if (decision.outcome === "REJECT") {
            for (const fragment of REJECTION_MESSAGES_MUST_NOT_CONTAIN(event)) expect(decision.message).not.toContain(fragment);
          }
        },
      ), { seed: seeds.refundMismatch, numRuns: propertyRuns });
    }, () => `applied=${appliedCount}`);
    expect(appliedCount).toBeGreaterThan(0);
  });

  /** **Validates: Requirements 11.4, 11.6** */
  it("applies each verified event at most once across duplicates and out-of-order sequences, never undoing settled money", () => {
    const coverage = { confirmations: 0, lateConfirmations: 0, refundsProcessed: 0, refundsFailed: 0, duplicatesIgnored: 0 };

    type Intent = "A" | "B";
    type DomainEvent =
      | { readonly type: "CAPTURE"; readonly intent: Intent; readonly second: boolean }
      | { readonly type: "PROVIDER_FAILURE" | "ATTEMPT_FAILED" | "INFORMATIONAL"; readonly intent: Intent }
      | { readonly type: "REFUND"; readonly intent: Intent; readonly refund: number; readonly processed: boolean };
    type Command =
      | { readonly kind: "DELIVER"; readonly event: DomainEvent }
      | { readonly kind: "REDELIVER"; readonly back: number }
      | { readonly kind: "RELEASE"; readonly intent: Intent }
      | { readonly kind: "REQUEST_REFUND"; readonly intent: Intent }
      | { readonly kind: "CASH_FILL" };

    const intentArbitrary = fc.constantFrom<Intent>("A", "B");
    const eventArbitrary: fc.Arbitrary<DomainEvent> = fc.oneof(
      { weight: 5, arbitrary: fc.record({ type: fc.constant("CAPTURE" as const), intent: intentArbitrary,
        second: fc.oneof({ weight: 5, arbitrary: fc.constant(false) }, { weight: 1, arbitrary: fc.constant(true) }) }) },
      { weight: 2, arbitrary: fc.record({ type: fc.constantFrom("PROVIDER_FAILURE" as const, "ATTEMPT_FAILED" as const, "INFORMATIONAL" as const),
        intent: intentArbitrary }) },
      { weight: 4, arbitrary: fc.record({ type: fc.constant("REFUND" as const), intent: intentArbitrary, refund: fc.nat({ max: 2 }),
        processed: fc.boolean() }) },
    );
    const commandArbitrary: fc.Arbitrary<Command> = fc.oneof(
      { weight: 6, arbitrary: fc.record({ kind: fc.constant("DELIVER" as const), event: eventArbitrary }) },
      { weight: 4, arbitrary: fc.record({ kind: fc.constant("REDELIVER" as const), back: fc.nat({ max: 5 }) }) },
      { weight: 1, arbitrary: fc.record({ kind: fc.constant("RELEASE" as const), intent: intentArbitrary }) },
      { weight: 3, arbitrary: fc.record({ kind: fc.constant("REQUEST_REFUND" as const), intent: intentArbitrary }) },
      { weight: 1, arbitrary: fc.constant({ kind: "CASH_FILL" as const }) },
    );

    runSeeded("provider-event-exactly-once", seeds.exactlyOnce, () => {
      fc.assert(fc.property(
        fc.integer({ min: 200, max: 10_000_000 }),
        fc.double({ min: 0.05, max: 0.95, noNaN: true }),
        fc.double({ min: 0.05, max: 1, noNaN: true }),
        fc.array(commandArbitrary, { minLength: 1, maxLength: 40 }),
        (totalPaise, shareA, shareB, commands) => {
          const invoice: PayableInvoice = { id: "invoice-1", totalPaise, currency: "INR", status: "ISSUED", superseded: false };
          const amountA = Math.max(1, Math.floor(totalPaise * shareA));
          const amountB = Math.max(1, Math.floor((totalPaise - amountA) * shareB));
          const ledger: PaymentLedgerEntry[] = [
            { id: "A", method: "ONLINE", status: "PENDING", amountPaise: amountA, currency: "INR", createdAt: new Date(0) },
            ...(amountA + amountB <= totalPaise
              ? [{ id: "B", method: "ONLINE" as const, status: "PENDING" as const, amountPaise: amountB, currency: "INR", createdAt: new Date(1) }]
              : []),
          ];
          const capturedPayment = new Map<string, string>();
          const refunds = new Map<Intent, Array<{ status: PaymentRefundStatus; providerRefundId: string; amountPaise: number }>>([["A", []], ["B", []]]);
          const delivered: Array<{ readonly facts: ProviderPaymentEventFacts; readonly intent: Intent }> = [];
          const effects = new Map<string, number>();
          const confirmationsInto = new Map<string, number>();
          let cashCount = 0;

          const entry = (intent: Intent) => ledger.find((candidate) => candidate.id === intent);
          const replace = (id: string, status: PaymentRecordStatus) => {
            const index = ledger.findIndex((candidate) => candidate.id === id);
            ledger[index] = { ...ledger[index]!, status };
          };
          const factsFor = (event: DomainEvent, payment: PaymentLedgerEntry): ProviderPaymentEventFacts => {
            const payId = `pay_KtPbt${event.intent}${event.type === "CAPTURE" && event.second ? "Second" : "First"}`;
            if (event.type === "REFUND") {
              const refund = refunds.get(event.intent)![event.refund];
              return {
                kind: event.processed ? "REFUND_CONFIRMED" : "REFUND_FAILED",
                providerEventId: `evt_refund_${event.intent}_${event.refund}_${event.processed ? "processed" : "failed"}`,
                providerPaymentId: capturedPayment.get(event.intent) ?? `pay_KtPbt${event.intent}First`,
                providerRefundId: `rfnd_KtPbt${event.intent}${event.refund}`,
                amountPaise: refund?.amountPaise ?? payment.amountPaise,
                currency: "INR",
              };
            }
            const kind: ProviderPaymentEventKind = event.type === "CAPTURE" ? "PAYMENT_CONFIRMED"
              : event.type === "PROVIDER_FAILURE" ? "PAYMENT_FAILED" : event.type === "ATTEMPT_FAILED" ? "PAYMENT_ATTEMPT_FAILED" : "INFORMATIONAL";
            return {
              kind,
              providerEventId: `evt_${event.type.toLowerCase()}_${event.intent}${event.type === "CAPTURE" && event.second ? "_second" : ""}`,
              providerReference: `order_KtPbt${event.intent}`,
              providerPaymentId: payId,
              amountPaise: payment.amountPaise,
              currency: "INR",
            };
          };

          const deliver = (facts: ProviderPaymentEventFacts, intent: Intent) => {
            const payment = entry(intent);
            if (payment === undefined) return;
            const before = payment.status;
            if (facts.kind === "REFUND_CONFIRMED" || facts.kind === "REFUND_FAILED") {
              const list = refunds.get(intent)!;
              const refund = list.find((candidate) => candidate.providerRefundId === facts.providerRefundId);
              const decision = evaluateProviderRefundEvent(refund === undefined ? undefined : {
                status: refund.status, amountPaise: refund.amountPaise, currency: "INR",
                providerPaymentId: capturedPayment.get(intent)!, providerRefundId: refund.providerRefundId,
                payment: { method: payment.method, status: payment.status },
              }, facts);
              if (decision.outcome !== "APPLY") {
                if (effects.has(facts.providerEventId)) coverage.duplicatesIgnored += 1;
                return;
              }
              refund!.status = decision.refundStatus;
              replace(intent, decision.paymentStatus);
              if (decision.refundStatus === "PROCESSED") coverage.refundsProcessed += 1;
              else coverage.refundsFailed += 1;
            } else {
              const capacity = lateConfirmationCapacity(invoice, ledger, intent, { currentInvoice: true, bookingPayable: true, disputed: false });
              const decision = evaluateProviderPaymentEvent({
                method: payment.method, status: payment.status, amountPaise: payment.amountPaise, currency: payment.currency,
                providerReference: `order_KtPbt${intent}`,
                ...(capturedPayment.has(intent) ? { providerPaymentId: capturedPayment.get(intent)! } : {}),
              }, facts, { lateConfirmationCapacityPaise: capacity });
              if (decision.outcome !== "APPLY") {
                if (effects.has(facts.providerEventId)) coverage.duplicatesIgnored += 1;
                return;
              }
              replace(intent, decision.toStatus);
              if (decision.toStatus === "PAID_ONLINE") {
                capturedPayment.set(intent, capturedPayment.get(intent) ?? facts.providerPaymentId!);
                confirmationsInto.set(intent, (confirmationsInto.get(intent) ?? 0) + 1);
                if (before === "PAYMENT_FAILED") coverage.lateConfirmations += 1;
                else coverage.confirmations += 1;
              }
            }
            effects.set(facts.providerEventId, (effects.get(facts.providerEventId) ?? 0) + 1);
            // Exactly once: the same verified event, evaluated again on the state it produced, does nothing.
            const again = facts.kind === "REFUND_CONFIRMED" || facts.kind === "REFUND_FAILED"
              ? evaluateProviderRefundEvent((() => {
                const refund = refunds.get(intent)!.find((candidate) => candidate.providerRefundId === facts.providerRefundId)!;
                const current = entry(intent)!;
                return { status: refund.status, amountPaise: refund.amountPaise, currency: "INR", providerPaymentId: capturedPayment.get(intent)!,
                  providerRefundId: refund.providerRefundId, payment: { method: current.method, status: current.status } };
              })(), facts)
              : evaluateProviderPaymentEvent({
                method: "ONLINE", status: entry(intent)!.status, amountPaise: payment.amountPaise, currency: "INR",
                providerReference: `order_KtPbt${intent}`, providerPaymentId: capturedPayment.get(intent)!,
              }, facts, { lateConfirmationCapacityPaise: lateConfirmationCapacity(invoice, ledger, intent,
                { currentInvoice: true, bookingPayable: true, disputed: false }) });
            expect(again.outcome).not.toBe("APPLY");
          };

          for (const command of commands) {
            const statusesBefore = new Map(ledger.map((candidate) => [candidate.id, candidate.status]));
            if (command.kind === "DELIVER") {
              const payment = entry(command.event.intent);
              if (payment === undefined) continue;
              const facts = factsFor(command.event, payment);
              delivered.push({ facts, intent: command.event.intent });
              deliver(facts, command.event.intent);
            } else if (command.kind === "REDELIVER") {
              const previous = delivered[delivered.length - 1 - (command.back % Math.max(1, delivered.length))];
              if (previous !== undefined) deliver(previous.facts, previous.intent);
            } else if (command.kind === "RELEASE") {
              const payment = entry(command.intent);
              if (payment?.status === "PENDING") {
                replace(payment.id, planPaymentTransition(payment, "PAYMENT_FAILED", "SYSTEM", { reason: "No successful payment at the provider" }).to);
              }
            } else if (command.kind === "REQUEST_REFUND") {
              const payment = entry(command.intent);
              const list = refunds.get(command.intent)!;
              if (payment?.status === "PAID_ONLINE" && list.length < 3) {
                replace(payment.id, planPaymentTransition(payment, "REFUND_PENDING", "SUPPORT", { reason: "Dispute upheld" }).to);
                list.push({ status: "SUBMITTED", providerRefundId: `rfnd_KtPbt${command.intent}${list.length}`, amountPaise: payment.amountPaise });
              }
            } else {
              const settlement = summarizeInvoiceSettlement(invoice, ledger, { disputed: false });
              const room = settlement.outstandingPaise - settlement.pendingPaise;
              if (room > 0 && settlement.status !== "REFUND_PENDING") {
                ledger.push({ id: `cash-${++cashCount}`, method: "CASH", status: "PAID_CASH", amountPaise: room, currency: "INR", createdAt: new Date(10 + cashCount) });
              }
            }

            // Settled money is never undone: a paid intent never returns to pending or failed.
            for (const payment of ledger) {
              const before = statusesBefore.get(payment.id);
              if (before === "PAID_ONLINE" || before === "REFUND_PENDING" || before === "REFUNDED") {
                expect(["PENDING", "PAYMENT_FAILED"]).not.toContain(payment.status);
              }
              if (before === "REFUNDED") expect(payment.status).toBe("REFUNDED");
            }
            for (const count of effects.values()) expect(count).toBe(1);
            for (const count of confirmationsInto.values()) expect(count).toBe(1);
            for (const list of refunds.values()) expect(list.filter((refund) => refund.status === "PROCESSED").length).toBeLessThanOrEqual(1);
            // Conservation: applied money fits the bill, and the bill is settled exactly when full.
            const settlement = summarizeInvoiceSettlement(invoice, ledger, { disputed: false });
            const applied = ledger.filter((candidate) => ["PAID_CASH", "PAID_ONLINE", "REFUND_PENDING"].includes(candidate.status))
              .reduce((sum, candidate) => sum + candidate.amountPaise, 0);
            expect(settlement.appliedPaise).toBe(applied);
            expect(applied).toBeLessThanOrEqual(totalPaise);
            expect(settlement.settled).toBe(applied === totalPaise);
          }
        },
      ), { seed: seeds.exactlyOnce, numRuns: propertyRuns });
    }, () => Object.entries(coverage).map(([key, value]) => `${key}=${value}`).join(" "));
    expect(coverage.confirmations).toBeGreaterThan(0);
    expect(coverage.lateConfirmations).toBeGreaterThan(0);
    expect(coverage.refundsProcessed).toBeGreaterThan(0);
    expect(coverage.refundsFailed).toBeGreaterThan(0);
    expect(coverage.duplicatesIgnored).toBeGreaterThan(0);
  });
});
