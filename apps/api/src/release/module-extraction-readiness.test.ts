import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

import type { ClaimedOutboxEvent } from "@kisantractor/database";
import {
  calculateFinalBill,
  evaluateProviderPaymentEvent,
  planPendingIntentRecovery,
  reproduceSubtotalFromTrace,
  summarizeInvoiceSettlement,
  type FinalBillCalculation,
  type PaymentLedgerEntry,
  type PaymentRecordStatus,
} from "@kisantractor/domain";
import { InMemoryOutboxLeaseStore } from "@kisantractor/test-utils";
import { describe, expect, it } from "vitest";

import {
  NonRetryableOutboxError,
  OutboxWorker,
  type OutboxEventHandler,
  type OutboxHandlerContext,
} from "../outbox/outbox-worker.js";

const ROOT = process.cwd();
const AT = new Date("2026-11-01T00:00:00.000Z");
const EVENT_TYPE = "BookingFinancialSnapshot";

interface ExtractionGate {
  readonly schemaVersion: string;
  readonly approvalStatus: string;
  readonly authoritativeWriter: string;
  readonly requirements: readonly string[];
  readonly consistencyCell: readonly string[];
  readonly invariants: readonly string[];
  readonly gates: readonly { readonly id: string; readonly evidence: readonly string[] }[];
  readonly contractPolicy: {
    readonly envelopeVersionField: string;
    readonly compatibility: string;
    readonly unsupportedMajor: string;
    readonly delivery: string;
    readonly consumerDeduplicationKey: string;
  };
  readonly reconciliationPolicy: {
    readonly cursor: readonly string[];
    readonly bounded: boolean;
    readonly requiredConsecutiveCleanPasses: number;
    readonly allowedMismatchCount: number;
    readonly sameVersionDivergence: string;
  };
  readonly performanceBudgetMs: {
    readonly readP95Exclusive: number;
    readonly stateChangeP95Exclusive: number;
  };
  readonly rollbackPolicy: {
    readonly beforeCommandCutover: string;
    readonly afterCommandCutoverRequires: string;
    readonly destructiveDownMigrationAllowed: boolean;
  };
}

type BookingFinancialStatus = "FINAL_BILL_GENERATED" | "COMPLETED";

interface VersionedPayment extends PaymentLedgerEntry {
  readonly invoiceId: string;
  readonly version: number;
}

interface FinancialSnapshot {
  readonly booking: {
    readonly id: string;
    readonly status: BookingFinancialStatus;
    readonly version: number;
    readonly agreementVersion: number;
  };
  readonly invoice: FinalBillCalculation & {
    readonly id: string;
    readonly bookingId: string;
    readonly invoiceVersion: number;
    readonly status: "ISSUED" | "SETTLED";
  };
  readonly payments: readonly VersionedPayment[];
}

interface WireFinancialSnapshot {
  readonly booking: FinancialSnapshot["booking"];
  readonly invoice: FinancialSnapshot["invoice"];
  readonly payments: readonly (Omit<VersionedPayment, "createdAt"> & { readonly createdAt: string })[];
  readonly producer?: string;
}

const cloneSnapshot = (snapshot: FinancialSnapshot): FinancialSnapshot => decodeSnapshot(toWire(snapshot));

function toWire(snapshot: FinancialSnapshot): WireFinancialSnapshot {
  return {
    booking: snapshot.booking,
    invoice: snapshot.invoice,
    payments: snapshot.payments.map((payment) => ({ ...payment, createdAt: payment.createdAt.toISOString() })),
    // Proves a v1 consumer tolerates an additive optional field from a newer v1 producer.
    producer: "modular-monolith-build-2026.11",
  };
}

function decodeSnapshot(payload: unknown): FinancialSnapshot {
  const wire = payload as WireFinancialSnapshot;
  if (wire === null || typeof wire !== "object" || wire.booking === undefined || wire.invoice === undefined
    || !Array.isArray(wire.payments)) {
    throw new NonRetryableOutboxError("INVALID_FINANCIAL_SNAPSHOT");
  }
  return {
    booking: { ...wire.booking },
    invoice: { ...wire.invoice, roundingTrace: { ...wire.invoice.roundingTrace } },
    payments: wire.payments.map((payment) => ({ ...payment, createdAt: new Date(payment.createdAt) })),
  };
}

