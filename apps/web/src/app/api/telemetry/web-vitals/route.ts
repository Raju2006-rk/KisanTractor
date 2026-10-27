import { parseWebVitalReport } from "@kisantractor/observability";

import { webTelemetry } from "../../../../lib/telemetry";

const MAX_BODY_BYTES = 1_024;

/**
 * First-party web-vitals beacon. Accepts only the bounded report contract
 * (vital, value, rating, coarse route group) and records it as metrics; it
 * stores nothing per user and returns no data.
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
  const report = parseWebVitalReport(body);
  if (report === undefined) return new Response(null, { status: 400 });
  const telemetry = webTelemetry();
  telemetry.indicators.webVitalReported(report);
  telemetry.logger.debug("web.vital.reported", {
    vital: report.vital,
    rating: report.rating,
    routeGroup: report.routeGroup,
    value: report.value,
  });
  return new Response(null, { status: 204 });
}
