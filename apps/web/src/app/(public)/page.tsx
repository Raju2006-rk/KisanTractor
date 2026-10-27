import type { Metadata } from "next";
import { headers } from "next/headers";

import { LandingPage, landingMetadata, prefersDataSaver } from "../../components/landing";
import { loadLocale, runtimeConfig } from "../../lib/server-context";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await loadLocale();
  return landingMetadata(locale, runtimeConfig().publicWebOrigin);
}

export default async function PublicHome() {
  const [locale, requestHeaders] = await Promise.all([loadLocale(), headers()]);
  const config = runtimeConfig();

  return (
    <LandingPage
      bookingNumber={config.telephonyBookingNumber}
      dataSaver={prefersDataSaver(requestHeaders.get("save-data"))}
      locale={locale}
      telephony={config.capabilities.TELEPHONY}
    />
  );
}
