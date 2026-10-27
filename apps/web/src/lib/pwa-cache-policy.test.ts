import { describe, expect, it } from "vitest";
import {
  classifyPwaRequest,
  isStorablePwaResponse,
  pwaCachePolicy,
  type PwaCacheDecision,
} from "./pwa-cache-policy";

const origin = "https://kisantractor.test";
const classify = (path: string, init: { method?: string; mode?: string; headers?: Record<string, string> } = {}) =>
  classifyPwaRequest(
    pwaCachePolicy,
    {
      method: init.method ?? "GET",
      url: path.startsWith("http") ? path : `${origin}${path}`,
      mode: init.mode ?? "no-cors",
      headers: new Headers(init.headers ?? {}),
    },
    origin,
  );
const cacheTarget = (decision: PwaCacheDecision) =>
  decision.action === "cache" ? `${decision.bucket}:${decision.strategy}` : decision.action === "bypass" ? `bypass:${decision.reason}` : decision.action;

/** Validates: Requirements 17.2 */
describe("PWA cache allow-list", () => {
  it.each([
    ["/_next/static/chunks/main-app-3f9a1c.js", "shell:cache-first"],
    ["/_next/static/css/app-7c1e2b.css", "shell:cache-first"],
    ["/_next/static/media/inter-latin.4f2b.woff2", "shell:cache-first"],
    ["/_next/static/chunks/app/farmer/%5B%5B...slug%5D%5D/page-91ab.js", "shell:cache-first"],
    ["/_next/static/chunks/webpack-1a2b.js?dpl=dpl_123", "shell:cache-first"],
    ["/offline.html", "shell:network-first"],
    ["/manifest.webmanifest", "shell:stale-while-revalidate"],
    ["/icons/icon-192.png", "static:stale-while-revalidate"],
    ["/images/landing/hero-tractor.webp", "static:stale-while-revalidate"],
    ["/favicon.ico", "static:stale-while-revalidate"],
    ["/locales/en.json", "translations:network-first"],
    ["/locales/te.json", "translations:network-first"],
    ["/locales/hi.json", "translations:network-first"],
    ["/locales/kn.json", "translations:network-first"],
    ["/locales/ta.json", "translations:network-first"],
  ])("caches %s as %s", (path, expected) => {
    expect(cacheTarget(classify(path))).toBe(expected);
  });

  it("allow-lists every precached URL so install and runtime rules agree", () => {
    for (const path of pwaCachePolicy.precacheUrls) {
      expect(classify(path).action, path).toBe("cache");
    }
  });
});

