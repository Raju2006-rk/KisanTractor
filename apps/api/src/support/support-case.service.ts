import { createHash } from "node:crypto";

import type { AuthPrincipal } from "@kisantractor/domain";

import type { SupportAccessDecision } from "./support-access-policy.js";
import type { SupportAccessPolicy, SupportAccessRequest } from "../authorization/authorization.contracts.js";
import type { RequestRefundCommand } from "../payment/payment-refund.service.js";
import type { PaymentRequestContext, RefundRequestResult } from "../payment/payment.contracts.js";
import type { SupportCaseAccessRecord, SupportCaseStore } from "./postgres-support-case-store.js";
import {
  decideResolution,
  partyStatementCodes,
  refundReasonFor,
  supportEvidenceKinds,
  supportReasonCodes,
  supportResolutionOutcomes,
  SupportNotFoundError,
  SupportValidationError,
  type DisputePartyRole,
  type SupportCaseProjection,
  type SupportCaseSummary,
  type SupportEvidenceReference,
  type SupportReasonCode,
  type SupportRequestContext,
  type SupportResolutionOutcome,
} from "./support.contracts.js";

/** The decision-returning form of the support access policy (PostgresSupportAccessPolicy). */
export interface SupportAccessEvaluator {
  evaluate(request: SupportAccessRequest): Promise<SupportAccessDecision>;
}

/**
 * Adapts any SupportAccessPolicy. A policy that cannot name the grant's case (such as the deny-all
 * default) never lets an operator into a case.
 */
export const supportAccessEvaluator = (policy: SupportAccessPolicy | (SupportAccessPolicy & SupportAccessEvaluator)): SupportAccessEvaluator =>
  "evaluate" in policy && typeof policy.evaluate === "function"
    ? { evaluate: (request) => policy.evaluate(request) }
    : { evaluate: async (request) => ({ allowed: await policy.hasExplicitAccess(request) }) };

/** The refund path support resolutions reuse; it re-checks support access itself. */
export interface SupportRefundRequester {
  requestRefund(principal: AuthPrincipal, command: RequestRefundCommand, context: PaymentRequestContext): Promise<RefundRequestResult>;
}

export interface StatementCommand {
  readonly expectedVersion: number;
  readonly statementCode: string;
  readonly statementText?: string;
  readonly evidence?: { readonly kind: string; readonly id: string };
  readonly idempotencyKey: string;
}

export interface ResolveCommand {
  readonly expectedVersion: number;
  readonly expectedBookingVersion?: number;
  readonly outcome: string;
  readonly reasonCode: string;
  readonly paymentId?: string;
  readonly idempotencyKey: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
// Seven or more digits look like a phone number; statements must not carry one.
const PHONE_LIKE = /\d[\d\s-]{6,}\d/u;

const id = (value: unknown): string => {
  if (typeof value !== "string" || !UUID.test(value.trim())) throw new SupportNotFoundError();
  return value.trim().toLowerCase();
};

const key = (value: unknown): string => {
  if (typeof value !== "string" || value.trim().length < 8 || value.trim().length > 200) {
    throw new SupportValidationError("idempotencyKey", "A stable idempotency key of 8 to 200 characters is required");
  }
  return value.trim();
};

const version = (value: unknown, field: string): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new SupportValidationError(field, `${field} must be a positive whole number`);
  }
  return value;
};

const code = <Code extends string>(value: unknown, allowed: readonly Code[], field: string): Code => {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new SupportValidationError(field, `Choose one of the listed ${field} values`);
  }
  return value as Code;
};

const statementText = (value: unknown): string | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new SupportValidationError("statementText", "Details must be text");
  const trimmed = value.trim().replace(/\s+/gu, " ");
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > 500) throw new SupportValidationError("statementText", "Details must be 500 characters or fewer");
  if (PHONE_LIKE.test(trimmed)) throw new SupportValidationError("statementText", "Do not include phone numbers");
  return trimmed;
};

const evidence = (value: StatementCommand["evidence"]): SupportEvidenceReference | undefined =>
  value === undefined ? undefined : { kind: code(value.kind, supportEvidenceKinds, "evidenceKind"), id: id(value.id) };

const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/**
 * Dispute review for support operators and the booking's parties (task 16.5).
 *
 * Operators act only through explicit, time-bounded grants evaluated server-side (default deny);
 * every read and command, allowed or not, is audited with ids and codes. Farmers and Owners see the
 * case of their own booking: status, outcome, and timeline, with statement text shown only to its
 * author. Commands use idempotency keys and optimistic case and booking versions.
 */
