import type { AuditEventInput } from "@kisantractor/database";
import type { AuthPrincipal } from "@kisantractor/domain";
import { describe, expect, it, vi } from "vitest";

import { DenyAllSupportAccessPolicy } from "../authorization/authorization.contracts.js";
import type { SupportCaseAccessRecord, SupportCaseStore, SupportCaseViewer } from "./postgres-support-case-store.js";
import { SupportCaseService, supportAccessEvaluator, type SupportAccessEvaluator } from "./support-case.service.js";
import {
  decideResolution,
  SupportNotFoundError,
  SupportRuleError,
  SupportValidationError,
  type ResolutionFacts,
  type SupportCaseProjection,
} from "./support.contracts.js";

const CASE = "c1000000-0000-4000-8000-000000000001";
const OTHER_CASE = "c1000000-0000-4000-8000-000000000002";
const BOOKING = "b1000000-0000-4000-8000-000000000001";
const PAYMENT = "a1000000-0000-4000-8000-000000000001";
const operator: AuthPrincipal = { userId: "e1000000-0000-4000-8000-000000000001", sessionId: "s-op", roles: ["FUTURE_OPERATOR"] };
const farmer: AuthPrincipal = { userId: "f1000000-0000-4000-8000-000000000001", sessionId: "s-f", roles: ["FARMER"] };
const owner: AuthPrincipal = { userId: "d1000000-0000-4000-8000-000000000001", sessionId: "s-o", roles: ["OWNER"] };
const context = { correlationId: "corr-support-1", actorChannel: "WEB" as const };

const facts = (overrides: Partial<ResolutionFacts> = {}): ResolutionFacts => ({
  bookingStatus: "DISPUTED", disputedInvoiceId: "inv-1", currentInvoiceId: "inv-1", currentInvoiceTotalPaise: 120_000,
  appliedOnCurrentPaise: 0, appliedOnSupersededPaise: 0, pendingPaise: 0, refundablePaymentIds: [], ...overrides,
});

/** Validates: Requirements 10.8, 1.4 */
describe("dispute resolution rules (version 1)", () => {
  it("maps each outcome to one explicit booking edge or to the refund path", () => {
    expect(decideResolution("UPHOLD", facts())).toEqual({ kind: "BOOKING_TRANSITION", action: "RESOLVE_DISPUTE", to: "FINAL_BILL_GENERATED" });
    expect(decideResolution("UPHOLD", facts({ appliedOnCurrentPaise: 120_000 }))).toEqual({ kind: "BOOKING_TRANSITION", action: "COMPLETE", to: "COMPLETED" });
    expect(decideResolution("ADJUST", facts({ currentInvoiceId: "inv-2", currentInvoiceTotalPaise: 90_000 })))
      .toEqual({ kind: "BOOKING_TRANSITION", action: "RESOLVE_DISPUTE", to: "FINAL_BILL_GENERATED" });
    expect(decideResolution("CANCEL", facts())).toEqual({ kind: "BOOKING_TRANSITION", action: "CANCEL", to: "CANCELLED" });
    expect(decideResolution("REFUND", facts({ refundablePaymentIds: [PAYMENT] }), PAYMENT)).toEqual({ kind: "REFUND", paymentId: PAYMENT });
  });

  it("refuses outcomes the money or invoice history does not allow", () => {
    const refused = (run: () => unknown) => {
      try { run(); } catch (error) { return error instanceof SupportRuleError ? error.code : "OTHER"; }
      return "ALLOWED";
    };
    expect(refused(() => decideResolution("UPHOLD", facts({ bookingStatus: "COMPLETED" })))).toBe("BOOKING_NOT_DISPUTED");
    expect(refused(() => decideResolution("UPHOLD", facts({ currentInvoiceId: "inv-2" })))).toBe("INVOICE_CHANGED");
    expect(refused(() => decideResolution("ADJUST", facts()))).toBe("ADJUSTED_INVOICE_REQUIRED");
    expect(refused(() => decideResolution("ADJUST", facts({ currentInvoiceId: "inv-2", appliedOnSupersededPaise: 1 })))).toBe("SUPERSEDED_PAYMENT_APPLIED");
    expect(refused(() => decideResolution("CANCEL", facts({ appliedOnCurrentPaise: 50_000 })))).toBe("PAYMENT_APPLIED");
    expect(refused(() => decideResolution("UPHOLD", facts({ pendingPaise: 120_000 })))).toBe("PAYMENT_PENDING");
    expect(refused(() => decideResolution("REFUND", facts(), PAYMENT))).toBe("REFUND_NOT_AVAILABLE");
  });
});

const projection = (viewer: SupportCaseViewer): SupportCaseProjection => ({
  id: CASE, bookingId: BOOKING, bookingReference: "KT-1", bookingStatus: "DISPUTED", bookingVersion: 9, status: "OPEN", version: 1,
  openedAt: new Date(0), disputedInvoiceId: "inv-1", disputedInvoiceVersion: 1, currentInvoiceId: "inv-1", currentInvoiceVersion: 1,
  currentInvoiceTotalPaise: 120_000, appliedPaise: 0, entries: [],
  ...(viewer.kind === "SUPPORT" ? { refundablePayments: [{ id: PAYMENT, amountPaise: 120_000 }] } : {}),
});

