import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { catalogLocales, localeMetadata, translate, type CatalogLocale } from "@kisantractor/i18n";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { contrastRatio } from "../../../quality/contrast";
import { imageSize } from "../../../quality/image-size";
import {
  accessibilityThresholds,
  allDeviceProfiles,
  deviceProfiles,
  landingAssetBudgets,
  percentile,
  representativeMobileProfile,
  slow4g,
  webVitalBudgets,
} from "../../../quality/profiles";
import { pageRouteExists } from "../../../quality/routes";
import { cssLengthToPx, Stylesheet } from "../../../quality/stylesheet";
import RootLayout, { metadata as rootMetadata, viewport as rootViewport } from "../../app/layout";
import manifest from "../../app/manifest";
import { generateMetadata as landingRouteMetadata } from "../../app/(public)/page";
import { AppShell } from "../shell/app-shell";
import {
  LandingPage,
  landingImages,
  openGraphLocale,
  phoneBookingPresentation,
  PublicFooter,
  type PhoneBookingCapability,
} from ".";

const serverContext = vi.hoisted(() => ({ locale: "en" as CatalogLocale }));
const webOrigin = "https://kisantractor.example";

vi.mock("next/navigation", () => ({ usePathname: () => "/" }));
vi.mock("../../lib/server-context", async () => {
  const { getPublicRuntimeConfig, validateEnvironment } = await import("@kisantractor/config");
  const config = getPublicRuntimeConfig(validateEnvironment({ APP_ENV: "test", NODE_ENV: "test", PUBLIC_WEB_ORIGIN: "https://kisantractor.example" }));
  return { loadLocale: async () => serverContext.locale, runtimeConfig: () => config };
});

const stylesheet = Stylesheet.fromFile(new URL("../../app/globals.css", import.meta.url));
const publicDirectory = new URL("../../../public/", import.meta.url);
const configuredNumber = "+919876543210";

const capabilityCases: readonly (readonly [PhoneBookingCapability, string | null])[] = [
  [{ state: "UNCONFIGURED", isLive: false }, null],
  [{ state: "SANDBOX", isLive: false }, configuredNumber],
  [{ state: "DEGRADED", isLive: false }, configuredNumber],
  [{ state: "LIVE", isLive: true }, null],
  [{ state: "LIVE", isLive: true }, configuredNumber],
];

function landingDocument(locale: CatalogLocale, telephony: PhoneBookingCapability = { state: "UNCONFIGURED", isLive: false }, bookingNumber: string | null = null) {
  return renderToStaticMarkup(createElement(AppShell, {
    locale,
    role: "PUBLIC",
    footer: createElement(PublicFooter, { locale }),
    children: createElement(LandingPage, { locale, telephony, bookingNumber }),
  }));
}

const decode = (value: string) => value.replaceAll("&amp;", "&").replaceAll("&quot;", '"');
const attributeValues = (markup: string, attribute: string) =>
  [...markup.matchAll(new RegExp(`\\s${attribute}="([^"]*)"`, "g"))].map((match) => decode(match[1]!));
const anchors = (markup: string) => [...markup.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map((match) => ({
  attributes: match[1]!,
  href: decode(/\shref="([^"]*)"/.exec(match[1]!)?.[1] ?? ""),
  className: /\sclass="([^"]*)"/.exec(match[1]!)?.[1] ?? null,
  inner: match[2]!,
}));
const textWithoutDecorations = (inner: string) => inner
  .replace(/<([a-z]+)[^>]*aria-hidden="true"[^>]*>[\s\S]*?<\/\1>/g, " ")
  .replace(/<[^>]+>/g, " ")
  .replace(/\s+/g, " ")
  .trim();
const fileBytes = (path: string) => statSync(new URL(`.${path}`, publicDirectory)).size;

