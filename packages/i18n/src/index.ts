import bn from "../catalogs/bn.json" with { type: "json" };
import en from "../catalogs/en.json" with { type: "json" };
import hi from "../catalogs/hi.json" with { type: "json" };
import kn from "../catalogs/kn.json" with { type: "json" };
import mr from "../catalogs/mr.json" with { type: "json" };
import ta from "../catalogs/ta.json" with { type: "json" };
import te from "../catalogs/te.json" with { type: "json" };
import reviewStatus from "../catalogs/review-status.json" with { type: "json" };

export const catalogLocales = ["en", "hi", "te", "kn", "ta", "mr", "bn"] as const;
export const defaultLocale = "en" as const;

export type CatalogLocale = (typeof catalogLocales)[number];
export type MessageKey = keyof typeof en;
export type MessageCatalog = Readonly<Record<string, string>>;
export type TranslationValues = Readonly<
  Record<string, string | number | bigint | boolean>
>;

export const localeMetadata = Object.freeze({
  en: Object.freeze({ intlLocale: "en-IN", nativeName: "English" }),
  hi: Object.freeze({ intlLocale: "hi-IN", nativeName: "हिन्दी" }),
  te: Object.freeze({ intlLocale: "te-IN", nativeName: "తెలుగు" }),
  kn: Object.freeze({ intlLocale: "kn-IN", nativeName: "ಕನ್ನಡ" }),
  ta: Object.freeze({ intlLocale: "ta-IN", nativeName: "தமிழ்" }),
  mr: Object.freeze({ intlLocale: "mr-IN", nativeName: "मराठी" }),
  bn: Object.freeze({ intlLocale: "bn-IN", nativeName: "বাংলা" }),
}) satisfies Readonly<
  Record<CatalogLocale, Readonly<{ intlLocale: string; nativeName: string }>>
>;

export const defaultCatalogs: Readonly<Record<CatalogLocale, MessageCatalog>> =
  Object.freeze({
    en: Object.freeze({ ...en }),
    hi: Object.freeze({ ...hi }),
    te: Object.freeze({ ...te }),
    kn: Object.freeze({ ...kn }),
    ta: Object.freeze({ ...ta }),
    mr: Object.freeze({ ...mr }),
    bn: Object.freeze({ ...bn }),
  });

export const messageKeys = Object.freeze(
  Object.keys(defaultCatalogs.en) as MessageKey[],
);

/**
 * Review state of a regional catalog entry (catalogs/review-status.json):
 *
 * - `MACHINE_DRAFT`: machine-produced text that no native speaker has reviewed yet. It is shown
 *   to users (better than an English fallback) but must not be described as verified.
 * - `NATIVE_REVIEWED`: a native-speaker reviewer signed the entry off; move a key here only with
 *   that evidence (see TRANSLATION_REVIEW.md).
 * - `UNRECORDED`: an entry from before review tracking existed; its review evidence is not
 *   recorded in the repository.
 */
export type TranslationReviewStatus = "MACHINE_DRAFT" | "NATIVE_REVIEWED" | "UNRECORDED";

export type RegionalLocale = Exclude<CatalogLocale, typeof defaultLocale>;

interface ReviewStatusFile {
  readonly schemaVersion: number;
  /** Every current entry in these newly added catalogs is a machine draft until reviewed. */
  readonly machineDraftCatalogs?: readonly RegionalLocale[];
  readonly locales: Readonly<Record<string, Readonly<Record<"MACHINE_DRAFT" | "NATIVE_REVIEWED", readonly string[]>>>>;
}

const reviewIndex: ReadonlyMap<string, TranslationReviewStatus> = (() => {
  const index = new Map<string, TranslationReviewStatus>();
  const record = reviewStatus as ReviewStatusFile;
  for (const locale of record.machineDraftCatalogs ?? []) {
    for (const key of Object.keys(defaultCatalogs[locale])) {
      index.set(`${locale}\u0000${key}`, "MACHINE_DRAFT");
    }
  }
  for (const [locale, statuses] of Object.entries(record.locales)) {
    for (const status of ["MACHINE_DRAFT", "NATIVE_REVIEWED"] as const) {
      for (const key of statuses[status] ?? []) index.set(`${locale}\u0000${key}`, status);
    }
  }
  return index;
})();

/** The recorded review state of one regional catalog entry. English is the source text. */
export function translationReviewStatus(locale: RegionalLocale, key: string): TranslationReviewStatus {
  return reviewIndex.get(`${locale}\u0000${key}`) ?? "UNRECORDED";
}

