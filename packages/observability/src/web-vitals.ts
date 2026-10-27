// Browser-safe entry (`@kisantractor/observability/web-vitals`): no Node built-ins.
import type { WebVitalReport } from "./indicators.js";
import { webRouteGroups, webVitalNames, webVitalRatings, type WebRouteGroup } from "./metrics.js";

export const WEB_VITALS_ENDPOINT = "/api/telemetry/web-vitals";
export { webRouteGroups, webVitalNames, webVitalRatings };
export type { WebRouteGroup, WebVitalReport };

/** Upper bounds that reject nonsense reports before they reach a histogram. */
const MAX_VALUE: Readonly<Record<WebVitalReport["vital"], number>> = Object.freeze({
  LCP: 120_000,
  INP: 60_000,
  FCP: 120_000,
  TTFB: 120_000,
  CLS: 50,
});

/**
 * Maps a browser pathname to a coarse route group. Only the first segment is
 * used, so booking references or other identifiers in later segments never
 * reach telemetry.
 */
export function webRouteGroup(pathname: string): WebRouteGroup {
  const first = pathname.split("?")[0]?.split("/").filter((segment) => segment.length > 0)[0];
  if (first === undefined) return "landing";
  if (first === "login") return "auth";
  return (webRouteGroups as readonly string[]).includes(first) ? (first as WebRouteGroup) : "other";
}

/**
 * Validates an untrusted browser web-vital beacon. Returns undefined for
 * anything outside the contract; unknown fields are ignored.
 */
export function parseWebVitalReport(input: unknown): WebVitalReport | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const { vital, value, rating, routeGroup } = input as Record<string, unknown>;
  if (typeof vital !== "string" || !(webVitalNames as readonly string[]).includes(vital)) return undefined;
  if (typeof rating !== "string" || !(webVitalRatings as readonly string[]).includes(rating)) return undefined;
  if (typeof routeGroup !== "string" || !(webRouteGroups as readonly string[]).includes(routeGroup)) return undefined;
  const name = vital as WebVitalReport["vital"];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > MAX_VALUE[name]) return undefined;
  return Object.freeze({
    vital: name,
    value,
    rating: rating as WebVitalReport["rating"],
    routeGroup: routeGroup as WebRouteGroup,
  });
}
