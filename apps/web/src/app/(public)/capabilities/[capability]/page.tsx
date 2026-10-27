import { notFound } from "next/navigation";

import { phoneBookingPresentation } from "../../../../components/landing";
import { CapabilityUnavailable, RouteSurface } from "../../../../components/shell";
import { loadLocale, runtimeConfig } from "../../../../lib/server-context";

type CapabilityKey = keyof ReturnType<typeof runtimeConfig>["capabilities"];

const capabilities: Readonly<Record<string, readonly [string, CapabilityKey]>> = {
  otp: ["OTP", "OTP"],
  maps: ["Maps and geocoding", "MAPS_GEOCODING"],
  payment: ["Online payment", "ONLINE_PAYMENT"],
  messaging: ["Messaging", "MESSAGING"],
  storage: ["Document storage", "OBJECT_STORAGE"],
  telephony: ["Phone booking", "TELEPHONY"],
};

interface CapabilityPageProps {
  readonly params: Promise<{ capability: string }>;
}

export default async function CapabilityPage({ params }: CapabilityPageProps) {
  const [{ capability }, locale] = await Promise.all([params, loadLocale()]);
  const definition = capabilities[capability];
  if (!definition) notFound();
  const [name, key] = definition;
  const config = runtimeConfig();
  const projection = config.capabilities[key];
  // Telephony reads as live only with a valid configured number, matching the landing page.
  const presentation = key === "TELEPHONY"
    ? { ...projection, state: phoneBookingPresentation(projection, config.telephonyBookingNumber).displayState }
    : projection;

  return (
    <RouteSurface title={name}>
      <CapabilityUnavailable capabilityName={name} locale={locale} presentation={presentation} />
    </RouteSurface>
  );
}
