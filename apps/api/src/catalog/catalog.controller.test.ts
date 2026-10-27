import type { AuthPrincipal, TractorEligibilityEvaluation } from "@kisantractor/domain";
import { describe, expect, it, vi } from "vitest";

import {
  type CatalogSessionAuthenticator,
  FarmerPricingController,
  OwnerCatalogController,
} from "./catalog.controller.js";
import {
  CatalogAuthorizationError,
  type OwnerCatalogService,
} from "./catalog.service.js";

const request = (credential: string, channel = "WEB") => ({
  headers: {
    authorization: `Bearer ${credential}`,
    "x-client-channel": channel,
  },
});

const principal = (userId: string): AuthPrincipal => ({
  userId,
  sessionId: `session-${userId}`,
  roles: ["OWNER"],
});

const farmerPrincipal = (userId: string): AuthPrincipal => ({
  userId,
  sessionId: `session-${userId}`,
  roles: ["FARMER"],
});

/** Validates: Requirements 4.1, 4.2, 4.3, 4.4 */
describe("OwnerCatalogController API", () => {
  it("converts onboarding location timestamps and preserves request context", async () => {
    const authenticateAccessCredential = vi.fn(async () => principal("owner-1"));
    const registerOrUpdateOwnerProfile = vi.fn(async (_principal, input) => input);
    const controller = new OwnerCatalogController(
      { authenticateAccessCredential } satisfies CatalogSessionAuthenticator,
      { registerOrUpdateOwnerProfile } as unknown as OwnerCatalogService,
    );

    await controller.putProfile(request("owner-token", "PWA"), {
      fullName: "Raju Naik",
      preferredLocale: "te",
      contactSharingConsent: false,
      operatingLocation: {
        state: "Telangana",
        district: "Warangal",
        mandalOrTaluk: "Geesugonda",
        village: "Vanchanagiri",
        source: "MANUAL_ADDRESS",
        capturedAt: "2025-01-01T00:00:00.000Z",
      },
    }, "corr-onboarding");

    expect(authenticateAccessCredential).toHaveBeenCalledWith("owner-token");
    expect(registerOrUpdateOwnerProfile).toHaveBeenCalledWith(
      principal("owner-1"),
      expect.objectContaining({
        fullName: "Raju Naik",
        operatingLocation: expect.objectContaining({
          capturedAt: new Date("2025-01-01T00:00:00.000Z"),
        }),
      }),
      { correlationId: "corr-onboarding", actorChannel: "PWA" },
      undefined,
    );
  });

  it("returns explicit unmet eligibility reasons for an incomplete Tractor", async () => {
    const evaluation: TractorEligibilityEvaluation = {
      tractorId: "60000000-0000-4000-8000-000000000001",
      status: "INCOMPLETE",
      discoverable: false,
      reasons: [
        {
          code: "REQUIRED_DOCUMENTS_MISSING",
          message: "Required Tractor documents are missing",
          missingDocumentKinds: ["REGISTRATION_CERTIFICATE"],
        },
        {
          code: "ACTIVE_SERVICE_PRICING_MISSING",
          message: "At least one active price is required",
        },
      ],
      evaluatedAt: new Date("2025-01-01T00:00:00.000Z"),
    };
    const evaluateEligibility = vi.fn(async () => evaluation);
    const controller = new OwnerCatalogController(
      { authenticateAccessCredential: async () => principal("owner-1") },
      { evaluateEligibility } as unknown as OwnerCatalogService,
    );

    const response = await controller.postEligibilityEvaluation(
      request("owner-token"),
      "60000000-0000-4000-8000-000000000001",
      "corr-eligibility",
    );

    expect(response).toEqual(evaluation);
    expect(response.discoverable).toBe(false);
    expect(response.reasons.map((reason) => reason.code)).toEqual([
      "REQUIRED_DOCUMENTS_MISSING",
      "ACTIVE_SERVICE_PRICING_MISSING",
    ]);
  });

  it("converts a disclosed hourly Pricing Rule command and preserves request context", async () => {
    const configurePricingRule = vi.fn(async (_principal, _offeringId, input) => input);
    const controller = new OwnerCatalogController(
      { authenticateAccessCredential: async () => principal("owner-1") },
      { configurePricingRule } as unknown as OwnerCatalogService,
    );

    await controller.putPricingRule(request("owner-token", "PWA"), "61000000-0000-4000-8000-000000000001", {
      method: "HOURLY",
      ratePaise: 80_000,
      roundingPolicy: "THIRTY_MINUTE_BLOCK",
      enabled: true,
      expectedVersion: 2,
    }, "corr-pricing");

    expect(configurePricingRule).toHaveBeenCalledWith(
      principal("owner-1"),
      "61000000-0000-4000-8000-000000000001",
      {
        method: "HOURLY",
        ratePaise: 80_000,
        roundingPolicy: "THIRTY_MINUTE_BLOCK",
        enabled: true,
      },
      { correlationId: "corr-pricing", actorChannel: "PWA" },
      2,
    );
  });

  /** Validates: Requirements 5.2, 5.3, 5.4, 5.5 */
  it("exposes refresh and command endpoints for the authoritative per-Tractor projection", async () => {
    const availability = {
      tractorId: "60000000-0000-4000-8000-000000000001",
      operationalStatus: "OFFLINE" as const,
      eligibilityStatus: "ELIGIBLE" as const,
      acceptingNewDemand: false,
      existingConfirmedBookingsManageable: true as const,
      effectiveAt: new Date("2025-01-01T00:00:00.000Z"),
      version: 4,
    };
    const getTractorAvailability = vi.fn(async () => availability);
    const setTractorOperationalStatus = vi.fn(async () => availability);
    const controller = new OwnerCatalogController(
      { authenticateAccessCredential: async () => principal("owner-1") },
      { getTractorAvailability, setTractorOperationalStatus } as unknown as OwnerCatalogService,
    );

    await expect(controller.getTractorAvailability(request("owner-token"), "60000000-0000-4000-8000-000000000001"))
      .resolves.toEqual(availability);
    await controller.putTractorAvailability(request("owner-token", "MOBILE"), "60000000-0000-4000-8000-000000000001", {
      status: "OFFLINE",
      expectedVersion: 3,
      reason: "Owner break",
    }, "corr-availability");

    expect(getTractorAvailability).toHaveBeenCalledWith(principal("owner-1"), "60000000-0000-4000-8000-000000000001");
    expect(setTractorOperationalStatus).toHaveBeenCalledWith(
      principal("owner-1"),
      "60000000-0000-4000-8000-000000000001",
      "OFFLINE",
      3,
      { correlationId: "corr-availability", actorChannel: "MOBILE" },
      "Owner break",
    );
  });

  it("propagates a cross-Owner denial without returning Tractor data", async () => {
    const getTractor = vi.fn(async () => {
      throw new CatalogAuthorizationError();
    });
    const controller = new OwnerCatalogController(
      { authenticateAccessCredential: async () => principal("owner-2") },
      { getTractor } as unknown as OwnerCatalogService,
    );

    // Unrelated and missing Tractors share one 404 response.
    await expect(controller.getTractor(request("owner-2-token"), "60000000-0000-4000-8000-000000000001"))
      .rejects.toMatchObject({ status: 404, response: { code: "NOT_FOUND" } });
    expect(getTractor).toHaveBeenCalledWith(principal("owner-2"), "60000000-0000-4000-8000-000000000001");
  });
});

