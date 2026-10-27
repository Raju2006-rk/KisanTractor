import { randomUUID } from "node:crypto";

import type { AuthPrincipal, WorkAction } from "@kisantractor/domain";
import { Body, Controller, Get, Headers, HttpException, Inject, Param, Post, Req } from "@nestjs/common";

import {
  BookingAuthorizationError,
  BookingConflictError,
  BookingService,
  BookingValidationError,
} from "../booking/booking.service.js";
import { isIdentifier } from "../http-identifiers.js";
import { AuthenticationRejectedError } from "../identity/identity.service.js";
import type { JobRequestContext, JobSessionAuthenticator } from "./job.contracts.js";
import {
  InvalidJobSequenceError,
  JobAuthorizationError,
  JobConflictError,
  JobService,
  JobValidationError,
} from "./job.service.js";

export const JOB_AUTHENTICATOR = Symbol("JOB_AUTHENTICATOR");
export const JOB_SERVICE = Symbol("JOB_SERVICE");
export const JOB_BOOKING_SERVICE = Symbol("JOB_BOOKING_SERVICE");

interface HttpRequestLike {
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
}

interface JobActionBody {
  readonly idempotencyKey?: string;
  readonly deviceObservedAt?: string;
  readonly completedQuantity?: number | string;
}

interface DisputeBody {
  readonly expectedVersion?: number;
  readonly reason?: string;
}

const actionsByPath: Readonly<Record<string, WorkAction>> = Object.freeze({
  start: "START",
  pause: "PAUSE",
  resume: "RESUME",
  complete: "COMPLETE",
});

const header = (request: HttpRequestLike, name: string): string | undefined => {
  const value = request.headers[name];
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === "string" && first.trim().length > 0 ? first.trim() : undefined;
};

const requestContext = (request: HttpRequestLike, correlationId: string | undefined): JobRequestContext => {
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

/** Maps domain failures to stable machine codes without exposing internal details. */
export function toJobHttpError(error: unknown): unknown {
  if (error instanceof HttpException) return error;
  if (error instanceof AuthenticationRejectedError) return new HttpException({ code: "UNAUTHENTICATED" }, 401);
  if (error instanceof InvalidJobSequenceError) {
    return new HttpException({
      code: error.code,
      message: error.message,
      currentState: error.currentState,
      validNextActions: error.validNextActions,
    }, 409);
  }
  if (error instanceof JobValidationError || error instanceof BookingValidationError) {
    return new HttpException({ code: error.code, field: error.field, message: error.message }, 422);
  }
  if (error instanceof JobConflictError || error instanceof BookingConflictError) {
    return new HttpException({ code: error.code, message: error.message }, 409);
  }
  if (error instanceof JobAuthorizationError || error instanceof BookingAuthorizationError) {
    // Unrelated principals receive the same response as a missing booking.
    return new HttpException({ code: "NOT_FOUND" }, 404);
  }
  if (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "OPTIMISTIC_CONCURRENCY_CONFLICT") {
    return new HttpException({ code: "BOOKING_CONFLICT", message: "The booking changed; refresh and retry" }, 409);
  }
  return error;
}

/** A malformed booking identifier names no booking the caller can see. */
const bookingPathId = (value: string): string => {
  if (!isIdentifier(value)) throw new HttpException({ code: "NOT_FOUND" }, 404);
  return value.trim();
};

const deviceInstant = (value: string | undefined): Date | undefined => {
  if (value === undefined || value.trim().length === 0) return undefined;
  return new Date(value);
};

@Controller("owner/bookings/:bookingId/job")
export class OwnerJobController {
  constructor(
    @Inject(JOB_AUTHENTICATOR) private readonly authenticator: JobSessionAuthenticator,
    @Inject(JOB_SERVICE) private readonly jobs: JobService,
  ) {}

  @Get()
  async session(
    @Req() request: HttpRequestLike,
    @Param("bookingId") bookingId: string,
    @Headers("x-correlation-id") correlationId?: string,
  ) {
    try {
      const principal = await this.authenticator.authenticateAccessCredential(bearerCredential(request));
      return await this.jobs.getWorkSession(principal, bookingPathId(bookingId), "OWNER", requestContext(request, correlationId));
    } catch (error) {
      throw toJobHttpError(error);
    }
  }

  @Post(":action")
  async act(
    @Req() request: HttpRequestLike,
    @Param("bookingId") bookingId: string,
    @Param("action") actionPath: string,
    @Body() body: JobActionBody = {},
    @Headers("x-correlation-id") correlationId?: string,
  ) {
    try {
      const action = actionsByPath[actionPath];
      if (action === undefined) throw new HttpException({ code: "NOT_FOUND" }, 404);
      const principal = await this.authenticator.authenticateAccessCredential(bearerCredential(request));
      const idempotencyKey = body.idempotencyKey ?? header(request, "idempotency-key");
      if (idempotencyKey === undefined) {
        throw new JobValidationError("idempotencyKey", "A stable idempotency key is required for job actions");
      }
      const deviceObservedAt = deviceInstant(body.deviceObservedAt);
      const command = {
        bookingId: bookingPathId(bookingId),
        idempotencyKey,
        ...(deviceObservedAt === undefined ? {} : { deviceObservedAt }),
      };
      const context = requestContext(request, correlationId);
      if (action === "START") return await this.jobs.startJob(principal, command, context);
      if (action === "PAUSE") return await this.jobs.pauseJob(principal, command, context);
      if (action === "RESUME") return await this.jobs.resumeJob(principal, command, context);
      return await this.jobs.completeJob(principal, {
        ...command,
        ...(body.completedQuantity === undefined ? {} : { completedQuantity: body.completedQuantity }),
      }, context);
    } catch (error) {
      throw toJobHttpError(error);
    }
  }
}

@Controller("farmer/bookings/:bookingId")
export class FarmerJobController {
  constructor(
    @Inject(JOB_AUTHENTICATOR) private readonly authenticator: JobSessionAuthenticator,
    @Inject(JOB_SERVICE) private readonly jobs: JobService,
    @Inject(JOB_BOOKING_SERVICE) private readonly bookings: BookingService,
  ) {}

  @Get("job")
  async session(
    @Req() request: HttpRequestLike,
    @Param("bookingId") bookingId: string,
    @Headers("x-correlation-id") correlationId?: string,
  ) {
    try {
      const principal = await this.authenticator.authenticateAccessCredential(bearerCredential(request));
      return await this.jobs.getWorkSession(principal, bookingPathId(bookingId), "FARMER", requestContext(request, correlationId));
    } catch (error) {
      throw toJobHttpError(error);
    }
  }

  /** Records the Farmer's bill dispute; the lifecycle then blocks settlement until review. */
  @Post("dispute")
  async dispute(
    @Req() request: HttpRequestLike,
    @Param("bookingId") bookingId: string,
    @Body() body: DisputeBody = {},
    @Headers("x-correlation-id") correlationId?: string,
  ) {
    try {
      const principal = await this.authenticator.authenticateAccessCredential(bearerCredential(request));
      if (!principal.roles.includes("FARMER")) throw new BookingAuthorizationError();
      // Act strictly as the booking Farmer even when the account also holds an Owner role.
      const farmer: AuthPrincipal = { ...principal, roles: ["FARMER"] };
      return await this.bookings.transitionLifecycle(farmer, {
        bookingId: bookingPathId(bookingId),
        expectedVersion: Number(body.expectedVersion),
        ...(body.reason === undefined ? {} : { reason: body.reason }),
      }, requestContext(request, correlationId), "DISPUTE");
    } catch (error) {
      throw toJobHttpError(error);
    }
  }
}