/** Validates: Requirements 13.5, 16.6, 17.1 */
describe("representative device profiles", () => {
  it("covers low-end mobile, the narrowest phone, tablet, laptop, desktop, and 200% zoom", () => {
    const ids = allDeviceProfiles.map((profile) => profile.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(allDeviceProfiles.map((profile) => profile.kind))).toEqual(new Set(["mobile", "tablet", "laptop", "desktop"]));
    expect(Math.min(...allDeviceProfiles.map((profile) => profile.width))).toBe(320);
    expect(deviceProfiles.desktopZoom200).toMatchObject({ width: 1280 / 2, height: 800 / 2, deviceScaleFactor: 2, zoom: 2 });
  });

  it("measures web vitals on a 360 px phone with a 4× slower CPU on slow 4G", () => {
    expect(representativeMobileProfile).toMatchObject({ width: 360, height: 640, mobile: true, cpuSlowdown: 4, network: slow4g });
    expect(webVitalBudgets).toEqual({ lcpMs: 2500, cls: 0.1, inpMs: 200, tbtMs: 200 });
    expect(percentile([3, 1, 2], 0.75)).toBe(3);
    expect(percentile([4, 1, 3, 2], 0.75)).toBe(3);
  });
});

/** Validates: Requirements 13.4, 16.6 */
describe("landing document metadata", () => {
  it("declares a zoomable device-width viewport, brand theme color, and the web manifest", () => {
    expect(rootViewport).toMatchObject({ width: "device-width", initialScale: 1 });
    expect(rootViewport).not.toHaveProperty("maximumScale");
    expect(rootViewport).not.toHaveProperty("userScalable");
    expect(rootViewport.themeColor).toBe(stylesheet.tokens.get("--kt-color-primary"));
    expect(rootMetadata).toMatchObject({ applicationName: "KisanTractor", manifest: "/manifest.webmanifest" });
    expect(manifest()).toMatchObject({ start_url: "/", display: "standalone", theme_color: rootViewport.themeColor });
  });

  it("sets the document language from the visitor's locale", async () => {
    for (const locale of catalogLocales) {
      serverContext.locale = locale;
      const markup = renderToStaticMarkup(await RootLayout({ children: createElement("p", null, "content") }));
      expect(markup).toMatch(new RegExp(`^<html lang="${localeMetadata[locale].intlLocale}">`));
    }
  });

  it("gives the landing route a localized title, description, canonical URL, and Open Graph card", async () => {
    for (const locale of catalogLocales) {
      serverContext.locale = locale;
      const metadata = await landingRouteMetadata();
      const title = `${translate(locale, "landing.hero.title")} | ${translate(locale, "app.name")}`;
      const description = translate(locale, "landing.hero.lead");
      expect(String(metadata.metadataBase)).toBe(`${webOrigin}/`);
      expect(metadata.title).toEqual({ absolute: title });
      expect(metadata.description).toBe(description);
      expect(metadata.alternates?.canonical).toBe("/");
      expect(metadata.formatDetection).toMatchObject({ telephone: false });
      expect(metadata.openGraph).toMatchObject({ type: "website", url: "/", title, description, siteName: translate(locale, "app.name"), locale: openGraphLocale(locale) });
      expect(openGraphLocale(locale)).toMatch(/^[a-z]{2}_IN$/);
      const [image] = metadata.openGraph?.images as unknown as { url: string; width: number; height: number; alt: string }[];
      expect(image).toMatchObject({ width: landingImages.hero.width, height: landingImages.hero.height, alt: translate(locale, "landing.hero.imageAlt") });
      expect(image!.url.startsWith("/images/landing/")).toBe(true);
      expect(fileBytes(image!.url)).toBeGreaterThan(0);
    }
  });
});

