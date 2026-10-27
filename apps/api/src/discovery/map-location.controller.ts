import {
  locationCollectionPurposes,
  type LocationCollectionPurpose,
} from "@kisantractor/domain";
import { ProviderGatedMapsAdapter } from "@kisantractor/providers";
import { Body, Controller, HttpException, Inject, Post, Req } from "@nestjs/common";

import { AuthenticationRejectedError } from "../identity/identity.service.js";
import type { DiscoverySessionAuthenticator } from "./discovery.contracts.js";
import { DISCOVERY_AUTHENTICATOR } from "./discovery.controller.js";
import { DiscoveryAuthorizationError, DiscoveryValidationError } from "./discovery.service.js";

export const MAPS_ADAPTER = Symbol("MAPS_ADAPTER");

interface HttpRequestLike {
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
}

interface MapSearchBody {
  readonly query?: unknown;
  readonly collectionPurpose?: unknown;
}

interface MapPinBody {
  readonly latitude?: unknown;
  readonly longitude?: unknown;
  readonly collectionPurpose?: unknown;
}

const bearerCredential = (request: HttpRequestLike): string => {
  const header = request.headers.authorization;
  const value = Array.isArray(header) ? header[0] : header;
  const match = typeof value === "string" ? /^Bearer\s+(.+)$/iu.exec(value.trim()) : null;
  if (!match?.[1]) throw new HttpException({ code: "UNAUTHENTICATED" }, 401);
  return match[1];
};

const purposeOf = (value: unknown): LocationCollectionPurpose => {
  if (typeof value !== "string" || !locationCollectionPurposes.includes(value as LocationCollectionPurpose)) {
    throw new DiscoveryValidationError("collectionPurpose", "Select a valid location collection purpose");
  }
  return value as LocationCollectionPurpose;
};

const coordinate = (value: unknown, field: "latitude" | "longitude", minimum: number, maximum: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new DiscoveryValidationError(field, `${field} must be from ${minimum} to ${maximum}`);
  }
  return value;
};

const toMapHttpError = (error: unknown): unknown => {
  if (error instanceof HttpException) return error;
  if (error instanceof AuthenticationRejectedError) return new HttpException({ code: "UNAUTHENTICATED" }, 401);
  if (error instanceof DiscoveryAuthorizationError) return new HttpException({ code: "NOT_FOUND" }, 404);
  if (error instanceof DiscoveryValidationError || error instanceof TypeError) {
    return new HttpException({
      code: "DISCOVERY_VALIDATION_FAILED",
      ...(error instanceof DiscoveryValidationError ? { field: error.field } : {}),
      message: error.message,
    }, 422);
  }
  return error;
};

/**
 * Provider map enhancements produce only normalized Location values. Discovery and booking
 * continue to consume their existing contracts, so provider availability cannot change radius,
 * idempotency, or interval-reservation semantics.
 */
@Controller("locations")
export class MapLocationController {
  constructor(
    @Inject(DISCOVERY_AUTHENTICATOR)
    private readonly authenticator: DiscoverySessionAuthenticator,
    @Inject(MAPS_ADAPTER)
    private readonly maps: ProviderGatedMapsAdapter,
  ) {}

  @Post("map-search")
  async search(@Req() request: HttpRequestLike, @Body() body: MapSearchBody) {
    try {
      const principal = await this.authenticator.authenticateAccessCredential(bearerCredential(request));
      if (!principal.roles.includes("FARMER") && !principal.roles.includes("OWNER")) throw new DiscoveryAuthorizationError();
      if (typeof body?.query !== "string") {
        throw new DiscoveryValidationError("query", "Map search query is required");
      }
      return await this.maps.search(body.query, purposeOf(body.collectionPurpose));
    } catch (error) {
      throw toMapHttpError(error);
    }
  }

  @Post("map-pin")
  async resolvePin(@Req() request: HttpRequestLike, @Body() body: MapPinBody) {
    try {
      const principal = await this.authenticator.authenticateAccessCredential(bearerCredential(request));
      if (!principal.roles.includes("FARMER") && !principal.roles.includes("OWNER")) throw new DiscoveryAuthorizationError();
      return await this.maps.resolvePin({
        latitude: coordinate(body?.latitude, "latitude", -90, 90),
        longitude: coordinate(body?.longitude, "longitude", -180, 180),
      }, purposeOf(body?.collectionPurpose));
    } catch (error) {
      throw toMapHttpError(error);
    }
  }
}
