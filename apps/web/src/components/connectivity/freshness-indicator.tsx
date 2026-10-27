"use client";

import { useEffect, useState } from "react";

import { evaluateFreshness, millisecondsUntilStale, type FreshnessKind, type FreshnessState } from "../../lib/data-freshness";
import { isDeviceOnline } from "../../lib/authoritative-action";
import { Button } from "../ui/primitives";

/** Pre-rendered, localized copy so this client component never bundles translation catalogs. */
export interface FreshnessMessages {
  readonly fresh: string;
  readonly pending?: string;
  readonly stale: string;
  readonly offline: string;
  readonly refresh: string;
}

export interface FreshnessIndicatorProps {
  readonly kind: FreshnessKind;
  /** When the server produced the shown data (ISO 8601); shown to the user in the messages. */
  readonly checkedAt: string;
  readonly messages: FreshnessMessages;
  /** The data itself awaits a server-side confirmation, such as a pending payment. */
  readonly pending?: boolean;
  /**
   * Device time (epoch ms) when the page received the data. Defaults to when this indicator
   * mounts; screens that reveal the indicator later, such as a stepper's review step, pass the
   * page's own receipt time instead.
   */
  readonly receivedAt?: number;
  readonly id?: string;
}

const tone: Readonly<Record<FreshnessState, string>> = {
  FRESH: "fresh",
  PENDING: "pending",
  STALE: "stale",
  OFFLINE: "offline",
};

/** Text for one freshness state; pending falls back to the fresh copy when a kind has none. */
export function freshnessText(state: FreshnessState, messages: FreshnessMessages): string {
  if (state === "OFFLINE") return messages.offline;
  if (state === "STALE") return messages.stale;
  if (state === "PENDING") return messages.pending ?? messages.fresh;
  return messages.fresh;
}

/**
 * Labels network-authoritative data with when it was checked and whether it may be out of date.
 * Age is measured from when this page received the data, so device clock skew cannot make fresh
 * data look current for longer. A page restored from the back-forward cache is always stale.
 * Refreshing is a user choice; nothing is refetched or resent in the background.
 */
export function FreshnessIndicator({ checkedAt, id, kind, messages, pending = false, receivedAt: providedReceivedAt }: FreshnessIndicatorProps) {
  const [state, setState] = useState<FreshnessState>(pending ? "PENDING" : "FRESH");

  useEffect(() => {
    const receivedAt = providedReceivedAt ?? Date.now();
    let restoredFromCache = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      const now = Date.now();
      setState(evaluateFreshness({ kind, checkedAt: receivedAt, now, online: isDeviceOnline(window), pending, restoredFromCache }));
      if (timer !== undefined) clearTimeout(timer);
      const wait = millisecondsUntilStale(kind, receivedAt, now);
      timer = wait > 0 && !restoredFromCache ? setTimeout(update, wait + 250) : undefined;
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      restoredFromCache = true;
      update();
    };
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, [checkedAt, kind, pending, providedReceivedAt]);

  return (
    <div className={`kt-freshness kt-freshness--${tone[state]}`} data-freshness={state} id={id}>
      <p aria-live="polite" role="status">
        <span aria-hidden="true" className="kt-freshness__symbol">{state === "FRESH" ? "✓" : state === "PENDING" ? "…" : "!"}</span>{" "}
        {freshnessText(state, messages)}
      </p>
      {state === "STALE" || state === "PENDING" ? (
        <Button onClick={() => window.location.reload()} variant="secondary">{messages.refresh}</Button>
      ) : null}
    </div>
  );
}
