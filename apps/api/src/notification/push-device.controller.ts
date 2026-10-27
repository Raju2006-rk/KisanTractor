import type { AuthPrincipal } from "@kisantractor/domain";
import { Body, Controller, Delete, Header, HttpCode, HttpException, Inject, Put, Req } from "@nestjs/common";

import { AuthenticationRejectedError } from "../identity/identity.service.js";
import { PushDeviceService, PushDeviceValidationError, PushUnavailableError } from "./push-device.service.js";

export const PUSH_DEVICE_AUTHENTICATOR = Symbol("PUSH_DEVICE_AUTHENTICATOR");
export const PUSH_DEVICE_SERVICE = Symbol("PUSH_DEVICE_SERVICE");

export interface PushDeviceSessionAuthenticator {
  authenticateAccessCredential(credential: string): Promise<AuthPrincipal>;
}

interface HttpRequestLike {
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
}

const bearerCredential = (request: HttpRequestLike): string => {
  const value = request.headers.authorization;
  const first = Array.isArray(value) ? value[0] : value;
  const match = /^Bearer\s+(.+)$/iu.exec(typeof first === "string" ? first.trim() : "");
  if (!match?.[1]) throw new HttpException({ code: "UNAUTHENTICATED" }, 401);
  return match[1];
};

const toHttpError = (error: unknown): unknown => {
  if (error instanceof HttpException) return error;
  if (error instanceof AuthenticationRejectedError) return new HttpException({ code: "UNAUTHENTICATED" }, 401);
  if (error instanceof PushDeviceValidationError) {
    return new HttpException({ code: error.code, field: error.field, message: error.message }, 422);
  }
  if (error instanceof PushUnavailableError) {
    return new HttpException({ code: error.code, capability: "MESSAGING", message: error.message }, 503);
  }
  return error;
};

/** Self-service push-device registration; responses never echo the token. */
@Controller("account/push-devices")
export class PushDeviceController {
  constructor(
    @Inject(PUSH_DEVICE_AUTHENTICATOR) private readonly authenticator: PushDeviceSessionAuthenticator,
    @Inject(PUSH_DEVICE_SERVICE) private readonly devices: PushDeviceService,
  ) {}

  @Put()
  @HttpCode(204)
  @Header("Cache-Control", "no-store")
  async register(@Req() request: HttpRequestLike, @Body() body: Readonly<{ token?: unknown; platform?: unknown }> = {}): Promise<void> {
    try {
      const principal = await this.authenticator.authenticateAccessCredential(bearerCredential(request));
      await this.devices.register(principal, body ?? {});
    } catch (error) {
      throw toHttpError(error);
    }
  }

  @Delete()
  @HttpCode(204)
  @Header("Cache-Control", "no-store")
  async unregister(@Req() request: HttpRequestLike, @Body() body: Readonly<{ token?: unknown }> = {}): Promise<void> {
    try {
      const principal = await this.authenticator.authenticateAccessCredential(bearerCredential(request));
      await this.devices.unregister(principal, body ?? {});
    } catch (error) {
      throw toHttpError(error);
    }
  }
}
