import type { CatalogLocale, LocalizationService } from "@kisantractor/i18n";
import { defaultLocale, localization, resolveLocale } from "@kisantractor/i18n";
import { SHAREABLE_PHONE_PATTERN } from "@kisantractor/domain";

export type NotificationTemplateVariable = "reference" | "ownerPhone";

export interface NotificationTemplateContract {
  /**
   * Contract version. Bump it whenever the English text or the variables change: registered SMS
   * templates (DLT) are keyed by template, version, and locale, so a new version needs a new
   * registration before it can be sent.
   */
  readonly version: number;
  readonly variables: readonly NotificationTemplateVariable[];
}

/**
 * Every notification template, keyed by its translation-catalog key. Templates
 * accept only declared variables. The booking reference is the only variable
 * in general; names, addresses, and amounts are never interpolated. The single
 * exception is `notification.booking.ownerContact`, which carries the Owner's
 * phone under the contact-sharing policy and is sent by SMS only.
 */
export type NotificationTemplateKey =
  | "notification.booking.requested"
  | "notification.booking.accepted"
  | "notification.booking.ownerContact"
  | "notification.booking.rejected"
  | "notification.booking.cancelled"
  | "notification.booking.expired"
  | "notification.bill.ready"
  | "notification.payment.cashRecorded"
  | "notification.payment.onlineConfirmed"
  | "notification.payment.onlineReceived"
  | "notification.payment.onlineFailed"
  | "notification.payment.onlineReleased"
  | "notification.refund.requested"
  | "notification.refund.processed"
  | "notification.refund.failed"
  | "notification.dispute.opened"
  | "notification.dispute.resolved";

const referenceOnly: NotificationTemplateContract = Object.freeze({ version: 1, variables: Object.freeze(["reference"] as const) });

export const notificationTemplates: Readonly<Record<NotificationTemplateKey, NotificationTemplateContract>> =
  Object.freeze({
    "notification.booking.requested": referenceOnly,
    "notification.booking.accepted": referenceOnly,
    "notification.booking.ownerContact": Object.freeze({ version: 1, variables: Object.freeze(["reference", "ownerPhone"] as const) }),
    "notification.booking.rejected": referenceOnly,
    "notification.booking.cancelled": referenceOnly,
    "notification.booking.expired": referenceOnly,
    "notification.bill.ready": referenceOnly,
    "notification.payment.cashRecorded": referenceOnly,
    "notification.payment.onlineConfirmed": referenceOnly,
    "notification.payment.onlineReceived": referenceOnly,
    "notification.payment.onlineFailed": referenceOnly,
    "notification.payment.onlineReleased": referenceOnly,
    "notification.refund.requested": referenceOnly,
    "notification.refund.processed": referenceOnly,
    "notification.refund.failed": referenceOnly,
    "notification.dispute.opened": referenceOnly,
    "notification.dispute.resolved": referenceOnly,
  });
export type NotificationTemplateVariables = Readonly<Partial<Record<NotificationTemplateVariable, string>>>;

export const notificationTemplateKeys = Object.freeze(
  Object.keys(notificationTemplates) as NotificationTemplateKey[],
);

/** Templates that carry a phone number; they may only go to the booking's Farmer by SMS. */
export const contactTemplateKeys: ReadonlySet<NotificationTemplateKey> = new Set(
  notificationTemplateKeys.filter((key) => notificationTemplates[key].variables.includes("ownerPhone")),
);

const variablePatterns: Readonly<Record<NotificationTemplateVariable, RegExp>> = Object.freeze({
  reference: /^[A-Za-z0-9][A-Za-z0-9-]{0,39}$/u,
  ownerPhone: SHAREABLE_PHONE_PATTERN,
});

// Seven or more consecutive digits look like a phone number and are refused outside `ownerPhone`.
const PHONE_LIKE = /\d{7,}/u;
const UNRESOLVED_PLACEHOLDER = /\{[A-Za-z][\w.]*\}/u;

export class NotificationTemplateError extends Error {
  readonly retryable = false;

  constructor(readonly code: string) {
    super(`Notification template contract violated: ${code}`);
    this.name = "NotificationTemplateError";
  }
}

export interface RenderedNotification {
  readonly templateKey: NotificationTemplateKey;
  readonly templateVersion: number;
  readonly locale: CatalogLocale;
  readonly body: string;
  /** The validated variables, for providers that send registered templates instead of text. */
  readonly variables: Readonly<Record<string, string>>;
}

const hasEntry = (catalog: Readonly<Record<string, string>>, key: string): boolean => {
  const value = catalog[key];
  return typeof value === "string" && value.trim().length > 0;
};

/**
 * Renders localized notification templates with English fallback. The locale
 * recorded on a notification is the one actually used to render it.
 */
export class NotificationTemplateRenderer {
  constructor(private readonly localizationService: LocalizationService = localization) {
    for (const key of notificationTemplateKeys) {
      if (!hasEntry(this.localizationService.catalogs.en, key)) {
        throw new NotificationTemplateError("TEMPLATE_MISSING_ENGLISH_ENTRY");
      }
    }
  }

  version(key: NotificationTemplateKey): number {
    return notificationTemplates[key].version;
  }

  /**
   * The requested locale when its catalog has the template, otherwise English.
   * Falling back records translation telemetry (Requirement 13.3) through the
   * localization service's miss hook, as `translate` does.
   */
  templateLocale(key: NotificationTemplateKey, requestedLocale: string | undefined): CatalogLocale {
    const resolved = resolveLocale(requestedLocale);
    if (hasEntry(this.localizationService.catalogs[resolved], key)) return resolved;
    if (resolved !== defaultLocale) {
      this.localizationService.onMissingTranslation?.(Object.freeze({
        requestedLocale: requestedLocale ?? resolved,
        resolvedLocale: resolved,
        fallbackLocale: defaultLocale,
        key,
        reason: "MISSING_LOCALE_ENTRY" as const,
      }));
    }
    return defaultLocale;
  }

  render(
    key: NotificationTemplateKey,
    requestedLocale: string | undefined,
    variables: NotificationTemplateVariables,
  ): RenderedNotification {
    const contract: NotificationTemplateContract = notificationTemplates[key];
    const supplied = Object.keys(variables);
    if (
      supplied.length !== contract.variables.length
      || supplied.some((name) => !contract.variables.includes(name as NotificationTemplateVariable))
    ) {
      throw new NotificationTemplateError("TEMPLATE_VARIABLES_MISMATCH");
    }
    const values: Record<string, string> = {};
    for (const name of contract.variables) {
      const value = variables[name];
      if (typeof value !== "string" || !variablePatterns[name].test(value)
        || (name !== "ownerPhone" && PHONE_LIKE.test(value))) {
        throw new NotificationTemplateError("TEMPLATE_VARIABLE_INVALID");
      }
      values[name] = value;
    }

    const locale = this.templateLocale(key, requestedLocale);
    const body = this.localizationService.translate(locale, key, values);
    if (UNRESOLVED_PLACEHOLDER.test(body)) {
      throw new NotificationTemplateError("TEMPLATE_PLACEHOLDER_UNRESOLVED");
    }
    return Object.freeze({ templateKey: key, templateVersion: contract.version, locale, body, variables: Object.freeze(values) });
  }
}
