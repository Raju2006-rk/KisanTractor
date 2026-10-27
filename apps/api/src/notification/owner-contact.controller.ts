import { randomUUID } from "node:crypto";

import type { AuthPrincipal } from "@kisantractor/domain";
import { Controller, Get, Header, Headers, HttpException, Inject, Param, Req } from "@nestjs/common";

import { AuthenticationRejectedError } from "../identity/identity.service.js";
import { OwnerContactNotFoundError, OwnerContactService, type OwnerContactView } from "./owner-contact.service.js";

export const OWNER_CONTACT_AUTHENTICATOR = Symbol("OWNER_CONTACT_AUTHENTICATOR");
export const OWNER_CONTACT_SERVICE = Symbol("OWNER_CONTACT_SERVICE");

export interface OwnerContactSessionAuthenticator {
  authenticateAccessCredential(credential: string): Promise<AuthPrincipal>;
}

interface HttpRequestLike {
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
}

const header = (request: HttpRequestLike, name: string): string | undefined => {
  const value = request.headers[name];
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === "string" && first.trim().length > 0 ? first.trim() : undefined;
};

/**
 * The booking Farmer's view of the Owner's contact. Responses are `no-store`, so no shared or
 * browser cache keeps a number after consent is withdrawn.
 */
@Controller("farmer/bookings/:bookingId/owner-contact")
export class FarmerOwnerContactController {
  constructor(
    @Inject(OWNER_CONTACT_AUTHENTICATOR) private readonly authenticator: OwnerContactSessionAuthenticator,
    @Inject(OWNER_CONTACT_SERVICE) private readonly contacts: OwnerContactService,
  ) {}

  @Get()
  @Header("Cache-Control", "no-store")
  async show(
    @Req() request: HttpRequestLike,
    @Param("bookingId") bookingId: string,
    @Headers("x-correlation-id") correlationId?: string,
  ): Promise<OwnerContactView> {
    try {
      const match = /^Bearer\s+(.+)$/iu.exec(header(request, "authorization") ?? "");
      if (!match?.[1]) throw new HttpException({ code: "UNAUTHENTICATED" }, 401);
      const principal = await this.authenticator.authenticateAccessCredential(match[1]);
      const channel = header(request, "x-client-channel");
      return await this.contacts.farmerView({ ...principal, roles: principal.roles.filter((role) => role === "FARMER") },
        bookingId.trim(), {
          correlationId: correlationId?.trim() || randomUUID(),
          actorChannel: channel === "PWA" || channel === "MOBILE" ? channel : "WEB",
        });
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if (error instanceof AuthenticationRejectedError) throw new HttpException({ code: "UNAUTHENTICATED" }, 401);
      if (error instanceof OwnerContactNotFoundError) throw new HttpException({ code: "NOT_FOUND" }, 404);
      throw error;
    }
  }
}
