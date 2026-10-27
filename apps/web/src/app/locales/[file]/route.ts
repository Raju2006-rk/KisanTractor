import { catalogLocales, defaultCatalogs, isCatalogLocale } from "@kisantractor/i18n";

export const dynamic = "force-static";
export const dynamicParams = false;

export function generateStaticParams() {
  return catalogLocales.map((locale) => ({ file: `${locale}.json` }));
}

/** Public, cacheable translation catalogs. They contain UI copy only and never user data. */
export async function GET(
  _request: Request,
  { params }: { readonly params: Promise<{ readonly file: string }> },
): Promise<Response> {
  const { file } = await params;
  const locale = file.endsWith(".json") ? file.slice(0, -".json".length) : "";
  if (!isCatalogLocale(locale)) {
    return Response.json({ error: "NOT_FOUND" }, { status: 404, headers: { "cache-control": "no-store" } });
  }
  return Response.json(defaultCatalogs[locale], {
    headers: {
      "cache-control": "public, max-age=3600, stale-while-revalidate=86400",
      "x-content-type-options": "nosniff",
    },
  });
}
