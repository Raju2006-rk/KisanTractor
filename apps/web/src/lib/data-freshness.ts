/**
 * Freshness rules for network-authoritative data: tractor availability, quotes, final bills, and
 * payment status. Screens always render server data fetched with `no-store`; these rules decide
 * when that data must be labelled as possibly out of date or pending.
 *
 * Dependency-free so client components can use it without bundling translation catalogs.
 */

export type FreshnessKind = "availability" | "quote" | "invoice" | "payment";
export type FreshnessState = "FRESH" | "PENDING" | "STALE" | "OFFLINE";

/** How long data is presented as current before the screen asks the user to refresh. */
export const freshnessWindowsMs: Readonly<Record<FreshnessKind, number>> = Object.freeze({
  // Another Farmer can book the same slot at any moment.
  availability: 2 * 60 * 1_000,
  // Prices can change until the booking is created with its quote snapshot.
  quote: 5 * 60 * 1_000,
  // A bill can be reissued after a correction or dispute.
  invoice: 10 * 60 * 1_000,
  // Payment confirmations arrive asynchronously.
  payment: 2 * 60 * 1_000,
});

/** Tolerated server-ahead clock skew before a timestamp is treated as untrustworthy. */
const maximumFutureSkewMs = 5 * 60 * 1_000;

export interface FreshnessInput {
  readonly kind: FreshnessKind;
  /** When the server produced or the client obtained the shown data. */
  readonly checkedAt: Date | string | number;
  readonly now: Date | number;
  readonly online: boolean;
  /** The data itself is awaiting a server-side confirmation, such as a pending payment. */
  readonly pending?: boolean;
  /** The page was restored from the browser's back-forward cache without being refetched. */
  readonly restoredFromCache?: boolean;
}

const toTime = (value: Date | string | number): number =>
  value instanceof Date ? value.getTime() : typeof value === "number" ? value : new Date(value).getTime();

/** Offline wins over everything, then age, then a server-reported pending state. */
export function evaluateFreshness(input: FreshnessInput): FreshnessState {
  if (!input.online) return "OFFLINE";
  const checkedAt = toTime(input.checkedAt);
  const now = toTime(input.now);
  if (!Number.isFinite(checkedAt) || !Number.isFinite(now)) return "STALE";
  if (input.restoredFromCache === true) return "STALE";
  if (checkedAt - now > maximumFutureSkewMs) return "STALE";
  if (now - checkedAt > freshnessWindowsMs[input.kind]) return "STALE";
  return input.pending === true ? "PENDING" : "FRESH";
}

/** Milliseconds until FRESH or PENDING data becomes STALE; 0 when it already is. */
export function millisecondsUntilStale(kind: FreshnessKind, checkedAt: Date | string | number, now: Date | number): number {
  const remaining = toTime(checkedAt) + freshnessWindowsMs[kind] - toTime(now);
  return Number.isFinite(remaining) ? Math.max(0, remaining) : 0;
}
