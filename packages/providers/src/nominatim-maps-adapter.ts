import { normalizeLocation } from "@kisantractor/domain";

import { assertProviderRuntimeSafety } from "./capability-registry.js";
import type {
  ConfiguredMapGeocodingProvider,
  ProviderMapLocation,
} from "./maps-geocoding.js";

export const NOMINATIM_PROVIDER = "nominatim";
/** OpenStreetMap's public Nominatim service. No API key; a User-Agent is required by its policy. */
export const NOMINATIM_API_BASE_URL = "https://nominatim.openstreetmap.org";
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESULTS = 5;

/** Minimal HTTP seam so contract tests never reach the public service. */
export interface MapsHttpRequest {
  readonly method: "GET";
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
}

export interface MapsHttpResponse {
  readonly status: number;
  json(): Promise<unknown>;
}

export type MapsHttpClient = (request: MapsHttpRequest) => Promise<MapsHttpResponse>;

/** Default client: global fetch, refusing redirects so no hop is followed. */
export const fetchMapsHttpClient: MapsHttpClient = async (request) => {
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    signal: request.signal,
    redirect: "error",
  });
  return { status: response.status, json: () => response.json() as Promise<unknown> };
};

export interface NominatimMapsAdapterOptions {
  readonly environment: "local" | "test" | "staging" | "production";
  readonly mode: "SANDBOX" | "LIVE";
  /** Contact identifier required by Nominatim's usage policy; sent as the User-Agent. */
  readonly userAgent: string;
  readonly http?: MapsHttpClient;
  readonly apiBaseUrl?: string;
  readonly timeoutMs?: number;
  /** Biases results to a country (ISO 3166-1 alpha-2). Defaults to "in". */
  readonly countryCodes?: string;
}

type JsonRecord = Readonly<Record<string, unknown>>;
const asRecord = (value: unknown): JsonRecord | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonRecord) : undefined;
const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value : undefined;
const num = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
};

/**
 * Maps a Nominatim `address` object to the fields the domain requires. Indian
 * results vary, so each slot falls back through several OSM keys. A result
 * missing any required slot is dropped rather than guessed.
 */
function toProviderLocation(entry: JsonRecord): ProviderMapLocation | undefined {
  const latitude = num(entry.lat);
  const longitude = num(entry.lon);
  if (latitude === undefined || longitude === undefined) return undefined;
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return undefined;

  const address = asRecord(entry.address) ?? {};
  const state = text(address.state) ?? text(address["state_district"]);
  const district =
    text(address["state_district"]) ??
    text(address.district) ??
    text(address.county);
  const mandalOrTaluk =
    text(address.county) ??
    text(address["sub_district"]) ??
    text(address.city) ??
    text(address.town) ??
    text(address.suburb);
  const village =
    text(address.village) ??
    text(address.hamlet) ??
    text(address.town) ??
    text(address.city) ??
    text(address.suburb) ??
    text(address.neighbourhood);

  if (state === undefined || district === undefined || mandalOrTaluk === undefined || village === undefined) {
    return undefined;
  }

  const postalCode = text(address["postcode"]);
  const landmark = text(entry["display_name"]);
  const placeId = entry["place_id"];

  return Object.freeze({
    state,
    district,
    mandalOrTaluk,
    village,
    ...(postalCode === undefined || !/^\d{6}$/u.test(postalCode) ? {} : { postalCode }),
    ...(landmark === undefined ? {} : { landmark: landmark.slice(0, 250) }),
    latitude,
    longitude,
    ...(typeof placeId === "string" || typeof placeId === "number" ? { providerPlaceId: String(placeId) } : {}),
  });
}

function requireHttps(value: string): URL {
  const base = new URL(value);
  if (base.protocol !== "https:") throw new TypeError("Nominatim base URL must use HTTPS");
  return base;
}

/**
 * OpenStreetMap Nominatim geocoding/reverse-geocoding, behind the provider-independent
 * `ConfiguredMapGeocodingProvider`. It returns only provider candidates; the
 * `ProviderGatedMapsAdapter` normalizes and capability-gates them, so discovery and
 * booking semantics are unchanged. SANDBOX and LIVE behave identically against the
 * same public service; the mode only labels results test-only in SANDBOX.
 */
export class NominatimMapsAdapter implements ConfiguredMapGeocodingProvider {
  readonly mode: "SANDBOX" | "LIVE";
  readonly #http: MapsHttpClient;
  readonly #base: URL;
  readonly #timeoutMs: number;
  readonly #userAgent: string;
  readonly #countryCodes: string;

  constructor(options: NominatimMapsAdapterOptions) {
    assertProviderRuntimeSafety({ environment: options.environment });
    if (options.mode === "LIVE" && (options.environment === "local" || options.environment === "test")) {
      throw new TypeError("LIVE maps are allowed only in staging or production");
    }
    if (options.mode === "SANDBOX" && options.environment === "production") {
      throw new TypeError("SANDBOX maps are development-only and must not run in production");
    }
    const userAgent = options.userAgent?.trim();
    if (!userAgent) throw new TypeError("Nominatim requires a non-empty User-Agent");
    this.mode = options.mode;
    this.#http = options.http ?? fetchMapsHttpClient;
    this.#base = requireHttps(options.apiBaseUrl ?? NOMINATIM_API_BASE_URL);
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError("timeoutMs must be a positive integer");
    this.#timeoutMs = timeoutMs;
    this.#userAgent = userAgent;
    this.#countryCodes = (options.countryCodes ?? "in").trim().toLowerCase();
  }

  async search(query: string, signal?: AbortSignal): Promise<readonly ProviderMapLocation[]> {
    const url = new URL("/search", this.#base);
    url.searchParams.set("q", query);
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("addressdetails", "1");
    url.searchParams.set("limit", String(MAX_RESULTS));
    if (this.#countryCodes.length > 0) url.searchParams.set("countrycodes", this.#countryCodes);

    const body = await this.#call(url, signal);
    if (!Array.isArray(body)) return Object.freeze([]);
    const locations: ProviderMapLocation[] = [];
    for (const entry of body) {
      const record = asRecord(entry);
      if (record === undefined) continue;
      const location = toProviderLocation(record);
      if (location !== undefined) locations.push(location);
    }
    return Object.freeze(locations);
  }

  async reverseGeocode(
    coordinates: Readonly<{ latitude: number; longitude: number }>,
    signal?: AbortSignal,
  ): Promise<ProviderMapLocation | undefined> {
    const url = new URL("/reverse", this.#base);
    url.searchParams.set("lat", String(coordinates.latitude));
    url.searchParams.set("lon", String(coordinates.longitude));
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("addressdetails", "1");

    const body = await this.#call(url, signal);
    const record = asRecord(body);
    if (record === undefined) return undefined;
    return toProviderLocation(record);
  }

  async #call(url: URL, signal?: AbortSignal): Promise<unknown> {
    const timeout = AbortSignal.timeout(this.#timeoutMs);
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    const response = await this.#http({
      method: "GET",
      url: url.toString(),
      headers: { "User-Agent": this.#userAgent, "Accept": "application/json" },
      signal: combined,
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Nominatim request failed with status ${response.status}`);
    }
    return response.json();
  }
}
