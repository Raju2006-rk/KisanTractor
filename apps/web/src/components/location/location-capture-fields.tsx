"use client";

import { evaluateLocationFreshness } from "@kisantractor/domain";
import type { LocationCollectionPurpose, LocationSource, OwnerLocationProjection } from "@kisantractor/domain";
import { translate, type CatalogLocale } from "@kisantractor/i18n";
import { useState } from "react";

import { captureConsentedBrowserLocation } from "../../lib/browser-location";
import type { BrowserLocationCaptureResult } from "../../lib/browser-location";
import { Button, CheckboxField, StatusChip, TextInput } from "../ui";

export interface MapsCapabilityPresentation {
  readonly state: "UNCONFIGURED" | "SANDBOX" | "LIVE" | "DEGRADED";
  readonly isOperational: boolean;
  readonly isTest: boolean;
  readonly canRetry: boolean;
  readonly message: string;
}

export type LocationFieldValue = Pick<
  OwnerLocationProjection,
  "state" | "district" | "mandalOrTaluk" | "village" | "postalCode" | "landmark" |
  "source" | "latitude" | "longitude" | "accuracyMeters" | "capturedAt" | "consentedAt"
> & Readonly<{ id?: string }>;

export interface LocationCaptureFieldsProps {
  readonly locale: CatalogLocale;
  readonly location?: LocationFieldValue;
  readonly collectionPurpose: LocationCollectionPurpose;
  readonly mapsCapability: MapsCapabilityPresentation;
  readonly legend?: string;
  /** Keeps the approved manual coordinate alternative available on discovery forms. */
  readonly showCoordinateEntry?: boolean;
}

interface CapturedFields {
  readonly source: LocationSource;
  readonly latitude: number | undefined;
  readonly longitude: number | undefined;
  readonly accuracyMeters: number | undefined;
  readonly capturedAt: string;
  readonly consentedAt: string | undefined;
}

interface AddressFields {
  readonly state: string;
  readonly district: string;
  readonly mandalOrTaluk: string;
  readonly village: string;
  readonly postalCode: string;
  readonly landmark: string;
}

interface MapCandidate extends AddressFields {
  readonly source: "MAP_SEARCH" | "MAP_PIN";
  readonly latitude: number;
  readonly longitude: number;
  readonly accuracyMeters?: number;
  readonly capturedAt: string;
}

type MapOperationResult =
  | Readonly<{ kind: "RESOLVED"; state: "SANDBOX" | "LIVE"; testOnly: boolean; locations?: readonly MapCandidate[]; location?: MapCandidate }>
  | Readonly<{ kind: "UNAVAILABLE"; state: "UNCONFIGURED" | "DEGRADED"; retryable: boolean; manualAlternativeAvailable: true; message: string }>;

const initialCapture = (location: LocationFieldValue | undefined): CapturedFields => ({
  source: location?.source ?? "MANUAL_ADDRESS",
  latitude: location?.latitude,
  longitude: location?.longitude,
  accuracyMeters: location?.accuracyMeters,
  capturedAt: new Date(location?.capturedAt ?? Date.now()).toISOString(),
  consentedAt: location?.consentedAt === undefined
    ? undefined
    : new Date(location.consentedAt).toISOString(),
});

const initialAddress = (location: LocationFieldValue | undefined): AddressFields => ({
  state: location?.state ?? "",
  district: location?.district ?? "",
  mandalOrTaluk: location?.mandalOrTaluk ?? "",
  village: location?.village ?? "",
  postalCode: location?.postalCode ?? "",
  landmark: location?.landmark ?? "",
});

const statusTone = (kind: BrowserLocationCaptureResult["kind"]) => {
  if (kind === "CAPTURED") return "success" as const;
  if (kind === "PERMISSION_DENIED") return "danger" as const;
  return "warning" as const;
};

