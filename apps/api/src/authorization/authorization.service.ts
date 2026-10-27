import {
  authorize,
  projectPublicTractor,
  type AuthorizationAction,
  type AuthorizationResource,
  type AuthPrincipal,
  type BookingAuthorizationResource,
  type DocumentAuthorizationResource,
  type PublicTractorProjection,
  type PublicTractorProjectionSource,
  type TractorAuthorizationResource,
} from "@kisantractor/domain";

import {
  DenyAllSupportAccessPolicy,
  type AuthorizationStore,
  type SupportAccessPolicy,
} from "./authorization.contracts.js";

export class AuthorizationDeniedError extends Error {
  readonly code = "AUTHORIZATION_DENIED";

  constructor() {
    super("You are not authorized to access this resource");
    this.name = "AuthorizationDeniedError";
  }
}

type AuthorizedOperation<Resource extends AuthorizationResource, Result> = (
  resource: Resource,
) => Promise<Result>;

/**
 * Server application boundary for resource queries and commands. Callers pass
 * their operation as a callback, which is never invoked until authorization
 * succeeds, preventing denied commands from mutating persistent state.
 */
export class AuthorizationService {
  constructor(
    private readonly store: AuthorizationStore,
    private readonly supportAccess: SupportAccessPolicy =
      new DenyAllSupportAccessPolicy(),
  ) {}

  queryBooking<Result>(
    principal: AuthPrincipal,
    bookingId: string,
    query: AuthorizedOperation<BookingAuthorizationResource, Result>,
  ): Promise<Result> {
    return this.#bookingOperation(principal, bookingId, "booking:read", query);
  }

  commandBooking<Result>(
    principal: AuthPrincipal,
    bookingId: string,
    command: AuthorizedOperation<BookingAuthorizationResource, Result>,
  ): Promise<Result> {
    return this.#bookingOperation(principal, bookingId, "booking:command", command);
  }

  queryTractor<Result>(
    principal: AuthPrincipal,
    tractorId: string,
    query: AuthorizedOperation<TractorAuthorizationResource, Result>,
  ): Promise<Result> {
    return this.#tractorOperation(principal, tractorId, "tractor:read", query);
  }

  commandTractor<Result>(
    principal: AuthPrincipal,
    tractorId: string,
    command: AuthorizedOperation<TractorAuthorizationResource, Result>,
  ): Promise<Result> {
    return this.#tractorOperation(principal, tractorId, "tractor:command", command);
  }

  queryPrivateDocument<Result>(
    principal: AuthPrincipal,
    documentId: string,
    query: AuthorizedOperation<DocumentAuthorizationResource, Result>,
  ): Promise<Result> {
    return this.#documentOperation(principal, documentId, "document:read", query);
  }

  commandPrivateDocument<Result>(
    principal: AuthPrincipal,
    documentId: string,
    command: AuthorizedOperation<DocumentAuthorizationResource, Result>,
  ): Promise<Result> {
    return this.#documentOperation(principal, documentId, "document:command", command);
  }

  publicTractor(source: PublicTractorProjectionSource): PublicTractorProjection {
    return projectPublicTractor(source);
  }

  async #bookingOperation<Result>(
    principal: AuthPrincipal,
    id: string,
    action: "booking:read" | "booking:command",
    operation: AuthorizedOperation<BookingAuthorizationResource, Result>,
  ): Promise<Result> {
    this.#assertIdentifier(id);
    const resource = await this.store.findBookingResource(id);
    return this.#execute(principal, action, resource, operation);
  }

  async #tractorOperation<Result>(
    principal: AuthPrincipal,
    id: string,
    action: "tractor:read" | "tractor:command",
    operation: AuthorizedOperation<TractorAuthorizationResource, Result>,
  ): Promise<Result> {
    this.#assertIdentifier(id);
    const resource = await this.store.findTractorResource(id);
    return this.#execute(principal, action, resource, operation);
  }

  async #documentOperation<Result>(
    principal: AuthPrincipal,
    id: string,
    action: "document:read" | "document:command",
    operation: AuthorizedOperation<DocumentAuthorizationResource, Result>,
  ): Promise<Result> {
    this.#assertIdentifier(id);
    const resource = await this.store.findDocumentResource(id);
    return this.#execute(principal, action, resource, operation);
  }

  async #execute<Resource extends AuthorizationResource, Result>(
    principal: AuthPrincipal,
    action: AuthorizationAction,
    resource: Resource | undefined,
    operation: AuthorizedOperation<Resource, Result>,
  ): Promise<Result> {
    // Missing and forbidden resources intentionally produce the same response.
    if (resource === undefined) throw new AuthorizationDeniedError();

    const explicitSupportAccess = await this.supportAccess.hasExplicitAccess({
      principal,
      action,
      resource,
    });
    const decision = authorize(
      principal,
      action,
      resource,
      explicitSupportAccess,
    );
    if (!decision.allowed) throw new AuthorizationDeniedError();

    return operation(resource);
  }

  #assertIdentifier(id: string): void {
    if (id.trim().length === 0) throw new AuthorizationDeniedError();
  }
}
