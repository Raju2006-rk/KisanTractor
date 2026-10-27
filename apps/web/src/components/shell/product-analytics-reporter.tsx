"use client";

import {
  PRODUCT_ANALYTICS_ENDPOINT,
  productAnalyticsBeaconBody,
  type ProductAnalyticsEvent,
  type ProductAnalyticsLocale,
} from "@kisantractor/observability/product-analytics";
import { usePathname } from "next/navigation";
import { useEffect } from "react";

export interface ProductAnalyticsReporterProps {
  readonly locale: ProductAnalyticsLocale;
}

export type ProductAnalyticsTransport = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<unknown>;

/** Sends a deliberately credential-free analytics request and treats telemetry failure as non-authoritative. */
export async function sendProductAnalytics(
  event: ProductAnalyticsEvent,
  pathname: string,
  locale: ProductAnalyticsLocale,
  transport: ProductAnalyticsTransport = fetch,
): Promise<void> {
  try {
    await transport(PRODUCT_ANALYTICS_ENDPOINT, {
      method: "POST",
      body: productAnalyticsBeaconBody(event, pathname, locale),
      credentials: "omit",
      referrerPolicy: "no-referrer",
      keepalive: true,
      headers: { "content-type": "application/json" },
    });
  } catch {
    // Analytics never changes or blocks the product workflow.
  }
}

/**
 * Sends one anonymous, coarse page-view event after navigation. The request deliberately omits
 * cookies and referrer data; concrete paths and query strings never leave the browser.
 */
export function ProductAnalyticsReporter({ locale }: ProductAnalyticsReporterProps) {
  const pathname = usePathname();
  useEffect(() => {
    const event = pathname === "/owner/earnings" ? "OWNER_EARNINGS_VIEWED"
      : pathname === "/owner/payments" || pathname === "/farmer/payments" ? "PAYMENT_HISTORY_VIEWED"
        : "PAGE_VIEW";
    void sendProductAnalytics(event, pathname, locale);
  }, [locale, pathname]);
  return null;
}