/** Validates: Requirements 13.4, 16.6 */
describe("landing links", () => {
  it("links only to in-page anchors, existing first-party pages, or the live configured number", () => {
    for (const locale of catalogLocales) {
      for (const [telephony, number] of capabilityCases) {
        const markup = landingDocument(locale, telephony, number);
        const phone = phoneBookingPresentation(telephony, number);
        const links = anchors(markup).map((anchor) => anchor.href);
        expect(links.length).toBeGreaterThan(10);
        for (const href of links) {
          const label = `${locale}:${telephony.state}:${href}`;
          if (href.startsWith("#")) {
            expect(markup, label).toContain(`id="${href.slice(1)}"`);
          } else if (href.startsWith("tel:")) {
            expect(phone.available, label).toBe(true);
            expect(href, label).toBe(`tel:${phone.bookingNumber!.e164}`);
          } else {
            expect(href.startsWith("/") && !href.startsWith("//"), label).toBe(true);
            const url = new URL(href, webOrigin);
            expect(pageRouteExists(url.pathname), label).toBe(true);
            const role = url.searchParams.get("role");
            if (role !== null) expect(["farmer", "owner"], label).toContain(role);
          }
        }
        expect(links.filter((href) => href.startsWith("tel:"))).toHaveLength(phone.available ? 1 : 0);
      }
    }
  });

  it("hotlinks nothing: every URL in markup and styles is first-party", () => {
    for (const locale of catalogLocales) {
      const markup = landingDocument(locale);
      const urls = [
        ...attributeValues(markup, "href"),
        ...attributeValues(markup, "src"),
        ...attributeValues(markup, "srcSet").flatMap((value) => value.split(",").map((candidate) => candidate.trim().split(/\s+/)[0]!)),
      ];
      expect(urls.length).toBeGreaterThan(0);
      for (const url of urls) expect(url, url).not.toMatch(/^(?:[a-z][a-z0-9+.-]*:)?\/\//i);
    }
    expect(stylesheet.source).not.toMatch(/@import|url\(\s*["']?(?:https?:)?\/\//i);
  });

  it("resolves dynamic App Router segments the way Next.js does", () => {
    expect(pageRouteExists("/")).toBe(true);
    expect(pageRouteExists("/farmer/search")).toBe(true);
    expect(pageRouteExists("/capabilities/telephony")).toBe(true);
    expect(pageRouteExists("/login/verify")).toBe(true);
    expect(pageRouteExists("/does-not-exist")).toBe(false);
    expect(pageRouteExists("/api/telemetry/web-vitals")).toBe(false);
  });
});

/** Validates: Requirement 13.4 */
describe("landing semantics in every locale", () => {
  it("orders headings from one h1 without skipping levels", () => {
    for (const locale of catalogLocales) {
      const levels = [...landingDocument(locale).matchAll(/<h([1-6])\b/g)].map((match) => Number(match[1]));
      expect(levels[0]).toBe(1);
      expect(levels.filter((level) => level === 1)).toHaveLength(1);
      levels.forEach((level, index) => {
        if (index > 0) expect(level - levels[index - 1]!, `${locale} heading ${index}`).toBeLessThanOrEqual(1);
      });
    }
  });

  it("exposes banner, main, labeled navigation, and contentinfo landmarks, with labeled sections", () => {
    for (const locale of catalogLocales) {
      const markup = landingDocument(locale);
      expect(markup.match(/<header\b/g)).toHaveLength(1);
      expect(markup.match(/<main\b/g)).toHaveLength(1);
      expect(markup.match(/<footer\b/g)).toHaveLength(1);
      const navs = markup.match(/<nav\b[^>]*>/g) ?? [];
      expect(navs.length).toBeGreaterThan(0);
      for (const nav of navs) expect(nav).toMatch(/aria-label="[^"]+"/);
      for (const labelledBy of attributeValues(markup, "aria-labelledby")) {
        expect(markup).toMatch(new RegExp(`<h[1-6] id="${labelledBy}">[^<]+<`));
      }
      const [skip] = anchors(markup);
      expect(skip).toMatchObject({ href: "#main-content", className: "kt-skip-link" });
      expect(markup).toContain('id="main-content"');
    }
  });

  it("names every link with visible text and keeps icons decorative", () => {
    for (const locale of catalogLocales) {
      const markup = landingDocument(locale);
      for (const anchor of anchors(markup)) {
        expect(textWithoutDecorations(anchor.inner), anchor.href).not.toBe("");
      }
      for (const icon of markup.matchAll(/<span aria-hidden="true" class="kt-landing-(?:step__number|tile__icon|benefits__mark)">/g)) {
        // Each decorative icon is followed by a heading that carries the meaning.
        const following = markup.slice(icon.index!, icon.index! + 400);
        expect(following).toMatch(/<\/span>(?:<div>)?<h3>[^<]+<\/h3>/);
      }
      for (const image of markup.match(/<img\b[^>]*>/g) ?? []) expect(image).toMatch(/alt="[^"]{10,}"/);
    }
  });

  it("styles every landing link as a target of at least 44 CSS pixels", () => {
    const min = accessibilityThresholds.minTargetPx;
    expect(cssLengthToPx(stylesheet.tokens.get("--kt-target-min")!)).toBe(min);
    for (const selector of [".kt-button", ".kt-brand", ".kt-app-header__actions a", ".kt-public-footer__links a"]) {
      expect(cssLengthToPx(stylesheet.value(selector, "min-height")), selector).toBeGreaterThanOrEqual(min);
    }
    expect(cssLengthToPx(stylesheet.value(".kt-button", "min-width"))).toBeGreaterThanOrEqual(min);
    const markup = landingDocument("en", { state: "LIVE", isLive: true }, configuredNumber);
    const header = markup.slice(markup.indexOf('<div class="kt-app-header__actions">'), markup.indexOf("</header>"));
    const footer = markup.slice(markup.indexOf('<ul class="kt-public-footer__links">'), markup.indexOf("</footer>"));
    for (const anchor of anchors(markup)) {
      const covered = anchor.className === "kt-skip-link"
        || anchor.className === "kt-brand"
        || /\bkt-button\b/.test(anchor.className ?? "")
        || (anchor.className === null && (header.includes(anchor.attributes) || footer.includes(anchor.attributes)));
      expect(covered, anchor.href).toBe(true);
    }
  });

  it("keeps text at a readable size, ignoring only decorative symbols", () => {
    const scoped = /^(?:\.kt-landing|\.kt-public-footer|\.kt-app-header|\.kt-brand|\.kt-status|\.kt-button|html|body)/;
    const decorative = /__(?:symbol|icon)\b/;
    let checked = 0;
    for (const rule of stylesheet.rules) {
      if (!rule.selectors.some((selector) => scoped.test(selector) && !decorative.test(selector))) continue;
      const size = /(?:^|[;\s])font-size\s*:\s*([^;]+)/.exec(rule.body)?.[1]?.trim();
      if (!size) continue;
      const smallest = /^clamp\(([^,]+),/.exec(size)?.[1]?.trim() ?? size;
      if (/em$/.test(smallest) && !/rem$/.test(smallest)) continue;
      expect(cssLengthToPx(smallest), rule.selectors.join(", ")).toBeGreaterThanOrEqual(accessibilityThresholds.minFontPx);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(8);
  });
});

/** Validates: Requirement 13.4 */
describe("green and cream token contrast", () => {
  type Color = readonly [selector: string, property: string];
  const textPairs: readonly (readonly [name: string, foreground: Color, background: Color])[] = [
    ["body text on page", ["body", "color"], ["body", "background"]],
    ["lead text on page", [".kt-landing__lead", "color"], ["body", "background"]],
    ["eyebrow on page", [".kt-landing__eyebrow", "color"], ["body", "background"]],
    ["card body text", [".kt-landing-step p", "color"], [".kt-landing-step", "background"]],
    ["Owner benefit text", [".kt-landing-benefits p", "color"], [".kt-landing-owner", "background"]],
    ["pricing note", ["body", "color"], [".kt-landing__note", "background"]],
    ["hero eyebrow", [".kt-landing-hero .kt-landing__eyebrow", "color"], [".kt-landing-hero", "background"]],
    ["hero lead", [".kt-landing-hero .kt-landing__lead", "color"], [".kt-landing-hero", "background"]],
    ["hero heading", [".kt-landing-hero h1", "color"], [".kt-landing-hero", "background"]],
    ["inverse primary button", [".kt-landing-actions--inverse .kt-button--primary", "color"], [".kt-landing-actions--inverse .kt-button--primary", "background"]],
    ["inverse primary button hover", [".kt-landing-actions--inverse .kt-button--primary", "color"], [".kt-landing-actions--inverse .kt-button--primary:hover:not(:disabled)", "background"]],
    ["inverse secondary button on hero", [".kt-landing-actions--inverse .kt-button--secondary", "color"], [".kt-landing-hero", "background"]],
    ["inverse secondary button on final CTA", [".kt-landing-actions--inverse .kt-button--secondary", "color"], [".kt-landing-final", "background"]],
    ["inverse secondary button hover", [".kt-landing-actions--inverse .kt-button--secondary", "color"], [".kt-landing-actions--inverse .kt-button--secondary:hover:not(:disabled)", "background"]],
    ["final CTA text", [".kt-landing-final", "color"], [".kt-landing-final", "background"]],
    ["primary button", [".kt-button--primary", "color"], [".kt-button--primary", "background"]],
    ["primary button hover", [".kt-button--primary", "color"], [".kt-button--primary:hover:not(:disabled)", "background"]],
    ["primary button active", [".kt-button--primary", "color"], [".kt-button--primary:active:not(:disabled)", "background"]],
    ["secondary button", [".kt-button--secondary", "color"], [".kt-button--secondary", "background"]],
    ["secondary button hover", [".kt-button--secondary", "color"], [".kt-button--secondary:hover:not(:disabled)", "background"]],
    ["step number", [".kt-landing-step__number", "color"], [".kt-landing-step__number", "background"]],
    ["price symbol", [".kt-landing-tile--price .kt-landing-tile__icon", "color"], [".kt-landing-tile--price .kt-landing-tile__icon", "background"]],
    ["benefit check mark", [".kt-landing-benefits__mark", "color"], [".kt-landing-benefits__mark", "background"]],
    ["language chip", ["body", "color"], [".kt-landing-languages li", "background"]],
    ["current language chip", [".kt-landing-languages li[aria-current=\"true\"]", "color"], [".kt-landing-languages li[aria-current=\"true\"]", "background"]],
    ["phone booking text", ["body", "color"], [".kt-landing-phone", "background"]],
    ["header links", [".kt-brand", "color"], [".kt-app-header", "background"]],
    ["skip link", [".kt-skip-link", "color"], [".kt-skip-link", "background"]],
    ["footer text", [".kt-public-footer p", "color"], [".kt-public-footer", "background"]],
    ["footer name", [".kt-public-footer .kt-public-footer__name", "color"], [".kt-public-footer", "background"]],
    ["footer links", [".kt-public-footer__links a", "color"], [".kt-public-footer", "background"]],
    ...(["success", "warning", "danger", "info", "neutral"] as const).map((tone) =>
      [`${tone} status chip`, [`.kt-status--${tone}`, "color"], [`.kt-status--${tone}`, "background"]] as const),
  ];

  it.each(textPairs)("%s meets WCAG 2.2 AA text contrast (4.5:1)", (_name, [fgSelector, fgProperty], [bgSelector, bgProperty]) => {
    const [foreground] = stylesheet.colors(fgSelector, fgProperty);
    const backgrounds = stylesheet.colors(bgSelector, bgProperty);
    for (const background of backgrounds) {
      expect(contrastRatio(foreground!, background), `${foreground} on ${background}`).toBeGreaterThanOrEqual(accessibilityThresholds.textContrast);
    }
  });

  it("draws a focus ring at least 2 px thick with 3:1 contrast against every surface it sits on", () => {
    const outline = stylesheet.value(":focus-visible", "outline");
    expect(outline).toMatch(/solid/);
    expect(cssLengthToPx(outline.split(/\s+/)[0]!)).toBeGreaterThanOrEqual(accessibilityThresholds.minFocusOutlinePx);
    const [focus] = stylesheet.colors(":focus-visible", "outline");
    const lightSurfaces = [
      ...stylesheet.colors("body", "background"),
      ...stylesheet.colors(".kt-landing-step", "background"),
      ...stylesheet.colors(".kt-landing-owner", "background"),
      ...stylesheet.colors(".kt-public-footer", "background"),
      ...stylesheet.colors(".kt-app-header", "background"),
    ];
    for (const surface of lightSurfaces) expect(contrastRatio(focus!, surface), surface).toBeGreaterThanOrEqual(accessibilityThresholds.nonTextContrast);
    for (const [section, override] of [[".kt-landing-hero", ".kt-landing-hero :focus-visible"], [".kt-landing-final", ".kt-landing-final :focus-visible"]] as const) {
      const [ring] = stylesheet.colors(override, "outline-color");
      for (const surface of stylesheet.colors(section, "background")) {
        expect(contrastRatio(ring!, surface), `${override} on ${surface}`).toBeGreaterThanOrEqual(accessibilityThresholds.nonTextContrast);
      }
    }
  });

  it("keeps the secondary button boundary visible against the page", () => {
    const [border] = stylesheet.colors(".kt-button--secondary", "border-color");
    expect(contrastRatio(border!, stylesheet.colors("body", "background")[0]!)).toBeGreaterThanOrEqual(accessibilityThresholds.nonTextContrast);
  });
});

/** Validates: Requirements 13.5, 17.1 */
describe("responsive landing styles", () => {
  const layoutProperties = ["width", "min-width", "flex-basis", "grid-template-columns", "inline-size"];
  const scoped = /^(?:\.kt-landing|\.kt-public-footer|\.kt-app-header|\.kt-app-shell|\.kt-shell-main|\.kt-brand|\.kt-button|\.kt-status|html|body)/;

  it("sets no fixed layout width wider than the 320 px minimum viewport", () => {
    let checked = 0;
    for (const rule of stylesheet.rules) {
      if (!rule.selectors.some((selector) => scoped.test(selector))) continue;
      for (const property of layoutProperties) {
        const value = new RegExp(`(?:^|[;\\s])${property}\\s*:\\s*([^;]+)`).exec(rule.body)?.[1];
        if (!value) continue;
        checked += 1;
        // Lengths inside min() are capped by the container, so only bare lengths can force overflow.
        const bare = stylesheet.resolve(value).replace(/min\([^()]*\)/g, "");
        for (const length of bare.match(/-?\d*\.?\d+(?:px|rem)\b/g) ?? []) {
          expect(cssLengthToPx(length), `${rule.selectors.join(", ")} ${property}: ${value}`).toBeLessThanOrEqual(320);
        }
      }
    }
    expect(checked).toBeGreaterThan(10);
  });

  it("scales landing images to their container while their attributes reserve the aspect ratio", () => {
    expect(stylesheet.value(".kt-landing-hero__image img", "width")).toBe("100%");
    expect(stylesheet.value(".kt-landing-hero__image img", "height")).toBe("auto");
    expect(stylesheet.value(".kt-landing-owner__image img", "height")).toBe("auto");
    // A shrink-to-fit wrapper would collapse to 0×0 until the lazy image loads, then shift layout.
    expect(stylesheet.value(".kt-landing-owner__image", "width")).toBe("100%");
    for (const image of Object.values(landingImages)) {
      const declared = image.width / image.height;
      for (const width of image.widths) {
        for (const format of ["avif", "webp"] as const) {
          const path = `${image.base}-${width}.${format}`;
          const size = imageSize(readFileSync(new URL(`.${path}`, publicDirectory)));
          expect(size.width, path).toBe(width);
          expect(Math.abs(size.width / size.height - declared) / declared, path).toBeLessThan(0.01);
        }
      }
    }
  });

  it("switches to multi-column layouts only at wide breakpoints and stacks actions on phones", () => {
    const wide = stylesheet.rules.filter((rule) => rule.media === "@media (min-width: 56rem)").flatMap((rule) => rule.selectors);
    expect(wide).toEqual(expect.arrayContaining([".kt-landing-hero", ".kt-landing-owner", ".kt-landing-grid--three"]));
    const phone = stylesheet.rules.filter((rule) => rule.media === "@media (max-width: 30rem)" && rule.selectors.includes(".kt-landing-actions > .kt-button"));
    expect(phone.map((rule) => /width\s*:\s*100%/.test(rule.body))).toContain(true);
  });
});

/** Validates: Requirement 16.6 */
describe("static landing performance budgets", () => {
  it("keeps every landing image crop and the worst-case image download within budget", () => {
    let worstCase = 0;
    for (const image of Object.values(landingImages)) {
      const sizes = image.widths.flatMap((width) => (["avif", "webp"] as const).map((format) => fileBytes(`${image.base}-${width}.${format}`)));
      for (const size of sizes) expect(size).toBeLessThanOrEqual(landingAssetBudgets.maxImageBytes);
      worstCase += Math.max(...sizes);
    }
    expect(worstCase).toBeLessThanOrEqual(landingAssetBudgets.totalImageBytes);
  });

  it("prioritizes only the hero image and lazy-loads the rest", () => {
    const images = landingDocument("en").match(/<img\b[^>]*>/g) ?? [];
    expect(images.filter((image) => /fetchPriority="high"/.test(image) && /loading="eager"/.test(image))).toHaveLength(1);
    expect(images[0]).toContain(landingImages.hero.base);
    expect(images.slice(1).every((image) => /loading="lazy"/.test(image))).toBe(true);
  });

  it("adds no render-blocking script, external font, or extra stylesheet to the landing route", () => {
    const sources = [
      "../../app/layout.tsx",
      "../../app/(public)/layout.tsx",
      "../../app/(public)/page.tsx",
      "./landing-page.tsx",
      "./public-footer.tsx",
      "../shell/app-shell.tsx",
    ].map((path) => [path, readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8")] as const);
    for (const [path, source] of sources) {
      expect(source, path).not.toMatch(/next\/script|next\/font\/google|<script|<link|<style|dangerouslySetInnerHTML|fonts\.(?:googleapis|gstatic)\.com/);
    }
    const stylesheetImports = sources.flatMap(([, source]) => source.match(/import\s+["'][^"']+\.css["']/g) ?? []);
    expect(stylesheetImports).toEqual(['import "./globals.css"']);
  });
});
