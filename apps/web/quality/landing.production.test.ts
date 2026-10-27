/**
 * Landing checks against a real production build (Requirements 13.4, 13.5,
 * 13.6, 16.6, 17.1). Enabled with KT_LANDING_PRODUCTION_TESTS=1, normally via
 * `corepack pnpm --filter @kisantractor/web test:landing` after `build`.
 *
 * - "production HTML" needs only the built app and runs over HTTP.
 * - "browser lab" also needs a Chromium-family browser. It is skipped when
 *   none is found unless KT_REQUIRE_BROWSER=1, which turns that into a failure.
 */
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

import { catalogLocales, localeMetadata, translate, type CatalogLocale } from "@kisantractor/i18n";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { findBrowserExecutable, HeadlessBrowser, type CdpPage } from "./cdp";
import {
  accessibilityThresholds,
  allDeviceProfiles,
  defaultLabRuns,
  deviceProfiles,
  landingAssetBudgets,
  percentile,
  representativeMobileProfile,
  webVitalBudgets,
  type DeviceProfile,
} from "./profiles";
import { startProductionServer, type ProductionServer } from "./production-server";

const enabled = process.env.KT_LANDING_PRODUCTION_TESTS === "1";
const requireBrowser = process.env.KT_REQUIRE_BROWSER === "1";
const browserPath = findBrowserExecutable();
const labRuns = Math.max(1, Number(process.env.KT_LAB_RUNS ?? defaultLabRuns));
const probeSource = readFileSync(new URL("./landing-probe.js", import.meta.url), "utf8");
const observerSource = readFileSync(new URL("./lab-observer.js", import.meta.url), "utf8");
const focusableSelector = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [tabindex]:not([tabindex="-1"])';

const decodeEntities = (value: string) => value
  .replaceAll("&amp;", "&")
  .replaceAll("&quot;", '"')
  .replaceAll("&#x27;", "'")
  .replaceAll("&#39;", "'")
  .replaceAll("&lt;", "<")
  .replaceAll("&gt;", ">");
const tags = (html: string, name: string) => html.match(new RegExp(`<${name}\\b[^>]*>`, "g")) ?? [];
const attribute = (tag: string, name: string) => {
  // HTML attribute names are case-insensitive; React writes `noModule`.
  const match = new RegExp(`\\s${name}(?:="([^"]*)")?(?=[\\s>/])`, "i").exec(tag);
  return match ? decodeEntities(match[1] ?? "") : null;
};
const metaContent = (html: string, key: "name" | "property", value: string) =>
  attribute(tags(html, "meta").find((tag) => attribute(tag, key) === value) ?? "", "content");

interface LabSample {
  readonly lcpMs: number;
  readonly lcpElement: string | null;
  readonly cls: number;
  readonly tbtMs: number;
  readonly inpMs: number;
  readonly fcpMs: number;
}

