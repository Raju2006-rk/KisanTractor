import { readFileSync } from "node:fs";

import type {
  OwnerPricingRuleProjection,
  OwnerProfileProjection,
  OwnerServiceOfferingProjection,
  OwnerTractorProjection,
} from "@kisantractor/domain";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  OwnerBookingDetail,
  OwnerDashboard,
  OwnerPricingScreen,
  OwnerProfileScreen,
  OwnerTractorListScreen,
} from "../../../../components/owner";
import { normalizeOwnerBooking } from "../../../../lib/owner-management";
import type { OwnerDashboardAvailability } from "../../../../lib/owner-dashboard-model";
import { POST } from "./route";

const { cookieGet } = vi.hoisted(() => ({ cookieGet: vi.fn() }));

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ get: cookieGet })),
}));

const location = {
  id: "location-1",
  state: "Telangana",
  district: "Warangal",
  mandalOrTaluk: "Geesugonda",
  village: "Vanchanagiri",
  source: "MANUAL_ADDRESS" as const,
  capturedAt: new Date("2025-01-01T00:00:00.000Z"),
};

const profile: OwnerProfileProjection = {
  userId: "owner-1",
  fullName: "Raju Naik",
  preferredLocale: "te",
  contactSharingConsent: false,
  mobileVerified: true,
  verificationStatus: "UNVERIFIED",
  operatingLocation: location,
  version: 1,
};

const tractor: OwnerTractorProjection = {
  id: "tractor-1",
  ownerId: "owner-1",
  brand: "Mahindra",
  model: "575 DI",
  registrationNumber: "TS08AB1234",
  manufacturingYear: 2022,
  horsepower: 47,
  operationalStatus: "OFFLINE",
  eligibilityStatus: "INCOMPLETE",
  operatingLocation: location,
  photos: [],
  version: 4,
};

const offering: OwnerServiceOfferingProjection = {
  id: "offering-1",
  tractorId: tractor.id,
  serviceId: "service-ploughing",
  serviceCode: "PLOUGHING",
  serviceName: "Ploughing",
  enabled: true,
  version: 1,
};

const hourlyRule: OwnerPricingRuleProjection = {
  id: "pricing-1",
  serviceOfferingId: offering.id,
  method: "HOURLY",
  ratePaise: 80_000,
  currency: "INR",
  roundingPolicy: "PROPORTIONAL_MINUTE",
  enabled: true,
  version: 2,
};

const booking = normalizeOwnerBooking({
  id: "booking-1",
  publicReference: "KT-2025-001",
  status: "PENDING_OWNER_RESPONSE",
  version: 3,
  customer: { displayName: "Anita Rao" },
  tractor: { id: tractor.id, brand: tractor.brand, model: tractor.model },
  serviceName: "Ploughing",
  requestedInterval: { start: "2025-02-10T03:00:00.000Z", end: "2025-02-10T07:00:00.000Z" },
  serviceLocationSnapshot: location,
  quoteSnapshot: {
    pricingRuleVersion: 7,
    method: "HOURLY",
    ratePaise: 80_000,
    roundingPolicy: "PROPORTIONAL_MINUTE",
    estimatedQuantity: "4",
    estimatedTotalPaise: 320_000,
  },
  paymentExpectation: "Cash after the final bill",
  updatedAt: "2025-02-01T10:00:00.000Z",
})!;

const routeContext = (path: string[]) => ({ params: Promise.resolve({ path }) });
const formRequest = (path: string, values: Record<string, string>) => new Request(`http://localhost:3000${path}`, {
  method: "POST",
  body: new URLSearchParams(values),
  headers: { "content-type": "application/x-www-form-urlencoded" },
});
const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" },
});

/**
 * Browser-boundary workflow coverage for Task 10.3.
 * Validates: Requirements 4.4, 5.2, 5.3, 5.4, 6.1, 6.2, 8.6, 13.4
 */
