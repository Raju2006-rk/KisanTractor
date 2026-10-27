import { describe, expect, it } from "vitest";

import { webVitalBeaconBody } from "../../../../components/shell/web-vitals-reporter";
import { forwardCorrelationId } from "../../../../lib/correlation";
import { webTelemetry } from "../../../../lib/telemetry";
import { POST } from "./route";

const beacon = (body: string) =>
  new Request("http://localhost:3000/api/telemetry/web-vitals", {
    method: "POST",
    body,
    headers: { "content-type": "application/json" },
  });

/** Validates: Requirements 18.1, 18.2 */
describe("web-vitals beacon", () => {
  it("builds a beacon with only the vital, value, rating, and coarse route group", () => {
    const body = webVitalBeaconBody({ name: "LCP", value: 2_100, rating: "good" }, "/farmer/bookings/KT-ABC123DEF456");
    expect(JSON.parse(body ?? "{}")).toEqual({ vital: "LCP", value: 2_100, rating: "good", routeGroup: "farmer" });
    expect(body).not.toContain("KT-ABC123DEF456");
    expect(webVitalBeaconBody({ name: "FID", value: 10, rating: "good" }, "/")).toBeUndefined();
  });

  it("records valid reports and rejects anything outside the contract", async () => {
    const metrics = webTelemetry().metrics;
    const before = metrics.value("kt_web_vitals_reports_total", { vital: "INP", rating: "poor", route_group: "owner" });

    const accepted = await POST(beacon(JSON.stringify({ vital: "INP", value: 650, rating: "poor", routeGroup: "owner" })));
    expect(accepted.status).toBe(204);
    expect(metrics.value("kt_web_vitals_reports_total", { vital: "INP", rating: "poor", route_group: "owner" })).toBe(before + 1);

    expect((await POST(beacon("not json"))).status).toBe(400);
    expect((await POST(beacon(JSON.stringify({ vital: "INP", value: 650, rating: "poor", routeGroup: "/owner/tractors/1" })))).status).toBe(400);
    expect((await POST(beacon("x".repeat(5_000)))).status).toBe(413);
  });
});

/** Validates: Requirement 18.1 */
describe("correlation forwarding", () => {
  it("forwards a valid inbound correlation ID and replaces PII-shaped values", () => {
    const withId = new Request("http://localhost:3000/api/x", { headers: { "x-correlation-id": "web:req-abcdefgh" } });
    expect(forwardCorrelationId(withId)).toBe("web:req-abcdefgh");
    const smuggled = new Request("http://localhost:3000/api/x", { headers: { "x-correlation-id": "+919876543210" } });
    expect(forwardCorrelationId(smuggled)).toMatch(/^[0-9a-f-]{36}$/u);
    expect(forwardCorrelationId(new Request("http://localhost:3000/api/x"))).toMatch(/^[0-9a-f-]{36}$/u);
  });
});
