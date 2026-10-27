import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { catalogLocales } from "@kisantractor/i18n";
import { pwaCachePolicy } from "./pwa-cache-policy";
import { buildServiceWorkerScript } from "./pwa-service-worker";

const origin = "https://kisantractor.test";
const apiOrigin = "https://api.kisantractor.test";

/** In-memory stand-in for the browser CacheStorage API used by the worker. */
class MemoryCache {
  readonly entries = new Map<string, Response>();
  private key(request: string | Request) {
    return typeof request === "string" ? request : request.url;
  }
  async put(request: string | Request, response: Response) {
    this.entries.set(this.key(request), response);
  }
  async match(request: string | Request) {
    const key = new URL(this.key(request), origin).href;
    return this.entries.get(key)?.clone();
  }
  async keys() {
    return [...this.entries.keys()].map((url) => new Request(url));
  }
  async delete(request: string | Request) {
    return this.entries.delete(this.key(request));
  }
}

class MemoryCacheStorage {
  readonly stores = new Map<string, MemoryCache>();
  async open(name: string) {
    const existing = this.stores.get(name) ?? new MemoryCache();
    this.stores.set(name, existing);
    return existing;
  }
  async keys() {
    return [...this.stores.keys()];
  }
  async delete(name: string) {
    return this.stores.delete(name);
  }
  storedUrls() {
    return [...this.stores.values()].flatMap((cache) => [...cache.entries.keys()]);
  }
}

type Route = () => Response;
interface FetchEventLike {
  readonly request: Request | { method: string; url: string; mode: string; headers: Headers };
  respondWith(response: Promise<Response>): void;
  waitUntil(task: Promise<unknown>): void;
}

const asset = (body: string, contentType: string, headers: Record<string, string> = {}) =>
  new Response(body, { status: 200, headers: { "content-type": contentType, ...headers } });

function defaultRoutes(): Map<string, Route> {
  const routes = new Map<string, Route>([
    [`${origin}/offline.html`, () => asset("<p>offline</p>", "text/html; charset=utf-8", { "cache-control": "public, max-age=0" })],
    [`${origin}/manifest.webmanifest`, () => asset("{}", "application/manifest+json")],
  ]);
  for (const locale of catalogLocales) {
    routes.set(`${origin}/locales/${locale}.json`, () => asset(JSON.stringify({ locale }), "application/json"));
  }
  return routes;
}

function loadWorker(routes: Map<string, Route> = defaultRoutes()) {
  const listeners = new Map<string, (event: unknown) => void>();
  const caches = new MemoryCacheStorage();
  const network = { online: true, calls: [] as { url: string; credentials: string | undefined }[] };
  const fetch = async (input: string | Request | { url: string }) => {
    const url = typeof input === "string" ? input : input.url;
    network.calls.push({ url, credentials: input instanceof Request ? input.credentials : undefined });
    if (!network.online) throw new TypeError("Failed to fetch");
    const route = routes.get(url);
    return route ? route() : new Response("not found", { status: 404, headers: { "content-type": "text/plain" } });
  };
  const lifecycle = { skipWaiting: 0, claimed: 0 };
  const self = {
    location: { origin },
    addEventListener: (type: string, listener: (event: unknown) => void) => listeners.set(type, listener),
    skipWaiting: async () => void (lifecycle.skipWaiting += 1),
    clients: { claim: async () => void (lifecycle.claimed += 1) },
  };
  const script = buildServiceWorkerScript();
  // A fresh realm proves the embedded policy functions are self-contained.
  runInContext(script, createContext({ self, caches, fetch, Request, Response, Headers, URL }));

  async function drain(tasks: Promise<unknown>[]) {
    while (tasks.length > 0) await Promise.allSettled(tasks.splice(0));
  }
  async function lifecycleEvent(type: "install" | "activate") {
    const tasks: Promise<unknown>[] = [];
    listeners.get(type)?.({ waitUntil: (task: Promise<unknown>) => tasks.push(task) });
    await drain(tasks);
  }
  async function dispatch(request: FetchEventLike["request"]) {
    let responded: Promise<Response> | undefined;
    const tasks: Promise<unknown>[] = [];
    const event: FetchEventLike = {
      request,
      respondWith: (response) => {
        responded = response;
      },
      waitUntil: (task) => tasks.push(task),
    };
    listeners.get("fetch")?.(event);
    if (!responded) return { intercepted: false as const };
    const response = await responded;
    await drain(tasks);
    return { intercepted: true as const, response };
  }
  const navigation = (path: string) => ({ method: "GET", url: `${origin}${path}`, mode: "navigate", headers: new Headers() });
  return { caches, dispatch, lifecycle, lifecycleEvent, navigation, network, routes, script };
}