const candidateFrom = (value: unknown): MapCandidate | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const source = value as Record<string, unknown>;
  const text = (field: string): string | undefined => typeof source[field] === "string" && source[field].trim()
    ? source[field].trim()
    : undefined;
  const state = text("state");
  const district = text("district");
  const mandalOrTaluk = text("mandalOrTaluk");
  const village = text("village");
  const latitude = source.latitude;
  const longitude = source.longitude;
  const locationSource = source.source;
  const capturedAt = text("capturedAt");
  if (!state || !district || !mandalOrTaluk || !village || typeof latitude !== "number" ||
      typeof longitude !== "number" || !Number.isFinite(latitude) || !Number.isFinite(longitude) ||
      (locationSource !== "MAP_SEARCH" && locationSource !== "MAP_PIN") || !capturedAt ||
      Number.isNaN(new Date(capturedAt).getTime())) return undefined;
  return Object.freeze({
    state,
    district,
    mandalOrTaluk,
    village,
    postalCode: text("postalCode") ?? "",
    landmark: text("landmark") ?? "",
    source: locationSource,
    latitude,
    longitude,
    capturedAt,
    ...(typeof source.accuracyMeters === "number" && Number.isFinite(source.accuracyMeters)
      ? { accuracyMeters: source.accuracyMeters }
      : {}),
  });
};

