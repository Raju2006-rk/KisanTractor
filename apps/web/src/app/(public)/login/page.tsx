import { translate } from "@kisantractor/i18n";

import { CapabilityUnavailable, RouteSurface } from "../../../components/shell";
import { StatusChip, TextInput } from "../../../components/ui";
import { loadLocale, runtimeConfig } from "../../../lib/server-context";

interface LoginPageProps {
  readonly searchParams: Promise<{ role?: string; error?: string; reason?: string }>;
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const [locale, query] = await Promise.all([loadLocale(), searchParams]);
  const role = query.role === "owner" ? "owner" : "farmer";
  const otp = runtimeConfig().capabilities.OTP;

  return (
    <RouteSurface title={translate(locale, "shell.login")}>
      <p className="kt-route-surface__lead">{translate(locale, role === "owner" ? "shell.ownerWelcome" : "shell.farmerWelcome")}</p>
      {otp.isOperational ? (
        <form action="/api/auth/request-otp" className="kt-auth-form" method="post">
          {otp.isTest ? <StatusChip tone="info">{translate(locale, "capability.sandboxLabel")}</StatusChip> : null}
          <input name="role" type="hidden" value={role} />
          <input name="locale" type="hidden" value={locale} />
          <TextInput autoComplete="tel" id="phone" inputMode="tel" label={translate(locale, "form.mobileNumber")} name="phone" required type="tel" />
          <p className="kt-field__hint">{translate(locale, "shell.mobileHint")}</p>
          {query.error ? <p className="kt-field__error" role="alert">{translate(locale, "shell.loginError")}</p> : null}
          <button className="kt-button kt-button--primary" type="submit">{translate(locale, "control.continue")}</button>
        </form>
      ) : (
        <CapabilityUnavailable capabilityName="OTP" locale={locale} presentation={otp} />
      )}
    </RouteSurface>
  );
}
