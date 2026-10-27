import type { AuthPrincipal } from "@kisantractor/domain";
import { describe, expect, it } from "vitest";

import type {
  DiscoverySessionAuthenticator,
  DiscoveryStore,
  NormalizedDiscoveryQuery,
} from "./discovery.contracts.js";
import { FarmerDiscoveryController } from "./discovery.controller.js";
import { DiscoveryService } from "./discovery.service.js";

class TestAuthenticator implements DiscoverySessionAuthenticator {
  credentials: string[] = [];

  async authenticateAccessCredential(accessCredential: string): Promise<AuthPrincipal> {
    this.credentials.push(accessCredential);
    return { userId: "farmer-1", sessionId: "session-1", roles: ["FARMER"] };
  }
}

class EmptyStore implements DiscoveryStore {
  queries: NormalizedDiscoveryQuery[] = [];

  async search(query: NormalizedDiscoveryQuery) {
    this.queries.push(query);
    return [];
  }
}

/** Validates: Requirements 7.2, 7.4, 7.6, 18.3 */
describe("FarmerDiscoveryController API", () => {
  it("authenticates the Farmer and converts wire dates without using profile location", async () => {
    const authenticator = new TestAuthenticator();
    const store = new EmptyStore();
    const controller = new FarmerDiscoveryController(
      authenticator,
      new DiscoveryService(
        store,
        new Uint8Array(32).fill(4),
        undefined,
        () => new Date("2025-03-01T10:00:00.000Z"),
      ),
    );

    const result = await controller.search(
      { headers: { authorization: "Bearer access-token" } },
      {
        serviceLocation: {
          state: "Tamil Nadu",
          district: "Thanjavur",
          mandalOrTaluk: "Thanjavur",
          village: "Recipient Farm",
          source: "SAVED_LOCATION",
          latitude: 10.787,
          longitude: 79.1378,
          capturedAt: "2025-03-01T09:00:00.000Z",
        },
        serviceId: "30000000-0000-4000-8000-000000000001",
        requestedInterval: {
          start: "2025-03-02T03:00:00.000Z",
          end: "2025-03-02T06:00:00.000Z",
        },
      },
    );

    expect(authenticator.credentials).toEqual(["access-token"]);
    expect(store.queries[0]).toMatchObject({
      serviceLocation: {
        village: "Recipient Farm",
        latitude: 10.787,
        longitude: 79.1378,
        collectionPurpose: "SERVICE_LOCATION",
      },
      requestedInterval: {
        start: new Date("2025-03-02T03:00:00.000Z"),
        end: new Date("2025-03-02T06:00:00.000Z"),
      },
    });
    expect(result.origin).toEqual({ state: "Tamil Nadu", district: "Thanjavur" });
  });

  it("rejects requests without a bearer credential before querying discovery", async () => {
    const store = new EmptyStore();
    const controller = new FarmerDiscoveryController(
      new TestAuthenticator(),
      new DiscoveryService(store, new Uint8Array(32).fill(4)),
    );

    await expect(controller.search(
      { headers: {} },
      {
        serviceLocation: {
          state: "Tamil Nadu",
          district: "Thanjavur",
          mandalOrTaluk: "Thanjavur",
          village: "Farm",
          source: "MANUAL_ADDRESS",
          latitude: 10.787,
          longitude: 79.1378,
          capturedAt: "2025-03-01T09:00:00.000Z",
        },
        serviceId: "30000000-0000-4000-8000-000000000001",
        requestedInterval: {
          start: "2025-03-02T03:00:00.000Z",
          end: "2025-03-02T06:00:00.000Z",
        },
      },
    )).rejects.toMatchObject({ status: 401, response: { code: "UNAUTHENTICATED" } });
    expect(store.queries).toHaveLength(0);
  });
});
