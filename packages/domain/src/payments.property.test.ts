import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { AuthPrincipal } from "./identity.js";
import {
  evaluatePaymentApplication,
  type PayableInvoice,
  type PaymentActorRole,
  type PaymentLedgerEntry,
  type PaymentMethod,
  paymentMethods,
  type PaymentRecordSource,
  type PaymentRecordStatus,
  paymentRecordStatuses,
  PaymentRuleError,
  type PaymentRuleCode,
  planPaymentTransition,
  projectPaymentReceipt,
  projectPaymentRecord,
  summarizeInvoiceSettlement,
} from "./payments.js";

// Feature: kisantractor-platform, Property 13 invoice-payment conservation and payment-method integrity (task 12.3).
const propertyRuns = 200;
const seeds = {
  ledgerConservation: 1_203_101,
  ledgerConsistency: 1_203_202,
  transitionIntegrity: 1_203_303,
} as const;

const OWNER_ID = "owner-1";
const FARMER_ID = "farmer-1";
const parties = { customerId: FARMER_ID, ownerId: OWNER_ID } as const;
const booking = { id: "booking-1", reference: "KT-2026-0001", ...parties } as const;
const farmer: AuthPrincipal = { userId: FARMER_ID, sessionId: "session-farmer", roles: ["FARMER"] };
const owner: AuthPrincipal = { userId: OWNER_ID, sessionId: "session-owner", roles: ["OWNER"] };
const baseTime = Date.UTC(2026, 2, 1, 12, 0, 0);
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/** Independent oracle: successful, not-yet-refunded money counts toward the invoice. */
const ORACLE_APPLIED: ReadonlySet<PaymentRecordStatus> = new Set(["PAID_CASH", "PAID_ONLINE", "REFUND_PENDING"]);
/** Independent oracle: an outstanding online intent reserves part of the invoice. */
const ORACLE_RESERVED: ReadonlySet<PaymentRecordStatus> = new Set(["PENDING"]);
/** Statuses that only an online payment may hold, and the one only cash may hold. */
const ONLINE_ONLY: ReadonlySet<PaymentRecordStatus> = new Set(["PAID_ONLINE", "PENDING", "PAYMENT_FAILED"]);
const CASH_ONLY: ReadonlySet<PaymentRecordStatus> = new Set(["PAID_CASH"]);

const actorRoles: readonly PaymentActorRole[] = ["FARMER", "OWNER", "SUPPORT", "SYSTEM", "PROVIDER"];

function runSeededProperty(name: string, seed: number, assertion: () => void): void {
  try {
    assertion();
    console.info(`[PBT] ${name}: seed=${seed} runs=${propertyRuns} minimizedCounterexample=none`);
  } catch (error) {
    console.error(`[PBT] ${name}: seed=${seed} minimizedCounterexample=reported by fast-check below`);
    throw error;
  }
}

function caught(run: () => unknown): unknown {
  try {
    run();
    return undefined;
  } catch (error) {
    return error;
  }
}

const isMethodConsistent = (method: PaymentMethod, status: PaymentRecordStatus): boolean =>
  method === "CASH" ? !ONLINE_ONLY.has(status) : !CASH_ONLY.has(status);

function oracleSums(ledger: readonly { readonly status: PaymentRecordStatus; readonly amountPaise: number }[]) {
  let applied = 0n;
  let pending = 0n;
  for (const entry of ledger) {
    if (ORACLE_APPLIED.has(entry.status)) applied += BigInt(entry.amountPaise);
    else if (ORACLE_RESERVED.has(entry.status)) pending += BigInt(entry.amountPaise);
  }
  return { applied, pending };
}

const toEntry = (payment: PaymentRecordSource): PaymentLedgerEntry => ({
  id: payment.id,
  method: payment.method,
  status: payment.status,
  amountPaise: payment.amountPaise,
  currency: payment.currency,
  createdAt: payment.createdAt,
});

