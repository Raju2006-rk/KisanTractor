"use client";
import { WEB_VITALS_ENDPOINT, webRouteGroup, webVitalNames } from "@kisantractor/observability/web-vitals";
import { useReportWebVitals } from "next/web-vitals";

export interface WebVitalsReporterProps {
  readonly enabled: boolean;
}

type ReportedMetric = Parameters<Parameters<typeof useReportWebVitals>[0]>[0];

/**
 * Builds the beacon body. Only the vital name, value, rating, and a coarse
 * route group leave the browser; the URL, query string, and identifiers in
 * later path segments never do.
 */
export function webVitalBeaconBody(metric: Pick<ReportedMetric, "name" | "value" | "rating">, pathname: string): string | undefined {
  if (!(webVitalNames as readonly string[]).includes(metric.name)) return undefined;
  return JSON.stringify({
    vital: metric.name,
    value: metric.value,
    rating: metric.rating,
    routeGroup: webRouteGroup(pathname),
  });
}

/** Reports Core Web Vitals to the first-party telemetry route. Renders nothing. */
export function WebVitalsReporter({ enabled }: WebVitalsReporterProps) {
  useReportWebVitals((metric) => {
    if (!enabled) return;
    const body = webVitalBeaconBody(metric, window.location.pathname);
    if (body === undefined) return;
    const blob = new Blob([body], { type: "application/json" });
    if (typeof navigator.sendBeacon !== "function" || !navigator.sendBeacon(WEB_VITALS_ENDPOINT, blob)) {
      void fetch(WEB_VITALS_ENDPOINT, { method: "POST", body, keepalive: true, headers: { "content-type": "application/json" } })
        .catch(() => undefined);
    }
  });
  return null;
}