const harness = (evaluator: SupportAccessEvaluator, refundFacts: Partial<ResolutionFacts> = {}) => {
  const audits: Omit<AuditEventInput, "correlationId">[] = [];
  const record: SupportCaseAccessRecord = { id: CASE, bookingId: BOOKING, customerId: farmer.userId, ownerId: owner.userId, status: "OPEN" };
  const store = {
    findCaseAccess: vi.fn(async (id: string) => (id === CASE ? record : undefined)),
    findPartyCase: vi.fn(async (_booking: string, role: "FARMER" | "OWNER", userId: string) =>
      (role === "FARMER" ? userId === farmer.userId : userId === owner.userId) ? record : undefined),
    listOperatorCases: vi.fn(async () => []),
    operatorGrantExpiry: vi.fn(async () => new Date(86_400_000)),
    readCase: vi.fn(async (_id: string, viewer: SupportCaseViewer) => projection(viewer)),
    readResolutionFacts: vi.fn(async () => facts(refundFacts)),
    appendEntry: vi.fn(async () => undefined),
    resolveCase: vi.fn(async () => undefined),
    audit: vi.fn(async (event: Omit<AuditEventInput, "correlationId">) => { audits.push(event); }),
  } satisfies SupportCaseStore;
  const refunds = { requestRefund: vi.fn(async () => ({ refund: { id: "refund-1" } }) as never) };
  const service = new SupportCaseService(store, evaluator, refunds, () => new Date(1_000));
  return { service, store, refunds, audits };
};

const allowCase = (caseId: string, scope: "READ" | "RESOLVE" = "RESOLVE"): SupportAccessEvaluator => ({
  evaluate: vi.fn(async ({ action }) => ({
    allowed: action === "booking:read" || scope === "RESOLVE", caseId, scope, grantId: "grant-1",
  })),
});

