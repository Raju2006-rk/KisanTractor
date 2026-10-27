import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { catalogLocales, defaultCatalogs, localeMetadata, translate } from "@kisantractor/i18n";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { AppShell } from "../shell/app-shell";
import {
  farmerBookingHref,
  LandingPage,
  landingImages,
  ownerRegistrationHref,
  phoneBookingPresentation,
  PublicFooter,
  publicFooterLinks,
  type PhoneBookingCapability,
} from ".";

vi.mock("next/navigation", () => ({ usePathname: () => "/" }));

const unconfigured: PhoneBookingCapability = { state: "UNCONFIGURED", isLive: false };
const render = (locale: (typeof catalogLocales)[number], telephony: PhoneBookingCapability = unconfigured) =>
  renderToStaticMarkup(createElement(LandingPage, { locale, telephony }));

const sectionIds = [
  "hero",
  "how-it-works",
  "services",
  "owner-benefits",
  "pricing",
  "phone-booking",
  "languages",
  "get-started",
] as const;

function phoneSection(markup: string): string {
  const start = markup.indexOf('aria-labelledby="landing-phone-title"');
  const end = markup.indexOf('aria-labelledby="landing-languages-title"');
  return markup.slice(start, end);
}

/** Validates: Requirements 16.1, 16.2, 16.3 */
describe("Phase 1 landing page content", () => {
  it("renders every required section in showcase order with a single page heading", () => {
    const markup = render("en");
    const positions = sectionIds.map((id) => markup.indexOf(`id="${id}"`));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(markup.match(/<h1\b/g)).toHaveLength(1);
    for (const id of sectionIds) {
      expect(markup).toMatch(new RegExp(`aria-labelledby="landing-[a-z]+-title"[^>]*id="${id}"`));
    }
    for (const text of ["How it works", "Farming services", "Earn more with your tractor", "Simple pricing methods", "Booking by phone", "Use KisanTractor in your language", "Ready for your next farm job?"]) {
      expect(markup).toContain(text);
    }
  });

  it("links role-specific calls to action to Farmer booking and Owner registration", () => {
    const markup = render("en");
    expect(farmerBookingHref).toBe("/farmer/search");
    expect(ownerRegistrationHref).toBe("/login?role=owner");
    const bookingLinks = markup.match(new RegExp(`href="${farmerBookingHref}"`, "g")) ?? [];
    const ownerLinks = markup.match(/href="\/login\?role=owner"/g) ?? [];
    // Hero, final CTA, and the unavailable phone-booking fallback all reach booking.
    expect(bookingLinks.length).toBeGreaterThanOrEqual(3);
    // Hero, Owner benefits, and final CTA all reach Owner registration.
    expect(ownerLinks.length).toBeGreaterThanOrEqual(3);
    expect(markup).toContain('href="/language"');
  });

  it("shows hourly, per-acre, and per-trip pricing methods", () => {
    const markup = render("en");
    for (const method of ["Per hour", "Per acre", "Per trip"]) expect(markup).toContain(method);
  });

  it("delivers content without 3D, canvas, or script payloads", () => {
    const markup = render("en");
    expect(markup).not.toMatch(/<canvas|<script|<iframe|<model|three\.js|webgl|\.glb|\.gltf/i);
  });
});

