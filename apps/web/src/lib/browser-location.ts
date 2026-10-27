import { describeCoordinateAccuracy, evaluateLocationFreshness } from "@kisantractor/domain";
import type {
  CoordinateAccuracyPresentation,
  LocationCollectionPurpose,
  LocationFreshness,
} from "@kisantractor/domain";

export interface BrowserCoordinates {
  readonly latitude: number;
  readonly longitude: number;
  readonly accuracy: number;
}

export interface BrowserPosition {
  readonly coords: BrowserCoordinates;
  readonly timestamp: number;
}

export interface BrowserPositionError {
  readonly code: number;
  readonly message?: string;
}

export interface BrowserGeolocation {
  getCurrentPosition(
    success: (position: BrowserPosition) => void,
    error: (error: BrowserPositionError) => void,
    options: Readonly<{
      enableHighAccuracy: boolean;
      maximumAge: number;
      timeout: number;
    }>,
  ): void;
}

export interface BrowserLocationConsent {
  readonly granted: boolean;
  readonly consentedAt?: Date;
  readonly purpose: LocationCollectionPurpose;
}

export interface CapturedBrowserLocation {
  readonly latitude: number;
  readonly longitude: number;
  readonly accuracyMeters: number;
  readonly capturedAt: Date;
  readonly consentedAt: Date;
  readonly collectionPurpose: LocationCollectionPurpose;
  readonly source: "DEVICE_GPS";
  readonly accuracy: CoordinateAccuracyPresentation;
  readonly freshness: LocationFreshness;
}

export type BrowserLocationCaptureResult =
  | Readonly<{ kind: "CAPTURED"; location: CapturedBrowserLocation }>
  | Readonly<{
      kind: "CONSENT_REQUIRED" | "PERMISSION_DENIED" | "UNAVAILABLE" | "POSITION_UNAVAILABLE" | "TIMED_OUT";
      message: string;
      manualEntryAvailable: true;
      mapAlternativeAvailable: boolean;
    }>;

export interface BrowserLocationCaptureOptions {
  readonly timeoutMs?: number;
  readonly mapAlternativeAvailable?: boolean;
  readonly now?: () => Date;
}

const unavailable = (
  kind: Exclude<BrowserLocationCaptureResult["kind"], "CAPTURED">,
  message: string,
  mapAlternativeAvailable: boolean,
): BrowserLocationCaptureResult => Object.freeze({
  kind,
  message,
  manualEntryAvailable: true,
  mapAlternativeAvailable,
});

export async function captureConsentedBrowserLocation(
  geolocation: BrowserGeolocation | undefined,
  consent: BrowserLocationConsent,
  options: BrowserLocationCaptureOptions = {},
): Promise<BrowserLocationCaptureResult> {
  const mapAvailable = options.mapAlternativeAvailable ?? false;
  if (!consent.granted || consent.consentedAt === undefined) {
    return unavailable(
      "CONSENT_REQUIRED",
      "Choose location sharing after reviewing its purpose. You can enter the location manually instead.",
      mapAvailable,
    );
  }
  if (!geolocation) {
    return unavailable(
      "UNAVAILABLE",
      "This browser cannot provide GPS. Enter the location manually or use an available map.",
      mapAvailable,
    );
  }

  const now = options.now ?? (() => new Date());
  const timeout = options.timeoutMs ?? 10_000;
  if (!Number.isFinite(timeout) || timeout <= 0) throw new RangeError("GPS timeout must be positive");

  return new Promise((resolve) => {
    geolocation.getCurrentPosition(
      (position) => {
        const capturedAt = new Date(position.timestamp);
        const consentedAt = new Date(consent.consentedAt!);
        const effectiveCaptureTime = Number.isNaN(capturedAt.getTime()) ? now() : capturedAt;
        const accuracy = describeCoordinateAccuracy(position.coords.accuracy);
        resolve(Object.freeze({
          kind: "CAPTURED",
          location: Object.freeze({
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            accuracyMeters: position.coords.accuracy,
            capturedAt: effectiveCaptureTime,
            consentedAt,
            collectionPurpose: consent.purpose,
            source: "DEVICE_GPS",
            accuracy,
            freshness: evaluateLocationFreshness(effectiveCaptureTime, undefined, now()),
          }),
        }));
      },
      (error) => {
        if (error.code === 1) {
          resolve(unavailable(
            "PERMISSION_DENIED",
            "Location permission was denied. We will not ask again automatically; enter the location manually or use an available map.",
            mapAvailable,
          ));
          return;
        }
        if (error.code === 3) {
          resolve(unavailable(
            "TIMED_OUT",
            "GPS took too long. Retry when the signal improves or enter the location manually.",
            mapAvailable,
          ));
          return;
        }
        resolve(unavailable(
          "POSITION_UNAVAILABLE",
          "GPS coordinates are unavailable. Enter the location manually or use an available map.",
          mapAvailable,
        ));
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout },
    );
  });
}
