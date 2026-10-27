import { randomUUID } from "node:crypto";

import {
  CatalogValidationError,
  LocationValidationError,
  PricingEstimateError,
  type AuthPrincipal,
  type EquipmentInput,
  type EquipmentUpdateInput,
  type HourlyRoundingPolicy,
  type OwnerProfileInput,
  type PricingMethod,
  type PricingRuleInput,
  type ServiceOfferingInput,
  type TractorInput,
  type TractorOperationalStatus,
  type TractorUpdateInput,
} from "@kisantractor/domain";
import { CapabilityUnavailableError } from "@kisantractor/providers";
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpException,
  Inject,
  Param,
  Post,
  Put,
  Req,
} from "@nestjs/common";

import { databaseErrorCode, isIdentifier, UNIQUE_VIOLATION } from "../http-identifiers.js";
import { AuthenticationRejectedError } from "../identity/identity.service.js";
import type { CatalogRequestContext } from "./catalog.contracts.js";
import {
  CatalogAuthorizationError,
  CatalogAvailabilityRejectedError,
  CatalogConflictError,
  CatalogNotFoundError,
  OwnerCatalogService,
} from "./catalog.service.js";

export const CATALOG_AUTHENTICATOR = Symbol("CATALOG_AUTHENTICATOR");
export const OWNER_CATALOG_SERVICE = Symbol("OWNER_CATALOG_SERVICE");

export interface CatalogSessionAuthenticator {
  authenticateAccessCredential(accessCredential: string): Promise<AuthPrincipal>;
}

interface HttpRequestLike {
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
}

interface OwnerProfileBody extends Omit<OwnerProfileInput, "operatingLocation"> {
  readonly operatingLocation: Omit<OwnerProfileInput["operatingLocation"], "capturedAt" | "consentedAt"> & {
    readonly capturedAt: string;
    readonly consentedAt?: string;
  };
  readonly expectedVersion?: number;
}

interface TractorBody extends Omit<TractorInput, "operatingLocation" | "photos"> {
  readonly operatingLocation: OwnerProfileBody["operatingLocation"];
  readonly photos?: TractorInput["photos"];
  readonly expectedVersion?: number;
}

interface AvailabilityBody {
  readonly status: TractorOperationalStatus;
  readonly expectedVersion?: number;
  readonly reason?: string;
}

interface EquipmentBody extends EquipmentInput {
  readonly expectedVersion?: number;
}

interface EquipmentAssignmentBody {
  readonly tractorId?: string | null;
  readonly expectedVersion?: number;
}

interface ServiceOfferingBody extends ServiceOfferingInput {
  readonly expectedVersion?: number;
}

interface FarmerQuoteBody {
  readonly pricingRuleId: string;
  readonly estimatedQuantity: number | string;
}

interface PricingRuleBody {
  readonly method: PricingMethod;
  readonly ratePaise: number;
  readonly roundingPolicy?: HourlyRoundingPolicy;
  readonly enabled: boolean;
  readonly expectedVersion?: number;
}

const NOT_FOUND = (): HttpException => new HttpException({ code: "NOT_FOUND" }, 404);

const bearerCredential = (request: HttpRequestLike): string => {
  const header = request.headers.authorization;
  const value = Array.isArray(header) ? header[0] : header;
  const match = typeof value === "string" ? /^Bearer\s+(.+)$/iu.exec(value.trim()) : null;
  if (!match?.[1]) throw new HttpException({ code: "UNAUTHENTICATED" }, 401);
  return match[1];
};

/** Path identifiers that are not well formed name no resource the caller can see. */
const pathId = (value: string): string => {
  if (!isIdentifier(value)) throw NOT_FOUND();
  return value.trim();
};

/** Optional body identifiers must be well formed when present. */
const bodyId = <Value>(value: Value, field: string): Value => {
  if (value !== undefined && value !== null && !isIdentifier(value)) {
    throw new CatalogValidationError(field, `${field} must be a valid identifier`);
  }
  return value;
};

const requireObject = <Body>(body: Body | undefined): Body => {
  if (typeof body !== "object" || body === null) {
    throw new CatalogValidationError("body", "A JSON object body is required");
  }
  return body;
};

/**
 * Maps catalog failures to stable machine codes. Missing and unrelated resources share one 404;
 * malformed input is a 422; driver and internal details never reach the response.
 */
