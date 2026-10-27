import { LocationValidationError, type LocationInput, type PricingMethod } from "@kisantractor/domain";
import { Body, Controller, HttpException, Inject, Post, Req } from "@nestjs/common";

import { isIdentifier } from "../http-identifiers.js";
import { AuthenticationRejectedError } from "../identity/identity.service.js";
import type { DiscoverySearchInput, DiscoverySessionAuthenticator } from "./discovery.contracts.js";
import { DiscoveryAuthorizationError, DiscoveryService, DiscoveryValidationError } from "./discovery.service.js";

export const DISCOVERY_AUTHENTICATOR = Symbol("DISCOVERY_AUTHENTICATOR");
export const DISCOVERY_SERVICE = Symbol("DISCOVERY_SERVICE");

interface HttpRequestLike {
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
}

interface DiscoveryLocationBody extends Omit<LocationInput, "capturedAt" | "consentedAt"> {
  readonly capturedAt: string;
  readonly consentedAt?: string;
}

interface DiscoverySearchBody {
  readonly serviceLocation: DiscoveryLocationBody;
  readonly serviceId: string;
  readonly requestedInterval: Readonly<{ start: string; end: string }>;
  readonly radiusKilometers?: number;
  readonly equipmentTypeId?: string;
  readonly pricingMethod?: PricingMethod;
  readonly pageSize?: number;
  readonly cursor?: string;
}

const bearerCredential = (request: HttpRequestLike): string => {
  const header = request.headers.authorization;
  const value = Array.isArray(header) ? header[0] : header;
  const match = typeof value === "string" ? /^Bearer\s+(.+)$/iu.exec(value.trim()) : null;
  if (!match?.[1]) throw new HttpException({ code: "UNAUTHENTICATED" }, 401);
  return match[1];
};

const toInput = (body: DiscoverySearchBody | undefined): DiscoverySearchInput => {
  if (typeof body !== "object" || body === null) {
    throw new DiscoveryValidationError("body", "A JSON object body is required");
  }
  if (typeof body.serviceLocation !== "object" || body.serviceLocation === null) {
    throw new DiscoveryValidationError("serviceLocation", "A Service Location is required");
  }
  if (typeof body.requestedInterval !== "object" || body.requestedInterval === null) {
    throw new DiscoveryValidationError("requestedInterval", "A requested interval is required");
  }
  // Catalog identifiers are validated here so hostile input never reaches SQL.
  if (!isIdentifier(body.serviceId)) {
    throw new DiscoveryValidationError("serviceId", "serviceId must be a valid identifier");
  }
  if (body.equipmentTypeId !== undefined && !isIdentifier(body.equipmentTypeId)) {
    throw new DiscoveryValidationError("equipmentTypeId", "equipmentTypeId must be a valid identifier");
  }
  const { capturedAt, consentedAt, ...location } = body.serviceLocation;
  return {
    serviceLocation: {
      ...location,
      capturedAt: new Date(capturedAt),
      ...(consentedAt === undefined ? {} : { consentedAt: new Date(consentedAt) }),
    },
    serviceId: body.serviceId.trim(),
    requestedInterval: {
      start: new Date(body.requestedInterval.start),
      end: new Date(body.requestedInterval.end),
    },
    ...(body.radiusKilometers === undefined ? {} : { radiusKilometers: body.radiusKilometers }),
    ...(body.equipmentTypeId === undefined ? {} : { equipmentTypeId: body.equipmentTypeId.trim() }),
    ...(body.pricingMethod === undefined ? {} : { pricingMethod: body.pricingMethod }),
    ...(body.pageSize === undefined ? {} : { pageSize: body.pageSize }),
    ...(body.cursor === undefined ? {} : { cursor: body.cursor }),
  };
};

/** Maps discovery failures to stable machine codes without exposing internal details. */
export function toDiscoveryHttpError(error: unknown): unknown {
  if (error instanceof HttpException) return error;
  if (error instanceof AuthenticationRejectedError) return new HttpException({ code: "UNAUTHENTICATED" }, 401);
  if (error instanceof DiscoveryAuthorizationError) return new HttpException({ code: "NOT_FOUND" }, 404);
  if (error instanceof DiscoveryValidationError || error instanceof LocationValidationError) {
    return new HttpException({ code: error.code, field: error.field, message: error.message }, 422);
  }
  if (error instanceof TypeError) {
    return new HttpException({ code: "DISCOVERY_VALIDATION_FAILED", message: "The search has missing or invalid fields" }, 422);
  }
  return error;
}

@Controller("farmer/discovery")
export class FarmerDiscoveryController {
  constructor(
    @Inject(DISCOVERY_AUTHENTICATOR)
    private readonly authenticator: DiscoverySessionAuthenticator,
    @Inject(DISCOVERY_SERVICE)
    private readonly discovery: DiscoveryService,
  ) {}

  @Post("search")
  async search(@Req() request: HttpRequestLike, @Body() body: DiscoverySearchBody) {
    try {
      const principal = await this.authenticator.authenticateAccessCredential(bearerCredential(request));
      return await this.discovery.search(principal, toInput(body));
    } catch (error) {
      throw toDiscoveryHttpError(error);
    }
  }
}
