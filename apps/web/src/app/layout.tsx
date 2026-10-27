import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { localeMetadata } from "@kisantractor/i18n";
import { ProductAnalyticsReporter, ServiceWorkerRegistrar, WebVitalsReporter } from "../components/shell";
import { shouldRegisterServiceWorker } from "../lib/pwa-registration";
import { loadLocale, runtimeConfig } from "../lib/server-context";
import "./globals.css";
export const metadata: Metadata = {
  title: "KisanTractor",
  description: "Book trusted tractor services for agricultural work.",
  applicationName: "KisanTractor",
  manifest: "/manifest.webmanifest",
};
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#006b3a",
};
/** The worker is optional: any configuration problem leaves plain browser flows in place. */
function serviceWorkerEnabled(): boolean {
  try {
    return shouldRegisterServiceWorker(runtimeConfig());
  } catch {
    return false;
  }
}
export default async function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  const locale = await loadLocale();
  return (
    <html lang={localeMetadata[locale].intlLocale}>
      <body>
        {children}
        <ProductAnalyticsReporter locale={locale} />
        <ServiceWorkerRegistrar enabled={serviceWorkerEnabled()} />
        {/* Anonymous vital/rating/route-group beacons only; see ops/observability. */}
        <WebVitalsReporter enabled />
      </body>
    </html>
  );
}
