import { localeMetadata, translate, type CatalogLocale } from "@kisantractor/i18n";
import type { Metadata } from "next";

import { landingImages } from "./landing-page";

/** Open Graph writes locales as `language_TERRITORY`. */
export function openGraphLocale(locale: CatalogLocale): string {
  return localeMetadata[locale].intlLocale.replace("-", "_");
}

/**
 * Localized document metadata for the landing route. The page is served at one
 * URL for every language (the locale comes from a cookie), so the canonical URL
 * is always `/`. The share image is the committed hero crop; nothing is
 * hotlinked. Phone-number auto-detection is off so no browser turns digits on
 * the page into a call link while telephony is unavailable.
 */
export function landingMetadata(locale: CatalogLocale, webOrigin: string): Metadata {
  const siteName = translate(locale, "app.name");
  const title = `${translate(locale, "landing.hero.title")} | ${siteName}`;
  const description = translate(locale, "landing.hero.lead");
  const hero = landingImages.hero;
  return {
    metadataBase: new URL(webOrigin),
    title: { absolute: title },
    description,
    alternates: { canonical: "/" },
    formatDetection: { telephone: false, address: false, email: false },
    openGraph: {
      type: "website",
      url: "/",
      siteName,
      title,
      description,
      locale: openGraphLocale(locale),
      images: [{
        url: `${hero.base}-${hero.widths[1]}.webp`,
        width: hero.width,
        height: hero.height,
        alt: translate(locale, "landing.hero.imageAlt"),
        type: "image/webp",
      }],
    },
  };
}