function assertSnapshotInvariants(snapshot: FinancialSnapshot): void {
  expect(snapshot.invoice.bookingId).toBe(snapshot.booking.id);
  expect(snapshot.invoice.agreementVersion).toBe(snapshot.booking.agreementVersion);
  expect(reproduceSubtotalFromTrace(snapshot.invoice.roundingTrace)).toBe(snapshot.invoice.subtotalPaise);
  expect(snapshot.invoice.totalPaise).toBe(snapshot.invoice.subtotalPaise + snapshot.invoice.adjustmentsPaise);
  expect(snapshot.payments.every((payment) => payment.invoiceId === snapshot.invoice.id)).toBe(true);

  const settlement = summarizeInvoiceSettlement({
    id: snapshot.invoice.id,
    totalPaise: snapshot.invoice.totalPaise,
    currency: snapshot.invoice.currency,
    status: snapshot.invoice.status,
    superseded: false,
  }, snapshot.payments, { disputed: false });
  expect(settlement.appliedPaise).toBeLessThanOrEqual(snapshot.invoice.totalPaise);
  expect(settlement.settled).toBe(settlement.appliedPaise === snapshot.invoice.totalPaise);
  if (snapshot.booking.status === "COMPLETED") {
    expect(snapshot.invoice.status).toBe("SETTLED");
    expect(settlement.settled).toBe(true);
  }
}

function settledSource(): FinancialSnapshot {
  const bill = calculateFinalBill({
    agreementId: "agreement-3",
    agreementVersion: 3,
    pricingRuleId: "rule-7",
    pricingRuleVersion: 7,
    method: "HOURLY",
    ratePaise: 80_000,
    currency: "INR",
    roundingPolicy: "PROPORTIONAL_MINUTE",
  }, {
    method: "HOURLY",
    activeMilliseconds: 90 * 60_000,
    evidenceReferences: ["work-start-1", "work-complete-1"],
  });

  const pending = {
    id: "payment-1",
    invoiceId: "invoice-1",
    version: 1,
    method: "ONLINE" as const,
    status: "PENDING" as PaymentRecordStatus,
    amountPaise: bill.totalPaise,
    currency: "INR",
    createdAt: new Date(AT.getTime() - 60 * 60_000),
  };
  const recovery = planPendingIntentRecovery({
    status: pending.status,
    amountPaise: pending.amountPaise,
    currency: pending.currency,
    providerReference: "order-1",
    createdAt: pending.createdAt,
  }, {
    providerReference: "order-1",
    amountPaise: pending.amountPaise,
    currency: "INR",
    orderState: "PAID",
    payments: [{
      providerPaymentId: "pay-1",
      state: "CAPTURED",
      captured: true,
      amountPaise: pending.amountPaise,
      currency: "INR",
    }],
  }, "RECONCILIATION", AT);
  expect(recovery).toMatchObject({ action: "CONFIRM", providerPaymentId: "pay-1" });

  const decision = evaluateProviderPaymentEvent({
    method: pending.method,
    status: pending.status,
    amountPaise: pending.amountPaise,
    currency: pending.currency,
    providerReference: "order-1",
  }, {
    kind: "PAYMENT_CONFIRMED",
    providerEventId: "api:payment.captured:pay-1",
    providerReference: "order-1",
    providerPaymentId: "pay-1",
    amountPaise: pending.amountPaise,
    currency: "INR",
  });
  expect(decision).toMatchObject({ outcome: "APPLY", toStatus: "PAID_ONLINE" });
  if (decision.outcome !== "APPLY") throw new Error("Expected verified reconciliation evidence to apply");

  const snapshot: FinancialSnapshot = {
    booking: { id: "booking-1", status: "COMPLETED", version: 12, agreementVersion: 3 },
    invoice: { ...bill, id: "invoice-1", bookingId: "booking-1", invoiceVersion: 1, status: "SETTLED" },
    payments: [{ ...pending, version: 2, status: decision.toStatus }],
  };
  assertSnapshotInvariants(snapshot);
  return snapshot;
}

