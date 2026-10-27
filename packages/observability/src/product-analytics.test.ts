import { describe, expect, it } from "vitest";

import { parseProductAnalyticsReport, productAnalyticsBeaconBody } from "./product-analytics.js";

/** Validates: Requirements 12.2, 13.1, 18.2 */
describe("product analytics privacy contract", () => {
  it("reduces paths to a coarse surface and keeps only allowlisted dimensions", () => {
    const body = productAnalyticsBeaconBody("OWNER_EARNINGS_VIEWED", "/owner/bookings/secret-booking-id?phone=9876543210", "te");
    expect(JSON.parse(body)).toEqual({ event: "OWNER_EARNINGS_VIEWED", surface: "owner", locale: "te" });
    expect(body).not.toContain("secret-booking-id");
    expect(body).not.toContain("9876543210");
    expect(parseProductAnalyticsReport(JSON.parse(body))).toEqual(JSON.parse(body));
  });

  it("accepts every expanded locale while retaining privacy-safe dimensions", () => {
    for (const locale of ["mr", "bn"] as const) {
      const body = productAnalyticsBeaconBody("PAGE_VIEW", "/farmer/bookings/private-id", locale);
      expect(parseProductAnalyticsReport(JSON.parse(body))).toEqual({ event: "PAGE_VIEW", surface: "farmer", locale });
      expect(body).not.toContain("private-id");
    }
  });

  it("rejects free text, identifiers, extra fields, and unsupported locales", () => {
    expect(parseProductAnalyticsReport({ event: "CUSTOM_EVENT", surface: "owner", locale: "en" })).toBeUndefined();
    expect(parseProductAnalyticsReport({ event: "PAGE_VIEW", surface: "owner/booking-1", locale: "en" })).toBeUndefined();
    expect(parseProductAnalyticsReport({ event: "PAGE_VIEW", surface: "owner", locale: "gu" })).toBeUndefined();
    expect(parseProductAnalyticsReport({ event: "PAGE_VIEW", surface: "owner", locale: "en", userId: "user-1" })).toBeUndefined();
  });
});