const invoiceTotalArbitrary = fc.oneof(
  { weight: 1, arbitrary: fc.constant(0) },
  { weight: 4, arbitrary: fc.integer({ min: 1, max: 500_000 }) },
  { weight: 2, arbitrary: fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }) },
);

/** Amounts are resolved against the remaining capacity at the time the command runs. */
type AmountSpec =
  | { readonly mode: "remaining"; readonly delta: -1 | 0 | 1 }
  | { readonly mode: "share"; readonly divisor: number }
  | { readonly mode: "fixed"; readonly value: number };

const amountSpecArbitrary: fc.Arbitrary<AmountSpec> = fc.oneof(
  fc.record({ mode: fc.constant("remaining" as const), delta: fc.constantFrom(-1 as const, 0 as const, 1 as const) }),
  fc.record({ mode: fc.constant("share" as const), divisor: fc.integer({ min: 2, max: 5 }) }),
  fc.record({
    mode: fc.constant("fixed" as const),
    value: fc.oneof(fc.integer({ min: -2, max: 1_000_000 }), fc.constantFrom(0, 1.5, Number.MAX_SAFE_INTEGER)),
  }),
);

function resolveAmount(spec: AmountSpec, capacity: bigint): number {
  if (spec.mode === "fixed") return spec.value;
  if (spec.mode === "share") return Number(capacity / BigInt(spec.divisor));
  return Number(capacity + BigInt(spec.delta));
}

type LedgerCommand =
  | {
    readonly kind: "APPLY";
    readonly method: PaymentMethod;
    readonly actorRole: PaymentActorRole;
    readonly actorId: string;
    readonly currency: string;
    readonly amount: AmountSpec;
  }
  | {
    readonly kind: "TRANSITION";
    readonly target: number;
    readonly to: PaymentRecordStatus;
    readonly actorRole: PaymentActorRole;
    readonly reason: string | undefined;
    readonly evidence: "valid" | "blank" | "none";
  }
  | { readonly kind: "DISPUTE"; readonly disputed: boolean }
  | { readonly kind: "REPEAT" };

const applyArbitrary: fc.Arbitrary<LedgerCommand> = fc.record({
  kind: fc.constant("APPLY" as const),
  method: fc.constantFrom(...paymentMethods),
  // Mostly the permitted party for each method, sometimes anyone else.
  actorRole: fc.oneof({ weight: 4, arbitrary: fc.constant("PERMITTED" as const) }, { weight: 1, arbitrary: fc.constantFrom(...actorRoles) }),
  actorId: fc.constantFrom(OWNER_ID, FARMER_ID, "owner-2"),
  currency: fc.constantFrom("INR", "INR", "INR", "USD"),
  amount: amountSpecArbitrary,
}).map((command) => command.actorRole === "PERMITTED"
  ? { ...command, actorRole: command.method === "CASH" ? "OWNER" as const : "FARMER" as const,
    actorId: command.method === "CASH" ? OWNER_ID : FARMER_ID }
  : { ...command, actorRole: command.actorRole });

const transitionArbitrary: fc.Arbitrary<LedgerCommand> = fc.record({
  kind: fc.constant("TRANSITION" as const),
  target: fc.nat({ max: 63 }),
  to: fc.constantFrom(...paymentRecordStatuses),
  actorRole: fc.constantFrom(...actorRoles),
  reason: fc.option(fc.constantFrom("Gateway timeout", "Dispute upheld", " ", ""), { nil: undefined }),
  evidence: fc.constantFrom("valid" as const, "blank" as const, "none" as const),
});

const commandArbitrary: fc.Arbitrary<LedgerCommand> = fc.oneof(
  { weight: 6, arbitrary: applyArbitrary },
  { weight: 4, arbitrary: transitionArbitrary },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("DISPUTE" as const), disputed: fc.boolean() }) },
  { weight: 1, arbitrary: fc.constant({ kind: "REPEAT" as const }) },
);

