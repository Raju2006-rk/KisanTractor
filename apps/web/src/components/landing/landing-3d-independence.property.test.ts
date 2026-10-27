import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { catalogLocales } from "@kisantractor/i18n";
import fc from "fast-check";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { AppShell } from "../shell/app-shell";
import {
  applyLandingSceneDecision,
  assessLandingSceneCapability,
  farmerBookingHref,
  LandingPage,
  ownerRegistrationHref,
  PublicFooter,
  type LandingEnhancementSignals,
} from ".";

vi.mock("next/navigation", () => ({ usePathname: () => "/" }));

const propertyRuns = 128;
const seed = 20_160_206;
const appDirectory = fileURLToPath(new URL("../../app/", import.meta.url));
const essentialSectionIds = [
  "hero",
  "how-it-works",
  "services",
  "owner-benefits",
  "pricing",
  "phone-booking",
  "languages",
  "get-started",
] as const;

interface FallbackCombination {
  readonly sceneLoadFailed: boolean;
  readonly scriptingDisabled: boolean;
  readonly reducedMotion: boolean;
  readonly lowDeviceMemory: boolean;
  readonly lowGpuConfidence: boolean;
  readonly dataSaver: boolean;
}

const booleans = [false, true] as const;
const fallbackCombinations: readonly FallbackCombination[] = booleans.flatMap((sceneLoadFailed) =>
  booleans.flatMap((scriptingDisabled) =>
    booleans.flatMap((reducedMotion) =>
      booleans.flatMap((lowDeviceMemory) =>
        booleans.flatMap((lowGpuConfidence) =>
          booleans.map((dataSaver) => ({
            sceneLoadFailed,
            scriptingDisabled,
            reducedMotion,
            lowDeviceMemory,
            lowGpuConfidence,
            dataSaver,
          })),
        ),
      ),
    ),
  ),
);

interface LinkControl {
  readonly label: string;
  readonly href: string;
  readonly isCta: boolean;
}

interface LandingContract {
  readonly visibleText: string;
  readonly sectionIds: readonly string[];
  readonly controls: readonly LinkControl[];
  readonly ctaDestinations: readonly string[];
}

function publicLandingDocument(locale: (typeof catalogLocales)[number], dataSaver: boolean): string {
  return renderToStaticMarkup(createElement(AppShell, {
    locale,
    role: "PUBLIC",
    footer: createElement(PublicFooter, { locale }),
    children: createElement(LandingPage, {
      locale,
      telephony: { state: "UNCONFIGURED", isLive: false },
      dataSaver,
    }),
  }));
}

function attribute(attributes: string, name: string): string | null {
  return new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attributes)?.[1] ?? null;
}

function plainText(markup: string): string {
  return markup.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}

function landingContract(markup: string): LandingContract {
  const controls = [...markup.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map((match) => {
    const attributes = match[1]!;
    return {
      label: plainText(match[2]!),
      href: attribute(attributes, "href") ?? "",
      isCta: (attribute(attributes, "class") ?? "").split(/\s+/).includes("kt-button"),
    };
  });

  return {
    visibleText: plainText(markup),
    sectionIds: [...markup.matchAll(/<section\b[^>]*\bid="([^"]+)"/g)].map((match) => match[1]!),
    controls,
    ctaDestinations: controls.filter((control) => control.isCta).map((control) => control.href),
  };
}

function firstPartyRouteExists(href: string): boolean {
  const path = new URL(href, "https://kisantractor.invalid").pathname;
  const segments = path.split("/").filter(Boolean);
  const candidates = [
    ["(public)", ...segments, "page.tsx"],
    [...segments, "page.tsx"],
    ...(segments.length > 0 ? [[segments[0]!, "[[...slug]]", "page.tsx"]] : []),
  ];
  return candidates.some((candidate) => existsSync(`${appDirectory}${candidate.join("/")}`));
}

function expectFunctionalDocument(markup: string, contract: LandingContract): void {
  expect(markup).not.toMatch(/<script|javascript:|\sdisabled(?:=|\s|>)/i);
  expect(contract.sectionIds).toEqual(essentialSectionIds);
  expect(contract.ctaDestinations).toEqual(expect.arrayContaining([farmerBookingHref, ownerRegistrationHref]));
  expect(contract.controls.length).toBeGreaterThan(0);

  for (const control of contract.controls) {
    expect(control.label.trim(), control.href).not.toBe("");
    expect(control.href.startsWith("/") && !control.href.startsWith("//"), control.href).toBe(true);
    expect(firstPartyRouteExists(control.href), control.href).toBe(true);
  }

  for (const labelledBy of markup.matchAll(/<section\b[^>]*aria-labelledby="([^"]+)"/g)) {
    expect(markup, labelledBy[1]).toContain(`id="${labelledBy[1]}"`);
  }
}

