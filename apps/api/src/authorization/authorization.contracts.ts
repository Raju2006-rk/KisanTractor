import type {
  AuthorizationAction,
  AuthorizationResource,
  BookingAuthorizationResource,
  DocumentAuthorizationResource,
  TractorAuthorizationResource,
  AuthPrincipal,
} from "@kisantractor/domain";

export type AuthorizationResourceKind = AuthorizationResource["kind"];

export interface AuthorizationStore {
  findBookingResource(id: string): Promise<BookingAuthorizationResource | undefined>;
  findTractorResource(id: string): Promise<TractorAuthorizationResource | undefined>;
  findDocumentResource(id: string): Promise<DocumentAuthorizationResource | undefined>;
}

export interface SupportAccessRequest {
  readonly principal: AuthPrincipal;
  readonly action: AuthorizationAction;
  readonly resource: AuthorizationResource;
  /** Request correlation id, so a policy that audits its decisions can link them to the request. */
  readonly correlationId?: string;
}

/** Implementations must match an explicit, unexpired grant for the exact request. */
export interface SupportAccessPolicy {
  hasExplicitAccess(request: SupportAccessRequest): Promise<boolean>;
}

export class DenyAllSupportAccessPolicy implements SupportAccessPolicy {
  async hasExplicitAccess(_request: SupportAccessRequest): Promise<boolean> {
    return false;
  }
}
