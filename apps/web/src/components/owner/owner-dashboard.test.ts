import { readFileSync } from "node:fs";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  normalizeOwnerDashboardBooking,
  summarizeOwnerDashboardBookings,
  type OwnerDashboardAvailability,
} from "../../lib/owner-dashboard-model";
import { OwnerDashboard } from "./owner-dashboard";

const offlineAvailability: OwnerDashboardAvailability = {
  tractorId: "tractor-1",
  tractorName: "Mahindra 575 DI",
  registrationNumber: "TS08AB1234",
  operationalStatus: "OFFLINE",
  eligibilityStatus: "ELIGIBLE",
  acceptingNewDemand: false,
  existingConfirmedBookingsManageable: true,
  effectiveAt: new Date("2025-03-01T10:00:00.000Z"),
  version: 4,
};

/** Validates: Requirements 5.1, 5.2, 5.3, 5.5 */
describe("Owner dashboard", () => {
  it("places authoritative per-Tractor availability before all dashboard summaries", () => {
    const markup = renderToStaticMarkup(createElement(OwnerDashboard, {
      availabilities: [offlineAvailability],
      locale: "en",
      summary: {
        totalTractors: 1,
        equipmentCount: 2,
        pendingRequests: 3,
        acceptedJobs: 2,
        activeJobs: 1,
        completedJobs: 5,
        recordedEarningsPaise: 120_000,
      },
    }));

    expect(markup.indexOf("Tractor availability")).toBeLessThan(markup.indexOf("Dashboard summary"));
    expect(markup).toContain('role="switch"');
    expect(markup).toContain('aria-checked="false"');
    expect(markup).toContain("Mahindra 575 DI");
    expect(markup).toContain("TS08AB1234");
    expect(markup).toContain("Not accepting new requests");
  });

  it("keeps request and active-job controls visible while every Tractor is offline", () => {
    const markup = renderToStaticMarkup(createElement(OwnerDashboard, {
      availabilities: [offlineAvailability],
      locale: "en",
      summary: { totalTractors: 1, equipmentCount: 0, pendingRequests: 1, acceptedJobs: 1, activeJobs: 1, completedJobs: 0, recordedEarningsPaise: 0 },
    }));

    expect(markup).toContain("All Tractors are offline for new demand");
    expect(markup).toContain("Existing confirmed bookings and job controls remain available");
    expect(markup).toContain('href="/owner/bookings"');
    expect(markup).toContain('href="/owner/bookings?view=active"');
  });

  it("shows summary values, management shortcuts, earnings, payments, profile, and help links", () => {
    const markup = renderToStaticMarkup(createElement(OwnerDashboard, {
      availabilities: [offlineAvailability],
      locale: "en",
      summary: { totalTractors: 1, equipmentCount: 2, pendingRequests: 3, acceptedJobs: 2, activeJobs: 1, completedJobs: 5, recordedEarningsPaise: 120_000 },
    }));

    for (const destination of [
      "/owner/tractors", "/owner/equipment", "/owner/documents", "/owner/pricing",
      "/owner/earnings", "/owner/payments", "/owner/profile", "/owner/help",
    ]) {
      expect(markup).toContain(`href="${destination}"`);
    }
    for (const label of ["Total Tractors", "New requests", "Accepted jobs", "Active jobs", "Completed jobs", "Recorded earnings"]) {
      expect(markup).toContain(label);
    }
    expect(markup).toContain("₹1,200");
  });

  it("does not invent booking or earnings totals when their authoritative projection is unavailable", () => {
    const markup = renderToStaticMarkup(createElement(OwnerDashboard, {
      availabilities: [],
      locale: "en",
      summary: { totalTractors: 0, equipmentCount: 0 },
    }));

    expect(markup).toContain("Add your first Tractor");
    expect(markup.match(/Unavailable/gu)?.length).toBeGreaterThanOrEqual(5);
  });

  it("uses responsive single-column layouts and accessible minimum targets", () => {
    const css = readFileSync(new URL("../../app/globals.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.kt-owner-summary-card,[\s\S]*?min-height:\s*var\(--kt-target-min\)/u);
    expect(css).toMatch(/@media \(max-width: 48rem\)[\s\S]*?\.kt-owner-availability,[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\)/u);
    expect(css).toMatch(/@media \(max-width: 30rem\)[\s\S]*?\.kt-owner-summary-grid,[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\)/u);
  });
});

describe("Owner dashboard projection", () => {
  it("classifies request and job statuses and uses only the authoritative earnings report total", () => {
    const inputs = [
      { id: "request", status: "PENDING_OWNER_RESPONSE" },
      { id: "accepted", status: "SCHEDULED" },
      { id: "active", status: "IN_PROGRESS" },
      { id: "complete", status: "COMPLETED", payment: { status: "PAID_CASH", amountPaise: 80_000 } },
      { id: "failed", status: "COMPLETED", payment: { status: "PAYMENT_FAILED", amountPaise: 50_000 } },
      { id: "mixed", status: "COMPLETED", payment: { status: "PAID_MIXED", amountPaise: 30_000 } },
    ].map(normalizeOwnerDashboardBooking).filter((item) => item !== undefined);

    expect(summarizeOwnerDashboardBookings(2, 4, inputs, 110_000)).toEqual({
      totalTractors: 2,
      equipmentCount: 4,
      pendingRequests: 1,
      acceptedJobs: 1,
      activeJobs: 1,
      completedJobs: 3,
      recordedEarningsPaise: 110_000,
    });
  });

  it("rejects malformed booking records and preserves unavailable state", () => {
    expect(normalizeOwnerDashboardBooking({ id: "booking-1", status: "UNKNOWN" })).toBeUndefined();
    expect(summarizeOwnerDashboardBookings(1, 2, undefined)).toEqual({ totalTractors: 1, equipmentCount: 2 });
  });
});
