import { translate } from "@kisantractor/i18n";

import { Card } from "../../../components/ui";
import { RouteSurface } from "../../../components/shell";
import { loadLocale } from "../../../lib/server-context";

export default async function OnboardingPage() {
  const locale = await loadLocale();
  return (
    <RouteSurface title={translate(locale, "shell.onboarding")}>
      <p className="kt-route-surface__lead">{translate(locale, "shell.chooseJourney")}</p>
      <div className="kt-role-grid">
        <Card title={translate(locale, "shell.farmer")}>
          <p>{translate(locale, "shell.farmerWelcome")}</p>
          <a className="kt-button kt-button--primary" href="/login?role=farmer">{translate(locale, "control.continue")}</a>
        </Card>
        <Card title={translate(locale, "shell.owner")}>
          <p>{translate(locale, "shell.ownerWelcome")}</p>
          <a className="kt-button kt-button--primary" href="/login?role=owner">{translate(locale, "control.continue")}</a>
        </Card>
      </div>
    </RouteSurface>
  );
}