/** Expected outcome of adding a payment, derived independently from the requirement rules. */
function expectedApplication(
  invoice: PayableInvoice,
  ledger: readonly PaymentRecordSource[],
  command: Extract<LedgerCommand, { kind: "APPLY" }>,
  amount: number,
  disputed: boolean,
): PaymentRuleCode | "ACCEPTED" {
  const permitted = command.method === "CASH"
    ? command.actorRole === "OWNER" && command.actorId === OWNER_ID
    : command.actorRole === "FARMER" && command.actorId === FARMER_ID;
  if (!permitted) return "PAYMENT_ACTOR_NOT_PERMITTED";
  if (disputed) return "PAYMENT_SETTLEMENT_BLOCKED";
  if (!Number.isSafeInteger(amount) || amount <= 0) return "PAYMENT_INVALID_AMOUNT";
  if (command.currency !== invoice.currency) return "PAYMENT_CURRENCY_MISMATCH";
  if (ledger.some((payment) => payment.status === "REFUND_PENDING")) return "PAYMENT_INVOICE_NOT_PAYABLE";
  const { applied, pending } = oracleSums(ledger);
  if (BigInt(amount) > BigInt(invoice.totalPaise) - applied - pending) return "PAYMENT_OVERPAYMENT";
  return "ACCEPTED";
}

/** The conservation and method-integrity invariants every reachable ledger must satisfy. */
function assertLedgerInvariants(invoice: PayableInvoice, ledger: readonly PaymentRecordSource[], disputed: boolean): void {
  const total = BigInt(invoice.totalPaise);
  const { applied, pending } = oracleSums(ledger);
  expect(applied <= total).toBe(true);
  expect(applied + pending <= total).toBe(true);

  for (const payment of ledger) {
    expect(isMethodConsistent(payment.method, payment.status)).toBe(true);
    if (payment.method === "CASH") expect(payment.status).not.toBe("PAID_ONLINE");
  }

  const settlement = summarizeInvoiceSettlement(invoice, ledger.map(toEntry), { disputed });
  expect(BigInt(settlement.appliedPaise)).toBe(applied);
  expect(BigInt(settlement.pendingPaise)).toBe(pending);
  expect(BigInt(settlement.outstandingPaise)).toBe(total - applied);
  expect(settlement.settled).toBe(applied === total);
  expect(settlement.settlementBlocked).toBe(disputed);

  const appliedMethods = new Set(ledger.filter((payment) => ORACLE_APPLIED.has(payment.status)).map((payment) => payment.method));
  expect([...settlement.settlementMethods].sort()).toEqual([...appliedMethods].sort());
  if (settlement.status === "PAID_CASH") expect([...appliedMethods]).toEqual(["CASH"]);
  if (settlement.status === "PAID_ONLINE") expect([...appliedMethods]).toEqual(["ONLINE"]);
  if (settlement.status === "PAID_MIXED") expect(appliedMethods.size).toBe(2);
  if (["PAID_CASH", "PAID_ONLINE", "PAID_MIXED", "NOTHING_DUE"].includes(settlement.status)) {
    expect(settlement.settled).toBe(true);
  }
  // A zero-total bill is reported as settled with nothing due, and no payment is ever applied to it.
  if (total === 0n) {
    expect(settlement.status).toBe("NOTHING_DUE");
    expect(ledger).toHaveLength(0);
  }
}

