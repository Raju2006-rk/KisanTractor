import { translate, type CatalogLocale } from "@kisantractor/i18n";
import type { ReactNode } from "react";

import { Card, StatusChip } from "../ui";

type CapabilityPresentation = Readonly<{
  state: "UNCONFIGURED" | "SANDBOX" | "LIVE" | "DEGRADED";
  canRetry: boolean;
}>;

export interface RouteSurfaceProps {
  readonly title: string;
  readonly children?: ReactNode;
  readonly eyebrow?: string;
}

export function RouteSurface({ title, children, eyebrow }: RouteSurfaceProps) {
  return (
    <section aria-labelledby="route-title" className="kt-route-surface">
      {eyebrow ? <p className="kt-route-surface__eyebrow">{eyebrow}</p> : null}
      <h1 id="route-title">{title}</h1>
      {children}
    </section>
  );
}

export interface CapabilityUnavailableProps {
  readonly capabilityName: string;
  readonly locale: CatalogLocale;
  readonly presentation: CapabilityPresentation;
}

export function CapabilityUnavailable({
  capabilityName,
  locale,
  presentation,
}: CapabilityUnavailableProps) {
  const stateCopy = {
    UNCONFIGURED: ["capability.unavailable", "capability.unconfiguredMessage", "warning"],
    DEGRADED: ["capability.degradedLabel", "capability.degradedMessage", "danger"],
    SANDBOX: ["capability.sandboxLabel", "capability.sandboxMessage", "info"],
    LIVE: ["capability.liveLabel", "capability.liveMessage", "success"],
  } as const;
  const [labelKey, messageKey, tone] = stateCopy[presentation.state];

  return (
    <Card
      className="kt-capability-surface"
      eyebrow={capabilityName}
      title={translate(locale, labelKey)}
    >
      <StatusChip tone={tone}>{translate(locale, labelKey)}</StatusChip>
      <p>{translate(locale, messageKey)}</p>
      {presentation.canRetry ? <p>{translate(locale, "control.retry")}</p> : null}
    </Card>
  );
}
