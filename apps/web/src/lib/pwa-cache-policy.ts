import { catalogLocales } from "@kisantractor/i18n";
import { pwaCachePrefix, serviceWorkerPath } from "./pwa-registration";

/**
 * Single source of truth for what the KisanTractor service worker may cache.
 *
 * The policy is an explicit allow-list (shell, public static assets, translation
 * catalogs) guarded by a deny-list that always wins. Anything not allow-listed,
 * including API, identity, document, payment, and booking traffic, bypasses the
 * service worker entirely and stays network-authoritative.
 *
 * `classifyPwaRequest` and `isStorablePwaResponse` are embedded verbatim into the
 * generated service worker script, so they MUST stay self-contained: no imports,
 * no references to module-level values, and only standard ES2022 syntax.
 */

export type PwaCacheBucket = "shell" | "static" | "translations";
export type PwaCacheStrategy = "cache-first" | "stale-while-revalidate" | "network-first";

export interface PwaAllowRule {
  readonly bucket: PwaCacheBucket;
  readonly strategy: PwaCacheStrategy;
  /** Regular-expression source matched against the raw URL pathname. */
  readonly pathPattern: string;
  /** Case-insensitive regular-expression source matched against the response Content-Type. */
  readonly contentTypePattern: string;
}

export interface PwaCachePolicy {
  readonly cachePrefix: string;
  readonly buckets: readonly PwaCacheBucket[];
  readonly precacheUrls: readonly string[];
  readonly offlineFallbackUrl: string;
  /** Case-insensitive regular-expression source matched against the decoded pathname. */
  readonly deniedPathPattern: string;
  /** Request headers whose presence marks a request as personalized or framework-private. */
  readonly sensitiveRequestHeaders: readonly string[];
  /** Query parameters tolerated on cacheable requests; any other parameter bypasses the cache. */
  readonly allowedQueryParams: readonly string[];
  readonly allowRules: readonly PwaAllowRule[];
  readonly maxEntriesPerBucket: number;
}

export type PwaBypassReason =
  | "method"
  | "invalid-url"
  | "cross-origin"
  | "sensitive-header"
  | "sensitive-path"
  | "query"
  | "not-allowlisted";

export type PwaCacheDecision =
  | {
      readonly action: "cache";
      readonly bucket: PwaCacheBucket;
      readonly strategy: PwaCacheStrategy;
      readonly contentTypePattern: string;
    }
  | { readonly action: "offline-fallback" }
  | { readonly action: "bypass"; readonly reason: PwaBypassReason };

export interface PwaRequestDescriptor {
  readonly method: string;
  readonly url: string;
  readonly mode?: string;
  readonly headers?: { get(name: string): string | null };
}

export interface PwaResponseDescriptor {
  readonly status: number;
  readonly type: string;
  readonly redirected?: boolean;
  readonly headers: { get(name: string): string | null };
}

const localeAlternation = catalogLocales.join("|");

export { serviceWorkerPath };
export const offlineFallbackUrl = "/offline.html";

export const translationCatalogUrl = (locale: (typeof catalogLocales)[number]) =>
  `/locales/${locale}.json`;

