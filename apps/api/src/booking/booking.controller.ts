import { randomUUID } from "node:crypto";

import {
  InvalidIndianPhoneError,
  LocationValidationError,
  PricingEstimateError,
  type AuthPrincipal,
  type EstimatedPricingQuantity,
  type LocationInput,
  type PricingMethod,
} from "@kisantractor/domain";
import { Body, Controller, Get, Headers, HttpException, Inject, Param, Post, Query, Req } from "@nestjs/common";

import { AuthenticationRejectedError } from "../identity/identity.service.js";
import type { BookingRequestContext, BookingSessionAuthenticator, BookingTarget, RecipientInput } from "./booking.contracts.js";
import { BookingNotFoundError, BookingQueryService, BookingQueryValidationError } from "./booking-query.service.js";
import type { BookingViewerRole } from "./booking-query.contracts.js";
import {
  BookingAuthorizationError,
  BookingConflictError,
  BookingService,
  BookingValidationError,
} from "./booking.service.js";

export const BOOKING_AUTHENTICATOR = Symbol("BOOKING_AUTHENTICATOR");
export const BOOKING_COMMAND_SERVICE = Symbol("BOOKING_COMMAND_SERVICE");
export const BOOKING_QUERY_SERVICE = Symbol("BOOKING_QUERY_SERVICE");

interface HttpRequestLike {
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
}

interface LocationBody extends Omit<LocationInput, "capturedAt" | "consentedAt"> {
  readonly capturedAt: string;
  readonly consentedAt?: string;
}

interface CreateBookingBody {
  readonly bookingTarget?: BookingTarget;
  readonly tractorId?: string;
  readonly serviceOfferingId?: string;
  readonly pricingRuleId?: string;
  readonly pricingMethod?: PricingMethod;
  readonly expectedQuantity?: EstimatedPricingQuantity;
  readonly requestedInterval?: Readonly<{ start?: string; end?: string }>;
  readonly serviceLocation?: LocationBody;
  readonly recipient?: RecipientInput;
  readonly idempotencyKey?: string;
}

interface DecisionBody {
  readonly expectedVersion?: number | string;
  readonly reason?: string;
}

const header = (request: HttpRequestLike, name: string): string | undefined => {
  const value = request.headers[name];
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === "string" && first.trim().length > 0 ? first.trim() : undefined;
};

const requestContext = (request: HttpRequestLike, correlationId: string | undefined): BookingRequestContext => {
  const channel = header(request, "x-client-channel");
  return {
    correlationId: correlationId?.trim() || randomUUID(),
    actorChannel: channel === "PWA" || channel === "MOBILE" ? channel : "WEB",
  };
};

const bearerCredential = (request: HttpRequestLike): string => {
  const match = /^Bearer\s+(.+)$/iu.exec(header(request, "authorization") ?? "");
  if (!match?.[1]) throw new HttpException({ code: "UNAUTHENTICATED" }, 401);
  return match[1];
};

const requiredText = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new BookingValidationError(field, `${field} is required`);
  }
  return value;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** Identifiers are validated before they reach SQL so malformed input is a 422, not a driver error. */
const identifier = (value: unknown, field: string): string => {
  const text = requiredText(value, field).trim();
  if (!UUID_PATTERN.test(text)) throw new BookingValidationError(field, `${field} must be a valid identifier`);
  return text;
};

const instant = (value: unknown, field: string): Date => {
  const date = new Date(requiredText(value, field));
  if (Number.isNaN(date.getTime())) throw new BookingValidationError(field, `${field} must be a valid instant`);
  return date;
};

const toLocation = (body: LocationBody | undefined): LocationInput => {
  if (body === undefined || typeof body !== "object") {
    throw new BookingValidationError("serviceLocation", "A Service Location is required");
  }
  const { capturedAt, consentedAt, ...fields } = body;
  return {
    ...fields,
    capturedAt: instant(capturedAt, "serviceLocation.capturedAt"),
    ...(consentedAt === undefined ? {} : { consentedAt: instant(consentedAt, "serviceLocation.consentedAt") }),
  };
};

const expectedVersion = (value: unknown): number => {
  const parsed = typeof value === "string" && /^\d{1,9}$/u.test(value.trim()) ? Number(value) : value;
  return typeof parsed === "number" ? parsed : Number.NaN;
};

