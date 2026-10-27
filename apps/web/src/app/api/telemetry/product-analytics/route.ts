import { parseProductAnalyticsReport } from "@kisantractor/observability";

import { webTelemetry } from "../../../../lib/telemetry";

const MAX_BODY_BYTES = 256;
const NO_STORE_HEADERS = { "cache-control": "no-store" } as const;

type BoundedBody = Readonly<{ status: "OK"; text: string }> | Readonly<{ status: "TOO_LARGE" }>;

/** Reads at most the accepted number of bytes, cancelling oversized request streams early. */
async function readBoundedBody(request: Request): Promise<BoundedBody> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null && /^\d+$/u.test(declaredLength) && Number(declaredLength) > MAX_BODY_BYTES) {
    return { status: "TOO_LARGE" };
  }
  if (request.body === null) return { status: "OK", text: "" };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    byteLength += chunk.value.byteLength;
    if (byteLength > MAX_BODY_BYTES) {
      await reader.cancel();
      return { status: "TOO_LARGE" };
    }
    chunks.push(chunk.value);
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { status: "OK", text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
}

/** First-party analytics endpoint. It accepts only fixed, aggregate dimensions and stores no user event row. */
export async function POST(request: Request): Promise<Response> {
  let payload: BoundedBody;
  try {
    payload = await readBoundedBody(request);
  } catch {
    return new Response(null, { status: 400, headers: NO_STORE_HEADERS });
  }
  if (payload.status === "TOO_LARGE") return new Response(null, { status: 413, headers: NO_STORE_HEADERS });

  let body: unknown;
  try {
    body = JSON.parse(payload.text);
  } catch {
    return new Response(null, { status: 400, headers: NO_STORE_HEADERS });
  }
  const report = parseProductAnalyticsReport(body);
  if (report === undefined) return new Response(null, { status: 400, headers: NO_STORE_HEADERS });
  webTelemetry().indicators.productAnalyticsEvent(report.event, report.surface, report.locale);
  return new Response(null, { status: 204, headers: NO_STORE_HEADERS });
}
