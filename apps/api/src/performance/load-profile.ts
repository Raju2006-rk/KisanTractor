/**
 * The documented initial load profile (Requirement 18.4). This module is the single definition
 * used by the seed (`load-seed.ts`), the HTTP load suite (`load.performance.test.ts`), and the
 * write-up in `ops/performance/initial-load-profile.md`. Change the numbers here only.
 *
 * Every number is a planning assumption for the Phase 1 launch, not measured demand. The doc
 * explains how each was derived.
 */

/** District service areas the launch covers. Coordinates are approximate district headquarters. */
export interface LaunchDistrict {
  readonly state: string;
  readonly district: string;
  readonly latitude: number;
  readonly longitude: number;
}

export const launchDistricts: readonly LaunchDistrict[] = Object.freeze([
  { state: "Telangana", district: "Warangal", latitude: 17.9784, longitude: 79.5941 },
  { state: "Telangana", district: "Karimnagar", latitude: 18.4386, longitude: 79.1288 },
  { state: "Telangana", district: "Nizamabad", latitude: 18.6725, longitude: 78.0941 },
  { state: "Telangana", district: "Khammam", latitude: 17.2473, longitude: 80.1514 },
  { state: "Telangana", district: "Nalgonda", latitude: 17.0575, longitude: 79.2671 },
  { state: "Telangana", district: "Mahabubnagar", latitude: 16.7488, longitude: 77.9855 },
  { state: "Andhra Pradesh", district: "Guntur", latitude: 16.3067, longitude: 80.4365 },
  { state: "Andhra Pradesh", district: "Krishna", latitude: 16.1875, longitude: 81.1389 },
  { state: "Andhra Pradesh", district: "Kurnool", latitude: 15.8281, longitude: 78.0373 },
  { state: "Karnataka", district: "Mysuru", latitude: 12.2958, longitude: 76.6394 },
  { state: "Karnataka", district: "Belagavi", latitude: 15.8497, longitude: 74.4977 },
  { state: "Karnataka", district: "Raichur", latitude: 16.2076, longitude: 77.3463 },
].map((district) => Object.freeze(district)));

/** Stored data volume at the end of the first season. */
export const dataVolume = Object.freeze({
  /** Owners spread evenly across launch districts. */
  owners: 1_500,
  /** Owners running a fleet; each has `fleetSize` Tractors. */
  fleetOwners: 20,
  fleetSize: 25,
  /** Tractors in total, including fleets. Non-fleet owners have one to four. */
  tractors: 4_000,
  /** Tractors are placed within this distance of their district headquarters. */
  tractorScatterKilometers: 30,
  farmers: 20_000,
  /** Bookings over the first season (180 days): about 650 a day. */
  historicalBookings: 120_000,
  seasonDays: 180,
  /** Share of historical bookings by final status; the rest are completed and paid in cash. */
  historicalStatusShare: Object.freeze({ REJECTED: 0.1, EXPIRED: 0.1, CANCELLED: 0.05 }),
  /** Share of historical bookings made for someone else (with a Recipient snapshot). */
  someoneElseShare: 0.15,
});

/**
 * Principals that sign in through the OTP sandbox and drive the HTTP load. Their history is
 * seeded so they sit at the heavy end of the distribution: fleet Owners' dashboards are many
 * pages deep, and some Farmers have long booking histories.
 */
export const activePrincipals = Object.freeze({
  farmers: 60,
  /** Of the active Farmers, these have `heavyFarmerBookings` historical bookings each. */
  heavyFarmers: 4,
  heavyFarmerBookings: 400,
  farmerBookings: 40,
  /** Active fleet Owners (each with `dataVolume.fleetSize` Tractors). */
  fleetOwners: 5,
  fleetOwnerBookings: 3_000,
  /** Active Owners with `ownerTractors` Tractors each. */
  owners: 15,
  ownerTractors: 4,
  ownerBookings: 150,
  /** Future requests waiting for each active Owner's decision when the run starts. */
  pendingPerOwner: 30,
  /** Future accepted per-acre/per-trip jobs per active Owner, ready to start. */
  acceptedPerOwner: 20,
});

export type LoadOperationKind = "read" | "write";

export interface LoadOperationShare {
  readonly operation: LoadOperationName;
  readonly kind: LoadOperationKind;
  /** Share of all requests in the mix; the shares sum to 1. */
  readonly share: number;
}

export type LoadOperationName =
  | "discovery.search"
  | "farmer.bookings.list"
  | "farmer.bookings.deepPage"
  | "farmer.booking.detail"
  | "farmer.booking.settlement"
  | "owner.bookings.list"
  | "owner.bookings.deepPage"
  | "owner.booking.detail"
  | "owner.tractors.list"
  | "owner.tractor.availability"
  | "owner.job.session"
  | "identity.session"
  | "farmer.booking.create"
  | "owner.booking.accept"
  | "owner.booking.reject"
  | "owner.job.start"
  | "owner.job.complete"
  | "owner.payment.cash"
  | "identity.otp.request"
  | "identity.otp.verify";

