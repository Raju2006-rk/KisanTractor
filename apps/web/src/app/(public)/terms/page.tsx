import { translate } from "@kisantractor/i18n";

import { RouteSurface } from "../../../components/shell";
import { loadLocale } from "../../../lib/server-context";

export default async function TermsPage() {
  const locale = await loadLocale();
  return (
    <RouteSurface title={translate(locale, "landing.footer.terms")}>
      <p className="kt-route-surface__lead">{translate(locale, "legal.pending")}</p>
      <a className="kt-text-link" href="/help">{translate(locale, "help.contactSupport")}</a>
    </RouteSurface>
  );
}
