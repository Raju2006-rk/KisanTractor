import { describe, expect, it, vi } from "vitest";

import { productAnalyticsBeaconBody } from "@kisantractor/observability";
import { sendProductAnalytics } from "./product-analytics-reporter";

/** Validates: Requirements 12.2, 13.1, 18.2 */
describe("ProductAnalyticsReporter payload", () => {
  it("never transmits concrete paths, query strings, or identifiers", () => {
    const body = productAnalyticsBeaconBody("PAGE_VIEW", "/owner/bookings/70000000-0000-4000-8000-000000000001?recipient=Ravi", "kn");
    expect(JSON.parse(body)).toEqual({ event: "PAGE_VIEW", surface: "owner", locale: "kn" });
    expect(body).not.toContain("70000000");
    expect(body).not.toContain("Ravi");
  });

  it("omits credentials and referrer data and ignores transport failure", async () => {
    const transport = vi.fn().mockRejectedValue(new Error("offline"));
    await expect(sendProductAnalytics("OWNER_EARNINGS_VIEWED", "/owner/earnings?from=private", "te", transport))
      .resolves.toBeUndefined();
    expect(transport).toHaveBeenCalledWith("/api/telemetry/product-analytics", expect.objectContaining({
      credentials: "omit",
      referrerPolicy: "no-referrer",
      keepalive: true,
      body: JSON.stringify({ event: "OWNER_EARNINGS_VIEWED", surface: "owner", locale: "te" }),
    }));
  });
});
