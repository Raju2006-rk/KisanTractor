import type { AuthPrincipal } from "@kisantractor/domain";
import { Body, Controller, Get, Headers, HttpCode, HttpException, Inject, Param, Post, Req } from "@nestjs/common";

import {
  bearerCredential,
  header,
  requestContext,
  toPaymentHttpError,
  type HttpRequestLike,
} from "../payment/payment.controller.js";
import type { SupportCaseService, StatementCommand } from "./support-case.service.js";
import {
  SupportConflictError,
  SupportNotFoundError,
  SupportRuleError,
  SupportValidationError,
  type DisputePartyRole,
  type SupportRequestContext,
  type SupportSessionAuthenticator,
} from "./support.contracts.js";

export const SUPPORT_AUTHENTICATOR = Symbol("SUPPORT_AUTHENTICATOR");
export const SUPPORT_CASE_SERVICE = Symbol("SUPPORT_CASE_SERVICE");

/** Maps support failures to stable codes; unrelated callers always see 404. */
export function toSupportHttpError(error: unknown): unknown {
  if (error instanceof HttpException) return error;
  if (error instanceof SupportNotFoundError) return new HttpException({ code: "NOT_FOUND" }, 404);
  if (error instanceof SupportValidationError) {
    return new HttpException({ code: error.code, field: error.field, message: error.message }, 422);
  }
  if (error instanceof SupportConflictError || error instanceof SupportRuleError) {
    return new HttpException({ code: error.code, message: error.message }, 409);
  }
  return toPaymentHttpError(error);
}

interface StatementBody {
  readonly expectedVersion?: unknown;
  readonly statementCode?: unknown;
  readonly statementText?: unknown;
  readonly evidenceKind?: unknown;
  readonly evidenceId?: unknown;
  readonly idempotencyKey?: unknown;
}

interface ResolutionBody {
  readonly expectedVersion?: unknown;
  readonly expectedBookingVersion?: unknown;
  readonly outcome?: unknown;
  readonly reasonCode?: unknown;
  readonly paymentId?: unknown;
  readonly idempotencyKey?: unknown;
}

const numberField = (value: unknown): number => typeof value === "string" && /^\d{1,9}$/u.test(value) ? Number(value) : value as number;

const idempotencyKey = (request: HttpRequestLike, value: unknown): string =>
  (typeof value === "string" ? value : header(request, "idempotency-key")) as string;

const statementCommand = (request: HttpRequestLike, body: StatementBody): StatementCommand => ({
  expectedVersion: numberField(body.expectedVersion),
  statementCode: body.statementCode as string,
  ...(typeof body.statementText === "string" ? { statementText: body.statementText } : {}),
  ...(body.evidenceKind === undefined && body.evidenceId === undefined ? {} : {
    evidence: { kind: body.evidenceKind as string, id: body.evidenceId as string },
  }),
  idempotencyKey: idempotencyKey(request, body.idempotencyKey),
});

const authenticated = async (
  authenticator: SupportSessionAuthenticator,
  request: HttpRequestLike,
): Promise<AuthPrincipal> => authenticator.authenticateAccessCredential(bearerCredential(request));

const operatorContext = (request: HttpRequestLike, correlationId: string | undefined): SupportRequestContext =>
  ({ ...requestContext(request, correlationId), actorChannel: "OPERATOR" });

/**
 * Support dispute review (task 16.5). Default deny: the caller must hold FUTURE_OPERATOR and an
 * explicit, unexpired grant for the case; everyone else gets 404. Every call is audited.
 */
@Controller("support")
export class SupportCaseController {
  constructor(
    @Inject(SUPPORT_AUTHENTICATOR) private readonly authenticator: SupportSessionAuthenticator,
    @Inject(SUPPORT_CASE_SERVICE) private readonly cases: SupportCaseService,
  ) {}

  @Get("cases")
  async list(@Req() request: HttpRequestLike, @Headers("x-correlation-id") correlationId?: string) {
    try {
      return { items: await this.cases.listCases(await authenticated(this.authenticator, request), operatorContext(request, correlationId)) };
    } catch (error) {
      throw toSupportHttpError(error);
    }
  }

