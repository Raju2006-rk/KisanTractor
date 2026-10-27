import { webRouteGroup } from "./web-vitals.js";
import { productAnalyticsEvents, webRouteGroups, type WebRouteGroup } from "./metrics.js";

export type ProductAnalyticsEvent = (typeof productAnalyticsEvents)[number];

export type ProductAnalyticsLocale = "en" | "hi" | "te" | "kn" | "ta" | "mr" | "bn";
const productAnalyticsLocales = ["en", "hi", "te", "kn", "ta", "mr", "bn"] as const satisfies readonly ProductAnalyticsLocale[];

export const PRODUCT_ANALYTICS_ENDPOINT = "/api/telemetry/product-analytics";
export interface ProductAnalyticsReport {
  readonly event: ProductAnalyticsEvent;
  readonly surface: WebRouteGroup;
  readonly locale: ProductAnalyticsLocale;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Privacy boundary for product analytics. Reports are accepted only when they contain exactly
 * three bounded dimensions; IDs, paths, query strings, free text, and arbitrary properties fail.
 */
export function parseProductAnalyticsReport(value: unknown): ProductAnalyticsReport | undefined {
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== "event,locale,surface") return undefined;
  if (typeof value.event !== "string" || !(productAnalyticsEvents as readonly string[]).includes(value.event)) return undefined;
  if (typeof value.surface !== "string" || !(webRouteGroups as readonly string[]).includes(value.surface)) return undefined;
  if (typeof value.locale !== "string" || !(productAnalyticsLocales as readonly string[]).includes(value.locale)) return undefined;
  return Object.freeze({
    event: value.event as ProductAnalyticsEvent,
    surface: value.surface as WebRouteGroup,
    locale: value.locale as ProductAnalyticsLocale,
  });
}

/** Builds the only payload a browser may send; the concrete URL never leaves the browser. */
export function productAnalyticsBeaconBody(
  event: ProductAnalyticsEvent,
  pathname: string,
  locale: ProductAnalyticsLocale,
): string {
  return JSON.stringify({ event, surface: webRouteGroup(pathname), locale });
}
