import { formatTime, translate, type CatalogLocale, type MessageKey } from "@kisantractor/i18n";

import type { FreshnessKind } from "../../lib/data-freshness";
import type { AuthoritativeActionMessages } from "./authoritative-action-form";
import type { FreshnessMessages } from "./freshness-indicator";

const freshKeys: Readonly<Record<FreshnessKind, MessageKey>> = {
  availability: "freshness.availability.fresh",
  quote: "freshness.quote.fresh",
  invoice: "freshness.invoice.fresh",
  payment: "freshness.payment.fresh",
};
const staleKeys: Readonly<Record<FreshnessKind, MessageKey>> = {
  availability: "freshness.availability.stale",
  quote: "freshness.quote.stale",
  invoice: "freshness.invoice.stale",
  payment: "freshness.payment.stale",
};
const pendingKeys: Readonly<Partial<Record<FreshnessKind, MessageKey>>> = {
  payment: "freshness.payment.pending",
};

/** Localized freshness copy with the check time already formatted for the locale. */
export function freshnessMessages(locale: CatalogLocale, kind: FreshnessKind, checkedAt: Date | string): FreshnessMessages {
  const time = formatTime(locale, checkedAt);
  const pendingKey = pendingKeys[kind];
  return Object.freeze({
    fresh: translate(locale, freshKeys[kind], { time }),
    ...(pendingKey ? { pending: translate(locale, pendingKey, { time }) } : {}),
    stale: translate(locale, staleKeys[kind], { time }),
    offline: translate(locale, "freshness.offline", { time }),
    refresh: translate(locale, "freshness.refresh"),
  });
}

/** Localized notices for one Authoritative Action, naming the control the user must press again. */
export function authoritativeActionMessages(locale: CatalogLocale, actionLabel: string): AuthoritativeActionMessages {
  return Object.freeze({
    offlineBlocked: translate(locale, "action.offlineBlocked", { action: actionLabel }),
    unknownOutcome: translate(locale, "action.unknownOutcome", { action: actionLabel }),
    draftRestored: translate(locale, "action.draftRestored"),
  });
}