export interface TranslationReviewReport {
  readonly locale: RegionalLocale;
  readonly totalKeys: number;
  readonly machineDraftKeys: readonly string[];
  readonly nativeReviewedKeys: readonly string[];
  readonly unrecordedKeys: number;
  /** English keys with no regional entry yet; they render the English fallback. */
  readonly missingKeys: readonly string[];
}

/** Per-locale counts and key lists, so pending native-speaker review can be tracked and reported. */
export function translationReviewReport(): readonly TranslationReviewReport[] {
  return catalogLocales.filter((locale): locale is RegionalLocale => locale !== defaultLocale).map((locale) => {
    const keys = Object.keys(defaultCatalogs[locale]);
    const machineDraftKeys = keys.filter((key) => translationReviewStatus(locale, key) === "MACHINE_DRAFT");
    const nativeReviewedKeys = keys.filter((key) => translationReviewStatus(locale, key) === "NATIVE_REVIEWED");
    return Object.freeze({
      locale,
      totalKeys: keys.length,
      machineDraftKeys: Object.freeze(machineDraftKeys),
      nativeReviewedKeys: Object.freeze(nativeReviewedKeys),
      unrecordedKeys: keys.length - machineDraftKeys.length - nativeReviewedKeys.length,
      missingKeys: Object.freeze(messageKeys.filter((key) => !keys.includes(key))),
    });
  });
}

/** The raw review-status file, for tooling that validates it against the catalogs. */
export const translationReviewRecord = reviewStatus as ReviewStatusFile;

export type MissingTranslationReason =
  | "UNSUPPORTED_LOCALE"
  | "MISSING_LOCALE_ENTRY"
  | "MISSING_ENGLISH_ENTRY";

export interface MissingTranslationEvent {
  readonly requestedLocale: string;
  readonly resolvedLocale: CatalogLocale;
  readonly fallbackLocale: typeof defaultLocale;
  readonly key: string;
  readonly reason: MissingTranslationReason;
}

export type TranslationTelemetry = (event: MissingTranslationEvent) => void;

export interface LocalizationOptions {
  /** Replaces individual locale catalogs; useful for independently loaded bundles. */
  readonly catalogs?: Partial<Record<CatalogLocale, MessageCatalog>>;
  /** Receives PII-free translation misses for application telemetry. */
  readonly onMissingTranslation?: TranslationTelemetry;
}

export type CurrencyFormatOptions = Omit<
  Intl.NumberFormatOptions,
  "currency" | "style"
>;

function hasMessage(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function isCatalogLocale(locale: string): locale is CatalogLocale {
  return (catalogLocales as readonly string[]).includes(locale);
}

export function resolveLocale(locale: string | null | undefined): CatalogLocale {
  if (!locale) {
    return defaultLocale;
  }

  const normalized = locale.trim().toLowerCase().replaceAll("_", "-");
  const language = normalized.split("-")[0] ?? "";
  return isCatalogLocale(language) ? language : defaultLocale;
}

function interpolate(message: string, values: TranslationValues): string {
  return message.replace(/\{([A-Za-z][\w.]*)\}/g, (placeholder, name: string) => {
    const value = values[name];
    return value === undefined ? placeholder : String(value);
  });
}

function validDate(value: Date | number | string): Date {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new RangeError("Date value must be valid");
  }
  return date;
}

const datePresentationOptions = [
  "dateStyle",
  "timeStyle",
  "weekday",
  "era",
  "year",
  "month",
  "day",
  "dayPeriod",
  "hour",
  "minute",
  "second",
  "fractionalSecondDigits",
  "timeZoneName",
] as const satisfies readonly (keyof Intl.DateTimeFormatOptions)[];

