import { normalizeLocation } from "@kisantractor/domain";
import type {
  LocationCollectionPurpose,
  NormalizedLocation,
} from "@kisantractor/domain";

import { CapabilityRegistry } from "./capability-registry.js";
import type { CapabilityState } from "./capability-registry.js";

export interface MapAddress {
  readonly state: string;
  readonly district: string;
  readonly mandalOrTaluk: string;
  readonly village: string;
  readonly postalCode?: string;
  readonly landmark?: string;
}

export interface ProviderMapLocation extends MapAddress {
  readonly latitude: number;
  readonly longitude: number;
  readonly accuracyMeters?: number;
  readonly providerPlaceId?: string;
}

export interface MapGeocodingProvider {
  search(query: string, signal?: AbortSignal): Promise<readonly ProviderMapLocation[]>;
  reverseGeocode(
    coordinates: Readonly<{ latitude: number; longitude: number }>,
    signal?: AbortSignal,
  ): Promise<ProviderMapLocation | undefined>;
}

/** A composition-root provider whose declared mode must match the capability state. */
export interface ConfiguredMapGeocodingProvider extends MapGeocodingProvider {
  readonly mode: "SANDBOX" | "LIVE";
}

export type MapGeocodingUnavailable = Readonly<{
  kind: "UNAVAILABLE";
  state: "UNCONFIGURED" | "DEGRADED";
  retryable: boolean;
  manualAlternativeAvailable: true;
  message: string;
}>;

export type MapSearchResult =
  | Readonly<{
      kind: "RESOLVED";
      state: "SANDBOX" | "LIVE";
      testOnly: boolean;
      locations: readonly NormalizedLocation[];
    }>
  | MapGeocodingUnavailable;

export type MapPinResult =
  | Readonly<{
      kind: "RESOLVED";
      state: "SANDBOX" | "LIVE";
      testOnly: boolean;
      location?: NormalizedLocation;
    }>
  | MapGeocodingUnavailable;

export interface ProviderGatedMapsAdapterOptions {
  readonly now?: () => Date;
}

const unavailable = (
  state: "UNCONFIGURED" | "DEGRADED",
): MapGeocodingUnavailable => Object.freeze({
  kind: "UNAVAILABLE",
  state,
  retryable: state === "DEGRADED",
  manualAlternativeAvailable: true,
  message: state === "UNCONFIGURED"
    ? "Maps and geocoding are not configured. Enter state, district, mandal or taluk, village, and landmark manually."
    : "Maps and geocoding are temporarily unavailable. Retry safely or enter the location manually.",
});

const activeState = (state: CapabilityState): state is "SANDBOX" | "LIVE" =>
  state === "SANDBOX" || state === "LIVE";

export class ProviderGatedMapsAdapter {
  readonly #now: () => Date;

  constructor(
    private readonly registry: CapabilityRegistry,
    options: ProviderGatedMapsAdapterOptions = {},
  ) {
    this.#now = options.now ?? (() => new Date());
  }

  async search(
    queryValue: string,
    purpose: LocationCollectionPurpose,
    signal?: AbortSignal,
  ): Promise<MapSearchResult> {
    const query = queryValue.normalize("NFC").trim().replace(/\s+/gu, " ");
    if (query.length === 0 || query.length > 250) {
      throw new TypeError("Map search query must contain 1 to 250 characters");
    }

    const state = this.registry.getState("MAPS_GEOCODING");
    if (!activeState(state)) return unavailable(state);

    const provider = this.registry.requireConfigured<MapGeocodingProvider>("MAPS_GEOCODING");
    try {
      const capturedAt = this.#now();
      const locations = (await provider.search(query, signal)).map((candidate) =>
        normalizeLocation({
          ...candidate,
          source: "MAP_SEARCH",
          capturedAt,
          collectionPurpose: purpose,
        }),
      );
      return Object.freeze({
        kind: "RESOLVED",
        state,
        testOnly: state === "SANDBOX",
        locations: Object.freeze(locations),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      return unavailable("DEGRADED");
    }
  }

  async resolvePin(
    coordinates: Readonly<{ latitude: number; longitude: number }>,
    purpose: LocationCollectionPurpose,
    signal?: AbortSignal,
  ): Promise<MapPinResult> {
    const state = this.registry.getState("MAPS_GEOCODING");
    if (!activeState(state)) return unavailable(state);

    const provider = this.registry.requireConfigured<MapGeocodingProvider>("MAPS_GEOCODING");
    try {
      const candidate = await provider.reverseGeocode(coordinates, signal);
      const location = candidate === undefined
        ? undefined
        : normalizeLocation({
            ...candidate,
            latitude: coordinates.latitude,
            longitude: coordinates.longitude,
            source: "MAP_PIN",
            capturedAt: this.#now(),
            collectionPurpose: purpose,
          });
      return Object.freeze({
        kind: "RESOLVED",
        state,
        testOnly: state === "SANDBOX",
        ...(location === undefined ? {} : { location }),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      return unavailable("DEGRADED");
    }
  }
}