const pageLimit = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  return /^\d{1,3}$/u.test(value.trim()) ? Number(value) : Number.NaN;
};

/** Maps booking failures to stable machine codes; unrelated callers see the same 404 as a missing booking. */
export function toBookingHttpError(error: unknown): unknown {
  if (error instanceof HttpException) return error;
  if (error instanceof AuthenticationRejectedError) return new HttpException({ code: "UNAUTHENTICATED" }, 401);
  if (error instanceof BookingValidationError || error instanceof BookingQueryValidationError
    || error instanceof LocationValidationError) {
    return new HttpException({ code: error.code, field: error.field, message: error.message }, 422);
  }
  if (error instanceof PricingEstimateError || error instanceof InvalidIndianPhoneError) {
    return new HttpException({ code: error.code, message: error.message }, 422);
  }
  if (error instanceof BookingConflictError) {
    return new HttpException({ code: error.code, reason: error.reason, message: error.message }, 409);
  }
  if (error instanceof BookingAuthorizationError || error instanceof BookingNotFoundError) {
    return new HttpException({ code: "NOT_FOUND" }, 404);
  }
  if (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "OPTIMISTIC_CONCURRENCY_CONFLICT") {
    return new HttpException({ code: "BOOKING_CONFLICT", message: "The booking changed; refresh and retry" }, 409);
  }
  return error;
}

abstract class BookingReadController {
  protected abstract readonly viewerRole: BookingViewerRole;

  constructor(
    protected readonly authenticator: BookingSessionAuthenticator,
    protected readonly queries: BookingQueryService,
  ) {}

  /** Acts strictly in this controller's role even when the account also holds another one. */
  protected async rolePrincipal(request: HttpRequestLike): Promise<AuthPrincipal> {
    const principal = await this.authenticator.authenticateAccessCredential(bearerCredential(request));
    if (!principal.roles.includes(this.viewerRole)) throw new BookingNotFoundError();
    return { ...principal, roles: [this.viewerRole] };
  }

  protected async list(request: HttpRequestLike, limit: string | undefined, cursor: string | undefined, correlationId: string | undefined) {
    try {
      const principal = await this.rolePrincipal(request);
      const parsedLimit = pageLimit(limit);
      return await this.queries.listBookings(principal, this.viewerRole, {
        ...(parsedLimit === undefined ? {} : { limit: parsedLimit }),
        ...(cursor === undefined || cursor.trim().length === 0 ? {} : { cursor: cursor.trim() }),
      }, requestContext(request, correlationId));
    } catch (error) {
      throw toBookingHttpError(error);
    }
  }

  protected async detail(request: HttpRequestLike, bookingId: string, correlationId: string | undefined) {
    try {
      const principal = await this.rolePrincipal(request);
      return await this.queries.getBooking(principal, bookingId, this.viewerRole, requestContext(request, correlationId));
    } catch (error) {
      throw toBookingHttpError(error);
    }
  }
}

@Controller("farmer/bookings")
export class FarmerBookingController extends BookingReadController {
  protected readonly viewerRole = "FARMER" as const;

  constructor(
    @Inject(BOOKING_AUTHENTICATOR) authenticator: BookingSessionAuthenticator,
    @Inject(BOOKING_QUERY_SERVICE) queries: BookingQueryService,
    @Inject(BOOKING_COMMAND_SERVICE) private readonly bookings: BookingService,
  ) {
    super(authenticator, queries);
  }