/** Validates: Requirements 16.2, 16.3, 16.4, 16.6 */
describe("Property 20: 3D independence", () => {
  it("preserves identical functional core content, links, controls, and CTA destinations for every fallback-signal combination", () => {
    try {
      fc.assert(
        fc.property(
          fc.constantFrom(...catalogLocales),
          fc.integer({ min: 4, max: 32 }),
          fc.double({ min: 0, max: 3.99, noNaN: true, noDefaultInfinity: true }),
          (locale, capableMemoryGb, constrainedMemoryGb) => {
            const fullMarkup = publicLandingDocument(locale, false);
            const saverMarkup = publicLandingDocument(locale, true);
            const expected = landingContract(fullMarkup);

            expectFunctionalDocument(fullMarkup, expected);
            expect(landingContract(saverMarkup)).toEqual(expected);

            for (const combination of fallbackCombinations) {
              const markup = combination.dataSaver ? saverMarkup : fullMarkup;
              const actual = landingContract(markup);
              const signals: LandingEnhancementSignals = {
                scriptsAvailable: !combination.scriptingDisabled,
                prefersReducedMotion: combination.reducedMotion,
                dataSaver: combination.dataSaver,
                deviceMemoryGb: combination.lowDeviceMemory ? constrainedMemoryGb : capableMemoryGb,
                gpuConfidence: combination.lowGpuConfidence ? "LOW" : "HIGH",
                sceneLoadFailed: combination.sceneLoadFailed,
              };
              const decision = assessLandingSceneCapability(signals);
              const shouldFallback = combination.sceneLoadFailed
                || combination.scriptingDisabled
                || combination.reducedMotion
                || combination.lowDeviceMemory
                || combination.lowGpuConfidence
                || combination.dataSaver;
              const serverRenderedChildren = Object.freeze({
                contract: actual,
                poster: "hero-farmer-tractor",
              });
              const attributes = new Map<string, string>();
              const sceneSlot = {
                children: serverRenderedChildren,
                setAttribute: (name: string, value: string) => attributes.set(name, value),
                removeAttribute: (name: string) => attributes.delete(name),
              };

              applyLandingSceneDecision(sceneSlot, decision);

              expect(decision.enhance).toBe(!shouldFallback);
              expect(sceneSlot.children).toBe(serverRenderedChildren);
              expect(actual).toEqual(expected);
              expectFunctionalDocument(markup, actual);
              expect(attributes.get("data-scene-state")).toBe(shouldFallback ? "fallback" : "eligible");
              expect(attributes.has("data-scene-fallback-reason")).toBe(shouldFallback);
            }
          },
        ),
        { numRuns: propertyRuns, seed, verbose: 2 },
      );
      console.info(`[PBT] property-20-3d-independence: seed=${seed} runs=${propertyRuns} combinationsPerRun=${fallbackCombinations.length} minimizedCounterexample=none`);
    } catch (error) {
      console.error(`[PBT] property-20-3d-independence: seed=${seed} minimizedCounterexample=reported by fast-check below`);
      throw error;
    }
  });
});
