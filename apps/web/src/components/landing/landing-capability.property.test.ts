import { catalogLocales, translate } from "@kisantractor/i18n";
import fc from "fast-check";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  farmerBookingHref,
  LandingPage,
  parseBookingNumber,
  PhoneBookingDetails,
  phoneBookingPresentation,
  type PhoneBookingCapability,
} from ".";

const propertyRuns = 200;
const seed = 14_020_016;

const states = ["UNCONFIGURED", "SANDBOX", "LIVE", "DEGRADED"] as const;

/** Valid E.164 values a server could be configured with. */
const validNumber = fc.oneof(
  fc.stringMatching(/^\+91[6-9]\d{9}$/),
  fc.stringMatching(/^\+[1-9]\d{7,14}$/),
);
/** Placeholder-looking or malformed values that must never reach the page. */
const invalidNumber = fc.oneof(
  fc.constantFrom("", " ", "1800-000-0000", "+91 00000 00000", "+0123456789", "TBD", "+91XXXXXXXXXX"),
  fc.stringMatching(/^\d{8,12}$/),
  fc.stringMatching(/^\+[1-9]\d{0,5}$/),
);
const configuredNumber = fc.oneof(fc.constant(null), fc.constant(undefined), validNumber, invalidNumber);

const scenario = fc.record({
  locale: fc.constantFrom(...catalogLocales),
  capability: fc.record({ state: fc.constantFrom(...states), isLive: fc.boolean() }),
  configuredNumber,
  dataSaver: fc.boolean(),
});

function phoneSection(markup: string): string {
  return markup.slice(
    markup.indexOf('aria-labelledby="landing-phone-title"'),
    markup.indexOf('aria-labelledby="landing-languages-title"'),
  );
}

/** Text a visitor reads, with tags and attributes removed. */
const visibleText = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const phoneLikeRuns = (text: string) => text.match(/\+?\d[\d\s-]{6,}\d/g) ?? [];

/** Validates: Requirements 14.2, 15.8 */
describe("capability-aware phone booking copy across states and locales", () => {
  it("never shows a number or a live claim unless telephony is LIVE with a valid configured number", () => {
    fc.assert(
      fc.property(scenario, ({ locale, capability, configuredNumber: number, dataSaver }) => {
        const telephony: PhoneBookingCapability = capability;
        const presentation = phoneBookingPresentation(telephony, number);
        const expectedLive = capability.state === "LIVE" && capability.isLive && parseBookingNumber(number) !== null;
        const markup = renderToStaticMarkup(createElement(LandingPage, { locale, telephony, bookingNumber: number, dataSaver }));
        const help = renderToStaticMarkup(createElement(PhoneBookingDetails, { locale, presentation }));
        const liveMessage = translate(locale, "landing.phone.live.message");

        expect(presentation.available).toBe(expectedLive);
        expect(presentation.displayState === "LIVE").toBe(expectedLive);

        for (const surface of [phoneSection(markup), help]) {
          const telLinks = [...surface.matchAll(/href="tel:([^"]*)"/g)].map((match) => match[1]);
          if (expectedLive) {
            expect(telLinks).toEqual([number]);
            expect(surface).toContain(liveMessage);
            expect(surface).toContain("kt-status--success");
            expect(surface).not.toContain(`href="${farmerBookingHref}"`);
          } else {
            expect(telLinks).toEqual([]);
            expect(surface).not.toContain(liveMessage);
            expect(surface).not.toContain("kt-status--success");
            expect(surface).toContain(`href="${farmerBookingHref}"`);
          }
        }

        // The only phone-like digits anywhere on the page are the configured number when live.
        const runs = phoneLikeRuns(visibleText(markup));
        expect(runs).toEqual(expectedLive ? [parseBookingNumber(number)!.display] : []);
      }),
      { numRuns: propertyRuns, seed },
    );
  });

  it("labels SANDBOX as a test and never as available", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...catalogLocales),
        fc.boolean(),
        configuredNumber,
        (locale, isLive, number) => {
          const presentation = phoneBookingPresentation({ state: "SANDBOX", isLive }, number);
          const section = phoneSection(renderToStaticMarkup(createElement(LandingPage, {
            locale,
            telephony: { state: "SANDBOX", isLive },
            bookingNumber: number,
          })));
          expect(presentation).toMatchObject({ available: false, displayState: "SANDBOX", tone: "info", bookingNumber: null });
          expect(section).toContain('data-capability-state="SANDBOX"');
          expect(section).toContain(`<span>${translate(locale, "landing.phone.sandbox.label")}</span>`);
          expect(section).toContain(translate(locale, "landing.phone.sandbox.message"));
          expect(section).not.toMatch(/href="tel:/);
        },
      ),
      { numRuns: propertyRuns, seed },
    );
  });
});