  /** Creates a self or someone-else booking; an equivalent retry with the same key returns the same booking. */
  @Post()
  async create(
    @Req() request: HttpRequestLike,
    @Body() body: CreateBookingBody = {},
    @Headers("x-correlation-id") correlationId?: string,
  ) {
    try {
      const principal = await this.rolePrincipal(request);
      const idempotencyKey = header(request, "idempotency-key") ?? body.idempotencyKey;
      if (idempotencyKey === undefined) {
        throw new BookingValidationError("idempotencyKey", "A stable idempotency key is required to create a booking");
      }
      const context = requestContext(request, correlationId);
      const created = await this.bookings.createBooking(principal, {
        bookingTarget: body.bookingTarget as BookingTarget,
        tractorId: identifier(body.tractorId, "tractorId"),
        serviceOfferingId: identifier(body.serviceOfferingId, "serviceOfferingId"),
        pricingRuleId: identifier(body.pricingRuleId, "pricingRuleId"),
        pricingMethod: requiredText(body.pricingMethod, "pricingMethod") as PricingMethod,
        expectedQuantity: body.expectedQuantity ?? "",
        requestedInterval: {
          start: instant(body.requestedInterval?.start, "requestedInterval.start"),
          end: instant(body.requestedInterval?.end, "requestedInterval.end"),
        },
        serviceLocation: toLocation(body.serviceLocation),
        ...(body.recipient === undefined ? {} : { recipient: body.recipient }),
      }, idempotencyKey, context);
      return await this.queries.getBooking(principal, created.id, "FARMER", context);
    } catch (error) {
      throw toBookingHttpError(error);
    }
  }

  @Get()
  index(
    @Req() request: HttpRequestLike,
    @Query("limit") limit?: string,
    @Query("cursor") cursor?: string,
    @Headers("x-correlation-id") correlationId?: string,
  ) {
    return this.list(request, limit, cursor, correlationId);
  }

  @Get(":bookingId")
  show(
    @Req() request: HttpRequestLike,
    @Param("bookingId") bookingId: string,
    @Headers("x-correlation-id") correlationId?: string,
  ) {
    return this.detail(request, bookingId, correlationId);
  }
}

@Controller("owner/bookings")
export class OwnerBookingController extends BookingReadController {
  protected readonly viewerRole = "OWNER" as const;

  constructor(
    @Inject(BOOKING_AUTHENTICATOR) authenticator: BookingSessionAuthenticator,
    @Inject(BOOKING_QUERY_SERVICE) queries: BookingQueryService,
    @Inject(BOOKING_COMMAND_SERVICE) private readonly bookings: BookingService,
  ) {
    super(authenticator, queries);
  }

  @Get()
  index(
    @Req() request: HttpRequestLike,
    @Query("limit") limit?: string,
    @Query("cursor") cursor?: string,
    @Headers("x-correlation-id") correlationId?: string,
  ) {
    return this.list(request, limit, cursor, correlationId);
  }

  @Get(":bookingId")
  show(
    @Req() request: HttpRequestLike,
    @Param("bookingId") bookingId: string,
    @Headers("x-correlation-id") correlationId?: string,
  ) {
    return this.detail(request, bookingId, correlationId);
  }

  /** Accepts the request; the store atomically refuses an overlapping Blocking Booking. */
  @Post(":bookingId/accept")
  accept(
    @Req() request: HttpRequestLike,
    @Param("bookingId") bookingId: string,
    @Body() body: DecisionBody = {},
    @Headers("x-correlation-id") correlationId?: string,
  ) {
    return this.#decide(request, bookingId, body, correlationId, "ACCEPT");
  }

  @Post(":bookingId/reject")
  reject(
    @Req() request: HttpRequestLike,
    @Param("bookingId") bookingId: string,
    @Body() body: DecisionBody = {},
    @Headers("x-correlation-id") correlationId?: string,
  ) {
    return this.#decide(request, bookingId, body, correlationId, "REJECT");
  }

  async #decide(
    request: HttpRequestLike,
    bookingId: string,
    body: DecisionBody,
    correlationId: string | undefined,
    decision: "ACCEPT" | "REJECT",
  ) {
    try {
      const principal = await this.rolePrincipal(request);
      if (!UUID_PATTERN.test(bookingId.trim())) throw new BookingNotFoundError();
      const context = requestContext(request, correlationId);
      const command = {
        bookingId: bookingId.trim(),
        expectedVersion: expectedVersion(body.expectedVersion),
        ...(typeof body.reason === "string" ? { reason: body.reason } : {}),
      };
      const decided = decision === "ACCEPT"
        ? await this.bookings.acceptBooking(principal, command, context)
        : await this.bookings.rejectBooking(principal, command, context);
      return await this.queries.getBooking(principal, decided.id, "OWNER", context);
    } catch (error) {
      throw toBookingHttpError(error);
    }
  }
}
