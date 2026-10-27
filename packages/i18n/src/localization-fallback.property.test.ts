import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  catalogLocales,
  createLocalization,
  defaultCatalogs,
  defaultLocale,
  messageKeys,
} from "./index.js";
import type {
  CatalogLocale,
  MessageCatalog,
  MessageKey,
  MissingTranslationEvent,
} from "./index.js";

const propertyRuns = 500;
const seeds = {
  registeredMessages: 13_010_203,
  englishFallback: 13_030_015,
} as const;

const [firstMessageKey, ...remainingMessageKeys] = messageKeys;
if (firstMessageKey === undefined) {
  throw new Error("The English catalog must register at least one message key");
}

const supportedLocaleArbitrary = fc.constantFrom<CatalogLocale>(
  ...catalogLocales,
);
const nonEnglishLocaleArbitrary = supportedLocaleArbitrary.filter(
  (locale) => locale !== defaultLocale,
);
const registeredMessageKeyArbitrary = fc.constantFrom<MessageKey>(
  firstMessageKey,
  ...remainingMessageKeys,
);
const missingEntryKindArbitrary = fc.constantFrom<
  "ABSENT" | "EMPTY" | "WHITESPACE"
>("ABSENT", "EMPTY", "WHITESPACE");

function catalogWithMissingEntry(
  locale: Exclude<CatalogLocale, typeof defaultLocale>,
  key: MessageKey,
  missingEntryKind: "ABSENT" | "EMPTY" | "WHITESPACE",
): MessageCatalog {
  const catalog = { ...defaultCatalogs[locale] };

  if (missingEntryKind === "ABSENT") {
    delete catalog[key];
  } else {
    catalog[key] = missingEntryKind === "EMPTY" ? "" : " \n\t ";
  }

  return catalog;
}

function runSeededProperty(
  name: string,
  seed: number,
  assertion: () => void,
): void {
  try {
    assertion();
    console.info(
      `[PBT] ${name}: seed=${seed} runs=${propertyRuns} minimizedCounterexample=none`,
    );
  } catch (error) {
    console.error(
      `[PBT] ${name}: seed=${seed} minimizedCounterexample=reported by fast-check below`,
    );
    throw error;
  }
}

describe("Property 15: Localization Fallback Completeness", () => {
  /** Validates: Requirements 13.1, 13.2, 13.3 */
  it("renders every generated supported-locale and registered-key pair as nonempty localized content", () => {
    const seed = seeds.registeredMessages;

    runSeededProperty("registered-localization-completeness", seed, () => {
      fc.assert(
        fc.property(
          supportedLocaleArbitrary,
          registeredMessageKeyArbitrary,
          (locale, key) => {
            const rendered = createLocalization().translate(locale, key);

            expect(rendered.trim().length).toBeGreaterThan(0);
            expect(rendered).not.toBe(key);
          },
        ),
        { seed, numRuns: propertyRuns, verbose: 2 },
      );
    });
  });

  /** Validates: Requirements 13.1, 13.2, 13.3 */
  it("uses nonempty English and records telemetry for every generated missing locale entry", () => {
    const seed = seeds.englishFallback;

    runSeededProperty("missing-entry-english-fallback", seed, () => {
      fc.assert(
        fc.property(
          nonEnglishLocaleArbitrary,
          registeredMessageKeyArbitrary,
          missingEntryKindArbitrary,
          (locale, key, missingEntryKind) => {
            const events: MissingTranslationEvent[] = [];
            const localizedCatalog = catalogWithMissingEntry(
              locale,
              key,
              missingEntryKind,
            );
            const service = createLocalization({
              catalogs: { [locale]: localizedCatalog },
              onMissingTranslation: (event) => events.push(event),
            });
            const englishFallback = defaultCatalogs.en[key];
            const rendered = service.translate(locale, key);

            expect(englishFallback).toBeDefined();
            expect(englishFallback?.trim().length).toBeGreaterThan(0);
            expect(rendered).toBe(englishFallback);
            expect(rendered.trim().length).toBeGreaterThan(0);
            expect(rendered).not.toBe(key);
            expect(events).toEqual([
              {
                requestedLocale: locale,
                resolvedLocale: locale,
                fallbackLocale: defaultLocale,
                key,
                reason: "MISSING_LOCALE_ENTRY",
              },
            ]);
          },
        ),
        { seed, numRuns: propertyRuns, verbose: 2 },
      );
    });
  });
});