/** Validates: Requirements 17.2 */
describe("PWA cache deny rules", () => {
  it.each([
    // Identity and session tokens.
    ["/api/auth/request-otp", "sensitive-path"],
    ["/api/auth/verify-otp", "sensitive-path"],
    ["/login/verify?next=%2Ffarmer", "sensitive-path"],
    ["/identity/session/token", "sensitive-path"],
    // Private documents and upload/download grants.
    ["/api/owner/documents/doc-1/download", "sensitive-path"],
    ["/documents/doc-1.pdf", "sensitive-path"],
    ["/uploads/rc-front.jpg", "sensitive-path"],
    ["/grants/abc", "sensitive-path"],
    // Payment responses and receipts.
    ["/api/owner/bookings/b-1/payments/cash", "sensitive-path"],
    ["/payments/p-1", "sensitive-path"],
    ["/receipts/r-1", "sensitive-path"],
    ["/invoices/i-1", "sensitive-path"],
    // Booking data, role workspaces, and framework data/RSC payloads.
    ["/api/farmer/bookings", "sensitive-path"],
    ["/api/farmer/bookings/b-1/dispute", "sensitive-path"],
    ["/farmer/bookings/b-1", "sensitive-path"],
    ["/owner/bookings/b-1", "sensitive-path"],
    ["/owner", "sensitive-path"],
    ["/_next/data/build/farmer/bookings.json", "sensitive-path"],
    ["/_next/image?url=%2Fuploads%2Fx.jpg&w=640&q=75", "sensitive-path"],
    ["/sw.js", "sensitive-path"],
    // Encoded or mixed-case paths cannot sneak past the deny-list.
    ["/%61pi/farmer/bookings", "sensitive-path"],
    ["/API/Farmer/Bookings", "sensitive-path"],
    ["/images/private/rc.png", "sensitive-path"],
    // Anything else is not allow-listed or carries an unexpected query.
    ["/", "not-allowlisted"],
    ["/help", "not-allowlisted"],
    ["/locales/xx.json", "not-allowlisted"],
    ["/_next/static/chunks/main.js?token=abc", "query"],
    ["/locales/en.json?session=1", "query"],
    ["/icons/icon.png?X-Amz-Signature=abc", "query"],
  ])("bypasses %s (%s)", (path, reason) => {
    expect(classify(path)).toEqual({ action: "bypass", reason });
  });

  it("bypasses cross-origin API traffic such as the backend booking and session endpoints", () => {
    for (const url of [
      "https://api.kisantractor.test/farmer/bookings",
      "https://api.kisantractor.test/identity/session",
      "https://storage.example/private/doc-1?signature=abc",
      "https://kisantractor.test.evil.example/_next/static/chunks/main.js",
    ]) {
      expect(classify(url)).toEqual({ action: "bypass", reason: "cross-origin" });
    }
  });

  it("bypasses non-GET requests even for shell paths", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD"]) {
      expect(classify("/_next/static/chunks/main.js", { method })).toEqual({ action: "bypass", reason: "method" });
    }
  });

  it("bypasses authorized, ranged, and RSC/server-action requests on otherwise cacheable paths", () => {
    for (const headers of [
      { authorization: "Bearer secret" },
      { range: "bytes=0-10" },
      { rsc: "1" },
      { "next-router-state-tree": "%5B%5D" },
      { "next-action": "abc" },
    ]) {
      expect(classify("/locales/en.json", { headers })).toEqual({ action: "bypass", reason: "sensitive-header" });
    }
  });

  it("never caches page navigations, including Farmer and Owner booking screens", () => {
    for (const path of ["/", "/farmer/bookings/b-1", "/owner/bookings", "/offline.html"]) {
      expect(classify(path, { mode: "navigate" })).toEqual({ action: "offline-fallback" });
    }
    expect(classify("/farmer", { mode: "navigate", method: "POST" })).toEqual({ action: "bypass", reason: "method" });
  });

  it("bypasses malformed URLs", () => {
    expect(classify("not a url")).toEqual({ action: "bypass", reason: "invalid-url" });
    expect(classify("/%E0%A4%A.js")).toEqual({ action: "bypass", reason: "invalid-url" });
  });
});

/** Validates: Requirements 17.2 */
describe("PWA response storability", () => {
  const json = "^application/json";
  const response = (headers: Record<string, string>, init: { status?: number; type?: string; redirected?: boolean } = {}) => ({
    status: init.status ?? 200,
    type: init.type ?? "basic",
    redirected: init.redirected ?? false,
    headers: new Headers({ "content-type": "application/json", ...headers }),
  });

  it("stores public same-origin 200 responses with the expected content type", () => {
    expect(isStorablePwaResponse(json, response({ "cache-control": "public, max-age=3600" }))).toBe(true);
    expect(isStorablePwaResponse(json, response({}, { type: "default" }))).toBe(true);
  });

  it.each([
    ["no-store", response({ "cache-control": "no-store" })],
    ["private", response({ "cache-control": "private, max-age=0" })],
    ["vary cookie", response({ vary: "Accept-Encoding, Cookie" })],
    ["vary authorization", response({ vary: "Authorization" })],
    ["vary *", response({ vary: "*" })],
    ["set-cookie", response({ "set-cookie": "kt_access_token=secret" })],
    ["wrong content type", response({ "content-type": "text/html" })],
    ["opaque", response({}, { type: "opaque" })],
    ["cors", response({}, { type: "cors" })],
    ["partial", response({}, { status: 206 })],
    ["not found", response({}, { status: 404 })],
    ["redirected", response({}, { redirected: true })],
  ])("refuses to store a %s response", (_label, candidate) => {
    expect(isStorablePwaResponse(json, candidate)).toBe(false);
  });

  it("refuses to store missing responses", () => {
    expect(isStorablePwaResponse(json, undefined)).toBe(false);
  });
});
