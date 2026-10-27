import { describe, expect, it, vi } from "vitest";

import {
  catalogLocales,
  createLocalization,
  defaultCatalogs,
  subscribeToTranslationMisses,
  translate as translateWithDefault,
  formatDate,
  formatDateTime,
  formatIndianCurrency,
  formatTime,
  localeMetadata,
  messageKeys,
  resolveLocale,
  translate,
  translationReviewRecord,
  translationReviewReport,
  translationReviewStatus,
  type CatalogLocale,
} from "./index.js";

/** Validates: Requirements 13.1, 13.2, 13.3 */
describe("translation catalogs", () => {
  it("registers the five initial and two expanded regional catalogs", () => {
    expect(catalogLocales).toEqual(["en", "hi", "te", "kn", "ta", "mr", "bn"]);
    expect(resolveLocale("te-IN")).toBe("te");
    expect(resolveLocale("HI_in")).toBe("hi");
    expect(resolveLocale("mr-IN")).toBe("mr");
    expect(resolveLocale("bn-Beng-IN")).toBe("bn");
    expect(resolveLocale("unknown")).toBe("en");
  });

  it("externalizes every required UI string category in every catalog", () => {
    const requiredPrefixes = [
      "menu.",
      "control.",
      "form.",
      "status.",
      "help.",
      "date.",
      "currency.",
    ];

    const englishKeys = new Set<string>(messageKeys as readonly string[]);
    // English defines the canonical key set.
    expect(Object.keys(defaultCatalogs.en).sort()).toEqual(
      [...messageKeys].sort(),
    );
    for (const locale of catalogLocales) {
      // Regional catalogs are a subset of English: no orphan keys, and every
      // present value is a non-empty string. A key added to English later falls
      // back to English per Requirement 13.3 until its regional entry lands.
      for (const [key, value] of Object.entries(defaultCatalogs[locale])) {
        expect(englishKeys.has(key)).toBe(true);
        expect(typeof value).toBe("string");
        expect(value.trim().length).toBeGreaterThan(0);
      }
      for (const prefix of requiredPrefixes) {
        expect(
          Object.entries(defaultCatalogs[locale]).some(
            ([key, value]) => key.startsWith(prefix) && value.trim().length > 0,
          ),
        ).toBe(true);
      }
      // Translating any English key in any supported locale returns non-empty
      // content, falling back to English when the regional entry is missing.
      for (const key of messageKeys) {
        const rendered = translate(locale, key);
        expect(rendered.trim().length).toBeGreaterThan(0);
      }
    }

    expect(translate("hi", "menu.home")).toBe("होम");
    expect(translate("te", "control.bookNow")).toBe("ఇప్పుడే బుక్ చేయండి");
    expect(translate("kn", "form.serviceLocation")).toBe("ಸೇವೆಯ ಸ್ಥಳ");
    expect(translate("ta", "status.booking.completed")).toBe("முடிந்தது");
    expect(translate("mr", "menu.searchTractors")).toBe("ट्रॅक्टर शोधा");
    expect(translate("bn", "control.bookNow")).toBe("এখনই বুক করুন");
  });

  it("interpolates localized values without embedding formatting in screens", () => {
    expect(
      translate("te", "date.scheduledFor", {
        date: "12 మే 2026",
        time: "ఉ. 9:30",
      }),
    ).toBe("12 మే 2026 ఉ. 9:30కు షెడ్యూల్ చేయబడింది");
  });
});

/** Validates: Requirements 13.1, 13.2 */
describe("regional catalog coverage and review tracking", () => {
  const placeholders = (message: string) => [...message.matchAll(/\{([A-Za-z][\w.]*)\}/g)].map((match) => match[1]).sort();

  it("keeps every regional entry's placeholders identical to English", () => {
    for (const locale of catalogLocales) {
      for (const [key, value] of Object.entries(defaultCatalogs[locale])) {
        expect(placeholders(value), `${locale}:${key}`).toEqual(placeholders(defaultCatalogs.en[key]!));
      }
    }
  });

  it("records review state only for existing regional keys, one state per key", () => {
    expect(translationReviewRecord.schemaVersion).toBe(1);
    expect(Object.keys(translationReviewRecord.locales).sort()).toEqual(["bn", "hi", "kn", "mr", "ta", "te"]);
    for (const [locale, statuses] of Object.entries(translationReviewRecord.locales)) {
      const drafts = new Set(statuses.MACHINE_DRAFT);
      expect(drafts.size).toBe(statuses.MACHINE_DRAFT.length);
      for (const key of [...statuses.MACHINE_DRAFT, ...statuses.NATIVE_REVIEWED]) {
        expect(defaultCatalogs[locale as CatalogLocale][key], `${locale}:${key}`).toBeDefined();
      }
      expect(statuses.NATIVE_REVIEWED.filter((key) => drafts.has(key))).toEqual([]);
    }
  });

  it("reports machine-drafted entries as pending native review, never as reviewed", () => {
    expect(translationReviewStatus("te", "dispute.title")).toBe("MACHINE_DRAFT");
    expect(translationReviewStatus("hi", "menu.home")).toBe("UNRECORDED");
    const report = translationReviewReport();
    expect(report.map(({ locale }) => locale)).toEqual(["hi", "te", "kn", "ta", "mr", "bn"]);
    for (const entry of report) {
      expect(entry.totalKeys + entry.missingKeys.length).toBe(messageKeys.length);
      if (entry.locale === "mr" || entry.locale === "bn") {
        expect(entry.machineDraftKeys).toEqual(Object.keys(defaultCatalogs[entry.locale]));
        expect(entry.nativeReviewedKeys).toEqual([]);
      } else {
        expect(entry.machineDraftKeys).toContain("notification.dispute.resolved");
      }
      expect(entry.machineDraftKeys.length + entry.nativeReviewedKeys.length + entry.unrecordedKeys).toBe(entry.totalKeys);
    }
  });
});