  @Get("cases/:caseId")
  async get(@Req() request: HttpRequestLike, @Param("caseId") caseId: string, @Headers("x-correlation-id") correlationId?: string) {
    try {
      return await this.cases.getCase(await authenticated(this.authenticator, request), caseId, operatorContext(request, correlationId));
    } catch (error) {
      throw toSupportHttpError(error);
    }
  }

  @Post("cases/:caseId/notes")
  @HttpCode(201)
  async note(
    @Req() request: HttpRequestLike,
    @Param("caseId") caseId: string,
    @Body() body: StatementBody = {},
    @Headers("x-correlation-id") correlationId?: string,
  ) {
    try {
      return await this.cases.addNote(await authenticated(this.authenticator, request), caseId,
        statementCommand(request, body), operatorContext(request, correlationId));
    } catch (error) {
      throw toSupportHttpError(error);
    }
  }

  @Post("cases/:caseId/resolution")
  @HttpCode(200)
  async resolve(
    @Req() request: HttpRequestLike,
    @Param("caseId") caseId: string,
    @Body() body: ResolutionBody = {},
    @Headers("x-correlation-id") correlationId?: string,
  ) {
    try {
      return await this.cases.resolve(await authenticated(this.authenticator, request), caseId, {
        expectedVersion: numberField(body.expectedVersion),
        ...(body.expectedBookingVersion === undefined ? {} : { expectedBookingVersion: numberField(body.expectedBookingVersion) }),
        outcome: body.outcome as string,
        reasonCode: body.reasonCode as string,
        ...(typeof body.paymentId === "string" ? { paymentId: body.paymentId } : {}),
        idempotencyKey: idempotencyKey(request, body.idempotencyKey),
      }, operatorContext(request, correlationId));
    } catch (error) {
      throw toSupportHttpError(error);
    }
  }
}

abstract class PartyDisputeCaseController {
  protected abstract readonly role: DisputePartyRole;
  constructor(
    private readonly authenticator: SupportSessionAuthenticator,
    private readonly cases: SupportCaseService,
  ) {}

  @Get("bookings/:bookingId/dispute-case")
  async get(@Req() request: HttpRequestLike, @Param("bookingId") bookingId: string) {
    try {
      return await this.cases.getPartyCase(await authenticated(this.authenticator, request), this.role, bookingId);
    } catch (error) {
      throw toSupportHttpError(error);
    }
  }

  @Post("bookings/:bookingId/dispute-case/statements")
  @HttpCode(201)
  async statement(
    @Req() request: HttpRequestLike,
    @Param("bookingId") bookingId: string,
    @Body() body: StatementBody = {},
    @Headers("x-correlation-id") correlationId?: string,
  ) {
    try {
      return await this.cases.addPartyStatement(await authenticated(this.authenticator, request), this.role, bookingId,
        statementCommand(request, body), requestContext(request, correlationId));
    } catch (error) {
      throw toSupportHttpError(error);
    }
  }
}

/** The booking Farmer's view of their dispute: status, outcome, timeline, and statements. */
@Controller("farmer")
export class FarmerDisputeCaseController extends PartyDisputeCaseController {
  protected readonly role = "FARMER" as const;
  constructor(
    @Inject(SUPPORT_AUTHENTICATOR) authenticator: SupportSessionAuthenticator,
    @Inject(SUPPORT_CASE_SERVICE) cases: SupportCaseService,
  ) {
    super(authenticator, cases);
  }
}

/** The assigned Owner's view of a dispute on their booking. */
@Controller("owner")
export class OwnerDisputeCaseController extends PartyDisputeCaseController {
  protected readonly role = "OWNER" as const;
  constructor(
    @Inject(SUPPORT_AUTHENTICATOR) authenticator: SupportSessionAuthenticator,
    @Inject(SUPPORT_CASE_SERVICE) cases: SupportCaseService,
  ) {
    super(authenticator, cases);
  }
}