export function toCatalogHttpError(error: unknown): unknown {
  if (error instanceof HttpException) return error;
  if (error instanceof AuthenticationRejectedError) return new HttpException({ code: "UNAUTHENTICATED" }, 401);
  if (error instanceof CatalogAuthorizationError || error instanceof CatalogNotFoundError) return NOT_FOUND();
  if (error instanceof CatalogValidationError || error instanceof LocationValidationError) {
    return new HttpException({ code: error.code, field: error.field, message: error.message }, 422);
  }
  if (error instanceof PricingEstimateError) return new HttpException({ code: error.code, message: error.message }, 422);
  if (error instanceof CatalogAvailabilityRejectedError) {
    return new HttpException({
      code: error.code, reasonCodes: error.reasonCodes, evaluation: error.evaluation,
      scheduleConflict: error.scheduleConflict, message: error.message,
    }, 409);
  }
  if (error instanceof CatalogConflictError) return new HttpException({ code: error.code, message: error.message }, 409);
  if (error instanceof CapabilityUnavailableError) {
    return new HttpException({ code: error.code, capability: error.capability, state: error.state, retryable: error.retryable }, 503);
  }
  // A duplicate registration (or other unique identity) never reveals who already holds it.
  if (databaseErrorCode(error) === UNIQUE_VIOLATION) {
    return new HttpException({ code: "CATALOG_CONFLICT", message: "This record conflicts with an existing registration" }, 409);
  }
  // Request-shape failures surface from validation as TypeErrors (missing or mistyped fields).
  if (error instanceof TypeError) {
    return new HttpException({ code: "CATALOG_VALIDATION_FAILED", message: "The request is missing or has invalid fields" }, 422);
  }
  return error;
}

const run = async <Result>(work: () => Promise<Result>): Promise<Result> => {
  try {
    return await work();
  } catch (error) {
    throw toCatalogHttpError(error);
  }
};

const contextFromRequest = (
  request: HttpRequestLike,
  correlationId: string | undefined,
): CatalogRequestContext => {
  const requestedChannel = request.headers["x-client-channel"];
  const value = Array.isArray(requestedChannel) ? requestedChannel[0] : requestedChannel;
  const actorChannel = value === "PWA" || value === "MOBILE" ? value : "WEB";
  return {
    correlationId: correlationId?.trim() || randomUUID(),
    actorChannel,
  };
};

const locationFromBody = (location: OwnerProfileBody["operatingLocation"]): OwnerProfileInput["operatingLocation"] => {
  if (typeof location !== "object" || location === null) {
    throw new LocationValidationError("operatingLocation", "An operating location is required");
  }
  const { capturedAt, consentedAt, ...fields } = location;
  return {
    ...fields,
    capturedAt: new Date(capturedAt),
    ...(consentedAt === undefined ? {} : { consentedAt: new Date(consentedAt) }),
  };
};

@Controller("owner")
export class OwnerCatalogController {
  constructor(
    @Inject(CATALOG_AUTHENTICATOR)
    private readonly authenticator: CatalogSessionAuthenticator,
    @Inject(OWNER_CATALOG_SERVICE)
    private readonly catalog: OwnerCatalogService,
  ) {}