/** Validates: Requirement 13.3 */
describe("English translation fallback and telemetry", () => {
  it("uses a nonempty English message and records a PII-free locale miss", () => {
    const onMissingTranslation = vi.fn();
    const service = createLocalization({
      catalogs: { ta: {} },
      onMissingTranslation,
    });

    expect(service.translate("ta", "control.retry")).toBe("Retry");
    expect(onMissingTranslation).toHaveBeenCalledWith({
      requestedLocale: "ta",
      resolvedLocale: "ta",
      fallbackLocale: "en",
      key: "control.retry",
      reason: "MISSING_LOCALE_ENTRY",
    });
  });

  it("never renders a raw unknown key when English also lacks it", () => {
    const onMissingTranslation = vi.fn();
    const service = createLocalization({ onMissingTranslation });
    const unknownKey = "future.screen.unregistered";

    expect(service.translate("kn", unknownKey)).toBe("Content unavailable");
    expect(service.translate("kn", unknownKey)).not.toContain(unknownKey);
    expect(onMissingTranslation).toHaveBeenCalledWith(
      expect.objectContaining({
        key: unknownKey,
        reason: "MISSING_ENGLISH_ENTRY",
      }),
    );
  });

  it("falls back for unsupported regional locale tags and records telemetry", () => {
    const onMissingTranslation = vi.fn();
    const service = createLocalization({ onMissingTranslation });

    expect(service.translate("gu-IN", "menu.home")).toBe("Home");
    expect(onMissingTranslation).toHaveBeenCalledWith(
      expect.objectContaining({
        requestedLocale: "gu-IN",
        resolvedLocale: "en",
        reason: "UNSUPPORTED_LOCALE",
      }),
    );
  });
});

/** Validates: Requirement 13.2 */
describe("localized date, time, and Indian currency formatting", () => {
  const instant = new Date("2026-05-12T04:00:00.000Z");
  const deterministicOptions = { timeZone: "Asia/Kolkata" } as const;

  it("formats dates and times with each locale's India language tag", () => {
    for (const locale of catalogLocales) {
      const intlLocale = localeMetadata[locale].intlLocale;
      expect(formatDate(locale, instant, deterministicOptions)).toBe(
        new Intl.DateTimeFormat(intlLocale, {
          dateStyle: "medium",
          ...deterministicOptions,
        }).format(instant),
      );
      expect(formatTime(locale, instant, deterministicOptions)).toBe(
        new Intl.DateTimeFormat(intlLocale, {
          timeStyle: "short",
          ...deterministicOptions,
        }).format(instant),
      );
      expect(formatDateTime(locale, instant, deterministicOptions)).toBe(
        new Intl.DateTimeFormat(intlLocale, {
          dateStyle: "medium",
          timeStyle: "short",
          ...deterministicOptions,
        }).format(instant),
      );
    }
  });

  it("formats integer paise as INR using Indian grouping and preserves paise", () => {
    expect(formatIndianCurrency("en", 120_000)).toMatch(/₹\s?1,200/);
    expect(formatIndianCurrency("en-IN", 12_34_56_789)).toMatch(
      /₹\s?12,34,567\.89/,
    );
  });

  it("rejects non-integer paise and invalid dates", () => {
    expect(() => formatIndianCurrency("en", 100.5)).toThrow(/integer.*paise/i);
    expect(() => formatDate("en", "not-a-date")).toThrow(/valid/i);
  });
});

/** Validates: Requirement 13.3 */
describe("default localization miss subscription", () => {
  it("notifies subscribers of misses from the shared translate helper until they unsubscribe", () => {
    const listener = vi.fn();
    const failing = vi.fn(() => {
      throw new Error("telemetry down");
    });
    const unsubscribe = subscribeToTranslationMisses(listener);
    const unsubscribeFailing = subscribeToTranslationMisses(failing);

    expect(translateWithDefault("gu-IN", "menu.home")).toBe("Home");
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ requestedLocale: "gu-IN", reason: "UNSUPPORTED_LOCALE" }));

    unsubscribe();
    unsubscribeFailing();
    listener.mockClear();
    translateWithDefault("gu-IN", "menu.home");
    expect(listener).not.toHaveBeenCalled();
  });
});
