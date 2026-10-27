import { LANDING_3D_TELEMETRY_ENDPOINT, landing3dOutcomes } from "@kisantractor/observability/landing-3d";
import { describe, expect, it } from "vitest";

import { landing3dBeaconBody, landing3dOutcomeForFallback } from "../../../../components/landing/landing-3d-telemetry";
import { webTelemetry } from "../../../../lib/telemetry";
import { POST } from "./route";

const beacon = (body: string) => new Request(`http://localhost:3000${LANDING_3D_TELEMETRY_ENDPOINT}`, {
  method: "POST",
  body,
  headers: { "content-type": "application/json" },
});

/** Validates: Requirements 16.5, 18.2 */
describe("landing 3D telemetry", () => {
  it("maps every fallback reason to a bounded, PII-free outcome", () => {
    expect(landing3dOutcomeForFallback("SCRIPTING_DISABLED")).toBe("DISABLED");
    expect(landing3dOutcomeForFallback("REDUCED_MOTION")).toBe("REDUCED_MOTION");
    expect(landing3dOutcomeForFallback("DATA_SAVER")).toBe("DATA_SAVER");
    expect(landing3dOutcomeForFallback("LOW_DEVICE_MEMORY")).toBe("LOW_CAPABILITY");
    expect(landing3dOutcomeForFallback("LOW_GPU_CONFIDENCE")).toBe("LOW_CAPABILITY");
    expect(landing3dOutcomeForFallback("LOAD_FAILED")).toBe("FAILED");
    expect(JSON.parse(landing3dBeaconBody("TIMED_OUT"))).toEqual({ outcome: "TIMED_OUT" });
  });

  it("records each valid terminal outcome and rejects unbounded reports", async () => {
    const metrics = webTelemetry().metrics;
    for (const outcome of landing3dOutcomes) {
      const before = metrics.value("kt_landing_3d_outcomes_total", { outcome });
      expect((await POST(beacon(landing3dBeaconBody(outcome)))).status).toBe(204);
      expect(metrics.value("kt_landing_3d_outcomes_total", { outcome })).toBe(before + 1);
    }

    expect((await POST(beacon("not json"))).status).toBe(400);
    expect((await POST(beacon(JSON.stringify({ outcome: "FAILED", path: "/farmer/bookings/private" })))).status).toBe(204);
    expect((await POST(beacon(JSON.stringify({ outcome: "NETWORK_ERROR" })))).status).toBe(400);
    expect((await POST(beacon("x".repeat(300)))).status).toBe(413);
  });
});