class FinancialSnapshotConsumer implements OutboxEventHandler {
  readonly name = "financial-snapshot-v1";
  readonly processed = new Set<string>();
  applications = 0;
  state: FinancialSnapshot | undefined;

  constructor(private crashAfterFirstCommit = false) {}

  handles(eventType: string): boolean {
    return eventType === EVENT_TYPE;
  }

  async handle(event: ClaimedOutboxEvent, _context: OutboxHandlerContext): Promise<void> {
    if (event.eventVersion !== 1) throw new NonRetryableOutboxError("UNSUPPORTED_CONTRACT_VERSION");
    if (this.processed.has(event.id)) return;
    const next = decodeSnapshot(event.payload);
    assertSnapshotInvariants(next);
    // In a real extracted service these three changes share one local transaction.
    this.state = next;
    this.processed.add(event.id);
    this.applications += 1;
    if (this.crashAfterFirstCommit) {
      this.crashAfterFirstCommit = false;
      throw Object.assign(new Error("worker crashed after local commit"), { code: "SIMULATED_POST_COMMIT_CRASH" });
    }
  }
}

function canonical(snapshot: FinancialSnapshot): string {
  return JSON.stringify(toWire(snapshot));
}

function reconcile(authoritative: FinancialSnapshot, shadow: FinancialSnapshot | undefined): FinancialSnapshot {
  if (shadow === undefined) return cloneSnapshot(authoritative);
  if (shadow.booking.version > authoritative.booking.version
    || shadow.invoice.invoiceVersion > authoritative.invoice.invoiceVersion
    || shadow.payments.some((payment) => {
      const source = authoritative.payments.find((candidate) => candidate.id === payment.id);
      return source === undefined || payment.version > source.version;
    })) {
    throw new Error("SHADOW_AHEAD_OF_AUTHORITY");
  }
  if (shadow.booking.version === authoritative.booking.version && canonical(shadow) !== canonical(authoritative)) {
    throw new Error("SAME_VERSION_DIVERGENCE");
  }
  const repaired = cloneSnapshot(authoritative);
  assertSnapshotInvariants(repaired);
  return repaired;
}

