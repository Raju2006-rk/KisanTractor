import { InMemoryMetrics, OperationalIndicators } from "@kisantractor/observability";
import { beforeEach, describe, expect, it, vi } from "vitest";

const metrics = new InMemoryMetrics();
vi.mock("../../../../lib/telemetry", () => ({
  webTelemetry: () => ({ indicators: new OperationalIndicators(metrics) }),
}));

import { POST } from "./route";

/** Validates: Requirements 12.2, 18.2 */
describe("product analytics route", () => {
  beforeEach(() => metrics.reset());

  it("records only allowlisted aggregate dimensions", async () => {
    const response = await POST(new Request("http://local/api/telemetry/product-analytics", {
      method: "POST", body: JSON.stringify({ event: "OWNER_EARNINGS_VIEWED", surface: "owner", locale: "hi" }),
    }));
    expect(response.status).toBe(204);
    expect(metrics.value("kt_product_analytics_events_total", { event: "OWNER_EARNINGS_VIEWED", surface: "owner", locale: "hi" })).toBe(1);
  });

  it("rejects extra personal or free-text fields", async () => {
    const response = await POST(new Request("http://local/api/telemetry/product-analytics", {
      method: "POST", body: JSON.stringify({ event: "PAGE_VIEW", surface: "owner", locale: "en", phone: "9876543210" }),
    }));
    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(metrics.total("kt_product_analytics_events_total")).toBe(0);
  });

  it("rejects oversized UTF-8 bodies by bytes without recording a metric", async () => {
    const response = await POST(new Request("http://local/api/telemetry/product-analytics", {
      method: "POST", body: JSON.stringify({ event: "PAGE_VIEW", surface: "owner", locale: "en", extra: "₹".repeat(100) }),
    }));
    expect(response.status).toBe(413);
    expect(metrics.total("kt_product_analytics_events_total")).toBe(0);
  });
});
