import type { CatalogLocale } from "@kisantractor/i18n";

import type { FreshnessKind } from "../../lib/data-freshness";
import { FreshnessIndicator } from "./freshness-indicator";
import { freshnessMessages } from "./messages";

export interface DataFreshnessProps {
  readonly kind: FreshnessKind;
  readonly checkedAt: Date | string;
  readonly locale: CatalogLocale;
  readonly pending?: boolean;
  readonly receivedAt?: number;
  readonly id?: string;
}

/** Freshness label for server-rendered screens: localizes on the server, ages on the client. */
export function DataFreshness({ checkedAt, id, kind, locale, pending, receivedAt }: DataFreshnessProps) {
  const instant = checkedAt instanceof Date ? checkedAt : new Date(checkedAt);
  if (Number.isNaN(instant.getTime())) return null;
  return (
    <FreshnessIndicator
      checkedAt={instant.toISOString()}
      kind={kind}
      messages={freshnessMessages(locale, kind, instant)}
      {...(pending === undefined ? {} : { pending })}
      {...(receivedAt === undefined ? {} : { receivedAt })}
      {...(id === undefined ? {} : { id })}
    />
  );
}