/** Validates: Requirement 16.1 */
describe("landing imagery", () => {
  it("serves committed AVIF and WebP sources with intrinsic dimensions and localized alt text", () => {
    const markup = render("en");
    for (const image of Object.values(landingImages)) {
      expect(markup).toContain(`${image.base}-${image.widths[0]}.avif ${image.widths[0]}w`);
      expect(markup).toContain(`${image.base}-${image.widths[1]}.webp ${image.widths[1]}w`);
      expect(markup).toMatch(new RegExp(`<img[^>]*height="${image.height}"[^>]*width="${image.width}"`));
      for (const width of image.widths) {
        for (const format of ["avif", "webp"]) {
          const file = fileURLToPath(new URL(`../../../public${image.base}-${width}.${format}`, import.meta.url));
          expect(existsSync(file)).toBe(true);
        }
      }
    }
    expect(markup).toMatch(/<img[^>]*fetchPriority="high"[^>]*loading="eager"/);
    expect(markup).toMatch(/<img[^>]*loading="lazy"/);
    expect(markup).not.toMatch(/src="https?:/);
    for (const locale of catalogLocales) {
      const localized = render(locale);
      expect(localized).toContain(`alt="${translate(locale, "landing.hero.imageAlt")}"`);
      expect(localized).toContain(`alt="${translate(locale, "landing.owner.imageAlt")}"`);
    }
  });

  it("reserves layout space for each image", () => {
    const markup = render("en");
    const images = markup.match(/<img[^>]*>/g) ?? [];
    expect(images).toHaveLength(2);
    for (const image of images) {
      expect(image).toMatch(/width="\d+"/);
      expect(image).toMatch(/height="\d+"/);
      expect(image).toMatch(/alt="[^"]+"/);
    }
  });
});

/** Validates: Requirements 15.8, 16.2 */
describe("capability-aware phone booking", () => {
  const live: PhoneBookingCapability = { state: "LIVE", isLive: true };
  const configuredNumber = "+910000000000";
  const states: readonly PhoneBookingCapability[] = [
    { state: "UNCONFIGURED", isLive: false },
    { state: "SANDBOX", isLive: false },
    { state: "DEGRADED", isLive: false },
    live,
  ];

  it("only reports phone booking as available for a live projection with a configured number", () => {
    expect(states.map((capability) => phoneBookingPresentation(capability, configuredNumber).available)).toEqual([false, false, false, true]);
    expect(phoneBookingPresentation({ state: "LIVE", isLive: false }, configuredNumber).available).toBe(false);
    expect(phoneBookingPresentation(live).available).toBe(false);
    expect(phoneBookingPresentation(live, "1800-000-0000").available).toBe(false);
  });

  it("renders no phone number or call link when no number is configured", () => {
    for (const capability of states) {
      for (const locale of catalogLocales) {
        const section = phoneSection(render(locale, capability));
        expect(section).toContain(`data-capability-state="${capability.state === "LIVE" ? "UNCONFIGURED" : capability.state}"`);
        expect(section).not.toMatch(/href="tel:/);
        expect(section).not.toMatch(/\d[\d\s-]{6,}\d/);
      }
    }
  });

  it("explains unavailable phone booking and points people to online booking", () => {
    const section = phoneSection(render("en", unconfigured));
    expect(section).toContain("Coming soon");
    expect(section).toContain("Phone booking is not available yet");
    expect(section).toContain(`href="${farmerBookingHref}"`);
    expect(section).not.toContain(">Available<");

    expect(phoneSection(render("en", { state: "SANDBOX", isLive: false }))).toContain("not open to the public");
    expect(phoneSection(render("en", { state: "DEGRADED", isLive: false }))).toContain("Temporarily unavailable");
  });

  it("offers a call link to the configured number only while telephony is live", () => {
    const markup = renderToStaticMarkup(createElement(LandingPage, { locale: "en", telephony: live, bookingNumber: configuredNumber }));
    const section = phoneSection(markup);
    expect(section).toContain('data-capability-state="LIVE"');
    expect(section).toContain("Available");
    expect(section).toContain(`href="tel:${configuredNumber}"`);
    expect(section).toContain("+91 00000 00000");
    expect(section).not.toContain(`href="${farmerBookingHref}"`);
  });
});

/** Validates: Requirements 13.1, 13.3, 16.2 */
describe("landing localization", () => {
  const landingKeys = Object.keys(defaultCatalogs.en).filter((key) => key.startsWith("landing.") || key === "legal.pending");

  it("keeps full initial catalogs and core expanded-locale landing copy nonempty", () => {
    expect(landingKeys.length).toBeGreaterThan(50);
    for (const locale of ["en", "hi", "te", "kn", "ta"] as const) {
      for (const key of landingKeys) {
        expect(defaultCatalogs[locale][key]?.trim(), `${locale}:${key}`).toBeTruthy();
      }
    }
    for (const locale of ["mr", "bn"] as const) {
      for (const key of [
        "landing.hero.eyebrow",
        "landing.hero.title",
        "landing.hero.lead",
        "landing.cta.bookTractor",
        "landing.cta.registerOwner",
        "landing.languages.title",
        "landing.languages.lead",
      ]) {
        expect(defaultCatalogs[locale][key]?.trim(), `${locale}:${key}`).toBeTruthy();
      }
      for (const key of landingKeys) {
        const rendered = translate(locale, key);
        expect(rendered.trim(), `${locale}:${key}`).toBeTruthy();
        expect(rendered, `${locale}:${key}`).not.toBe(key);
      }
    }
  });

  it("renders each locale's copy without raw keys and lists every language in its own script", () => {
    for (const locale of catalogLocales) {
      const markup = render(locale);
      expect(markup).toContain(translate(locale, "landing.hero.title"));
      expect(markup).toContain(translate(locale, "landing.cta.bookTractor"));
      expect(markup).not.toMatch(/landing\.[a-zA-Z]/);
      expect(markup).not.toContain("Content unavailable");
      for (const language of catalogLocales) {
        expect(markup).toContain(`lang="${language}">${localeMetadata[language].nativeName}<`);
      }
      expect(markup).toMatch(new RegExp(`aria-current="true" lang="${locale}"`));
    }
    expect(render("te")).toContain("ట్రాక్టర్ బుక్ చేయండి");
    expect(render("hi")).toContain("फ़ोन से बुकिंग");
  });
});

/** Validates: Requirement 16.2 */
describe("public footer", () => {
  it("renders required first-party links in a labeled footer navigation", () => {
    const markup = renderToStaticMarkup(createElement(PublicFooter, { locale: "en" }));
    expect(markup).toMatch(/^<footer/);
    expect(markup).toContain('aria-label="Site links"');
    for (const [href] of publicFooterLinks) {
      expect(href.startsWith("/")).toBe(true);
      expect(markup).toContain(`href="${href}"`);
    }
    for (const label of ["Help", "Choose language", "Privacy policy", "Terms of use"]) {
      expect(markup).toContain(label);
    }
  });

  it("places the footer after main content in the public shell", () => {
    const markup = renderToStaticMarkup(createElement(AppShell, {
      locale: "kn",
      role: "PUBLIC",
      footer: createElement(PublicFooter, { locale: "kn" }),
      children: "content",
    }));
    expect(markup.indexOf("</main>")).toBeLessThan(markup.indexOf("<footer"));
    expect(markup).toContain(translate("kn", "landing.footer.privacy"));
  });
});
