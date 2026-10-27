import { describe, expect, it, vi } from "vitest";

import type {
  AuthPrincipal,
  BookingAuthorizationResource,
  DocumentAuthorizationResource,
  TractorAuthorizationResource,
} from "@kisantractor/domain";

import type {
  AuthorizationStore,
  SupportAccessPolicy,
} from "./authorization.contracts.js";
import {
  AuthorizationDeniedError,
  AuthorizationService,
} from "./authorization.service.js";

const farmer: AuthPrincipal = {
  userId: "farmer-1",
  sessionId: "session-farmer",
  roles: ["FARMER"],
};
const owner: AuthPrincipal = {
  userId: "owner-1",
  sessionId: "session-owner",
  roles: ["OWNER"],
};
const unrelatedOwner: AuthPrincipal = {
  userId: "owner-2",
  sessionId: "session-other-owner",
  roles: ["OWNER"],
};
const operator: AuthPrincipal = {
  userId: "operator-1",
  sessionId: "session-operator",
  roles: ["FUTURE_OPERATOR"],
};

const booking: BookingAuthorizationResource = {
  kind: "BOOKING",
  id: "booking-1",
  customerId: farmer.userId,
  ownerId: owner.userId,
};
const tractor: TractorAuthorizationResource = {
  kind: "TRACTOR",
  id: "tractor-1",
  ownerId: owner.userId,
};
const document: DocumentAuthorizationResource = {
  kind: "DOCUMENT",
  id: "document-1",
  ownerId: owner.userId,
  tractorId: tractor.id,
};

class MemoryAuthorizationStore implements AuthorizationStore {
  async findBookingResource(id: string) {
    return id === booking.id ? booking : undefined;
  }

  async findTractorResource(id: string) {
    return id === tractor.id ? tractor : undefined;
  }

  async findDocumentResource(id: string) {
    return id === document.id ? document : undefined;
  }
}

describe("AuthorizationService", () => {
  it("enforces Farmer ownership for booking queries and commands", async () => {
    const service = new AuthorizationService(new MemoryAuthorizationStore());
    const query = vi.fn(async () => "booking-view");
    const command = vi.fn(async () => "cancelled");

    await expect(service.queryBooking(farmer, booking.id, query)).resolves.toBe("booking-view");
    await expect(service.commandBooking(farmer, booking.id, command)).resolves.toBe("cancelled");
    expect(query).toHaveBeenCalledWith(booking);
    expect(command).toHaveBeenCalledWith(booking);
  });

  it("enforces assigned Owner access for booking queries and commands", async () => {
    const service = new AuthorizationService(new MemoryAuthorizationStore());
    const assignedQuery = vi.fn(async () => "assigned");
    const deniedCommand = vi.fn(async () => "mutated");

    await expect(service.queryBooking(owner, booking.id, assignedQuery)).resolves.toBe("assigned");
    await expect(
      service.commandBooking(unrelatedOwner, booking.id, deniedCommand),
    ).rejects.toBeInstanceOf(AuthorizationDeniedError);
    expect(deniedCommand).not.toHaveBeenCalled();
  });

  it("prevents cross-Owner Tractor commands before mutation", async () => {
    const service = new AuthorizationService(new MemoryAuthorizationStore());
    const ownerCommand = vi.fn(async () => "offline");
    const deniedCommand = vi.fn(async () => "online");

    await expect(service.commandTractor(owner, tractor.id, ownerCommand)).resolves.toBe("offline");
    await expect(
      service.commandTractor(unrelatedOwner, tractor.id, deniedCommand),
    ).rejects.toBeInstanceOf(AuthorizationDeniedError);
    expect(deniedCommand).not.toHaveBeenCalled();
  });

  it("authorizes private document access before issuing a grant", async () => {
    const service = new AuthorizationService(new MemoryAuthorizationStore());
    const issueGrant = vi.fn(async () => ({ expiresInSeconds: 60 }));
    const deniedGrant = vi.fn(async () => ({ expiresInSeconds: 60 }));

    await expect(
      service.queryPrivateDocument(owner, document.id, issueGrant),
    ).resolves.toEqual({ expiresInSeconds: 60 });
    await expect(
      service.queryPrivateDocument(unrelatedOwner, document.id, deniedGrant),
    ).rejects.toBeInstanceOf(AuthorizationDeniedError);
    expect(deniedGrant).not.toHaveBeenCalled();
  });

  it("requires both FUTURE_OPERATOR membership and an exact explicit support grant", async () => {
    const support: SupportAccessPolicy = {
      hasExplicitAccess: vi.fn(async ({ principal, action, resource }) =>
        principal.userId === operator.userId &&
        action === "document:read" &&
        resource.kind === "DOCUMENT" &&
        resource.id === document.id,
      ),
    };
    const service = new AuthorizationService(new MemoryAuthorizationStore(), support);
    const documentQuery = vi.fn(async () => "short-lived-private-grant");
    const bookingQuery = vi.fn(async () => "booking");

    await expect(
      service.queryPrivateDocument(operator, document.id, documentQuery),
    ).resolves.toBe("short-lived-private-grant");
    await expect(
      service.queryBooking(operator, booking.id, bookingQuery),
    ).rejects.toBeInstanceOf(AuthorizationDeniedError);
    expect(bookingQuery).not.toHaveBeenCalled();
  });

  it("uses the same denial for missing and forbidden resources", async () => {
    const service = new AuthorizationService(new MemoryAuthorizationStore());
    const operation = vi.fn(async () => "must-not-run");

    const missing = service.queryBooking(farmer, "missing", operation);
    const forbidden = service.queryBooking(
      { ...farmer, userId: "farmer-2" },
      booking.id,
      operation,
    );

    await expect(missing).rejects.toMatchObject({ code: "AUTHORIZATION_DENIED" });
    await expect(forbidden).rejects.toMatchObject({ code: "AUTHORIZATION_DENIED" });
    expect(operation).not.toHaveBeenCalled();
  });

  it("serves public Tractor views only through the redacted projection", () => {
    const service = new AuthorizationService(new MemoryAuthorizationStore());
    const projection = service.publicTractor({
      id: tractor.id,
      brand: "Deutz-Fahr",
      model: "Agrolux",
      state: "Tamil Nadu",
      district: "Coimbatore",
      ownerDisplayName: "Private Owner",
      ownerNamePublic: false,
      serviceNames: ["Tilling"],
      pricingMethods: ["PER_ACRE"],
      available: true,
      privateFields: {
        ownerPhone: "+919999999999",
        exactCoordinates: { latitude: 11.0168, longitude: 76.9558 },
        documentObjectKeys: ["documents/private.pdf"],
        otpMaterial: "otp-secret",
        paymentProviderPayload: "provider-secret",
      },
    });

    expect(projection).not.toHaveProperty("privateFields");
    expect(projection).not.toHaveProperty("ownerDisplayName");
    expect(JSON.stringify(projection)).not.toMatch(/9999999999|11\.0168|private\.pdf|secret/u);
  });
});