export class SupportCaseService {
  constructor(
    private readonly store: SupportCaseStore,
    private readonly access: SupportAccessEvaluator,
    private readonly refunds: SupportRefundRequester,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async listCases(principal: AuthPrincipal, context: SupportRequestContext): Promise<readonly SupportCaseSummary[]> {
    const operator = this.#operator(principal);
    const cases = await this.store.listOperatorCases(operator.userId, this.now());
    await this.store.audit({
      actorId: operator.userId, actorChannel: "OPERATOR", action: "support.case.list", resourceType: "SupportCase",
      outcome: "SUCCEEDED", metadata: { caseCount: cases.length },
    }, context);
    return cases;
  }

  async getCase(principal: AuthPrincipal, caseId: string, context: SupportRequestContext): Promise<SupportCaseProjection> {
    const operator = this.#operator(principal);
    const record = await this.#authorizeOperator(operator, id(caseId), "booking:read", context);
    const grantExpiresAt = await this.store.operatorGrantExpiry(operator.userId, record.id, this.now());
    const projection = await this.store.readCase(record.id, { kind: "SUPPORT", ...(grantExpiresAt === undefined ? {} : { grantExpiresAt }) });
    await this.store.audit({
      actorId: operator.userId, actorChannel: "OPERATOR", action: "support.case.read", resourceType: "SupportCase",
      resourceId: record.id, outcome: "SUCCEEDED", metadata: { bookingId: record.bookingId, caseStatus: projection.status },
    }, context);
    return projection;
  }

  async addNote(principal: AuthPrincipal, caseId: string, command: StatementCommand, context: SupportRequestContext): Promise<SupportCaseProjection> {
    const operator = this.#operator(principal);
    const record = await this.#authorizeOperator(operator, id(caseId), "booking:command", context);
    const statementCode = code(command.statementCode, supportReasonCodes, "statementCode");
    const text = statementText(command.statementText);
    const linked = evidence(command.evidence);
    const expectedVersion = version(command.expectedVersion, "expectedVersion");
    await this.store.appendEntry({
      caseId: record.id, expectedVersion, entryType: "SUPPORT_NOTE", authorRole: "SUPPORT", authorUserId: operator.userId,
      statementCode, ...(text === undefined ? {} : { statementText: text }), ...(linked === undefined ? {} : { evidence: linked }),
      idempotencyKey: key(command.idempotencyKey),
      requestDigest: digest({ caseId: record.id, expectedVersion, statementCode, text: text ?? null, linked: linked ?? null }),
      occurredAt: this.now(),
    }, { ...context, actorChannel: "OPERATOR" });
    return this.store.readCase(record.id, { kind: "SUPPORT" });
  }

  async resolve(principal: AuthPrincipal, caseId: string, command: ResolveCommand, context: SupportRequestContext): Promise<SupportCaseProjection> {
    const operator = this.#operator(principal);
    // Resolving needs command access while the case is open. Once it is resolved, the store only
    // replays the same request (by idempotency key) or refuses, so read access is enough to learn
    // that an earlier attempt committed.
    const record = await this.#authorizeOperator(operator, id(caseId),
      (candidate) => (candidate.status === "OPEN" ? "booking:command" : "booking:read"), context);
    const outcome: SupportResolutionOutcome = code(command.outcome, supportResolutionOutcomes, "outcome");
    const reasonCode: SupportReasonCode = code(command.reasonCode, supportReasonCodes, "reasonCode");
    const expectedVersion = version(command.expectedVersion, "expectedVersion");
    const idempotencyKey = key(command.idempotencyKey);
    const occurredAt = this.now();
    const operatorContext = { ...context, actorChannel: "OPERATOR" as const };
    let paymentRefundId: string | undefined;
    let expectedBookingVersion: number | undefined;

    if (outcome === "REFUND") {
      const paymentId = id(command.paymentId);
      if (record.status === "OPEN") {
        const facts = await this.store.readResolutionFacts(record.id);
        // A retried request finds the booking already REFUND_PENDING; the refund replays by key.
        if (facts.bookingStatus !== "REFUND_PENDING") decideResolution("REFUND", facts, paymentId);
        const refund = await this.refunds.requestRefund(operator, {
          paymentId, reasonCode: refundReasonFor(reasonCode), idempotencyKey,
        }, operatorContext);
        paymentRefundId = refund.refund.id;
      }
    } else {
      expectedBookingVersion = version(command.expectedBookingVersion, "expectedBookingVersion");
    }

    await this.store.resolveCase({
      caseId: record.id, expectedVersion, outcome, reasonCode, actorId: operator.userId, idempotencyKey,
      ...(expectedBookingVersion === undefined ? {} : { expectedBookingVersion }),
      ...(paymentRefundId === undefined ? {} : { paymentRefundId }),
      requestDigest: digest({ caseId: record.id, expectedVersion, outcome, reasonCode, paymentId: command.paymentId ?? null }),
      occurredAt,
    }, operatorContext);
    return this.store.readCase(record.id, { kind: "SUPPORT" });
  }

