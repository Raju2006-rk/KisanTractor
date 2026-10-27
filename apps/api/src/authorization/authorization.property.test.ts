import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  userRoles,
  type AuthPrincipal,
  type BookingAuthorizationResource,
  type DocumentAuthorizationResource,
  type PublicTractorProjectionSource,
  type TractorAuthorizationResource,
  type UserRole,
} from "@kisantractor/domain";

import type {
  AuthorizationStore,
  SupportAccessPolicy,
} from "./authorization.contracts.js";
import {
  AuthorizationDeniedError,
  AuthorizationService,
} from "./authorization.service.js";

const propertyRuns = 250;
const seeds = {
  roleIsolation: 2_304_506,
  redaction: 3_405_122,
} as const;

type GeneratedResource =
  | {
      readonly action: "booking:read" | "booking:command";
      readonly resource: BookingAuthorizationResource;
    }
  | {
      readonly action: "tractor:read" | "tractor:command";
      readonly resource: TractorAuthorizationResource;
    }
  | {
      readonly action: "document:read" | "document:command";
      readonly resource: DocumentAuthorizationResource;
    };

class GeneratedAuthorizationStore implements AuthorizationStore {
  constructor(
    private readonly booking: BookingAuthorizationResource,
    private readonly tractor: TractorAuthorizationResource,
    private readonly document: DocumentAuthorizationResource,
  ) {}

  async findBookingResource(id: string) {
    return id === this.booking.id ? this.booking : undefined;
  }

  async findTractorResource(id: string) {
    return id === this.tractor.id ? this.tractor : undefined;
  }

  async findDocumentResource(id: string) {
    return id === this.document.id ? this.document : undefined;
  }
}

const roleMembershipsArbitrary = fc.uniqueArray(
  fc.constantFrom<UserRole>(...userRoles),
  { maxLength: userRoles.length },
);

const ownershipGraphArbitrary = fc
  .uniqueArray(fc.integer({ min: 0, max: 1_000_000 }), {
    minLength: 5,
    maxLength: 5,
  })
  .map(([customer, owner, unrelated, operator, resourceSuffix]) => ({
    customerId: `user-${customer}`,
    ownerId: `user-${owner}`,
    unrelatedId: `user-${unrelated}`,
    operatorId: `user-${operator}`,
    booking: {
      kind: "BOOKING" as const,
      id: `booking-${resourceSuffix}`,
      customerId: `user-${customer}`,
      ownerId: `user-${owner}`,
    },
    tractor: {
      kind: "TRACTOR" as const,
      id: `tractor-${resourceSuffix}`,
      ownerId: `user-${owner}`,
    },
    document: {
      kind: "DOCUMENT" as const,
      id: `document-${resourceSuffix}`,
      ownerId: `user-${owner}`,
      tractorId: `tractor-${resourceSuffix}`,
    },
  }));

const generatedAuthorizationCaseArbitrary = ownershipGraphArbitrary.chain(
  (graph) => {
    const resourceArbitrary: fc.Arbitrary<GeneratedResource> = fc.oneof(
      fc.record({
        action: fc.constantFrom<"booking:read" | "booking:command">(
          "booking:read",
          "booking:command",
        ),
        resource: fc.constant(graph.booking),
      }),
      fc.record({
        action: fc.constantFrom<"tractor:read" | "tractor:command">(
          "tractor:read",
          "tractor:command",
        ),
        resource: fc.constant(graph.tractor),
      }),
      fc.record({
        action: fc.constantFrom<"document:read" | "document:command">(
          "document:read",
          "document:command",
        ),
        resource: fc.constant(graph.document),
      }),
    );

    return fc.record({
      graph: fc.constant(graph),
      principal: fc.record({
        userId: fc.constantFrom(
          graph.customerId,
          graph.ownerId,
          graph.unrelatedId,
          graph.operatorId,
        ),
        sessionId: fc.integer({ min: 0, max: 1_000_000 }).map(
          (value) => `session-${value}`,
        ),
        roles: roleMembershipsArbitrary,
      }),
      target: resourceArbitrary,
      explicitSupportGrant: fc.boolean(),
    });
  },
);