export function LocationCaptureFields({
  locale,
  location,
  collectionPurpose,
  mapsCapability,
  legend = translate(locale, "form.serviceLocation"),
  showCoordinateEntry = false,
}: LocationCaptureFieldsProps) {
  const [address, setAddress] = useState<AddressFields>(() => initialAddress(location));
  const [capture, setCapture] = useState<CapturedFields>(() => initialCapture(location));
  const [gpsConsent, setGpsConsent] = useState(false);
  const [consentedAt, setConsentedAt] = useState<string>();
  const [captureResult, setCaptureResult] = useState<BrowserLocationCaptureResult>();
  const [capturing, setCapturing] = useState(false);
  const [mapQuery, setMapQuery] = useState("");
  const [mapCandidates, setMapCandidates] = useState<readonly MapCandidate[]>([]);
  const [mapMessage, setMapMessage] = useState<string>();
  const [mapBusy, setMapBusy] = useState(false);

  const freshness = evaluateLocationFreshness(new Date(capture.capturedAt));
  const mapsUnavailable = !mapsCapability.isOperational;

  const markManualEdit = () => {
    setCapture((current) => current.source === "MANUAL_ADDRESS"
      ? current
      : { ...current, source: "MANUAL_ADDRESS", capturedAt: new Date().toISOString() });
    setMapMessage(undefined);
  };

  const updateAddress = (field: keyof AddressFields, value: string) => {
    markManualEdit();
    setAddress((current) => ({ ...current, [field]: value }));
  };

  const updateCoordinate = (field: "latitude" | "longitude", value: string) => {
    markManualEdit();
    const parsed = value.trim() === "" ? undefined : Number(value);
    setCapture((current) => ({
      ...current,
      [field]: parsed !== undefined && Number.isFinite(parsed) ? parsed : undefined,
      accuracyMeters: undefined,
    }));
  };

  const requestGps = async () => {
    setCapturing(true);
    const result = await captureConsentedBrowserLocation(
      typeof navigator === "undefined" ? undefined : navigator.geolocation,
      {
        granted: gpsConsent,
        ...(consentedAt === undefined ? {} : { consentedAt: new Date(consentedAt) }),
        purpose: collectionPurpose,
      },
      { mapAlternativeAvailable: mapsCapability.isOperational },
    );
    setCaptureResult(result);
    if (result.kind === "CAPTURED") {
      setCapture({
        source: result.location.source,
        latitude: result.location.latitude,
        longitude: result.location.longitude,
        accuracyMeters: result.location.accuracyMeters,
        capturedAt: result.location.capturedAt.toISOString(),
        consentedAt: result.location.consentedAt.toISOString(),
      });
    }
    setCapturing(false);
  };

  const callMaps = async (operation: "map-search" | "map-pin", body: Readonly<Record<string, unknown>>) => {
    setMapBusy(true);
    setMapMessage(undefined);
    try {
      const response = await fetch(`/api/locations/${operation}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...body, collectionPurpose }),
      });
      const result = await response.json() as MapOperationResult;
      if (result.kind === "UNAVAILABLE") {
        setMapCandidates([]);
        setMapMessage(result.message);
        return;
      }
      const candidates = (result.locations ?? (result.location ? [result.location] : []))
        .map(candidateFrom)
        .filter((candidate): candidate is MapCandidate => candidate !== undefined);
      setMapCandidates(candidates);
      setMapMessage(candidates.length === 0 ? translate(locale, "location.mapNoResults") : undefined);
      if (operation === "map-pin" && candidates[0]) applyCandidate(candidates[0]);
    } catch {
      setMapCandidates([]);
      setMapMessage(translate(locale, "location.mapsRetryManual"));
    } finally {
      setMapBusy(false);
    }
  };

  const applyCandidate = (candidate: MapCandidate) => {
    setAddress({
      state: candidate.state,
      district: candidate.district,
      mandalOrTaluk: candidate.mandalOrTaluk,
      village: candidate.village,
      postalCode: candidate.postalCode,
      landmark: candidate.landmark,
    });
    setCapture({
      source: candidate.source,
      latitude: candidate.latitude,
      longitude: candidate.longitude,
      accuracyMeters: candidate.accuracyMeters,
      capturedAt: candidate.capturedAt,
      consentedAt: undefined,
    });
    setMapCandidates([]);
    setMapMessage(translate(locale, "location.mapSelected"));
  };

  return (
    <fieldset className="kt-owner-form__section kt-location-capture">
      <legend>{legend}</legend>
      <p className="kt-field__hint">{translate(locale, "location.manualHelp")}</p>
      <div className="kt-owner-form__grid">
        <TextInput id="state" label={translate(locale, "form.state")} name="state" onChange={(event) => updateAddress("state", event.currentTarget.value)} required value={address.state} />
        <TextInput id="district" label={translate(locale, "form.district")} name="district" onChange={(event) => updateAddress("district", event.currentTarget.value)} required value={address.district} />
        <TextInput id="mandalOrTaluk" label={translate(locale, "form.mandalOrTaluk")} name="mandalOrTaluk" onChange={(event) => updateAddress("mandalOrTaluk", event.currentTarget.value)} required value={address.mandalOrTaluk} />
        <TextInput id="village" label={translate(locale, "form.village")} name="village" onChange={(event) => updateAddress("village", event.currentTarget.value)} required value={address.village} />
        <TextInput id="postalCode" inputMode="numeric" label={translate(locale, "form.postalCode")} maxLength={6} name="postalCode" onChange={(event) => updateAddress("postalCode", event.currentTarget.value)} pattern="[0-9]{6}" value={address.postalCode} />
        <TextInput id="landmark" label={translate(locale, "form.landmark")} name="landmark" onChange={(event) => updateAddress("landmark", event.currentTarget.value)} value={address.landmark} />
        {showCoordinateEntry ? (
          <>
            <TextInput id="latitude" inputMode="decimal" label={translate(locale, "form.latitude")} max={90} min={-90} name="latitude" onChange={(event) => updateCoordinate("latitude", event.currentTarget.value)} required step="any" type="number" value={capture.latitude ?? ""} />
            <TextInput id="longitude" inputMode="decimal" label={translate(locale, "form.longitude")} max={180} min={-180} name="longitude" onChange={(event) => updateCoordinate("longitude", event.currentTarget.value)} required step="any" type="number" value={capture.longitude ?? ""} />
          </>
        ) : null}
      </div>

      <section aria-labelledby="gps-location-title" className="kt-location-capture__option">
        <h3 id="gps-location-title">{translate(locale, "location.useGps")}</h3>
        <CheckboxField checked={gpsConsent} hint={translate(locale, "location.gpsConsentPurpose")} id="gpsLocationConsent" label={translate(locale, "location.gpsConsent")} name="gpsLocationConsent" onChange={(event) => {
          const checked = event.currentTarget.checked;
          setGpsConsent(checked);
          setConsentedAt(checked ? new Date().toISOString() : undefined);
        }} value="true" />
        <Button disabled={!gpsConsent || capturing} onClick={requestGps} type="button" variant="secondary">
          {capturing ? translate(locale, "location.capturingGps") : translate(locale, "location.captureGps")}
        </Button>
        {captureResult ? <div aria-live="polite" className="kt-location-capture__status" role={captureResult.kind === "PERMISSION_DENIED" ? "alert" : "status"}>
          <StatusChip tone={statusTone(captureResult.kind)}>{captureResult.kind === "CAPTURED" ? translate(locale, "location.gpsCaptured") : translate(locale, "location.gpsUnavailable")}</StatusChip>
          <p>{captureResult.kind === "CAPTURED" ? captureResult.location.accuracy.message : captureResult.message}</p>
        </div> : null}
      </section>

      <section aria-labelledby="map-location-title" className="kt-location-capture__option">
        <h3 id="map-location-title">{translate(locale, "location.maps")}</h3>
        <StatusChip tone={mapsUnavailable ? "warning" : mapsCapability.isTest ? "info" : "success"}>
          {mapsUnavailable
            ? translate(locale, mapsCapability.state === "DEGRADED" ? "capability.degradedLabel" : "capability.unavailable")
            : translate(locale, mapsCapability.isTest ? "capability.sandboxLabel" : "capability.liveLabel")}
        </StatusChip>
        <p>{mapsUnavailable ? translate(locale, "help.mapsUnavailable") : mapsCapability.message}</p>
        {mapsCapability.isOperational ? (
          <div className="kt-location-map-search">
            <TextInput id="mapLocationQuery" label={translate(locale, "location.mapSearchLabel")} onChange={(event) => setMapQuery(event.currentTarget.value)} value={mapQuery} />
            <Button disabled={mapBusy || mapQuery.trim().length === 0} onClick={() => void callMaps("map-search", { query: mapQuery })} type="button" variant="secondary">
              {mapBusy ? translate(locale, "location.mapSearching") : translate(locale, "location.mapSearchAction")}
            </Button>
            {showCoordinateEntry && capture.latitude !== undefined && capture.longitude !== undefined ? (
              <Button disabled={mapBusy} onClick={() => void callMaps("map-pin", { latitude: capture.latitude, longitude: capture.longitude })} type="button" variant="quiet">
                {translate(locale, "location.resolveCoordinates")}
              </Button>
            ) : null}
            {mapCandidates.length > 0 ? <div aria-label={translate(locale, "location.mapResults")} className="kt-location-map-search__results">
              {mapCandidates.map((candidate) => <Button key={`${candidate.latitude}:${candidate.longitude}`} onClick={() => applyCandidate(candidate)} type="button" variant="quiet">
                {translate(locale, "location.useMapResult")}: {candidate.village}, {candidate.district}
              </Button>)}
            </div> : null}
          </div>
        ) : null}
        {mapsCapability.canRetry ? <p>{translate(locale, "location.mapsRetryManual")}</p> : null}
        {mapMessage ? <p aria-live="polite" role="status">{mapMessage}</p> : null}
      </section>

      <div aria-live="polite" className="kt-location-capture__freshness">
        <StatusChip tone={freshness.status === "STALE" ? "danger" : freshness.status === "AGING" ? "warning" : "success"}>
          {translate(locale, `location.freshness.${freshness.status.toLowerCase()}`)}
        </StatusChip>
        <p>{freshness.message}</p>
      </div>

      <input name="source" type="hidden" value={capture.source} />
      <input name="collectionPurpose" type="hidden" value={collectionPurpose} />
      <input name="capturedAt" type="hidden" value={capture.capturedAt} />
      {capture.consentedAt ? <input name="consentedAt" type="hidden" value={capture.consentedAt} /> : null}
      {showCoordinateEntry || capture.latitude === undefined ? null : <input name="latitude" type="hidden" value={capture.latitude} />}
      {showCoordinateEntry || capture.longitude === undefined ? null : <input name="longitude" type="hidden" value={capture.longitude} />}
      {capture.accuracyMeters === undefined ? null : <input name="accuracyMeters" type="hidden" value={capture.accuracyMeters} />}
    </fieldset>
  );
}