  /** The Farmer's or Owner's view of the latest dispute case on their own booking. */
  async getPartyCase(principal: AuthPrincipal, role: DisputePartyRole, bookingId: string): Promise<SupportCaseProjection> {
    const party = this.#party(principal, role);
    const record = await this.store.findPartyCase(id(bookingId), role, party.userId);
    if (record === undefined) throw new SupportNotFoundError();
    return this.store.readCase(record.id, { kind: "PARTY", userId: party.userId });
  }

  async addPartyStatement(
    principal: AuthPrincipal,
    role: DisputePartyRole,
    bookingId: string,
    command: StatementCommand,
    context: SupportRequestContext,
  ): Promise<SupportCaseProjection> {
    const party = this.#party(principal, role);
    const record = await this.store.findPartyCase(id(bookingId), role, party.userId);
    if (record === undefined) throw new SupportNotFoundError();
    const statementCode = code(command.statementCode, partyStatementCodes, "statementCode");
    const text = statementText(command.statementText);
    const linked = evidence(command.evidence);
    const expectedVersion = version(command.expectedVersion, "expectedVersion");
    await this.store.appendEntry({
      caseId: record.id, expectedVersion, entryType: "PARTY_STATEMENT", authorRole: role, authorUserId: party.userId,
      statementCode, ...(text === undefined ? {} : { statementText: text }), ...(linked === undefined ? {} : { evidence: linked }),
      idempotencyKey: key(command.idempotencyKey),
      requestDigest: digest({ caseId: record.id, expectedVersion, statementCode, text: text ?? null, linked: linked ?? null }),
      occurredAt: this.now(),
    }, context);
    return this.store.readCase(record.id, { kind: "PARTY", userId: party.userId });
  }

  #operator(principal: AuthPrincipal): AuthPrincipal {
    // Non-operators learn nothing about support cases, not even whether one exists.
    if (!principal.roles.includes("FUTURE_OPERATOR")) throw new SupportNotFoundError();
    return { ...principal, roles: ["FUTURE_OPERATOR"] };
  }

  #party(principal: AuthPrincipal, role: DisputePartyRole): AuthPrincipal {
    if (!principal.roles.includes(role)) throw new SupportNotFoundError();
    return { ...principal, roles: [role] };
  }

  async #deny(operator: AuthPrincipal, caseId: string, action: string, reasonCode: string, context: SupportRequestContext): Promise<never> {
    await this.store.audit({
      actorId: operator.userId, actorChannel: "OPERATOR", action: "support.case.access", resourceType: "SupportCase",
      resourceId: caseId, outcome: "DENIED", reasonCode, metadata: { requestedAction: action },
    }, context);
    throw new SupportNotFoundError();
  }

  async #authorizeOperator(
    operator: AuthPrincipal,
    caseId: string,
    requested: "booking:read" | "booking:command" | ((record: SupportCaseAccessRecord) => "booking:read" | "booking:command"),
    context: SupportRequestContext,
  ): Promise<SupportCaseAccessRecord> {
    const record = await this.store.findCaseAccess(caseId);
    if (record === undefined) {
      return this.#deny(operator, caseId, typeof requested === "string" ? requested : "booking:command", "CASE_NOT_FOUND", context);
    }
    const action = typeof requested === "string" ? requested : requested(record);
    const decision = await this.access.evaluate({
      principal: operator,
      action,
      resource: { kind: "BOOKING", id: record.bookingId, customerId: record.customerId, ownerId: record.ownerId },
      correlationId: context.correlationId,
    });
    // The grant must be for this case, not merely for another case of the same booking.
    if (!decision.allowed || decision.caseId !== record.id) {
      return this.#deny(operator, caseId, action, decision.allowed ? "GRANT_FOR_OTHER_CASE" : "NO_ACTIVE_GRANT", context);
    }
    return record;
  }
}