  @Get("profile")
  getProfile(@Req() request: HttpRequestLike) {
    return run(async () => this.catalog.getOwnerProfile(await this.#principal(request)));
  }

  @Put("profile")
  putProfile(
    @Req() request: HttpRequestLike,
    @Body() body: OwnerProfileBody,
    @Headers("x-correlation-id") correlationId?: string,
  ) {
    return run(async () => {
      const principal = await this.#principal(request);
      const input = requireObject(body);
      return this.catalog.registerOrUpdateOwnerProfile(
        principal,
        {
          fullName: input.fullName,
          preferredLocale: input.preferredLocale,
          contactSharingConsent: input.contactSharingConsent,
          operatingLocation: locationFromBody(input.operatingLocation),
        },
        contextFromRequest(request, correlationId),
        input.expectedVersion,
      );
    });
  }

  @Get("tractors")
  listTractors(@Req() request: HttpRequestLike) {
    return run(async () => this.catalog.listTractors(await this.#principal(request)));
  }

  @Post("tractors")
  postTractor(
    @Req() request: HttpRequestLike,
    @Body() body: TractorBody,
    @Headers("x-correlation-id") correlationId?: string,
  ) {
    return run(async () => {
      const principal = await this.#principal(request);
      return this.catalog.addTractor(
        principal,
        this.#tractorInput(requireObject(body), true) as TractorInput,
        contextFromRequest(request, correlationId),
      );
    });
  }

  @Get("tractors/:tractorId")
  getTractor(
    @Req() request: HttpRequestLike,
    @Param("tractorId") tractorId: string,
  ) {
    return run(async () => {
      const principal = await this.#principal(request);
      return this.catalog.getTractor(principal, pathId(tractorId));
    });
  }

  @Put("tractors/:tractorId")
  putTractor(
    @Req() request: HttpRequestLike,
    @Param("tractorId") tractorId: string,
    @Body() body: TractorBody,
    @Headers("x-correlation-id") correlationId?: string,
  ) {
    return run(async () => {
      const principal = await this.#principal(request);
      const id = pathId(tractorId);
      const input = requireObject(body);
      return this.catalog.updateTractor(
        principal,
        id,
        this.#tractorInput(input, false),
        input.expectedVersion ?? 0,
        contextFromRequest(request, correlationId),
      );
    });
  }

  @Get("tractors/:tractorId/availability")
  getTractorAvailability(
    @Req() request: HttpRequestLike,
    @Param("tractorId") tractorId: string,
  ) {
    return run(async () => {
      const principal = await this.#principal(request);
      return this.catalog.getTractorAvailability(principal, pathId(tractorId));
    });
  }

  @Put("tractors/:tractorId/availability")
  putTractorAvailability(
    @Req() request: HttpRequestLike,
    @Param("tractorId") tractorId: string,
    @Body() body: AvailabilityBody,
    @Headers("x-correlation-id") correlationId?: string,
  ) {
    return run(async () => {
      const principal = await this.#principal(request);
      const id = pathId(tractorId);
      const input = requireObject(body);
      return this.catalog.setTractorOperationalStatus(
        principal,
        id,
        input.status,
        input.expectedVersion ?? 0,
        contextFromRequest(request, correlationId),
        input.reason,
      );
    });
  }

  @Get("equipment")
  listEquipment(@Req() request: HttpRequestLike) {
    return run(async () => this.catalog.listEquipment(await this.#principal(request)));
  }

  @Post("equipment")
  postEquipment(
    @Req() request: HttpRequestLike,
    @Body() body: EquipmentBody,
    @Headers("x-correlation-id") correlationId?: string,
  ) {
    return run(async () => {
      const principal = await this.#principal(request);
      const input = requireObject(body);
      bodyId(input.equipmentTypeId, "equipmentTypeId");
      bodyId(input.tractorId, "tractorId");
      return this.catalog.addEquipment(principal, input, contextFromRequest(request, correlationId));
    });
  }

  @Put("equipment/:equipmentId")
  putEquipment(
    @Req() request: HttpRequestLike,
    @Param("equipmentId") equipmentId: string,
    @Body() body: EquipmentBody,
    @Headers("x-correlation-id") correlationId?: string,
  ) {
    return run(async () => {
      const principal = await this.#principal(request);
      const id = pathId(equipmentId);
      const source = requireObject(body);
      const input: EquipmentUpdateInput = {
        displayName: source.displayName,
        availabilityStatus: source.availabilityStatus ?? "AVAILABLE",
      };
      return this.catalog.updateEquipment(
        principal,
        id,
        input,
        source.expectedVersion ?? 0,
        contextFromRequest(request, correlationId),
      );
    });
  }

  @Put("equipment/:equipmentId/assignment")
  putEquipmentAssignment(
    @Req() request: HttpRequestLike,
    @Param("equipmentId") equipmentId: string,
    @Body() body: EquipmentAssignmentBody,
    @Headers("x-correlation-id") correlationId?: string,
  ) {
    return run(async () => {
      const principal = await this.#principal(request);
      const id = pathId(equipmentId);
      const input = requireObject(body);
      return this.catalog.assignEquipment(
        principal,
        id,
        bodyId(input.tractorId, "tractorId") ?? undefined,
        input.expectedVersion ?? 0,
        contextFromRequest(request, correlationId),
      );
    });
  }

  @Get("tractors/:tractorId/service-offerings")
  listServiceOfferings(
    @Req() request: HttpRequestLike,
    @Param("tractorId") tractorId: string,
  ) {
    return run(async () => {
      const principal = await this.#principal(request);
      return this.catalog.listServiceOfferings(principal, pathId(tractorId));
    });
  }

  @Put("tractors/:tractorId/service-offerings")
  putServiceOffering(
    @Req() request: HttpRequestLike,
    @Param("tractorId") tractorId: string,
    @Body() body: ServiceOfferingBody,
    @Headers("x-correlation-id") correlationId?: string,
  ) {
    return run(async () => {
      const principal = await this.#principal(request);
      const id = pathId(tractorId);
      const input = requireObject(body);
      bodyId(input.serviceId, "serviceId");
      bodyId(input.equipmentId, "equipmentId");
      return this.catalog.configureServiceOffering(
        principal,
        id,
        input,
        contextFromRequest(request, correlationId),
        input.expectedVersion,
      );
    });
  }

  @Get("service-offerings/:serviceOfferingId/pricing-rules")
  listPricingRules(
    @Req() request: HttpRequestLike,
    @Param("serviceOfferingId") serviceOfferingId: string,
  ) {
    return run(async () => {
      const principal = await this.#principal(request);
      return this.catalog.listPricingRules(principal, pathId(serviceOfferingId));
    });
  }

  @Put("service-offerings/:serviceOfferingId/pricing-rules")
  putPricingRule(
    @Req() request: HttpRequestLike,
    @Param("serviceOfferingId") serviceOfferingId: string,
    @Body() body: PricingRuleBody,
    @Headers("x-correlation-id") correlationId?: string,
  ) {
    return run(async () => {
      const principal = await this.#principal(request);
      const id = pathId(serviceOfferingId);
      const source = requireObject(body);
      const input: PricingRuleInput = source.method === "HOURLY"
        ? {
            method: source.method,
            ratePaise: source.ratePaise,
            roundingPolicy: source.roundingPolicy as HourlyRoundingPolicy,
            enabled: source.enabled,
          }
        : {
            method: source.method,
            ratePaise: source.ratePaise,
            enabled: source.enabled,
          };
      return this.catalog.configurePricingRule(
        principal,
        id,
        input,
        contextFromRequest(request, correlationId),
        source.expectedVersion,
      );
    });
  }

  @Post("tractors/:tractorId/eligibility/evaluate")
  postEligibilityEvaluation(
    @Req() request: HttpRequestLike,
    @Param("tractorId") tractorId: string,
    @Headers("x-correlation-id") correlationId?: string,
  ) {
    return run(async () => {
      const principal = await this.#principal(request);
      return this.catalog.evaluateEligibility(
        principal,
        pathId(tractorId),
        contextFromRequest(request, correlationId),
      );
    });
  }

  async #principal(request: HttpRequestLike): Promise<AuthPrincipal> {
    return this.authenticator.authenticateAccessCredential(bearerCredential(request));
  }

  #tractorInput(body: TractorBody, creating: boolean): TractorUpdateInput {
    return {
      brand: body.brand,
      model: body.model,
      registrationNumber: body.registrationNumber,
      manufacturingYear: body.manufacturingYear,
      ...(body.horsepower === undefined ? {} : { horsepower: body.horsepower }),
      operatingLocation: locationFromBody(body.operatingLocation),
      ...((creating || body.photos !== undefined) ? { photos: body.photos ?? [] } : {}),
    };
  }
}

@Controller("farmer")
export class FarmerPricingController {
  constructor(
    @Inject(CATALOG_AUTHENTICATOR)
    private readonly authenticator: CatalogSessionAuthenticator,
    @Inject(OWNER_CATALOG_SERVICE)
    private readonly catalog: OwnerCatalogService,
  ) {}

  @Get("service-offerings/:serviceOfferingId/pricing-rules")
  listActivePricingRules(
    @Req() request: HttpRequestLike,
    @Param("serviceOfferingId") serviceOfferingId: string,
  ) {
    return run(async () => {
      const principal = await this.#principal(request);
      return this.catalog.listActivePricingRules(principal, pathId(serviceOfferingId));
    });
  }

  @Post("service-offerings/:serviceOfferingId/quote-snapshots")
  postQuoteSnapshot(
    @Req() request: HttpRequestLike,
    @Param("serviceOfferingId") serviceOfferingId: string,
    @Body() body: FarmerQuoteBody,
  ) {
    return run(async () => {
      const principal = await this.#principal(request);
      const id = pathId(serviceOfferingId);
      const input = requireObject(body);
      if (!isIdentifier(input.pricingRuleId)) {
        throw new CatalogValidationError("pricingRuleId", "pricingRuleId must be a valid identifier");
      }
      return this.catalog.createFarmerQuoteSnapshot(principal, id, input.pricingRuleId.trim(), input.estimatedQuantity);
    });
  }

  async #principal(request: HttpRequestLike): Promise<AuthPrincipal> {
    return this.authenticator.authenticateAccessCredential(bearerCredential(request));
  }
}