/** Validates: Requirements 6.4, 6.5, 6.6 */
describe("FarmerPricingController API", () => {
  it("authenticates Farmer pricing selection and forwards exact quote inputs", async () => {
    const listActivePricingRules = vi.fn(async () => [{ id: "62000000-0000-4000-8000-000000000001", method: "PER_ACRE" }]);
    const createFarmerQuoteSnapshot = vi.fn(async () => ({
      pricingRuleId: "62000000-0000-4000-8000-000000000001",
      estimatedQuantity: "2.5",
      estimatedTotalPaise: 300_000,
    }));
    const controller = new FarmerPricingController(
      { authenticateAccessCredential: async () => farmerPrincipal("farmer-1") },
      { listActivePricingRules, createFarmerQuoteSnapshot } as unknown as OwnerCatalogService,
    );

    await expect(controller.listActivePricingRules(
      request("farmer-token"), "61000000-0000-4000-8000-000000000001",
    )).resolves.toEqual([{ id: "62000000-0000-4000-8000-000000000001", method: "PER_ACRE" }]);
    await expect(controller.postQuoteSnapshot(request("farmer-token"), "61000000-0000-4000-8000-000000000001", {
      pricingRuleId: "62000000-0000-4000-8000-000000000001",
      estimatedQuantity: "2.5",
    })).resolves.toMatchObject({ estimatedTotalPaise: 300_000 });

    expect(listActivePricingRules).toHaveBeenCalledWith(farmerPrincipal("farmer-1"), "61000000-0000-4000-8000-000000000001");
    expect(createFarmerQuoteSnapshot).toHaveBeenCalledWith(
      farmerPrincipal("farmer-1"), "61000000-0000-4000-8000-000000000001", "62000000-0000-4000-8000-000000000001", "2.5",
    );
  });
});