function dateOptions(
  options: Intl.DateTimeFormatOptions | undefined,
  defaults: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormatOptions {
  if (!options) {
    return defaults;
  }

  const hasPresentationOverride = datePresentationOptions.some(
    (key) => options[key] !== undefined,
  );
  return hasPresentationOverride ? options : { ...defaults, ...options };
}

export class LocalizationService {
  readonly catalogs: Readonly<Record<CatalogLocale, MessageCatalog>>;
  readonly onMissingTranslation: TranslationTelemetry | undefined;

  constructor(options: LocalizationOptions = {}) {
    this.catalogs = Object.freeze(
      Object.fromEntries(
        catalogLocales.map((locale) => [
          locale,
          Object.freeze({ ...(options.catalogs?.[locale] ?? defaultCatalogs[locale]) }),
        ]),
      ) as Record<CatalogLocale, MessageCatalog>,
    );
    this.onMissingTranslation = options.onMissingTranslation;
  }

  translate(
    requestedLocale: string,
    key: MessageKey | (string & {}),
    values: TranslationValues = {},
  ): string {
    const resolvedLocale = resolveLocale(requestedLocale);
    const normalizedRequested = requestedLocale
      .trim()
      .toLowerCase()
      .replaceAll("_", "-")
      .split("-")[0];

    if (!normalizedRequested || !isCatalogLocale(normalizedRequested)) {
      this.recordMiss(requestedLocale, resolvedLocale, key, "UNSUPPORTED_LOCALE");
    }

    const localizedMessage = this.catalogs[resolvedLocale][key];
    if (hasMessage(localizedMessage)) {
      return interpolate(localizedMessage, values);
    }

    if (resolvedLocale !== defaultLocale) {
      this.recordMiss(requestedLocale, resolvedLocale, key, "MISSING_LOCALE_ENTRY");
    }

    const englishMessage = this.catalogs.en[key];
    if (hasMessage(englishMessage)) {
      return interpolate(englishMessage, values);
    }

    this.recordMiss(requestedLocale, resolvedLocale, key, "MISSING_ENGLISH_ENTRY");
    const safeMessage = this.catalogs.en["translation.missing"];
    return hasMessage(safeMessage) ? safeMessage : "Content unavailable";
  }

  formatDate(
    locale: string,
    value: Date | number | string,
    options?: Intl.DateTimeFormatOptions,
  ): string {
    return new Intl.DateTimeFormat(
      localeMetadata[resolveLocale(locale)].intlLocale,
      dateOptions(options, { dateStyle: "medium" }),
    ).format(validDate(value));
  }

  formatTime(
    locale: string,
    value: Date | number | string,
    options?: Intl.DateTimeFormatOptions,
  ): string {
    return new Intl.DateTimeFormat(
      localeMetadata[resolveLocale(locale)].intlLocale,
      dateOptions(options, { timeStyle: "short" }),
    ).format(validDate(value));
  }

  formatDateTime(
    locale: string,
    value: Date | number | string,
    options?: Intl.DateTimeFormatOptions,
  ): string {
    return new Intl.DateTimeFormat(
      localeMetadata[resolveLocale(locale)].intlLocale,
      dateOptions(options, { dateStyle: "medium", timeStyle: "short" }),
    ).format(validDate(value));
  }

  /** Formats integer paise as Indian rupees without changing the stored amount. */
  formatIndianCurrency(
    locale: string,
    amountMinorUnits: number,
    options: CurrencyFormatOptions = {},
  ): string {
    if (!Number.isSafeInteger(amountMinorUnits)) {
      throw new RangeError("Currency amount must be a safe integer number of paise");
    }

    return new Intl.NumberFormat(localeMetadata[resolveLocale(locale)].intlLocale, {
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
      ...options,
      style: "currency",
      currency: "INR",
    }).format(amountMinorUnits / 100);
  }

  private recordMiss(
    requestedLocale: string,
    resolvedLocale: CatalogLocale,
    key: string,
    reason: MissingTranslationReason,
  ): void {
    this.onMissingTranslation?.(
      Object.freeze({
        requestedLocale,
        resolvedLocale,
        fallbackLocale: defaultLocale,
        key,
        reason,
      }),
    );
  }
}

export function createLocalization(options: LocalizationOptions = {}): LocalizationService {
  return new LocalizationService(options);
}

const defaultMissListeners = new Set<TranslationTelemetry>();

/**
 * Subscribes to translation misses from the shared default `localization`
 * (and the module-level `translate` helpers). Returns an unsubscribe function.
 * Listener failures are ignored so telemetry never changes rendered text.
 */
export function subscribeToTranslationMisses(listener: TranslationTelemetry): () => void {
  defaultMissListeners.add(listener);
  return () => {
    defaultMissListeners.delete(listener);
  };
}

export const localization = new LocalizationService({
  onMissingTranslation: (event) => {
    for (const listener of defaultMissListeners) {
      try {
        listener(event);
      } catch {
        // Telemetry must never affect localization output.
      }
    }
  },
});

export function translate(
  locale: string,
  key: MessageKey | (string & {}),
  values: TranslationValues = {},
): string {
  return localization.translate(locale, key, values);
}

export function formatDate(
  locale: string,
  value: Date | number | string,
  options?: Intl.DateTimeFormatOptions,
): string {
  return localization.formatDate(locale, value, options);
}

export function formatTime(
  locale: string,
  value: Date | number | string,
  options?: Intl.DateTimeFormatOptions,
): string {
  return localization.formatTime(locale, value, options);
}

export function formatDateTime(
  locale: string,
  value: Date | number | string,
  options?: Intl.DateTimeFormatOptions,
): string {
  return localization.formatDateTime(locale, value, options);
}

export function formatIndianCurrency(
  locale: string,
  amountMinorUnits: number,
  options: CurrencyFormatOptions = {},
): string {
  return localization.formatIndianCurrency(locale, amountMinorUnits, options);
}