function hasExplicitAuthorization(
  principal: AuthPrincipal,
  target: GeneratedResource,
  explicitSupportGrant: boolean,
): boolean {
  if (
    explicitSupportGrant &&
    principal.roles.includes("FUTURE_OPERATOR")
  ) {
    return true;
  }

  if (target.resource.kind === "BOOKING") {
    return (
      (principal.roles.includes("FARMER") &&
        principal.userId === target.resource.customerId) ||
      (principal.roles.includes("OWNER") &&
        principal.userId === target.resource.ownerId)
    );
  }

  return (
    principal.roles.includes("OWNER") &&
    principal.userId === target.resource.ownerId
  );
}

function dispatchOperation(
  service: AuthorizationService,
  principal: AuthPrincipal,
  target: GeneratedResource,
  operation: () => Promise<string>,
): Promise<string> {
  switch (target.action) {
    case "booking:read":
      return service.queryBooking(principal, target.resource.id, operation);
    case "booking:command":
      return service.commandBooking(principal, target.resource.id, operation);
    case "tractor:read":
      return service.queryTractor(principal, target.resource.id, operation);
    case "tractor:command":
      return service.commandTractor(principal, target.resource.id, operation);
    case "document:read":
      return service.queryPrivateDocument(
        principal,
        target.resource.id,
        operation,
      );
    case "document:command":
      return service.commandPrivateDocument(
        principal,
        target.resource.id,
        operation,
      );
  }
}

function runSeededProperty(
  name: string,
  seed: number,
  assertion: () => void | Promise<void>,
): Promise<void> {
  return Promise.resolve()
    .then(assertion)
    .then(() => {
      console.info(
        `[PBT] ${name}: seed=${seed} runs=${propertyRuns} minimizedCounterexample=none`,
      );
    })
    .catch((error: unknown) => {
      console.error(
        `[PBT] ${name}: seed=${seed} minimizedCounterexample=reported by fast-check below`,
      );
      throw error;
    });
}

const safeTextArbitrary = fc.string({ minLength: 1, maxLength: 32 });
const pricingMethodArbitrary = fc.constantFrom<
  "HOURLY" | "PER_ACRE" | "PER_TRIP"
>("HOURLY", "PER_ACRE", "PER_TRIP");

const privateProjectionCaseArbitrary = fc
  .tuple(fc.uuid(), fc.uuid())
  .filter(([ownerId, viewerId]) => ownerId !== viewerId)
  .chain(([ownerId, viewerId]) =>
    fc.record({
      viewer: fc.option(
        fc.record({
          userId: fc.constant(viewerId),
          sessionId: fc.uuid().map((id) => `session-${id}`),
          roles: roleMembershipsArbitrary,
        }),
        { nil: undefined },
      ),
      ownerId: fc.constant(ownerId),
      secretMarker: fc.uuid().map((id) => `protected-${id}`),
      id: fc.uuid().map((id) => `tractor-${id}`),
      brand: safeTextArbitrary,
      model: safeTextArbitrary,
      state: safeTextArbitrary,
      district: safeTextArbitrary,
      approximateDistanceKilometers: fc.option(
        fc.double({ min: 0, max: 5_000, noNaN: true, noDefaultInfinity: true }),
        { nil: undefined },
      ),
      ownerDisplayName: safeTextArbitrary,
      ownerNamePublic: fc.boolean(),
      serviceNames: fc.array(safeTextArbitrary, { maxLength: 4 }),
      pricingMethods: fc.uniqueArray(pricingMethodArbitrary, { maxLength: 3 }),
      available: fc.boolean(),
      latitude: fc.double({ min: -90, max: 90, noNaN: true, noDefaultInfinity: true }),
      longitude: fc.double({ min: -180, max: 180, noNaN: true, noDefaultInfinity: true }),
    }),
  );

function collectObjectKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (value === null || typeof value !== "object") return keys;
  for (const [key, nestedValue] of Object.entries(value)) {
    keys.add(key);
    collectObjectKeys(nestedValue, keys);
  }
  return keys;
}

