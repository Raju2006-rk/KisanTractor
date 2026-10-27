export interface PrivatePublicTractorFields {
  readonly ownerPhone?: string;
  readonly exactCoordinates?: {
    readonly latitude: number;
    readonly longitude: number;
  };
  readonly registrationNumber?: string;
  readonly documentObjectKeys?: readonly string[];
  readonly otpMaterial?: unknown;
  readonly paymentProviderPayload?: unknown;
}

export interface PublicTractorProjectionSource {
  readonly id: string;
  readonly brand: string;
  readonly model: string;
  readonly state: string;
  readonly district: string;
  readonly approximateDistanceKilometers?: number;
  readonly ownerDisplayName?: string;
  readonly ownerNamePublic: boolean;
  readonly serviceNames: readonly string[];
  readonly pricingMethods: readonly ("HOURLY" | "PER_ACRE" | "PER_TRIP")[];
  readonly available: boolean;
  readonly privateFields?: PrivatePublicTractorFields;
}

export interface PublicTractorProjection {
  readonly id: string;
  readonly brand: string;
  readonly model: string;
  readonly approximateLocation: {
    readonly state: string;
    readonly district: string;
  };
  readonly approximateDistanceKilometers?: number;
  readonly ownerDisplayName?: string;
  readonly serviceNames: readonly string[];
  readonly pricingMethods: readonly ("HOURLY" | "PER_ACRE" | "PER_TRIP")[];
  readonly available: boolean;
}

/** Builds public output from an allowlist; private source fields are never copied. */
export function projectPublicTractor(
  source: PublicTractorProjectionSource,
): PublicTractorProjection {
  const projection: PublicTractorProjection = {
    id: source.id,
    brand: source.brand,
    model: source.model,
    approximateLocation: Object.freeze({
      state: source.state,
      district: source.district,
    }),
    serviceNames: Object.freeze([...source.serviceNames]),
    pricingMethods: Object.freeze([...source.pricingMethods]),
    available: source.available,
    ...(source.approximateDistanceKilometers === undefined
      ? {}
      : { approximateDistanceKilometers: source.approximateDistanceKilometers }),
    ...(source.ownerNamePublic && source.ownerDisplayName !== undefined
      ? { ownerDisplayName: source.ownerDisplayName }
      : {}),
  };

  return Object.freeze(projection);
}