function assertReceipts(invoice: PayableInvoice, ledger: readonly PaymentRecordSource[], disputed: boolean): void {
  const settlement = summarizeInvoiceSettlement(invoice, ledger.map(toEntry), { disputed });
  const invoiceView = { id: invoice.id, invoiceVersion: 1, totalPaise: invoice.totalPaise, currency: invoice.currency };
  for (const payment of ledger) {
    const record = projectPaymentRecord(payment, parties);
    expect(record.method).toBe(payment.method);
    if (payment.method === "CASH") {
      expect(record.confirmedBy).toBe("OWNER");
      expect(record.paidAt).toEqual(payment.receivedAt);
    } else {
      expect(record.confirmedBy === undefined || record.confirmedBy === "PAYMENT_PROVIDER").toBe(true);
    }
    for (const [principal, role] of [[farmer, "FARMER"], [owner, "OWNER"]] as const) {
      const issue = (): unknown => projectPaymentReceipt(principal, role, { booking, invoice: invoiceView, payment, settlement });
      if (settlement.settled && ORACLE_APPLIED.has(payment.status)) {
        const receipt = issue() as ReturnType<typeof projectPaymentReceipt>;
        expect(receipt).toMatchObject({
          paymentId: payment.id, method: payment.method, status: payment.status, amountPaise: payment.amountPaise,
          settlementStatus: settlement.status, invoiceTotalPaise: invoice.totalPaise,
          confirmedBy: payment.method === "CASH" ? "OWNER" : "PAYMENT_PROVIDER",
        });
      } else {
        expect(caught(issue)).toMatchObject({ code: "PAYMENT_RECEIPT_UNAVAILABLE" });
      }
    }
  }
}

