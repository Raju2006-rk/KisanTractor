import { translate, type CatalogLocale, type MessageKey } from "@kisantractor/i18n";

/** Footer destinations required on public pages; every href is a first-party route. */
export const publicFooterLinks = [
  ["/help", "menu.help"],
  ["/language", "control.chooseLanguage"],
  ["/login?role=farmer", "shell.login"],
  ["/login?role=owner", "landing.cta.registerOwner"],
  ["/privacy", "landing.footer.privacy"],
  ["/terms", "landing.footer.terms"],
] as const satisfies readonly (readonly [string, MessageKey])[];

export function PublicFooter({ locale }: { readonly locale: CatalogLocale }) {
  return (
    <footer className="kt-public-footer">
      <div className="kt-public-footer__inner">
        <div className="kt-public-footer__brand">
          <p className="kt-public-footer__name">{translate(locale, "app.name")}</p>
          <p>{translate(locale, "landing.footer.tagline")}</p>
        </div>
        <nav aria-label={translate(locale, "landing.footer.label")}>
          <ul className="kt-public-footer__links">
            {publicFooterLinks.map(([href, key]) => (
              <li key={href}><a href={href}>{translate(locale, key)}</a></li>
            ))}
          </ul>
        </nav>
      </div>
    </footer>
  );
}