/** Validates: Requirements 1.4, 10.8, 12.4 */
describe("support case service", () => {
  it("denies every operator call under the deny-all default and audits the refusal without PII", async () => {
    const { service, store, audits } = harness(supportAccessEvaluator(new DenyAllSupportAccessPolicy()));
    await expect(service.getCase(operator, CASE, context)).rejects.toBeInstanceOf(SupportNotFoundError);
    await expect(service.resolve(operator, CASE, {
      expectedVersion: 1, expectedBookingVersion: 9, outcome: "UPHOLD", reasonCode: "EVIDENCE_SUPPORTS_BILL", idempotencyKey: "resolve-key-1",
    }, context)).rejects.toBeInstanceOf(SupportNotFoundError);
    expect(store.readCase).not.toHaveBeenCalled();
    expect(store.resolveCase).not.toHaveBeenCalled();
    expect(audits.map(({ action, outcome, reasonCode }) => [action, outcome, reasonCode])).toEqual([
      ["support.case.access", "DENIED", "NO_ACTIVE_GRANT"], ["support.case.access", "DENIED", "NO_ACTIVE_GRANT"],
    ]);
  });

  it("refuses non-operators, unknown cases, and grants for a different case of the booking", async () => {
    const { service } = harness(allowCase(OTHER_CASE));
    await expect(service.getCase(farmer, CASE, context)).rejects.toBeInstanceOf(SupportNotFoundError);
    await expect(service.getCase(operator, "c1000000-0000-4000-8000-00000000000f", context)).rejects.toBeInstanceOf(SupportNotFoundError);
    await expect(service.getCase(operator, CASE, context)).rejects.toBeInstanceOf(SupportNotFoundError);
    await expect(service.getCase(operator, "not-a-uuid", context)).rejects.toBeInstanceOf(SupportNotFoundError);
  });

  it("audits an allowed read and lets a READ grant read but not resolve", async () => {
    const { service, store, audits } = harness(allowCase(CASE, "READ"));
    const view = await service.getCase(operator, CASE, context);
    expect(view.refundablePayments).toEqual([{ id: PAYMENT, amountPaise: 120_000 }]);
    expect(store.readCase).toHaveBeenCalledWith(CASE, { kind: "SUPPORT", grantExpiresAt: new Date(86_400_000) });
    expect(audits.at(-1)).toMatchObject({ action: "support.case.read", outcome: "SUCCEEDED", resourceId: CASE, metadata: { bookingId: BOOKING } });
    await expect(service.addNote(operator, CASE, {
      expectedVersion: 1, statementCode: "OTHER", idempotencyKey: "note-key-1",
    }, context)).rejects.toBeInstanceOf(SupportNotFoundError);
    expect(store.appendEntry).not.toHaveBeenCalled();
  });

  it("validates codes, versions, keys, and phone-free statements before writing", async () => {
    const { service, store } = harness(allowCase(CASE));
    const note = (overrides: Record<string, unknown>) => service.addNote(operator, CASE, {
      expectedVersion: 1, statementCode: "OTHER", idempotencyKey: "note-key-1", ...overrides,
    } as never, context);
    await expect(note({ statementCode: "FREE_TEXT" })).rejects.toBeInstanceOf(SupportValidationError);
    await expect(note({ expectedVersion: 0 })).rejects.toBeInstanceOf(SupportValidationError);
    await expect(note({ idempotencyKey: "short" })).rejects.toBeInstanceOf(SupportValidationError);
    await expect(note({ statementText: "Call me on 98765 43210" })).rejects.toBeInstanceOf(SupportValidationError);
    await expect(note({ evidence: { kind: "DOCUMENT", id: PAYMENT } })).rejects.toBeInstanceOf(SupportValidationError);
    expect(store.appendEntry).not.toHaveBeenCalled();
    await note({ statementText: "  Checked   the work record  ", evidence: { kind: "PAYMENT", id: PAYMENT } });
    expect(store.appendEntry).toHaveBeenCalledWith(expect.objectContaining({
      entryType: "SUPPORT_NOTE", authorRole: "SUPPORT", statementText: "Checked the work record", evidence: { kind: "PAYMENT", id: PAYMENT },
    }), { ...context, actorChannel: "OPERATOR" });
  });

  it("resolves through the store with optimistic versions, and refunds through the refund service first", async () => {
    const { service, store, refunds } = harness(allowCase(CASE), { refundablePaymentIds: [PAYMENT] });
    await service.resolve(operator, CASE, {
      expectedVersion: 2, expectedBookingVersion: 9, outcome: "UPHOLD", reasonCode: "EVIDENCE_SUPPORTS_BILL", idempotencyKey: "resolve-key-1",
    }, context);
    expect(store.resolveCase).toHaveBeenLastCalledWith(expect.objectContaining({
      caseId: CASE, expectedVersion: 2, expectedBookingVersion: 9, outcome: "UPHOLD", actorId: operator.userId,
    }), expect.objectContaining({ actorChannel: "OPERATOR" }));
    await expect(service.resolve(operator, CASE, {
      expectedVersion: 2, outcome: "CANCEL", reasonCode: "PARTIES_AGREED", idempotencyKey: "resolve-key-2",
    }, context)).rejects.toBeInstanceOf(SupportValidationError);

    await service.resolve(operator, CASE, {
      expectedVersion: 2, outcome: "REFUND", reasonCode: "SERVICE_NOT_DELIVERED", paymentId: PAYMENT, idempotencyKey: "resolve-key-3",
    }, context);
    expect(refunds.requestRefund).toHaveBeenCalledWith(expect.objectContaining({ roles: ["FUTURE_OPERATOR"] }), {
      paymentId: PAYMENT, reasonCode: "SERVICE_NOT_DELIVERED", idempotencyKey: "resolve-key-3",
    }, expect.objectContaining({ actorChannel: "OPERATOR" }));
    expect(store.resolveCase).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: "REFUND", paymentRefundId: "refund-1" }), expect.anything());
  });

  it("does not request a refund the rules refuse", async () => {
    const { service, store, refunds } = harness(allowCase(CASE));
    await expect(service.resolve(operator, CASE, {
      expectedVersion: 2, outcome: "REFUND", reasonCode: "OTHER", paymentId: PAYMENT, idempotencyKey: "resolve-key-4",
    }, context)).rejects.toMatchObject({ code: "REFUND_NOT_AVAILABLE" });
    expect(refunds.requestRefund).not.toHaveBeenCalled();
    expect(store.resolveCase).not.toHaveBeenCalled();
  });

  it("shows each party only its own booking's case and records statements under its role", async () => {
    const { service, store } = harness(allowCase(CASE));
    await service.getPartyCase(farmer, "FARMER", BOOKING);
    expect(store.readCase).toHaveBeenLastCalledWith(CASE, { kind: "PARTY", userId: farmer.userId });
    await expect(service.getPartyCase(farmer, "OWNER", BOOKING)).rejects.toBeInstanceOf(SupportNotFoundError);
    await expect(service.getPartyCase({ ...farmer, userId: "f1000000-0000-4000-8000-0000000000ff" }, "FARMER", BOOKING))
      .rejects.toBeInstanceOf(SupportNotFoundError);
    await service.addPartyStatement(owner, "OWNER", BOOKING, {
      expectedVersion: 1, statementCode: "WORK_RECORD_CORRECT", idempotencyKey: "statement-key-1",
    }, context);
    expect(store.appendEntry).toHaveBeenCalledWith(expect.objectContaining({
      entryType: "PARTY_STATEMENT", authorRole: "OWNER", authorUserId: owner.userId, statementCode: "WORK_RECORD_CORRECT",
    }), context);
    await expect(service.addPartyStatement(owner, "OWNER", BOOKING, {
      expectedVersion: 1, statementCode: "EVIDENCE_SUPPORTS_BILL", idempotencyKey: "statement-key-2",
    }, context)).rejects.toBeInstanceOf(SupportValidationError);
  });
});