describe("Property 1: Role Isolation", () => {
  /** Validates: Requirements 2.3, 2.4, 2.5, 2.6, 4.5 */
  it("denies generated principals without role/ownership grants before operations can mutate state", async () => {
    const seed = seeds.roleIsolation;

    await runSeededProperty("role-isolation-no-mutation", seed, async () => {
      await fc.assert(
        fc.asyncProperty(
          generatedAuthorizationCaseArbitrary.filter(
            ({ principal, target, explicitSupportGrant }) =>
              !hasExplicitAuthorization(
                principal,
                target,
                explicitSupportGrant,
              ),
          ),
          async ({ graph, principal, target, explicitSupportGrant }) => {
            const store = new GeneratedAuthorizationStore(
              graph.booking,
              graph.tractor,
              graph.document,
            );
            const supportPolicy: SupportAccessPolicy = {
              async hasExplicitAccess(request) {
                return (
                  explicitSupportGrant &&
                  request.principal.userId === principal.userId &&
                  request.action === target.action &&
                  request.resource.id === target.resource.id
                );
              },
            };
            const service = new AuthorizationService(store, supportPolicy);
            const persistentState = {
              revision: 7,
              audit: ["existing-event"],
              values: { status: "UNCHANGED" },
            };
            const before = structuredClone(persistentState);
            let operationCalls = 0;
            const mutatingOperation = async () => {
              operationCalls += 1;
              persistentState.revision += 1;
              persistentState.audit.push("unauthorized-event");
              persistentState.values.status = "MUTATED";
              return "mutated";
            };

            await expect(
              dispatchOperation(
                service,
                principal,
                target,
                mutatingOperation,
              ),
            ).rejects.toBeInstanceOf(AuthorizationDeniedError);
            expect(operationCalls).toBe(0);
            expect(persistentState).toEqual(before);
          },
        ),
        { seed, numRuns: propertyRuns, verbose: 2 },
      );
    });
  });
});

describe("Property 18: Redaction", () => {
  /** Validates: Requirements 3.4, 4.5, 12.2 */
  it("never leaks protected fields to anonymous or unrelated public viewers", async () => {
    const seed = seeds.redaction;

    await runSeededProperty("public-projection-redaction", seed, () => {
      fc.assert(
        fc.property(privateProjectionCaseArbitrary, (generated) => {
          expect(generated.viewer?.userId).not.toBe(generated.ownerId);

          const source: PublicTractorProjectionSource = {
            id: generated.id,
            brand: generated.brand,
            model: generated.model,
            state: generated.state,
            district: generated.district,
            ...(generated.approximateDistanceKilometers === undefined
              ? {}
              : {
                  approximateDistanceKilometers:
                    generated.approximateDistanceKilometers,
                }),
            ownerDisplayName: generated.ownerDisplayName,
            ownerNamePublic: generated.ownerNamePublic,
            serviceNames: generated.serviceNames,
            pricingMethods: generated.pricingMethods,
            available: generated.available,
            privateFields: {
              ownerPhone: `+91-${generated.secretMarker}`,
              exactCoordinates: {
                latitude: generated.latitude,
                longitude: generated.longitude,
              },
              registrationNumber: `registration-${generated.secretMarker}`,
              documentObjectKeys: [
                `private/${generated.secretMarker}/document.pdf`,
              ],
              otpMaterial: { code: `otp-${generated.secretMarker}` },
              paymentProviderPayload: {
                token: `payment-${generated.secretMarker}`,
              },
            },
          };
          const service = new AuthorizationService(
            new GeneratedAuthorizationStore(
              {
                kind: "BOOKING",
                id: "unused-booking",
                customerId: "unused-farmer",
                ownerId: generated.ownerId,
              },
              {
                kind: "TRACTOR",
                id: generated.id,
                ownerId: generated.ownerId,
              },
              {
                kind: "DOCUMENT",
                id: "unused-document",
                ownerId: generated.ownerId,
              },
            ),
          );
          const projection = service.publicTractor(source);
          const serialized = JSON.stringify(projection);
          const projectedKeys = collectObjectKeys(projection);

          expect(projectedKeys).not.toContain("privateFields");
          expect(projectedKeys).not.toContain("ownerPhone");
          expect(projectedKeys).not.toContain("exactCoordinates");
          expect(projectedKeys).not.toContain("registrationNumber");
          expect(projectedKeys).not.toContain("documentObjectKeys");
          expect(projectedKeys).not.toContain("otpMaterial");
          expect(projectedKeys).not.toContain("paymentProviderPayload");
          expect(serialized).not.toContain(generated.secretMarker);
          expect(projection.approximateLocation).toEqual({
            state: generated.state,
            district: generated.district,
          });

          if (generated.ownerNamePublic) {
            expect(projection.ownerDisplayName).toBe(
              generated.ownerDisplayName,
            );
          } else {
            expect(projection).not.toHaveProperty("ownerDisplayName");
          }
        }),
        { seed, numRuns: propertyRuns, verbose: 2 },
      );
    });
  });
});
