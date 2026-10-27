import { parseLanding3dReport } from "@kisantractor/observability/landing-3d";

import { webTelemetry } from "../../../../lib/telemetry";

const MAX_BODY_BYTES = 256;

/**
 * First-party, PII-free landing 3D outcome beacon. Exactly one bounded outcome
 * per page view feeds the production fallback-rate counter.
 */
export async function POST(request: Request): Promise<Response> {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return new Response(null, { status: 413 });
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return new Response(null, { status: 400 });
  }
  const report = parseLanding3dReport(body);
  if (report === undefined) return new Response(null, { status: 400 });

  const telemetry = webTelemetry();
  telemetry.indicators.landing3dOutcome(report.outcome);
  telemetry.logger.debug("landing.3d.outcome", { outcome: report.outcome });
  return new Response(null, { status: 204 });
}
