"use client";

import {
  LANDING_3D_TELEMETRY_ENDPOINT,
  type Landing3dOutcome,
} from "@kisantractor/observability/landing-3d";

import type { LandingSceneFallbackReason } from "./landing-enhancement";

/** Maps detailed client capability reasons onto the bounded operational metric. */
export function landing3dOutcomeForFallback(reason: LandingSceneFallbackReason): Landing3dOutcome {
  switch (reason) {
    case "SCRIPTING_DISABLED": return "DISABLED";
    case "REDUCED_MOTION": return "REDUCED_MOTION";
    case "DATA_SAVER": return "DATA_SAVER";
    case "LOW_DEVICE_MEMORY":
    case "LOW_GPU_CONFIDENCE": return "LOW_CAPABILITY";
    case "LOAD_FAILED": return "FAILED";
  }
}

/** The beacon contains one bounded outcome and no URL, device value, or identifier. */
export function landing3dBeaconBody(outcome: Landing3dOutcome): string {
  return JSON.stringify({ outcome });
}

/** Best-effort first-party reporting; telemetry can never block the static landing page. */
export function reportLanding3dOutcome(outcome: Landing3dOutcome): void {
  const body = landing3dBeaconBody(outcome);
  const blob = new Blob([body], { type: "application/json" });
  if (typeof navigator.sendBeacon !== "function" || !navigator.sendBeacon(LANDING_3D_TELEMETRY_ENDPOINT, blob)) {
    void fetch(LANDING_3D_TELEMETRY_ENDPOINT, {
      method: "POST",
      body,
      keepalive: true,
      headers: { "content-type": "application/json" },
    }).catch(() => undefined);
  }
}