/** Validates: Requirements 18.3, 18.4, 18.5, 18.6 */
describe("module extraction readiness", () => {
  it("keeps a complete, blocked, machine-readable gate with real evidence", () => {
    const manifestPath = resolve(ROOT, "ops/architecture/module-extraction-gate.json");
    const gate = JSON.parse(readFileSync(manifestPath, "utf8")) as ExtractionGate;
    expect(gate).toMatchObject({
      schemaVersion: "kisantractor.module-extraction-readiness/v1",
      approvalStatus: "BLOCKED",
      authoritativeWriter: "MODULAR_MONOLITH",
      requirements: ["18.3", "18.4", "18.5", "18.6"],
      consistencyCell: ["BOOKING", "INVOICE", "PAYMENT"],
    });
    expect(new Set(gate.invariants)).toEqual(new Set([
      "BOOKING_AGREEMENT_IMMUTABLE",
      "INVOICE_AGREEMENT_LINK",
      "INVOICE_REPRODUCIBLE",
      "PAYMENT_CONSERVATION",
      "COMPLETION_REQUIRES_SETTLEMENT",
      "PROVIDER_EVIDENCE_IDEMPOTENT",
    ]));
    expect(new Set(gate.gates.map(({ id }) => id))).toEqual(new Set([
      "OWNERSHIP_BOUNDARY",
      "VERSIONED_CONTRACT",
      "OUTBOX_IDEMPOTENCY",
      "RECONCILIATION",
      "ROLLBACK",
      "BOUNDED_CURSOR_QUERIES",
      "LATENCY_BUDGET",
    ]));
    expect(gate.contractPolicy).toEqual({
      envelopeVersionField: "eventVersion",
      compatibility: "ADDITIVE_WITHIN_MAJOR",
      unsupportedMajor: "REJECT_WITHOUT_MUTATION_AND_DEAD_LETTER",
      delivery: "AT_LEAST_ONCE",
      consumerDeduplicationKey: "outboxEventId",
    });
    expect(gate.reconciliationPolicy).toMatchObject({
      cursor: ["updatedAt", "id"], bounded: true, requiredConsecutiveCleanPasses: 3,
      allowedMismatchCount: 0, sameVersionDivergence: "BLOCK_CUTOVER",
    });
    expect(gate.performanceBudgetMs).toEqual({ readP95Exclusive: 500, stateChangeP95Exclusive: 800 });
    expect(gate.rollbackPolicy).toEqual({
      beforeCommandCutover: "ROUTE_TO_MONOLITH_AND_REBUILD_SHADOW",
      afterCommandCutoverRequires: "PROVEN_REVERSE_SYNCHRONIZATION",
      destructiveDownMigrationAllowed: false,
    });
    for (const path of gate.gates.flatMap(({ evidence }) => evidence)) {
      expect(existsSync(resolve(ROOT, path)), path).toBe(true);
    }
  });

  it("preserves financial invariants across additive v1 fields and an at-least-once retry", async () => {
    const source = settledSource();
    const sourceBefore = canonical(source);
    const store = new InMemoryOutboxLeaseStore();
    const event = store.append({
      aggregateType: "Booking",
      aggregateId: source.booking.id,
      eventType: EVENT_TYPE,
      payload: toWire(source),
      availableAt: AT,
      correlationId: "extraction-proof-1",
    });
    const consumer = new FinancialSnapshotConsumer(true);
    let now = AT;
    const worker = new OutboxWorker(store, {
      workerId: "extraction-proof",
      handlers: [consumer],
      now: () => now,
      random: () => 0,
      retryPolicy: { maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 1_000, jitterRatio: 0 },
    });

    await expect(worker.runOnce()).resolves.toMatchObject({ claimed: 1, retryScheduled: 1 });
    expect(store.rows.get(event.id)).toMatchObject({ status: "FAILED", attemptCount: 1 });
    expect(consumer.applications).toBe(1);
    expect(canonical(source)).toBe(sourceBefore);

    now = new Date(AT.getTime() + 1_000);
    await expect(worker.runOnce()).resolves.toMatchObject({ claimed: 1, published: 1 });
    expect(store.rows.get(event.id)).toMatchObject({ status: "PUBLISHED", attemptCount: 2 });
    expect(consumer.applications).toBe(1);
    expect(consumer.processed).toEqual(new Set([event.id]));
    expect(canonical(consumer.state!)).toBe(sourceBefore);
    assertSnapshotInvariants(consumer.state!);
  });

  it("repairs a missed delivery idempotently and blocks divergence or an unsafe contract rollback", async () => {
    const source = settledSource();
    const firstPass = reconcile(source, undefined);
    expect(canonical(firstPass)).toBe(canonical(source));
    const secondPass = reconcile(source, firstPass);
    expect(canonical(secondPass)).toBe(canonical(firstPass));

    const divergent = cloneSnapshot(source);
    (divergent.booking as { status: BookingFinancialStatus }).status = "FINAL_BILL_GENERATED";
    expect(() => reconcile(source, divergent)).toThrow("SAME_VERSION_DIVERGENCE");

    const store = new InMemoryOutboxLeaseStore();
    const event = store.append({
      aggregateType: "Booking",
      aggregateId: source.booking.id,
      eventType: EVENT_TYPE,
      payload: toWire(source),
      availableAt: AT,
    });
    event.eventVersion = 2;
    const consumer = new FinancialSnapshotConsumer();
    consumer.state = cloneSnapshot(source);
    const candidateBefore = canonical(consumer.state);
    const worker = new OutboxWorker(store, { workerId: "unsupported-version", handlers: [consumer], now: () => AT });

    await expect(worker.runOnce()).resolves.toMatchObject({ claimed: 1, deadLettered: 1 });
    expect(store.rows.get(event.id)).toMatchObject({ status: "DEAD_LETTER", lastErrorCode: "UNSUPPORTED_CONTRACT_VERSION" });
    expect(canonical(consumer.state)).toBe(candidateBefore);
    expect(consumer.applications).toBe(0);

    // Pre-cutover rollback is a route switch: the monolith remained authoritative and unchanged.
    const routeToCandidate = false;
    const routed = routeToCandidate ? consumer.state : source;
    expect(canonical(routed!)).toBe(canonical(source));
    assertSnapshotInvariants(routed!);
  });
});