export const pwaCachePolicy: PwaCachePolicy = Object.freeze({
  cachePrefix: pwaCachePrefix,
  buckets: Object.freeze(["shell", "static", "translations"] as const),
  precacheUrls: Object.freeze([
    offlineFallbackUrl,
    "/manifest.webmanifest",
    ...catalogLocales.map(translationCatalogUrl),
  ]),
  offlineFallbackUrl,
  deniedPathPattern: [
    // Server APIs, identity, role workspaces, and every private record family.
    "^/(?:api|auth|login|logout|verify|otp|sessions?|onboarding|account|farmer|owner|admin|support",
    "|documents?|uploads?|downloads?|grants?|payments?|receipts?|invoices?|refunds?|bookings?|jobs?",
    "|_next/data|_next/image|sw\\.js)(?:[/.]|$)",
    // Defensive catch-all for credential-like path segments anywhere.
    "|/(?:tokens?|private|secrets?|credentials?)(?:[/.]|$)",
  ].join(""),
  sensitiveRequestHeaders: Object.freeze([
    "authorization",
    "range",
    "rsc",
    "next-router-state-tree",
    "next-router-prefetch",
    "next-action",
  ]),
  allowedQueryParams: Object.freeze(["v", "dpl"]),
  allowRules: Object.freeze([
    Object.freeze({
      bucket: "shell",
      strategy: "cache-first",
      pathPattern: "^/_next/static/[A-Za-z0-9._~@%/[\\]()+-]+$",
      contentTypePattern: "^(?:application/javascript|text/javascript|text/css|font/|application/font-woff|image/)",
    }),
    Object.freeze({
      bucket: "shell",
      strategy: "network-first",
      pathPattern: "^/offline\\.html$",
      contentTypePattern: "^text/html",
    }),
    Object.freeze({
      bucket: "shell",
      strategy: "stale-while-revalidate",
      pathPattern: "^/manifest\\.webmanifest$",
      contentTypePattern: "^application/(?:manifest\\+)?json",
    }),
    Object.freeze({
      bucket: "static",
      strategy: "stale-while-revalidate",
      pathPattern: "^/(?:icons|images|fonts)/[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)*\\.(?:png|jpe?g|webp|avif|svg|ico|woff2?)$|^/(?:favicon\\.ico|apple-touch-icon\\.png)$",
      contentTypePattern: "^(?:image/|font/|application/font-woff)",
    }),
    Object.freeze({
      bucket: "translations",
      strategy: "network-first",
      pathPattern: `^/locales/(?:${localeAlternation})\\.json$`,
      contentTypePattern: "^application/json",
    }),
  ] as const),
  maxEntriesPerBucket: 150,
});

/** Decides how the service worker treats a request. Self-contained: embedded in /sw.js. */
export function classifyPwaRequest(
  policy: PwaCachePolicy,
  request: PwaRequestDescriptor,
  scopeOrigin: string,
): PwaCacheDecision {
  if (String(request.method).toUpperCase() !== "GET") return { action: "bypass", reason: "method" };
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return { action: "bypass", reason: "invalid-url" };
  }
  if (url.origin !== scopeOrigin) return { action: "bypass", reason: "cross-origin" };
  // Pages are never stored; the worker only substitutes the static offline page on network failure.
  if (request.mode === "navigate") return { action: "offline-fallback" };
  const headers = request.headers;
  if (headers) {
    for (const name of policy.sensitiveRequestHeaders) {
      if (headers.get(name) !== null) return { action: "bypass", reason: "sensitive-header" };
    }
  }
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(url.pathname);
  } catch {
    return { action: "bypass", reason: "invalid-url" };
  }
  const denied = new RegExp(policy.deniedPathPattern, "i");
  if (denied.test(url.pathname) || denied.test(decodedPath)) {
    return { action: "bypass", reason: "sensitive-path" };
  }
  for (const name of url.searchParams.keys()) {
    if (!policy.allowedQueryParams.includes(name)) return { action: "bypass", reason: "query" };
  }
  for (const rule of policy.allowRules) {
    if (new RegExp(rule.pathPattern).test(url.pathname)) {
      return {
        action: "cache",
        bucket: rule.bucket,
        strategy: rule.strategy,
        contentTypePattern: rule.contentTypePattern,
      };
    }
  }
  return { action: "bypass", reason: "not-allowlisted" };
}

/** Decides whether a network response may be written to a cache. Self-contained: embedded in /sw.js. */
export function isStorablePwaResponse(
  contentTypePattern: string,
  response: PwaResponseDescriptor | undefined | null,
): boolean {
  if (!response || response.status !== 200 || response.redirected === true) return false;
  // "basic" is a same-origin network response; "default" is a same-realm constructed one.
  if (response.type !== "basic" && response.type !== "default") return false;
  const header = (name: string) => response.headers.get(name) ?? "";
  if (/(?:^|[,\s])(?:no-store|private)(?:$|[,\s=])/i.test(header("cache-control"))) return false;
  if (/(?:^|[,\s])(?:\*|cookie|authorization)(?:$|[,\s])/i.test(header("vary"))) return false;
  if (response.headers.get("set-cookie") !== null) return false;
  return new RegExp(contentTypePattern, "i").test(header("content-type").trim());
}