describe.runIf(enabled)("landing production build", () => {
  let server: ProductionServer;

  beforeAll(async () => {
    server = await startProductionServer();
    console.info(`[landing] serving ${server.source === "external" ? server.origin : `build ${server.buildId} via next start at ${server.origin}`}`);
  }, 120_000);

  afterAll(async () => {
    await server?.stop();
  });

  const fetchLanding = async (locale: CatalogLocale, headers: Record<string, string> = {}) => {
    const response = await fetch(`${server.origin}/`, { headers: { cookie: `kt_locale=${locale}`, ...headers } });
    expect(response.status).toBe(200);
    return response.text();
  };

  describe("production HTML", () => {
    it("serves localized head metadata and the document language in every locale", async () => {
      for (const locale of catalogLocales) {
        const html = await fetchLanding(locale);
        expect(tags(html, "html")[0], locale).toContain(`lang="${localeMetadata[locale].intlLocale}"`);
        const title = `${translate(locale, "landing.hero.title")} | ${translate(locale, "app.name")}`;
        expect(decodeEntities(/<title>([^<]*)<\/title>/.exec(html)?.[1] ?? ""), locale).toBe(title);
        expect(metaContent(html, "name", "description"), locale).toBe(translate(locale, "landing.hero.lead"));
        expect(metaContent(html, "name", "viewport")).toBe("width=device-width, initial-scale=1");
        expect(metaContent(html, "name", "theme-color")).toBe("#006b3a");
        expect(metaContent(html, "name", "format-detection")).toContain("telephone=no");
        expect(metaContent(html, "property", "og:title")).toBe(title);
        expect(metaContent(html, "property", "og:locale")).toBe(localeMetadata[locale].intlLocale.replace("-", "_"));
        expect(metaContent(html, "property", "og:type")).toBe("website");
        expect(new URL(metaContent(html, "property", "og:image")!).pathname).toBe("/images/landing/hero-farmer-tractor-640.webp");
        const links = tags(html, "link");
        expect(attribute(links.find((tag) => attribute(tag, "rel") === "manifest") ?? "", "href")).toBe("/manifest.webmanifest");
        expect(new URL(attribute(links.find((tag) => attribute(tag, "rel") === "canonical") ?? "", "href")!).pathname).toBe("/");
      }
      const manifest = await fetch(`${server.origin}/manifest.webmanifest`);
      expect(manifest.status).toBe(200);
      expect(await manifest.json()).toMatchObject({ start_url: "/", theme_color: "#006b3a" });
    });

    it("links only to first-party pages that answer, and shows no call link while telephony is unconfigured", async () => {
      const hrefs = new Set<string>();
      for (const locale of catalogLocales) {
        for (const tag of tags(await fetchLanding(locale), "a")) hrefs.add(attribute(tag, "href") ?? "");
      }
      expect(hrefs.size).toBeGreaterThan(5);
      for (const href of hrefs) {
        expect(href, href).not.toMatch(/^(?:tel:|mailto:|[a-z][a-z0-9+.-]*:\/\/|\/\/)/i);
        if (href.startsWith("#")) continue;
        const response = await fetch(new URL(href, server.origin), { redirect: "manual" });
        if (response.status >= 300 && response.status < 400) {
          // Signed-out Farmer routes hand off to login; nothing else may redirect.
          expect(new URL(response.headers.get("location")!, server.origin).pathname, href).toBe("/login");
        } else {
          expect(response.status, href).toBe(200);
        }
      }
    });

    it("loads only first-party, non-blocking scripts and inlines its one stylesheet within transfer budgets", async () => {
      const html = await fetchLanding("en");
      const scripts = tags(html, "script").filter((tag) => attribute(tag, "src") !== null);
      const stylesheets = tags(html, "link").filter((tag) => attribute(tag, "rel") === "stylesheet");
      expect(scripts.length).toBeGreaterThan(0);
      for (const tag of scripts) {
        expect(attribute(tag, "src")!.startsWith("/"), tag).toBe(true);
        expect(attribute(tag, "async") !== null || attribute(tag, "defer") !== null || attribute(tag, "nomodule") !== null || attribute(tag, "type") === "module", tag).toBe(true);
      }
      // experimental.inlineCss (task 15.3): no render-blocking stylesheet request, one inline block.
      expect(stylesheets).toHaveLength(0);
      const inlineStyles = [...html.matchAll(/<style\b[^>]*data-precedence="next"[^>]*>([\s\S]*?)<\/style>/gu)].map((match) => match[1]!);
      expect(inlineStyles).toHaveLength(1);
      const startupScripts = scripts.filter((tag) => attribute(tag, "nomodule") === null).map((tag) => attribute(tag, "src")!);
      const gzipBytes = async (path: string) => {
        const response = await fetch(new URL(path, server.origin));
        expect(response.status, path).toBe(200);
        return gzipSync(Buffer.from(await response.arrayBuffer())).length;
      };
      const jsBytes = (await Promise.all(startupScripts.map(gzipBytes))).reduce((sum, bytes) => sum + bytes, 0);
      const cssBytes = gzipSync(Buffer.from(inlineStyles[0]!)).length;
      const htmlBytes = gzipSync(Buffer.from(html)).length;
      console.info(`[landing] gzip transfer: html ${htmlBytes} B, js ${jsBytes} B in ${startupScripts.length} files, css ${cssBytes} B`);
      expect(htmlBytes).toBeLessThanOrEqual(landingAssetBudgets.htmlGzipBytes);
      expect(jsBytes).toBeLessThanOrEqual(landingAssetBudgets.initialJsGzipBytes);
      expect(cssBytes).toBeLessThanOrEqual(landingAssetBudgets.cssGzipBytes);
    });

    it("serves only the small image crops when Save-Data is on", async () => {
      const html = await fetchLanding("en", { "save-data": "on" });
      expect(html).toContain('data-static-only="true"');
      // The Open Graph card may name the large crop; only rendered images must not.
      const rendered = [...tags(html, "img"), ...tags(html, "source")].join("\n");
      expect(rendered).toMatch(/-(?:320|240)\.(?:avif|webp)/);
      expect(rendered).not.toMatch(/-(?:640|480)\.(?:avif|webp)/);
    });
  });

  describe.runIf(browserPath !== undefined || requireBrowser)("browser lab", () => {
    let browser: HeadlessBrowser;

    beforeAll(async () => {
      if (!browserPath) throw new Error("KT_REQUIRE_BROWSER=1 but no Chromium-family browser was found; set KT_CHROME_PATH.");
      browser = await HeadlessBrowser.launch(browserPath);
      console.info(`[landing] browser ${browser.version} at ${browserPath}`);
    }, 60_000);

    afterAll(async () => {
      await browser?.close();
    });

    interface OpenOptions {
      readonly locale?: CatalogLocale;
      readonly reducedMotion?: boolean;
      readonly throttle?: boolean;
    }

    async function openLanding(profile: DeviceProfile, { locale = "en", reducedMotion = false, throttle = false }: OpenOptions = {}): Promise<CdpPage> {
      const page = await browser.newPage();
      await page.send("Emulation.setDeviceMetricsOverride", {
        width: profile.width,
        height: profile.height,
        deviceScaleFactor: profile.deviceScaleFactor,
        mobile: profile.mobile,
      });
      await page.send("Emulation.setTouchEmulationEnabled", { enabled: profile.touch, maxTouchPoints: profile.touch ? 5 : 1 });
      await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: reducedMotion ? "reduce" : "no-preference" }] });
      await page.send("Network.setCacheDisabled", { cacheDisabled: true });
      await page.send("Network.setCookie", { name: "kt_locale", value: locale, url: server.origin });
      if (throttle) {
        await page.send("Emulation.setCPUThrottlingRate", { rate: profile.cpuSlowdown });
        if (profile.network) {
          await page.send("Network.emulateNetworkConditions", {
            offline: false,
            latency: profile.network.latencyMs,
            downloadThroughput: (profile.network.downloadKbps * 1024) / 8,
            uploadThroughput: (profile.network.uploadKbps * 1024) / 8,
          });
        }
      }
      await page.send("Page.addScriptToEvaluateOnNewDocument", { source: observerSource });
      await page.navigate(`${server.origin}/`);
      return page;
    }

    const probe = <T>(page: CdpPage, mode: "audit" | "focus" | "motion", extra: Record<string, unknown> = {}) =>
      page.evaluate<T>(`(${probeSource})(${JSON.stringify({ mode, focusableSelector, ...accessibilityThresholds, ...extra })})`);

    interface Audit {
      readonly viewport: { width: number; height: number; devicePixelRatio: number };
      readonly horizontalOverflowPx: number;
      readonly overflowingElements: string[];
      readonly contrastFailures: unknown[];
      readonly smallText: unknown[];
      readonly smallestFontPx: number;
      readonly targets: { element: string; width: number; height: number; name: string }[];
      readonly headings: number[];
      readonly landmarks: { banner: number; main: number; contentinfo: number; unlabeledNavigation: number };
      readonly textOutsideLandmarks: string[];
      readonly images: { src: string; alt: string | null; attributes: [number, number]; rendered: [number, number] }[];
      readonly links: { href: string; name: string }[];
      readonly mainText: string;
      readonly document: Record<string, string | null>;
    }

    const auditCases = allDeviceProfiles.flatMap((profile) => catalogLocales.map((locale) => [profile.id, locale, profile] as const));

    it.each(auditCases)("%s · %s: fits the viewport, meets target, contrast, text, landmark, and image rules", async (_id, locale, profile) => {
      const page = await openLanding(profile, { locale });
      try {
        const audit = await probe<Audit>(page, "audit");
        expect(audit.viewport.width).toBe(profile.width);
        expect(audit.horizontalOverflowPx, audit.overflowingElements.join(", ")).toBe(0);
        expect(audit.contrastFailures).toEqual([]);
        expect(audit.smallText).toEqual([]);
        const small = audit.targets.filter((target) => target.width < accessibilityThresholds.minTargetPx || target.height < accessibilityThresholds.minTargetPx);
        expect(small).toEqual([]);
        expect(audit.targets.filter((target) => target.name === "")).toEqual([]);
        expect(audit.headings[0]).toBe(1);
        expect(audit.headings.filter((level) => level === 1)).toHaveLength(1);
        audit.headings.forEach((level, index) => {
          if (index > 0) expect(level - audit.headings[index - 1]!).toBeLessThanOrEqual(1);
        });
        expect(audit.landmarks).toEqual({ banner: 1, main: 1, contentinfo: 1, unlabeledNavigation: 0 });
        expect(audit.textOutsideLandmarks).toEqual([]);
        expect(audit.images).toHaveLength(2);
        for (const image of audit.images) {
          expect(image.alt?.length ?? 0, image.src).toBeGreaterThan(10);
          // Space is reserved at the intrinsic aspect ratio whether or not the lazy image has loaded.
          const [width, height] = image.rendered;
          expect(height, image.src).toBeGreaterThan(0);
          expect(Math.abs(width / height - image.attributes[0] / image.attributes[1]), image.src).toBeLessThan(0.02);
          expect(width, image.src).toBeLessThanOrEqual(profile.width);
        }
        expect(audit.document.lang).toBe(localeMetadata[locale].intlLocale);
        expect(audit.links.some((link) => link.href.startsWith("tel:"))).toBe(false);
      } finally {
        await page.close();
      }
    }, 60_000);

    interface Focus {
      readonly element: string;
      readonly index: number;
      readonly focusVisible: boolean;
      readonly outlineStyle: string;
      readonly outlineWidth: number;
      readonly ringContrast: number;
      readonly inViewport: boolean;
    }

    it.each(allDeviceProfiles.map((profile) => [profile.id, profile] as const))("%s: reaches every control by keyboard in order with a visible focus ring", async (_id, profile) => {
      const page = await openLanding(profile);
      try {
        const total = await page.evaluate<number>(`document.querySelectorAll(${JSON.stringify(focusableSelector)}).length`);
        const visited: Focus[] = [];
        for (let step = 0; step < total + 2; step += 1) {
          await page.press("Tab");
          const focus = await probe<Focus | null>(page, "focus");
          if (focus === null || visited.some((entry) => entry.index === focus.index)) break;
          visited.push(focus);
        }
        expect(visited.map((entry) => entry.index)).toEqual([...Array(total).keys()]);
        for (const focus of visited) {
          expect(focus.focusVisible, focus.element).toBe(true);
          expect(focus.outlineStyle, focus.element).toBe("solid");
          expect(focus.outlineWidth, focus.element).toBeGreaterThanOrEqual(accessibilityThresholds.minFocusOutlinePx);
          expect(focus.ringContrast, focus.element).toBeGreaterThanOrEqual(accessibilityThresholds.nonTextContrast);
          expect(focus.inViewport, focus.element).toBe(true);
        }
      } finally {
        await page.close();
      }
    }, 90_000);

    interface Motion {
      readonly longestTransitionMs: number;
      readonly longestAnimationMs: number;
      readonly runningAnimations: number;
      readonly scrollBehavior: string;
      readonly hoveredTransform: string | null;
      readonly hoveredMatches: boolean;
    }

    it.each([deviceProfiles.lowEndMobile, deviceProfiles.desktop].map((profile) => [profile.id, profile] as const))("%s: reduced motion removes motion but keeps every word and link", async (_id, profile) => {
      const hoverSelector = "#hero .kt-button--primary";
      const measure = async (reducedMotion: boolean) => {
        const page = await openLanding(profile, { reducedMotion });
        try {
          const audit = await probe<Audit>(page, "audit");
          const box = await page.evaluate<{ x: number; y: number }>(`(() => { const r = document.querySelector(${JSON.stringify(hoverSelector)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
          await page.hover(box.x, box.y);
          await new Promise((resolve) => setTimeout(resolve, 400));
          const motion = await probe<Motion>(page, "motion", { hoverSelector });
          return { audit, motion };
        } finally {
          await page.close();
        }
      };
      const full = await measure(false);
      const reduced = await measure(true);
      // The no-preference page does animate, so the reduced checks are not vacuous.
      expect(full.motion.longestTransitionMs).toBeGreaterThanOrEqual(100);
      if (!profile.touch) expect(full.motion.hoveredTransform).not.toBe("none");
      expect(reduced.motion.longestTransitionMs).toBeLessThanOrEqual(0.01);
      expect(reduced.motion.longestAnimationMs).toBeLessThanOrEqual(0.01);
      expect(reduced.motion.runningAnimations).toBe(0);
      expect(reduced.motion.scrollBehavior).toBe("auto");
      expect(reduced.motion.hoveredTransform === null || reduced.motion.hoveredTransform === "none").toBe(true);
      expect(reduced.audit.mainText).toBe(full.audit.mainText);
      expect(reduced.audit.links).toEqual(full.audit.links);
      expect(reduced.audit.images.map((image) => image.src)).toEqual(full.audit.images.map((image) => image.src));
    }, 90_000);

    async function labSample(profile: DeviceProfile): Promise<LabSample> {
      const page = await openLanding(profile, { throttle: true });
      try {
        // Let late resources and hydration settle before reading LCP; input would finalize it.
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        const target = await page.evaluate<{ x: number; y: number }>(`(() => { const r = document.querySelector("#landing-hero-title").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
        const beforeInput = await page.evaluate<{ lcp: number | null; lcpElement: string | null; fcp: number | null }>("({ lcp: window.__ktLab.lcp, lcpElement: window.__ktLab.lcpElement, fcp: window.__ktLab.fcp })");
        await page.click(target.x, target.y);
        // Scroll through the page so lazy images load inside the viewport and any shift is recorded.
        await page.evaluate(`(async () => { for (let y = 0; y < document.documentElement.scrollHeight; y += innerHeight / 2) { scrollTo(0, y); await new Promise((r) => setTimeout(r, 150)); } })()`);
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        const lab = await page.evaluate<{ cls: number; longTasks: { start: number; duration: number }[]; events: { duration: number; interactionId: number }[] }>("window.__ktLab");
        if (beforeInput.lcp === null || beforeInput.fcp === null) throw new Error("browser reported no LCP or FCP entry");
        const tbtMs = lab.longTasks
          .filter((task) => task.start >= beforeInput.fcp!)
          .reduce((sum, task) => sum + Math.max(0, task.duration - 50), 0);
        // Entries under the 16 ms observer threshold are not reported, so 0 means "below 16 ms".
        const inpMs = Math.max(0, ...lab.events.map((event) => event.duration));
        return { lcpMs: beforeInput.lcp, lcpElement: beforeInput.lcpElement, cls: lab.cls, tbtMs, inpMs, fcpMs: beforeInput.fcp };
      } finally {
        await page.close();
      }
    }

    it(`${representativeMobileProfile.id}: p75 of ${labRuns} cold loads meets LCP, CLS, and interaction budgets`, async () => {
      const samples: LabSample[] = [];
      for (let run = 0; run < labRuns; run += 1) samples.push(await labSample(representativeMobileProfile));
      for (const [index, sample] of samples.entries()) {
        console.info(`[landing] lab run ${index + 1}: FCP ${Math.round(sample.fcpMs)} ms, LCP ${Math.round(sample.lcpMs)} ms (${sample.lcpElement}), CLS ${sample.cls.toFixed(4)}, TBT ${Math.round(sample.tbtMs)} ms, interaction ${Math.round(sample.inpMs)} ms`);
      }
      const p75 = {
        lcpMs: percentile(samples.map((sample) => sample.lcpMs), 0.75),
        cls: percentile(samples.map((sample) => sample.cls), 0.75),
        tbtMs: percentile(samples.map((sample) => sample.tbtMs), 0.75),
        inpMs: percentile(samples.map((sample) => sample.inpMs), 0.75),
      };
      console.info(`[landing] p75 on ${representativeMobileProfile.id}: ${JSON.stringify(p75)}`);
      expect(p75.lcpMs).toBeLessThanOrEqual(webVitalBudgets.lcpMs);
      expect(p75.cls).toBeLessThanOrEqual(webVitalBudgets.cls);
      // TBT remains diagnostic because it is not a Core Web Vital. The observed
      // interaction duration is the lab gate for Requirement 16.6's INP target.
      expect(p75.inpMs).toBeLessThanOrEqual(webVitalBudgets.inpMs);
    }, 60_000 + labRuns * 45_000);
  });
});
