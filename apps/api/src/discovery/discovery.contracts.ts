import type {
  AuthPrincipal,
  LocationInput,
  NormalizedLocation,
  PricingMethod,
} from "@kisantractor/domain";

export interface DiscoveryPolicy {
  readonly defaultRadiusKilometers: number;
  readonly maximumRadiusKilometers: number;
  readonly defaultPageSize: number;
  readonly maximumPageSize: number;
  readonly maximumLocationAgeMs: number;
}

export const defaultDiscoveryPolicy: Readonly<DiscoveryPolicy> = Object.freeze({
  defaultRadiusKilometers: 5,
  maximumRadiusKilometers: 100,
  defaultPageSize: 20,
  maximumPageSize: 50,
  maximumLocationAgeMs: 24 * 60 * 60 * 1_000,
});

export interface DiscoveryIntervalInput {
  readonly start: Date;
  readonly end: Date;
}

export interface DiscoverySearchInput {
  readonly serviceLocation: LocationInput;
  readonly serviceId: string;
  readonly requestedInterval: DiscoveryIntervalInput;
  readonly radiusKilometers?: number;
  readonly equipmentTypeId?: string;
  readonly pricingMethod?: PricingMethod;
  readonly pageSize?: number;
  readonly cursor?: string;
}

export interface DiscoveryCursorPosition {
  readonly availabilityRank: number;
  readonly distanceMeters: number;
  readonly tractorId: string;
}

export interface NormalizedDiscoveryQuery {
  readonly serviceLocation: NormalizedLocation & {
    readonly latitude: number;
    readonly longitude: number;
  };
  readonly serviceId: string;
  readonly requestedInterval: DiscoveryIntervalInput;
  readonly radiusKilometers: number;
  readonly equipmentTypeId?: string;
  readonly pricingMethod?: PricingMethod;
  readonly pageSize: number;
  readonly evaluatedAt: Date;
  readonly staleBefore: Date;
  readonly cursor?: DiscoveryCursorPosition;
}

export interface DiscoveryPricingRule {
  readonly id: string;
  readonly method: PricingMethod;
  readonly ratePaise: number;
  readonly currency: string;
  readonly roundingPolicy?: "PROPORTIONAL_MINUTE" | "THIRTY_MINUTE_BLOCK" | "ONE_HOUR_BLOCK";
}

export interface DiscoveryStoreRow {
  readonly tractorId: string;
  readonly brand: string;
  readonly model: string;
  readonly state: string;
  readonly district: string;
  readonly ownerDisplayName?: string;
  readonly photoAltText?: string;
  readonly serviceOfferingId: string;
  readonly serviceId: string;
  readonly serviceName: string;
  readonly equipmentId?: string;
  readonly equipmentTypeId?: string;
  readonly equipmentName?: string;
  readonly pricingRules: readonly DiscoveryPricingRule[];
  readonly availabilityRank: number;
  readonly distanceMeters: number;
}

export interface DiscoveryStore {
  search(query: NormalizedDiscoveryQuery): Promise<readonly DiscoveryStoreRow[]>;
}

export interface DiscoveryTractorCard {
  readonly id: string;
  readonly brand: string;
  readonly model: string;
  readonly photo?: Readonly<{ altText: string }>;
  readonly approximateLocation: Readonly<{ state: string; district: string }>;
  readonly approximateDistance: Readonly<{
    kilometers: number;
    label: string;
    isEstimate: true;
    exactCoordinatesExposed: false;
  }>;
  readonly ownerDisplayName?: string;
  readonly service: Readonly<{
    offeringId: string;
    id: string;
    name: string;
  }>;
  readonly equipment?: Readonly<{
    id: string;
    typeId: string;
    name: string;
  }>;
  readonly pricingRules: readonly DiscoveryPricingRule[];
  readonly availability: Readonly<{ available: true; rank: number }>;
}

export interface DiscoveryPage {
  readonly items: readonly DiscoveryTractorCard[];
  readonly nextCursor?: string;
  readonly radiusKilometers: number;
  readonly defaultRadiusApplied: boolean;
  readonly canExpandRadius: boolean;
  readonly maximumRadiusKilometers: number;
  readonly origin: Readonly<{ state: string; district: string }>;
  readonly evaluatedAt: Date;
}

export interface DiscoverySessionAuthenticator {
  authenticateAccessCredential(accessCredential: string): Promise<AuthPrincipal>;
}
