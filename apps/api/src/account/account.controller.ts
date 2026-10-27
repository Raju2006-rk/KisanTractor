import { randomUUID } from "node:crypto";

import type { AuditActorChannel } from "@kisantractor/database";
import type { AuthPrincipal } from "@kisantractor/domain";
import { Body, Controller, Header, Headers, HttpCode, HttpException, Inject, Post, Req } from "@nestjs/common";

import { AuthenticationRejectedError } from "../identity/identity.service.js";
import {
  AccountDeletionConfirmationError,
  AccountDeletionService,
  AccountHasOpenBookingsError,
  AccountNotActiveError,
} from "./account-deletion.service.js";

export const ACCOUNT_AUTHENTICATOR = Symbol("ACCOUNT_AUTHENTICATOR");
export const ACCOUNT_DELETION_SERVICE = Symbol("ACCOUNT_DELETION_SERVICE");

export interface AccountSessionAuthenticator {
  authenticateAccessCredential(credential: string): Promise<AuthPrincipal>;
}

interface HttpRequestLike {
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
}

interface AccountDeletionBody {
  readonly confirmation?: unknown;
}

const header = (request: HttpRequestLike, name: string): string | undefined => {
  const value = request.headers[name];
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === "string" && first.trim().length > 0 ? first.trim() : undefined;
};

const actorChannel = (request: HttpRequestLike): AuditActorChannel => {
  const channel = header(request, "x-client-channel");
  return channel === "PWA" || channel === "MOBILE" ? channel : "WEB";
};

const bearerCredential = (request: HttpRequestLike): string => {
  const match = /^Bearer\s+(.+)$/iu.exec(header(request, "authorization") ?? "");
  if (!match?.[1]) throw new HttpException({ code: "UNAUTHENTICATED" }, 401);
  return match[1];
};

/** Maps account-deletion failures to stable machine codes; responses never carry personal data. */
export function toAccountHttpError(error: unknown): unknown {
  if (error instanceof HttpException) return error;
  if (error instanceof AuthenticationRejectedError) return new HttpException({ code: "UNAUTHENTICATED" }, 401);
  if (error instanceof AccountDeletionConfirmationError) {
    return new HttpException({ code: error.code, field: "confirmation", message: error.message }, 422);
  }
  if (error instanceof AccountHasOpenBookingsError) {
    return new HttpException({ code: error.code, openBookings: error.openBookings, message: error.message }, 409);
  }
  // A session for a deleted or suspended account should not exist; answer as unauthenticated.
  if (error instanceof AccountNotActiveError) return new HttpException({ code: "UNAUTHENTICATED" }, 401);
  return error;
}

/**
 * Self-service account deletion (Requirement 12.5). The account holder confirms with a fixed
 * phrase; personal data is erased or anonymized while bookings, invoices, payments, and audit
 * records are retained. Every session of the account ends in the same transaction.
 */
@Controller("account")
export class AccountController {
  constructor(
    @Inject(ACCOUNT_AUTHENTICATOR) private readonly authenticator: AccountSessionAuthenticator,
    @Inject(ACCOUNT_DELETION_SERVICE) private readonly deletion: AccountDeletionService,
  ) {}

  @Post("deletion")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  async deleteAccount(
    @Req() request: HttpRequestLike,
    @Body() body: AccountDeletionBody = {},
    @Headers("x-correlation-id") correlationId?: string,
  ) {
    try {
      const principal = await this.authenticator.authenticateAccessCredential(bearerCredential(request));
      const result = await this.deletion.deleteOwnAccount({
        principal,
        confirmation: body?.confirmation,
        actorChannel: actorChannel(request),
        correlationId: correlationId?.trim() || randomUUID(),
      });
      return {
        status: result.status,
        erasedAt: result.erasedAt.toISOString(),
        erased: result.erased,
        retained: result.retained,
      };
    } catch (error) {
      throw toAccountHttpError(error);
    }
  }
}