describe("Owner browser workflows", () => {
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    cookieGet.mockReturnValue({ value: "owner-session" });
    fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("carries accessible onboarding fields through the web boundary", async () => {
    const markup = renderToStaticMarkup(createElement(OwnerProfileScreen, { locale: "en", profile }));
    for (const field of ["fullName", "preferredLocale", "state", "district", "mandalOrTaluk", "village", "capturedAt"]) {
      expect(markup).toContain(`name="${field}"`);
    }
    expect(markup).toContain('for="fullName"');
    expect(markup).toContain('type="submit"');

    fetchMock.mockResolvedValueOnce(jsonResponse({ ...profile, operatingLocation: { ...location, capturedAt: location.capturedAt.toISOString() } }));
    const response = await POST(formRequest("/api/owner/profile", {
      fullName: "Raju Naik",
      preferredLocale: "te",
      state: "Telangana",
      district: "Warangal",
      mandalOrTaluk: "Geesugonda",
      village: "Vanchanagiri",
      source: "MANUAL_ADDRESS",
      capturedAt: "2025-01-01T00:00:00.000Z",
      expectedVersion: "1",
    }), routeContext(["profile"]));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("http://localhost:3000/owner/profile?saved=1");
    expect(fetchMock).toHaveBeenCalledWith("http://localhost:4100/owner/profile", expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({
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
        expectedVersion: 1,
      }),
    }));
  });

  it("returns explicit eligibility failures without publishing an incomplete Tractor", async () => {
    const evaluation = {
      tractorId: tractor.id,
      status: "INCOMPLETE",
      discoverable: false,
      reasons: [
        { code: "REQUIRED_DOCUMENTS_MISSING", message: "Required Tractor documents are missing" },
        { code: "ACTIVE_SERVICE_PRICING_MISSING", message: "At least one active price is required" },
      ],
      evaluatedAt: "2025-01-01T00:00:00.000Z",
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(evaluation));

    const response = await POST(new Request(`http://localhost:3000/api/owner/tractors/${tractor.id}/eligibility`, {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json" },
    }), routeContext(["tractors", tractor.id, "eligibility"]));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(evaluation);
    expect(fetchMock).toHaveBeenCalledWith(`http://localhost:4100/owner/tractors/${tractor.id}/eligibility`, expect.objectContaining({ method: "POST" }));

    const markup = renderToStaticMarkup(createElement(OwnerTractorListScreen, { locale: "en", tractors: [tractor] }));
    expect(markup).toContain("Setup incomplete");
    expect(markup).not.toContain("Eligible</span>");
  });

  it("takes an eligible Tractor online and offline while preserving existing-booking management", async () => {
    const offline: OwnerDashboardAvailability = {
      tractorId: tractor.id,
      tractorName: `${tractor.brand} ${tractor.model}`,
      registrationNumber: tractor.registrationNumber,
      operationalStatus: "OFFLINE",
      eligibilityStatus: "ELIGIBLE",
      acceptingNewDemand: false,
      existingConfirmedBookingsManageable: true,
      effectiveAt: new Date("2025-03-01T10:00:00.000Z"),
      version: 4,
    };
    const online = { ...offline, operationalStatus: "ONLINE", acceptingNewDemand: true, effectiveAt: "2025-03-01T10:01:00.000Z", version: 5 };
    const offlineAgain = { ...offline, effectiveAt: "2025-03-01T10:02:00.000Z", version: 6 };
    fetchMock.mockResolvedValueOnce(jsonResponse(online)).mockResolvedValueOnce(jsonResponse(offlineAgain));

    const onlineResponse = await POST(new Request(`http://localhost:3000/api/owner/tractors/${tractor.id}/availability`, {
      method: "POST",
      body: JSON.stringify({ status: "ONLINE", expectedVersion: 4 }),
      headers: { "content-type": "application/json" },
    }), routeContext(["tractors", tractor.id, "availability"]));
    const offlineResponse = await POST(new Request(`http://localhost:3000/api/owner/tractors/${tractor.id}/availability`, {
      method: "POST",
      body: JSON.stringify({ status: "OFFLINE", expectedVersion: 5 }),
      headers: { "content-type": "application/json" },
    }), routeContext(["tractors", tractor.id, "availability"]));

    await expect(onlineResponse.json()).resolves.toMatchObject({ operationalStatus: "ONLINE", acceptingNewDemand: true });
    await expect(offlineResponse.json()).resolves.toMatchObject({ operationalStatus: "OFFLINE", acceptingNewDemand: false, existingConfirmedBookingsManageable: true });
    expect(fetchMock.mock.calls.map(([, init]) => [init?.method, init?.body])).toEqual([
      ["PUT", JSON.stringify({ status: "ONLINE", expectedVersion: 4 })],
      ["PUT", JSON.stringify({ status: "OFFLINE", expectedVersion: 5 })],
    ]);

    const markup = renderToStaticMarkup(createElement(OwnerDashboard, {
      availabilities: [offline],
      locale: "en",
      summary: { totalTractors: 1, equipmentCount: 0, pendingRequests: 1, acceptedJobs: 1, activeJobs: 1, completedJobs: 0, recordedEarningsPaise: 0 },
    }));
    expect(markup).toContain('role="switch"');
    expect(markup).toContain('aria-checked="false"');
    expect(markup).toContain('href="/owner/bookings?view=active"');
    expect(markup).toContain("Existing confirmed bookings and job controls remain available");
  });

  it("submits positive method-specific pricing with the disclosed hourly policy", async () => {
    const markup = renderToStaticMarkup(createElement(OwnerPricingScreen, {
      locale: "en",
      configurations: [{ tractor, offering, rules: [hourlyRule] }],
    }));
    expect(markup.match(/name="method"/gu)).toHaveLength(3);
    expect(markup.match(/name="ratePaise"/gu)).toHaveLength(3);
    expect(markup).toContain('min="1"');
    expect(markup).toContain('name="roundingPolicy"');

    fetchMock.mockResolvedValueOnce(jsonResponse(hourlyRule));
    const response = await POST(formRequest(`/api/owner/service-offerings/${offering.id}/pricing-rules`, {
      method: "HOURLY",
      ratePaise: "80000",
      roundingPolicy: "THIRTY_MINUTE_BLOCK",
      enabled: "true",
      expectedVersion: "2",
    }), routeContext(["service-offerings", offering.id, "pricing-rules"]));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("http://localhost:3000/owner/pricing?saved=1");
    expect(fetchMock).toHaveBeenCalledWith(`http://localhost:4100/owner/service-offerings/${offering.id}/pricing-rules`, expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({
        method: "HOURLY",
        ratePaise: 80_000,
        roundingPolicy: "THIRTY_MINUTE_BLOCK",
        enabled: true,
        expectedVersion: 2,
      }),
    }));
  });

  it("submits accept and reject decisions with optimistic versions and a required rejection reason", async () => {
    const markup = renderToStaticMarkup(createElement(OwnerBookingDetail, { booking, locale: "en" }));
    expect(markup).toContain(`/api/owner/bookings/${booking.id}/accept`);
    expect(markup).toContain(`/api/owner/bookings/${booking.id}/reject`);
    expect(markup.match(/name="expectedVersion" value="3"/gu)).toHaveLength(2);
    expect(markup).toContain('for="rejectionReason"');
    expect(markup).toMatch(/<textarea[^>]*name="reason"[^>]*required=""/u);

    fetchMock.mockResolvedValueOnce(jsonResponse({ status: "ACCEPTED" })).mockResolvedValueOnce(jsonResponse({ status: "REJECTED" }));
    const accepted = await POST(formRequest(`/api/owner/bookings/${booking.id}/accept`, { expectedVersion: "3" }), routeContext(["bookings", booking.id, "accept"]));
    const rejected = await POST(formRequest(`/api/owner/bookings/${booking.id}/reject`, { expectedVersion: "3", reason: "Unable to serve this village" }), routeContext(["bookings", booking.id, "reject"]));

    expect(accepted.headers.get("location")).toBe(`http://localhost:3000/owner/bookings/${booking.id}?saved=1`);
    expect(rejected.headers.get("location")).toBe(`http://localhost:3000/owner/bookings/${booking.id}?saved=1`);
    expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.method, init?.body])).toEqual([
      [`http://localhost:4100/owner/bookings/${booking.id}/accept`, "POST", JSON.stringify({ expectedVersion: 3 })],
      [`http://localhost:4100/owner/bookings/${booking.id}/reject`, "POST", JSON.stringify({ expectedVersion: 3, reason: "Unable to serve this village" })],
    ]);
  });

  it("redirects a concurrent acceptance conflict to announced, recoverable feedback", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ code: "BOOKING_CONFLICT" }, 409));
    const response = await POST(formRequest(`/api/owner/bookings/${booking.id}/accept`, { expectedVersion: "3" }), routeContext(["bookings", booking.id, "accept"]));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`http://localhost:3000/owner/bookings/${booking.id}?error=schedule-conflict`);

    const markup = renderToStaticMarkup(createElement(OwnerBookingDetail, { booking, locale: "en", scheduleConflict: true }));
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("concurrent schedule conflict");
    expect(markup).toContain(`href="/owner/bookings/${booking.id}"`);
    expect(markup).toContain("Retry");
  });

  it("preserves minimum targets, visible focus, named controls, and responsive single-column actions", () => {
    const css = readFileSync(new URL("../../../../app/globals.css", import.meta.url), "utf8");
    const onboarding = renderToStaticMarkup(createElement(OwnerProfileScreen, { locale: "en", profile }));
    const decision = renderToStaticMarkup(createElement(OwnerBookingDetail, { booking, locale: "en" }));

    expect(onboarding).toMatch(/<label[^>]*for="fullName"[^>]*>/u);
    expect(decision).toMatch(/<section[^>]*aria-labelledby="owner-booking-decision"/u);
    expect(css).toContain("--kt-target-min: 2.75rem");
    expect(css).toMatch(/:focus-visible\s*\{[^}]*outline:/su);
    expect(css).toMatch(/@media \(max-width: 40rem\)[\s\S]*?\.kt-owner-booking-decision__actions[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\);/u);
  });
});
