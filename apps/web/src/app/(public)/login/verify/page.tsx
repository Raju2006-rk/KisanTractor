import { translate } from "@kisantractor/i18n";
import { notFound } from "next/navigation";
import { CapabilityUnavailable, RouteSurface } from "../../../../components/shell";
import { StatusChip, TextInput } from "../../../../components/ui";
import { loadLocale, runtimeConfig } from "../../../../lib/server-context";
interface VerifyPageProps {
  readonly searchParams: Promise<{ challengeId?: string; role?: string; error?: string; phone?: string; devCode?: string }>;
}
export default async function VerifyPage({ searchParams }: VerifyPageProps) {
  const [locale, query] = await Promise.all([loadLocale(), searchParams]);
  if (!query.challengeId || (query.role !== "farmer" && query.role !== "owner")) notFound();
  const otp = runtimeConfig().capabilities.OTP;
  return (
    <RouteSurface title={translate(locale, "shell.verifyCode")}>
      {otp.isOperational ? (
        <form action="/api/auth/verify-otp" className="kt-auth-form" method="post">
          {otp.isTest ? <StatusChip tone="info">{translate(locale, "capability.sandboxLabel")}</StatusChip> : null}
          <input name="challengeId" type="hidden" value={query.challengeId} />
          <input name="role" type="hidden" value={query.role} />
          <TextInput
            autoComplete="tel"
            defaultValue={query.phone ?? ""}
            id="phone"
            inputMode="tel"
            label={translate(locale, "form.mobileNumber")}
            name="phone"
            required
            type="tel"
          />
          <TextInput
            autoComplete="one-time-code"
            defaultValue={query.devCode ?? ""}
            id="code"
            inputMode="numeric"
            label={translate(locale, "shell.otpCode")}
            name="code"
            required
            type="text"
          />
          {query.devCode ? (
            <p className="kt-field__hint">
              {translate(locale, "capability.sandboxLabel")}: <strong>{query.devCode}</strong>
            </p>
          ) : null}
          {query.error ? <p className="kt-field__error" role="alert">{translate(locale, "shell.loginError")}</p> : null}
          <button className="kt-button kt-button--primary" type="submit">{translate(locale, "control.confirm")}</button>
        </form>
      ) : (
        <CapabilityUnavailable capabilityName="OTP" locale={locale} presentation={otp} />
      )}
    </RouteSurface>
  );
}
