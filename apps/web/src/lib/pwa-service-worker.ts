import { createHash } from "node:crypto";
import {
  classifyPwaRequest,
  isStorablePwaResponse,
  pwaCachePolicy,
  type PwaCachePolicy,
} from "./pwa-cache-policy";

/**
 * Builds the service worker script served at /sw.js. The cache decisions are the
 * exact functions exported from pwa-cache-policy.ts, so the tested policy is the
 * shipped policy. The worker never registers push handlers or asks for permissions.
 */
export function buildServiceWorkerScript(policy: PwaCachePolicy = pwaCachePolicy): string {
  const body = `
const POLICY = ${JSON.stringify(policy)};
const classifyRequest = (${classifyPwaRequest.toString()});
const isStorableResponse = (${isStorablePwaResponse.toString()});
`;
  const version = createHash("sha256").update(body).digest("hex").slice(0, 16);
  return `/* KisanTractor service worker. Generated; do not edit. */
"use strict";
${body}
const CACHE_VERSION = ${JSON.stringify(version)};
const cacheName = (bucket) => POLICY.cachePrefix + bucket + "-" + CACHE_VERSION;
const currentCaches = new Set(POLICY.buckets.map(cacheName));

const decide = (request) => classifyRequest(POLICY, {
  method: request.method,
  url: request.url,
  mode: request.mode,
  headers: request.headers,
}, self.location.origin);

async function store(decision, url, response) {
  if (!isStorableResponse(decision.contentTypePattern, response)) return;
  const cache = await caches.open(cacheName(decision.bucket));
  await cache.put(url, response);
  const keys = await cache.keys();
  for (const key of keys.slice(0, Math.max(0, keys.length - POLICY.maxEntriesPerBucket))) {
    await cache.delete(key);
  }
}

async function fromNetwork(event, decision) {
  // Credentials are omitted so a stored copy can never be a personalized response.
  const response = await fetch(new Request(event.request, { credentials: "omit" }));
  if (isStorableResponse(decision.contentTypePattern, response)) {
    event.waitUntil(store(decision, event.request.url, response.clone()).catch(() => undefined));
  }
  return response;
}

async function fromCache(decision, url) {
  const cache = await caches.open(cacheName(decision.bucket));
  return cache.match(url);
}

async function respond(event, decision) {
  const url = event.request.url;
  if (decision.strategy === "cache-first") {
    return (await fromCache(decision, url)) ?? fromNetwork(event, decision);
  }
  if (decision.strategy === "stale-while-revalidate") {
    const cached = await fromCache(decision, url);
    if (!cached) return fromNetwork(event, decision);
    event.waitUntil(fromNetwork(event, decision).catch(() => undefined));
    return cached;
  }
  try {
    return await fromNetwork(event, decision);
  } catch (error) {
    const cached = await fromCache(decision, url);
    if (cached) return cached;
    throw error;
  }
}

async function navigate(event) {
  try {
    return await fetch(event.request);
  } catch (error) {
    const cache = await caches.open(cacheName("shell"));
    const offline = await cache.match(POLICY.offlineFallbackUrl);
    if (offline) return offline;
    throw error;
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    await Promise.allSettled(POLICY.precacheUrls.map(async (path) => {
      const url = new URL(path, self.location.origin).href;
      const decision = classifyRequest(POLICY, { method: "GET", url, mode: "same-origin" }, self.location.origin);
      if (decision.action !== "cache") return;
      const response = await fetch(new Request(url, { cache: "reload", credentials: "omit" }));
      await store(decision, url, response);
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter((name) => name.startsWith(POLICY.cachePrefix) && !currentCaches.has(name))
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const decision = decide(event.request);
  if (decision.action === "offline-fallback") {
    event.respondWith(navigate(event));
    return;
  }
  // Bypassed requests are not intercepted, so the browser handles them with no worker cache.
  if (decision.action !== "cache") return;
  event.respondWith(respond(event, decision));
});
`;
}
