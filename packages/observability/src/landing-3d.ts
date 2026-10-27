// Browser-safe entry (`@kisantractor/observability/landing-3d`): no Node built-ins.
import { landing3dOutcomes } from "./metrics.js";

export const LANDING_3D_TELEMETRY_ENDPOINT = "/api/telemetry/landing-3d";
export { landing3dOutcomes };
export type Landing3dOutcome = (typeof landing3dOutcomes)[number];

export interface Landing3dReport {
  readonly outcome: Landing3dOutcome;
}

/** Validates an untrusted browser report without accepting identifiers or free text. */
export function parseLanding3dReport(input: unknown): Landing3dReport | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const { outcome } = input as Record<string, unknown>;
  if (typeof outcome !== "string" || !(landing3dOutcomes as readonly string[]).includes(outcome)) return undefined;
  return Object.freeze({ outcome: outcome as Landing3dOutcome });
}
