import { describe, expect, it } from "vitest";
import { catalogLocales, defaultCatalogs, translate } from "@kisantractor/i18n";
import nextConfig from "../../next.config";
import { classifyPwaRequest, isStorablePwaResponse, pwaCachePolicy } from "../lib/pwa-cache-policy";
import { buildServiceWorkerScript } from "../lib/pwa-service-worker";
import { GET as getCatalog, generateStaticParams } from "./locales/[file]/route";
import { GET as getOfflinePage } from "./offline.html/route";
import { GET as getServiceWorker } from "./sw.js/route";

const origin = "https://kisantractor.test";
const storable = (path: string, response: Response) => {
  const decision = classifyPwaRequest(pwaCachePolicy, { method: "GET", url: `${origin}${path}` }, origin);
  return decision.action === "cache" && isStorablePwaResponse(decision.contentTypePattern, response);
};
const catalogRequest = (file: string) =>
  getCatalog(new Request(`${origin}/locales/${file}`), { params: Promise.resolve({ file }) });

/** Validates: Requirements 17.2, 17.5 */
describe("PWA routes", () => {
  it("serves the generated worker as always-revalidated JavaScript", async () => {
    const response = getServiceWorker();
    expect(response.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-cache, max-age=0, must-revalidate");
    expect(response.headers.get("service-worker-allowed")).toBe("/");
    expect(await response.text()).toBe(buildServiceWorkerScript());
  });

  it("publishes every translation catalog as a public, cacheable JSON resource", async () => {
    expect(generateStaticParams()).toEqual(catalogLocales.map((locale) => ({ file: `${locale}.json` })));
    for (const locale of catalogLocales) {
      const response = await catalogRequest(`${locale}.json`);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toContain("public");
      expect(storable(`/locales/${locale}.json`, response.clone())).toBe(true);
      expect(await response.json()).toEqual(defaultCatalogs[locale]);
    }
  });

  it("rejects unknown catalogs without making them cacheable", async () => {
    for (const file of ["xx.json", "en", "../en.json"]) {
      const response = await catalogRequest(file);
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("serves a shared, storable offline page with localized retry guidance and no session data", async () => {
    const response = getOfflinePage();
    expect(storable("/offline.html", response.clone())).toBe(true);
    const html = await response.text();
    for (const locale of catalogLocales) {
      expect(html).toContain(translate(locale, "help.offline"));
      expect(html).toContain(translate(locale, "control.retry"));
    }
    expect(html).toContain('name="viewport"');
    expect(html).not.toMatch(/<script|kt_access_token|Bearer/i);
  });

  it("marks same-origin API responses as private and non-storable for shared caches", async () => {
    const rules = (await nextConfig.headers?.()) ?? [];
    expect(rules).toContainEqual({
      source: "/api/:path*",
      headers: [{ key: "Cache-Control", value: "private, no-store, max-age=0" }],
    });
  });
});
