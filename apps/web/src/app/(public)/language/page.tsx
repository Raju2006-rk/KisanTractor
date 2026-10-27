import { catalogLocales, localeMetadata, translate } from "@kisantractor/i18n";

import { RouteSurface } from "../../../components/shell";
import { loadLocale } from "../../../lib/server-context";
import { selectLanguage } from "./actions";

export default async function LanguagePage() {
  const locale = await loadLocale();
  return (
    <RouteSurface title={translate(locale, "control.chooseLanguage")}>
      <form action={selectLanguage} className="kt-language-form">
        <fieldset>
          <legend>{translate(locale, "control.chooseLanguage")}</legend>
          {catalogLocales.map((option) => (
            <label className="kt-language-option" key={option}>
              <input defaultChecked={locale === option} name="locale" type="radio" value={option} />
              <span lang={localeMetadata[option].intlLocale}>{localeMetadata[option].nativeName}</span>
            </label>
          ))}
        </fieldset>
        <input name="returnTo" type="hidden" value="/" />
        <button className="kt-button kt-button--primary" type="submit">{translate(locale, "control.save")}</button>
      </form>
    </RouteSurface>
  );
}