/**
 * Request mix at the design point: 80% reads, 20% writes. Discovery is a read even though it is
 * a POST (it changes no state). The Owner dashboard fans out to the Tractor list, one
 * availability read per Tractor, and the first bookings page, so those appear separately.
 */
export const requestMix: readonly LoadOperationShare[] = Object.freeze([
  { operation: "discovery.search", kind: "read", share: 0.25 },
  { operation: "farmer.bookings.list", kind: "read", share: 0.08 },
  { operation: "farmer.bookings.deepPage", kind: "read", share: 0.04 },
  { operation: "farmer.booking.detail", kind: "read", share: 0.08 },
  { operation: "farmer.booking.settlement", kind: "read", share: 0.03 },
  { operation: "owner.bookings.list", kind: "read", share: 0.08 },
  { operation: "owner.bookings.deepPage", kind: "read", share: 0.06 },
  { operation: "owner.booking.detail", kind: "read", share: 0.06 },
  { operation: "owner.tractors.list", kind: "read", share: 0.04 },
  { operation: "owner.tractor.availability", kind: "read", share: 0.04 },
  { operation: "owner.job.session", kind: "read", share: 0.02 },
  { operation: "identity.session", kind: "read", share: 0.02 },
  { operation: "farmer.booking.create", kind: "write", share: 0.08 },
  // New sign-ups during the launch window: one challenge and one verification each.
  { operation: "identity.otp.request", kind: "write", share: 0.005 },
  { operation: "identity.otp.verify", kind: "write", share: 0.005 },
  { operation: "owner.booking.accept", kind: "write", share: 0.04 },
  { operation: "owner.booking.reject", kind: "write", share: 0.01 },
  { operation: "owner.job.start", kind: "write", share: 0.02 },
  { operation: "owner.job.complete", kind: "write", share: 0.02 },
  { operation: "owner.payment.cash", kind: "write", share: 0.02 },
].map((entry) => Object.freeze(entry as LoadOperationShare)));

/** Discovery radius choices: most searches keep the 5 km default, some widen to broad rural areas. */
export const discoveryRadiusMix: readonly Readonly<{ radiusKilometers: number | undefined; share: number }>[] = Object.freeze([
  { radiusKilometers: undefined, share: 0.5 },
  { radiusKilometers: 25, share: 0.3 },
  { radiusKilometers: 50, share: 0.15 },
  { radiusKilometers: 100, share: 0.05 },
]);

/**
 * Arrival rates. The design point is the documented initial load the latency budgets apply to;
 * the headroom step doubles it and is reported, with only the no-5xx rule asserted.
 */
export const trafficProfile = Object.freeze({
  designRequestsPerSecond: 20,
  headroomRequestsPerSecond: 40,
  /** Measured duration of each step. */
  stepSeconds: 120,
  /** Unmeasured warm-up at the design rate before the first step. */
  warmUpSeconds: 15,
  /**
   * Concurrent acceptance race: Tractors, overlapping requests per Tractor, adjacent per Tractor.
   * Each Tractor's requests are accepted at the same instant; Tractors start one after another
   * every `raceStaggerMs` on top of the design load. The last `raceSimultaneousTractors` all
   * start together as a stress case (reported; correctness asserted, latency not budgeted).
   */
  raceTractors: 40,
  raceStaggerMs: 250,
  raceSimultaneousTractors: 10,
  raceOverlappingPerTractor: 4,
  raceAdjacentPerTractor: 1,
});

/** Requirement 18.4 budgets for the documented initial load. */
export const latencyBudgets = Object.freeze({
  readP95Ms: 500,
  writeP95Ms: 800,
});

/** Validates that the mixes are well formed; called by the unit tests and the load suite. */
export function assertLoadProfileConsistent(): void {
  const total = requestMix.reduce((sum, entry) => sum + entry.share, 0);
  if (Math.abs(total - 1) > 1e-9) throw new Error(`request mix shares sum to ${total}, not 1`);
  const radius = discoveryRadiusMix.reduce((sum, entry) => sum + entry.share, 0);
  if (Math.abs(radius - 1) > 1e-9) throw new Error(`discovery radius shares sum to ${radius}, not 1`);
  const names = new Set(requestMix.map((entry) => entry.operation));
  if (names.size !== requestMix.length) throw new Error("request mix lists an operation twice");
  const nonFleetTractors = dataVolume.tractors - dataVolume.fleetOwners * dataVolume.fleetSize;
  const nonFleetOwners = dataVolume.owners - dataVolume.fleetOwners;
  if (nonFleetTractors < nonFleetOwners || nonFleetTractors > nonFleetOwners * 4) {
    throw new Error("non-fleet owners must have one to four Tractors each");
  }
  if (activePrincipals.fleetOwners > dataVolume.fleetOwners) throw new Error("more active fleet owners than fleet owners");
}
