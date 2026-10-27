import { catalogLocales, localeMetadata, translate } from "@kisantractor/i18n";

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);

/**
 * Static offline fallback shown by the service worker when a page cannot load.
 * It is identical for every visitor, holds no session or booking data, and its
 * retry link simply reloads the address the person was trying to open.
 */
export function buildOfflinePage(): string {
  const sections = catalogLocales
    .map((locale) => {
      const lang = escapeHtml(localeMetadata[locale].intlLocale);
      return `<section lang="${lang}"><p>${escapeHtml(translate(locale, "help.offline"))}</p>` +
        `<a class="retry" href="">${escapeHtml(translate(locale, "control.retry"))}</a></section>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#006b3a">
<title>${escapeHtml(translate("en", "app.name"))}</title>
<style>
body{margin:0;font-family:system-ui,sans-serif;background:#fffdf7;color:#102f25;line-height:1.5}
main{max-width:40rem;margin:0 auto;padding:1.5rem 1rem}
h1{color:#006b3a;font-size:1.5rem}
section{border:1px solid #b9c9bf;border-radius:12px;background:#fff;padding:1rem;margin:0 0 1rem}
p{margin:0 0 .75rem;font-size:1.0625rem}
.retry{display:inline-block;min-height:44px;line-height:44px;padding:0 1.25rem;border-radius:10px;background:#006b3a;color:#fff;font-weight:600;text-decoration:none}
.retry:focus-visible{outline:3px solid #075fbd;outline-offset:2px}
</style>
</head>
<body>
<main>
<h1>${escapeHtml(translate("en", "app.name"))}</h1>
${sections}
</main>
</body>
</html>
`;
}