/** Validates: Requirements 17.2, 17.5 */
describe("generated service worker", () => {
  it("precaches only the offline shell, manifest, and translation catalogs without credentials", async () => {
    const worker = loadWorker();
    await worker.lifecycleEvent("install");
    expect(worker.caches.storedUrls().sort()).toEqual(
      [
        `${origin}/manifest.webmanifest`,
        `${origin}/offline.html`,
        ...catalogLocales.map((locale) => `${origin}/locales/${locale}.json`),
      ].sort(),
    );
    expect(worker.network.calls.every((call) => call.credentials === "omit")).toBe(true);
    expect([...worker.caches.stores.keys()].every((name) => name.startsWith(pwaCachePolicy.cachePrefix))).toBe(true);
    expect(worker.lifecycle.skipWaiting).toBe(1);
  });

  it("never intercepts or stores token, document, payment, or booking traffic", async () => {
    const worker = loadWorker();
    const sensitive = [
      new Request(`${origin}/api/auth/verify-otp`, { method: "POST", body: "{}" }),
      new Request(`${origin}/api/farmer/bookings`),
      new Request(`${origin}/api/farmer/bookings/b-1/dispute`, { method: "POST", body: "{}" }),
      new Request(`${origin}/api/owner/documents/doc-1/download`),
      new Request(`${origin}/api/owner/bookings/b-1/payments/cash`, { method: "POST", body: "{}" }),
      new Request(`${origin}/farmer/bookings/b-1?_rsc=abc`, { headers: { rsc: "1" } }),
      new Request(`${apiOrigin}/identity/session`, { headers: { authorization: "Bearer secret" } }),
      new Request(`${apiOrigin}/farmer/bookings`),
      new Request(`${origin}/locales/en.json`, { headers: { authorization: "Bearer secret" } }),
    ];
    for (const request of sensitive) {
      expect((await worker.dispatch(request)).intercepted, request.url).toBe(false);
    }
    expect(worker.caches.storedUrls()).toEqual([]);
    expect(worker.network.calls).toEqual([]);
  });

  it("serves hashed shell assets cache-first after the first network load", async () => {
    const url = `${origin}/_next/static/chunks/main-app-3f9a1c.js`;
    const worker = loadWorker();
    worker.routes.set(url, () => asset("console.log(1)", "application/javascript", { "cache-control": "public, max-age=31536000, immutable" }));
    const first = await worker.dispatch(new Request(url));
    expect(first.intercepted && (await first.response.text())).toBe("console.log(1)");
    worker.network.online = false;
    const second = await worker.dispatch(new Request(url));
    expect(second.intercepted && (await second.response.text())).toBe("console.log(1)");
  });

  it("refreshes translation catalogs from the network and falls back to the cache offline", async () => {
    const url = `${origin}/locales/te.json`;
    const worker = loadWorker();
    await worker.lifecycleEvent("install");
    worker.routes.set(url, () => asset(JSON.stringify({ version: 2 }), "application/json"));
    const online = await worker.dispatch(new Request(url));
    expect(online.intercepted && (await online.response.json())).toEqual({ version: 2 });
    worker.network.online = false;
    const offline = await worker.dispatch(new Request(url));
    expect(offline.intercepted && (await offline.response.json())).toEqual({ version: 2 });
  });

  it("does not store allow-listed paths whose responses are private or personalized", async () => {
    const worker = loadWorker();
    worker.routes.set(`${origin}/locales/en.json`, () => asset("{}", "application/json", { "cache-control": "private, no-store" }));
    worker.routes.set(`${origin}/icons/icon.png`, () => asset("png", "image/png", { vary: "Cookie" }));
    worker.routes.set(`${origin}/_next/static/chunks/a.js`, () => asset("<html>", "text/html"));
    for (const path of ["/locales/en.json", "/icons/icon.png", "/_next/static/chunks/a.js"]) {
      const result = await worker.dispatch(new Request(`${origin}${path}`));
      expect(result.intercepted && result.response.status).toBe(200);
    }
    expect(worker.caches.storedUrls()).toEqual([]);
  });

  it("passes page navigations to the network without storing them and shows the offline page on failure", async () => {
    const worker = loadWorker();
    await worker.lifecycleEvent("install");
    const before = worker.caches.storedUrls().length;
    worker.routes.set(`${origin}/farmer/bookings/b-1`, () => asset("<p>Booking for Lakshmi</p>", "text/html", { "cache-control": "private, no-store" }));
    const online = await worker.dispatch(worker.navigation("/farmer/bookings/b-1"));
    expect(online.intercepted && (await online.response.text())).toBe("<p>Booking for Lakshmi</p>");
    expect(worker.caches.storedUrls()).toHaveLength(before);

    worker.network.online = false;
    const offline = await worker.dispatch(worker.navigation("/farmer/bookings/b-1"));
    expect(offline.intercepted && (await offline.response.text())).toBe("<p>offline</p>");
  });

  it("removes stale KisanTractor caches on activation and leaves other caches alone", async () => {
    const worker = loadWorker();
    await worker.lifecycleEvent("install");
    const current = [...worker.caches.stores.keys()];
    await worker.caches.open(`${pwaCachePolicy.cachePrefix}shell-oldversion`);
    await worker.caches.open("unrelated-cache");
    await worker.lifecycleEvent("activate");
    expect([...worker.caches.stores.keys()].sort()).toEqual([...current, "unrelated-cache"].sort());
    expect(worker.lifecycle.claimed).toBe(1);
  });

  it("bounds each cache bucket", async () => {
    const worker = loadWorker();
    const limit = pwaCachePolicy.maxEntriesPerBucket;
    for (let index = 0; index < limit + 5; index += 1) {
      const url = `${origin}/_next/static/chunks/c${index}.js`;
      worker.routes.set(url, () => asset("x", "text/javascript"));
      await worker.dispatch(new Request(url));
    }
    expect(worker.caches.storedUrls()).toHaveLength(limit);
    expect(worker.caches.storedUrls()).not.toContain(`${origin}/_next/static/chunks/c0.js`);
  });

  it("is deterministic and contains no push, notification, sync, or install-prompt behavior", () => {
    const { script } = loadWorker();
    expect(buildServiceWorkerScript()).toBe(script);
    expect(script).not.toMatch(/addEventListener\(\s*["'](?:push|notificationclick|sync|periodicsync)["']/);
    expect(script).not.toMatch(/requestPermission|pushManager|showNotification|beforeinstallprompt/);
  });
});