describe("Property 13: Invoice-Payment Conservation", () => {
  /** **Validates: Requirements 11.2, 11.7** */
  it("keeps applied payments within the invoice total, settles iff they equal it, and never relabels cash as online", () => {
    runSeededProperty("invoice-payment-conservation", seeds.ledgerConservation, () => {
      fc.assert(fc.property(
        invoiceTotalArbitrary,
        fc.array(commandArbitrary, { minLength: 1, maxLength: 40 }),
        (totalPaise, commands) => {
          const invoice: PayableInvoice = { id: "invoice-1", totalPaise, currency: "INR", status: "ISSUED", superseded: false };
          const ledger: PaymentRecordSource[] = [];
          let disputed = false;
          let previous: { readonly command: LedgerCommand; readonly amount?: number } | undefined;

          commands.forEach((generated, step) => {
            const replay = generated.kind === "REPEAT" ? previous : undefined;
            if (generated.kind === "REPEAT" && replay === undefined) return;
            const command = replay?.command ?? generated;
            const at = new Date(baseTime + step * 60_000);

            if (command.kind === "DISPUTE") {
              disputed = command.disputed;
            } else if (command.kind === "APPLY") {
              const { applied, pending } = oracleSums(ledger);
              const amount = replay?.amount ?? resolveAmount(command.amount, BigInt(totalPaise) - applied - pending);
              previous = { command, amount };
              const expected = expectedApplication(invoice, ledger, command, amount, disputed);
              const before = JSON.stringify(ledger);
              const run = () => evaluatePaymentApplication(invoice, ledger.map(toEntry), {
                method: command.method, amountPaise: amount, currency: command.currency,
                actorId: command.actorId, actorRole: command.actorRole,
              }, parties, { disputed });
              if (expected !== "ACCEPTED") {
                const error = caught(run);
                expect(error).toBeInstanceOf(PaymentRuleError);
                expect((error as PaymentRuleError).code).toBe(expected);
                expect(JSON.stringify(ledger)).toBe(before);
              } else {
                const decision = run();
                // Cash is born paid-cash with its recorder; an online intent is only pending.
                expect(decision.initialStatus).toBe(command.method === "CASH" ? "PAID_CASH" : "PENDING");
                const payment: PaymentRecordSource = {
                  id: `p${String(ledger.length).padStart(4, "0")}`, invoiceId: invoice.id, method: command.method,
                  status: decision.initialStatus, amountPaise: amount, currency: "INR", createdAt: at,
                  ...(command.method === "CASH" ? { recordedByUserId: OWNER_ID, receivedAt: at } : {}),
                };
                ledger.push(payment);
                const actual = summarizeInvoiceSettlement(invoice, ledger.map(toEntry), { disputed });
                expect(decision.settlementAfter).toMatchObject({
                  appliedPaise: actual.appliedPaise, pendingPaise: actual.pendingPaise,
                  outstandingPaise: actual.outstandingPaise, settled: actual.settled, status: actual.status,
                });
              }
            } else if (command.kind === "TRANSITION") {
              previous = { command };
              if (ledger.length === 0) return;
              const index = command.target % ledger.length;
              const target = ledger[index]!;
              const evidence = command.evidence === "none" ? undefined
                : { kind: "VERIFIED_PROVIDER_EVENT" as const, providerEventId: command.evidence === "valid" ? `evt_${step}` : "  " };
              const outcome = caught(() => planPaymentTransition(target, command.to, command.actorRole, {
                ...(command.reason === undefined ? {} : { reason: command.reason }),
                ...(evidence === undefined ? {} : { evidence }),
              }));
              if (outcome !== undefined) {
                expect(outcome).toBeInstanceOf(PaymentRuleError);
                return;
              }
              // Payment-method integrity of every permitted transition.
              expect(command.to).not.toBe("PAID_CASH");
              if (command.to === "PAID_ONLINE") {
                expect(target.method).toBe("ONLINE");
                expect(command.actorRole).toBe("PROVIDER");
                expect(command.evidence).toBe("valid");
              }
              ledger[index] = {
                ...target, status: command.to,
                ...(command.to === "PAID_ONLINE" ? { verifiedAt: at } : {}),
              };
              // The same transition repeated has no further effect: the payment already left its source state.
              expect(caught(() => planPaymentTransition(ledger[index]!, command.to, command.actorRole, {
                ...(command.reason === undefined ? {} : { reason: command.reason }),
                ...(evidence === undefined ? {} : { evidence }),
              }))).toMatchObject({ code: "PAYMENT_TRANSITION_NOT_ALLOWED" });
            }
            assertLedgerInvariants(invoice, ledger, disputed);
          });

          assertLedgerInvariants(invoice, ledger, disputed);
          assertReceipts(invoice, ledger, disputed);
        },
      ), { seed: seeds.ledgerConservation, numRuns: propertyRuns, verbose: 2 });
    });
  });

  /** **Validates: Requirements 11.2, 11.7** */
  it("accepts a ledger only when every method/status pair is consistent and applied money fits the total", () => {
    const entryArbitrary = fc.record({
      method: fc.constantFrom(...paymentMethods),
      status: fc.constantFrom(...paymentRecordStatuses),
      amountPaise: fc.oneof(fc.integer({ min: 1, max: 2_000_000 }), fc.constant(Number.MAX_SAFE_INTEGER)),
    });
    const totalModeArbitrary = fc.oneof(
      fc.record({ kind: fc.constant("slack" as const), slack: fc.oneof(fc.constant(0), fc.integer({ min: -3, max: 1_000 })) }),
      fc.record({ kind: fc.constant("free" as const), total: invoiceTotalArbitrary }),
    );

    runSeededProperty("ledger-method-integrity-and-settlement", seeds.ledgerConsistency, () => {
      fc.assert(fc.property(
        fc.array(entryArbitrary, { maxLength: 6 }),
        totalModeArbitrary,
        fc.boolean(),
        (entries, totalMode, disputed) => {
          const ledger: PaymentLedgerEntry[] = entries.map((entry, index) => ({
            ...entry, id: `p${index}`, currency: "INR", createdAt: new Date(baseTime + index * 60_000),
          }));
          const { applied, pending } = oracleSums(ledger);
          const exactTotal = totalMode.kind === "slack" ? applied + BigInt(totalMode.slack) : BigInt(totalMode.total);
          if (exactTotal < 0n || exactTotal > MAX_SAFE) return;
          const total = exactTotal;
          const invoice: PayableInvoice = {
            id: "invoice-1", totalPaise: Number(total), currency: "INR", status: "ISSUED", superseded: false,
          };
          const inconsistent = ledger.some((entry) => !isMethodConsistent(entry.method, entry.status));
          const outcome = caught(() => summarizeInvoiceSettlement(invoice, ledger, { disputed }));

          if (inconsistent || applied > total) {
            expect(outcome).toMatchObject({ code: "PAYMENT_LEDGER_INCONSISTENT" });
            return;
          }
          expect(outcome).toBeUndefined();
          const settlement = summarizeInvoiceSettlement(invoice, ledger, { disputed });
          expect(BigInt(settlement.appliedPaise)).toBe(applied);
          expect(BigInt(settlement.pendingPaise)).toBe(pending);
          expect(settlement.settled).toBe(applied === total);
          const appliedMethods = new Set(ledger.filter((entry) => ORACLE_APPLIED.has(entry.status)).map((entry) => entry.method));
          if (settlement.status === "PAID_ONLINE") expect([...appliedMethods]).toEqual(["ONLINE"]);
          if (settlement.status === "PAID_CASH") expect([...appliedMethods]).toEqual(["CASH"]);
          if (total === 0n) expect(settlement.status).toBe("NOTHING_DUE");
        },
      ), { seed: seeds.ledgerConsistency, numRuns: propertyRuns, verbose: 2 });
    });
  });

  /** **Validates: Requirements 11.2, 11.7** */
  it("never moves cash into an online status, and reaches paid-online only from a provider with verified evidence", () => {
    runSeededProperty("payment-transition-method-integrity", seeds.transitionIntegrity, () => {
      fc.assert(fc.property(
        fc.constantFrom(...paymentMethods),
        fc.constantFrom(...paymentRecordStatuses),
        fc.constantFrom(...paymentRecordStatuses),
        fc.constantFrom(...actorRoles),
        fc.option(fc.constantFrom("Reviewed by support", "", "   "), { nil: undefined }),
        fc.constantFrom("valid" as const, "blank" as const, "none" as const),
        (method, from, to, actorRole, reason, evidenceMode) => {
          const evidence = evidenceMode === "none" ? undefined
            : { kind: "VERIFIED_PROVIDER_EVENT" as const, providerEventId: evidenceMode === "valid" ? "evt_1" : " " };
          const details = {
            ...(reason === undefined ? {} : { reason }),
            ...(evidence === undefined ? {} : { evidence }),
          };
          const outcome = caught(() => planPaymentTransition({ method, status: from }, to, actorRole, details));
          if (outcome !== undefined) {
            expect(outcome).toBeInstanceOf(PaymentRuleError);
            expect(["PAYMENT_TRANSITION_NOT_ALLOWED", "PAYMENT_ACTOR_NOT_PERMITTED", "PAYMENT_REASON_REQUIRED",
              "PAYMENT_EVIDENCE_REQUIRED"]).toContain((outcome as PaymentRuleError).code);
            return;
          }
          const rule = planPaymentTransition({ method, status: from }, to, actorRole, details);
          expect(rule.from).toBe(from);
          expect(rule.to).toBe(to);
          // Only consistent states lead to consistent states, and no transition fabricates paid-cash.
          expect(to).not.toBe("PAID_CASH");
          expect(isMethodConsistent(method, to)).toBe(true);
          if (method === "CASH") expect(ONLINE_ONLY.has(to)).toBe(false);
          if (to === "PAID_ONLINE" || (method === "ONLINE" && to === "REFUNDED")) {
            expect(actorRole).toBe("PROVIDER");
            expect(evidenceMode).toBe("valid");
          }
          if (rule.reasonRequired === true) expect((reason ?? "").trim().length).toBeGreaterThan(0);
        },
      ), { seed: seeds.transitionIntegrity, numRuns: propertyRuns, verbose: 2 });
    });
  });
});
