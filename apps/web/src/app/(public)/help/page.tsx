import { translate } from "@kisantractor/i18n";
import { PhoneBookingDetails, phoneBookingPresentation } from "../../../components/landing";
import { Card } from "../../../components/ui";
import { RouteSurface } from "../../../components/shell";
import { loadLocale, runtimeConfig } from "../../../lib/server-context";
export default async function HelpPage() {
  const locale = await loadLocale();
  const config = runtimeConfig();
  const phone = phoneBookingPresentation(config.capabilities.TELEPHONY, config.telephonyBookingNumber);
  return (
    <RouteSurface title={translate(locale, "help.title")}>
      <div className="kt-help-grid">
        {["help.gettingStarted", "help.booking", "help.payment", "help.contactSupport"].map((key) => (
          <Card key={key} title={translate(locale, key)}><p>{translate(locale, "shell.routePending")}</p></Card>
        ))}
        <Card data-capability-state={phone.displayState} id="phone-booking" title={translate(locale, "landing.phone.title")}>
          <PhoneBookingDetails locale={locale} presentation={phone} />
        </Card>
      </div>
    </RouteSurface>
  );
}
