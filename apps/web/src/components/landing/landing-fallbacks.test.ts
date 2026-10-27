import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { catalogLocales, translate } from "@kisantractor/i18n";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { AppShell } from "../shell/app-shell";
import {
  applyLandingSceneDecision,
  assessLandingSceneCapability,
  detectGpuConfidence,
  farmerBookingHref,
  heroSceneSlot,
  LandingPage,
  landingImages,
  minimumSceneTextureSize,
  ownerRegistrationHref,
  prefersDataSaver,
  PublicFooter,
  shouldEnhanceLandingScene,
  type LandingEnhancementSignals,
  type WebGlContextLike,
} from ".";

vi.mock("next/navigation", () => ({ usePathname: () => "/" }));

const appDirectory = fileURLToPath(new URL("../../app/", import.meta.url));

interface CssRule {
  readonly media: string | null;
  readonly selector: string;
  readonly body: string;
}

/** Splits a stylesheet into rules, keeping the enclosing `@media` condition for each one. */
function cssRules(source: string): CssRule[] {
  const rules: CssRule[] = [];
  const walk = (text: string, media: string | null) => {
    let position = 0;
    while (position < text.length) {
      const open = text.indexOf("{", position);
      if (open < 0) return;
      const prelude = text.slice(position, open).split(";").at(-1)!.trim();
      let depth = 1;
      let close = open + 1;
      for (; close < text.length && depth > 0; close += 1) {
        if (text[close] === "{") depth += 1;
        if (text[close] === "}") depth -= 1;
      }
      const body = text.slice(open + 1, close - 1);
      if (prelude.startsWith("@media")) walk(body, prelude);
      else rules.push({ media, selector: prelude.replace(/\s+/g, " "), body });
      position = close;
    }
  };
  walk(source.replace(/\/\*[\s\S]*?\*\//g, ""), null);
  return rules;
}

const stylesheet = cssRules(readFileSync(new URL("../../app/globals.css", import.meta.url), "utf8"));
const reducedMotion = (rule: CssRule) => rule.media?.includes("prefers-reduced-motion: reduce") ?? false;
const declarationValue = (rule: CssRule, property: string) =>
  new RegExp(`(?:^|[;{\\s])${property}\\s*:\\s*([^;]+)`).exec(rule.body)?.[1]?.trim();

/** Validates: Requirements 13.6, 16.5 */
describe("reduced-motion stylesheet coverage", () => {
  it("stops every transition, animation, and smooth scroll with a universal important override", () => {
    const universal = stylesheet.find((rule) => reducedMotion(rule) && rule.selector.split(",").map((part) => part.trim()).includes("*"));
    expect(universal).toBeDefined();
    for (const [property, value] of [
      ["scroll-behavior", "auto"],
      ["animation-duration", "0.01ms"],
      ["animation-delay", "0s"],
      ["animation-iteration-count", "1"],
      ["transition-duration", "0.01ms"],
      ["transition-delay", "0s"],
    ] as const) {
      expect(declarationValue(universal!, property), property).toBe(`${value} !important`);
    }
  });

  it("covers the animated selectors and lets none of them out-rank the override", () => {
    const animated = stylesheet.filter((rule) => !reducedMotion(rule) && /(?:^|[;\s])(transition|animation)(-[a-z-]+)?\s*:/.test(rule.body));
    expect(animated.map((rule) => rule.selector)).toEqual(expect.arrayContaining([".kt-button"]));
    for (const rule of animated) {
      expect(rule.body, rule.selector).not.toMatch(/(transition|animation)[a-z-]*\s*:[^;]*!important/);
    }
  });

  it("removes every hover movement under reduced motion", () => {
    const hoverMoves = stylesheet.filter((rule) => !reducedMotion(rule)
      && rule.selector.includes(":hover")
      && (declarationValue(rule, "transform") ?? "none") !== "none");
    expect(hoverMoves.length).toBeGreaterThan(0);
    for (const rule of hoverMoves) {
      const override = stylesheet.find((candidate) => reducedMotion(candidate) && candidate.selector === rule.selector);
      expect(override, rule.selector).toBeDefined();
      expect(declarationValue(override!, "transform")).toBe("none");
    }
  });

  it("adds no smooth scrolling or keyframe animation outside a motion-allowed query", () => {
    const outsideNoPreference = stylesheet.filter((rule) => !rule.media?.includes("prefers-reduced-motion: no-preference"));
    for (const rule of outsideNoPreference) {
      expect(rule.selector).not.toMatch(/^@keyframes/);
      if (!reducedMotion(rule)) expect(declarationValue(rule, "scroll-behavior") ?? "auto").toBe("auto");
    }
  });
});

const visibleText = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const hrefs = (markup: string) => [...markup.matchAll(/href="([^"]*)"/g)].map((match) => match[1]!.replaceAll("&amp;", "&"));

/** Resolves a first-party path to the App Router page that serves it. */
function routeExists(href: string): boolean {
  const path = new URL(href, "https://kisantractor.invalid").pathname;
  const segments = path.split("/").filter(Boolean);
  const candidates = [
    ["(public)", ...segments, "page.tsx"],
    [...segments, "page.tsx"],
    ...(segments.length > 0 ? [[segments[0]!, "[[...slug]]", "page.tsx"]] : []),
  ];
  return candidates.some((candidate) => existsSync(`${appDirectory}${candidate.join("/")}`));
}

function publicLandingDocument(locale: (typeof catalogLocales)[number], dataSaver = false) {
  return renderToStaticMarkup(createElement(AppShell, {
    locale,
    role: "PUBLIC",
    footer: createElement(PublicFooter, { locale }),
    children: createElement(LandingPage, { locale, telephony: { state: "UNCONFIGURED", isLive: false }, dataSaver }),
  }));
}

/** Validates: Requirements 16.3, 16.5 */
describe("static landing without scripts", () => {
  it("serves all essential content and plain primary links in server HTML for every locale", () => {
    for (const locale of catalogLocales) {
      const markup = publicLandingDocument(locale);
      expect(markup).not.toMatch(/<script|<noscript|<canvas|<iframe|\son[a-z]+=|javascript:/i);
      for (const key of ["landing.hero.title", "landing.howItWorks.title", "landing.services.title", "landing.owner.title", "landing.pricing.title", "landing.phone.title", "landing.languages.title", "landing.finalCta.title", "landing.footer.privacy"] as const) {
        expect(markup, `${locale}:${key}`).toContain(translate(locale, key));
      }
      expect(markup).toMatch(new RegExp(`<a class="kt-button kt-button--primary" href="${farmerBookingHref}">`));
      expect(markup).toContain(`href="${ownerRegistrationHref}"`);
    }
  });

  it("links only to in-page anchors or first-party routes that exist", () => {
    const markup = publicLandingDocument("en");
    const links = hrefs(markup);
    expect(links).toEqual(expect.arrayContaining([farmerBookingHref, ownerRegistrationHref, "/help", "/language"]));
    for (const href of links) {
      if (href.startsWith("#")) {
        expect(markup, href).toContain(`id="${href.slice(1)}"`);
      } else {
        expect(href.startsWith("/") && !href.startsWith("//"), href).toBe(true);
        expect(routeExists(href), href).toBe(true);
      }
    }
  });

  it("renders the hero poster inside the optional scene slot, ahead of any enhancement", () => {
    const markup = publicLandingDocument("en");
    const slot = new RegExp(`<div class="kt-landing-hero__media" data-enhancement-slot="${heroSceneSlot}">\\s*<picture class="kt-landing-hero__image">`);
    expect(markup).toMatch(slot);
    expect(markup.indexOf('id="landing-hero-title"')).toBeLessThan(markup.indexOf(`data-enhancement-slot="${heroSceneSlot}"`));
  });
});

/** Validates: Requirement 16.5 */
describe("data saver", () => {
  it("serves only the smallest image crops while keeping identical content and links", () => {
    for (const locale of catalogLocales) {
      const full = publicLandingDocument(locale);
      const saver = publicLandingDocument(locale, true);
      expect(visibleText(saver)).toBe(visibleText(full));
      expect(hrefs(saver)).toEqual(hrefs(full));
      expect(saver).toContain('data-static-only="true"');
      for (const image of Object.values(landingImages)) {
        expect(saver).toContain(`${image.base}-${image.widths[0]}.avif ${image.widths[0]}w`);
        expect(saver).not.toContain(`${image.base}-${image.widths[1]}.`);
      }
    }
  });

  it("recognizes only the Save-Data token on", () => {
    expect(prefersDataSaver("on")).toBe(true);
    expect(prefersDataSaver(" On ")).toBe(true);
    for (const value of [null, undefined, "", "off", "1", "true"]) expect(prefersDataSaver(value)).toBe(false);
  });
});

/** Validates: Requirements 16.2, 16.3, 16.4, 16.6 */
describe("optional scene enhancement policy", () => {
  const capable: LandingEnhancementSignals = {
    scriptsAvailable: true,
    prefersReducedMotion: false,
    dataSaver: false,
    deviceMemoryGb: 8,
    gpuConfidence: "HIGH",
  };

  it.each([
    ["scripting disabled", { scriptsAvailable: false }, "SCRIPTING_DISABLED"],
    ["reduced motion", { prefersReducedMotion: true }, "REDUCED_MOTION"],
    ["data saver", { dataSaver: true }, "DATA_SAVER"],
    ["low device memory", { deviceMemoryGb: 2 }, "LOW_DEVICE_MEMORY"],
    ["invalid device memory", { deviceMemoryGb: Number.NaN }, "LOW_DEVICE_MEMORY"],
    ["low GPU confidence", { gpuConfidence: "LOW" }, "LOW_GPU_CONFIDENCE"],
    ["scene load failure", { sceneLoadFailed: true }, "LOAD_FAILED"],
  ] as const)("keeps the static poster for %s", (_name, override, reason) => {
    const signals = { ...capable, ...override };
    expect(shouldEnhanceLandingScene(signals)).toBe(false);
    expect(assessLandingSceneCapability(signals)).toEqual({ enhance: false, reason });
  });

  it("allows the scene only when all known capability checks pass", () => {
    expect(shouldEnhanceLandingScene(capable)).toBe(true);
    expect(shouldEnhanceLandingScene({ ...capable, deviceMemoryGb: undefined, gpuConfidence: "UNKNOWN" })).toBe(true);
  });

  it("classifies unavailable, lost, undersized, and capable graphics contexts", () => {
    const context = (textureSize: number, lost = false): WebGlContextLike => ({
      MAX_TEXTURE_SIZE: 0x0d33,
      getParameter: () => textureSize,
      isContextLost: () => lost,
    });
    expect(detectGpuConfidence(null)).toBe("UNKNOWN");
    expect(detectGpuConfidence({ getContext: () => null })).toBe("LOW");
    expect(detectGpuConfidence({ getContext: () => context(minimumSceneTextureSize - 1) })).toBe("LOW");
    expect(detectGpuConfidence({ getContext: () => context(minimumSceneTextureSize, true) })).toBe("LOW");
    expect(detectGpuConfidence({ getContext: () => context(minimumSceneTextureSize) })).toBe("HIGH");
    expect(detectGpuConfidence({ getContext: () => { throw new Error("graphics probe failed"); } })).toBe("LOW");
  });

  it("records fallback state without touching poster, content, links, controls, or CTAs", () => {
    const attributes = new Map<string, string>();
    const serverRenderedChildren = Object.freeze({
      poster: "hero-farmer-tractor",
      hrefs: [farmerBookingHref, ownerRegistrationHref],
      controls: ["language", "help"],
    });
    const slot = {
      children: serverRenderedChildren,
      setAttribute: (name: string, value: string) => attributes.set(name, value),
      removeAttribute: (name: string) => attributes.delete(name),
    };

    applyLandingSceneDecision(slot, { enhance: false, reason: "LOAD_FAILED" });

    expect(attributes).toEqual(new Map([
      ["data-scene-state", "fallback"],
      ["data-scene-fallback-reason", "LOAD_FAILED"],
    ]));
    expect(slot.children).toBe(serverRenderedChildren);
  });

  it("forces the poster visible and suppresses failed enhancement children", () => {
    const fallbackRules = stylesheet.filter((rule) => rule.selector.includes('[data-scene-state="fallback"]'));
    expect(fallbackRules.some((rule) => rule.selector.endsWith("> :not(picture)") && /display\s*:\s*none\s*!important/.test(rule.body))).toBe(true);
    expect(fallbackRules.some((rule) => rule.selector.endsWith("> picture") && /visibility\s*:\s*visible\s*!important/.test(rule.body))).toBe(true);
  });
});
