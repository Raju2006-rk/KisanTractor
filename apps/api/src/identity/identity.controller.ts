import { randomUUID } from "node:crypto";

import { otpPurposes, type OtpPurpose } from "@kisantractor/domain";
import { CapabilityUnavailableError } from "@kisantractor/providers";
import { Body, Controller, Get, Header, Headers, HttpCode, HttpException, Inject, Post, Req } from "@nestjs/common";

import type { RequestContext } from "./identity.contracts.js";
import { AuthenticationRejectedError, IdentityService } from "./identity.service.js";

export const IDENTITY_SERVICE_TOKEN = Symbol("IDENTITY_SERVICE_TOKEN");

interface HttpRequestLike {
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly ip?: string;
  readonly socket?: Readonly<{ remoteAddress?: string }>;
}

interface OtpChallengeBody {
  readonly phone?: unknown;
  readonly purpose?: unknown;
}

interface OtpVerifyBody extends OtpChallengeBody {
  readonly challengeId?: unknown;
  readonly code?: unknown;
}

interface RefreshBody {
  readonly refreshCredential?: unknown;
}

interface RevokeBody {
  readonly reason?: unknown;
}

const header = (request: HttpRequestLike, name: string): string | undefined => {
  const value = request.headers[name];
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === "string" && first.trim().length > 0 ? first.trim() : undefined;
};

/**
 * The requester fingerprint feeds only the hashed per-requester OTP throttle; it is never stored
 * in plaintext. It combines the transport address with the user agent.
 */
const requestContext = (request: HttpRequestLike, correlationId: string | undefined): RequestContext => {
  const channel = header(request, "x-client-channel");
  const address = request.ip ?? request.socket?.remoteAddress ?? "unknown-address";
  return {
    correlationId: correlationId?.trim() || randomUUID(),
    requesterFingerprint: `${address}|${header(request, "user-agent") ?? "unknown-agent"}`,
    actorChannel: channel === "PWA" || channel === "MOBILE" ? channel : "WEB",
  };
};

const bearerCredential = (request: HttpRequestLike): string => {
  const match = /^Bearer\s+(.+)$/iu.exec(header(request, "authorization") ?? "");
  if (!match?.[1]) throw new HttpException({ code: "UNAUTHENTICATED" }, 401);
  return match[1];
};

const requiredText = (value: unknown, field: string, maximum = 200): string => {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum) {
    throw new HttpException({ code: "IDENTITY_VALIDATION_FAILED", field }, 422);
  }
  return value.trim();
};

const purpose = (value: unknown): OtpPurpose => {
  if (typeof value !== "string" || !(otpPurposes as readonly string[]).includes(value)) {
    throw new HttpException({ code: "IDENTITY_VALIDATION_FAILED", field: "purpose" }, 422);
  }
  return value as OtpPurpose;
};

/** Maps identity failures to enumeration-resistant responses. */
export function toIdentityHttpError(error: unknown): unknown {
  if (error instanceof HttpException) return error;
  if (error instanceof AuthenticationRejectedError) {
    return new HttpException({ code: error.code, message: error.message }, 401);
  }
  if (error instanceof CapabilityUnavailableError) {
    return new HttpException({
      code: error.code,
      capability: error.capability,
      state: error.state,
      retryable: error.retryable,
    }, 503);
  }
  return error;
}

/**
 * OTP sign-in and session endpoints. Responses never reveal whether a phone has an account; a
 * development code is returned only by the explicitly labelled local/test OTP adapter.
 */
@Controller("identity")
export class IdentityController {
  constructor(@Inject(IDENTITY_SERVICE_TOKEN) private readonly identity: IdentityService) {}

  @Post("otp/challenges")
  @Header("Cache-Control", "no-store")
  async requestOtp(
    @Req() request: HttpRequestLike,
    @Body() body: OtpChallengeBody = {},
    @Headers("x-correlation-id") correlationId?: string,
  ) {
    try {
      return await this.identity.requestOtp(
        requiredText(body.phone, "phone", 32),
        purpose(body.purpose),
        requestContext(request, correlationId),
      );
    } catch (error) {
      throw toIdentityHttpError(error);
    }
  }

  @Post("otp/verify")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  async verifyOtp(
    @Req() request: HttpRequestLike,
    @Body() body: OtpVerifyBody = {},
    @Headers("x-correlation-id") correlationId?: string,
  ) {
    try {
      return await this.identity.verifyOtp({
        challengeId: requiredText(body.challengeId, "challengeId"),
        phone: requiredText(body.phone, "phone", 32),
        purpose: purpose(body.purpose),
        code: requiredText(body.code, "code", 16),
        context: requestContext(request, correlationId),
      });
    } catch (error) {
      throw toIdentityHttpError(error);
    }
  }

  @Get("session")
  @Header("Cache-Control", "no-store")
  async session(@Req() request: HttpRequestLike) {
    try {
      return { principal: await this.identity.authenticateAccessCredential(bearerCredential(request)) };
    } catch (error) {
      throw toIdentityHttpError(error);
    }
  }

  @Post("session/refresh")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  async refresh(
    @Req() request: HttpRequestLike,
    @Body() body: RefreshBody = {},
    @Headers("x-correlation-id") correlationId?: string,
  ) {
    try {
      return await this.identity.refreshSession(
        requiredText(body.refreshCredential, "refreshCredential", 512),
        requestContext(request, correlationId),
      );
    } catch (error) {
      throw toIdentityHttpError(error);
    }
  }

  @Post("session/revoke")
  @HttpCode(204)
  async revoke(
    @Req() request: HttpRequestLike,
    @Body() body: RevokeBody = {},
    @Headers("x-correlation-id") correlationId?: string,
  ): Promise<void> {
    try {
      const principal = await this.identity.authenticateAccessCredential(bearerCredential(request));
      await this.identity.revokeSession(
        principal,
        typeof body.reason === "string" ? body.reason.slice(0, 100) : "USER_REQUESTED",
        requestContext(request, correlationId),
      );
    } catch (error) {
      throw toIdentityHttpError(error);
    }
  }
}
