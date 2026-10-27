import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

import type { PricingMethod } from "@kisantractor/domain";
import type { PoolClient } from "pg";

import { CatalogCrypto } from "../catalog/catalog-crypto.js";
import { activePrincipals, dataVolume, launchDistricts, trafficProfile, type LaunchDistrict } from "./load-profile.js";
import { createRandom, pick, randomInt } from "./load-runner.js";

/**
 * Bulk seed for the load-test database. Owners, Tractors, offerings, prices, and the season's
 * booking history are planned in memory from a fixed PRNG seed and written with set-based
 * INSERT ... SELECT FROM unnest(...). The active principals were created through the OTP sandbox
 * first; this seed gives them profiles, Tractors, history, and future work.
 *
 * Not seeded: outbox events, audit events, notifications, documents, and idempotency records
 * for history. The read paths under test do not touch them; the write paths append to them, and
 * idempotency records start empty as they would on launch day.
 */

export const loadServices = Object.freeze([
  { id: "30000000-0000-4000-8000-0000000000a1", code: "PLOUGHING", name: "Ploughing", equipmentType: "CULTIVATOR", areaMethod: "PER_ACRE" },
  { id: "30000000-0000-4000-8000-0000000000a2", code: "ROTAVATION", name: "Rotavation", equipmentType: "ROTAVATOR", areaMethod: "PER_ACRE" },
  { id: "30000000-0000-4000-8000-0000000000a3", code: "SOWING", name: "Sowing", equipmentType: "SEED_DRILL", areaMethod: "PER_ACRE" },
  { id: "30000000-0000-4000-8000-0000000000a4", code: "HAULAGE", name: "Haulage", equipmentType: "TROLLEY", areaMethod: "PER_TRIP" },
  { id: "30000000-0000-4000-8000-0000000000a5", code: "LAND_LEVELLING", name: "Land levelling", equipmentType: undefined, areaMethod: "PER_ACRE" },
] as const);

export const loadEquipmentTypes = Object.freeze([
  { id: "50000000-0000-4000-8000-0000000000b1", code: "CULTIVATOR", name: "Cultivator" },
  { id: "50000000-0000-4000-8000-0000000000b2", code: "ROTAVATOR", name: "Rotavator" },
  { id: "50000000-0000-4000-8000-0000000000b3", code: "SEED_DRILL", name: "Seed drill" },
  { id: "50000000-0000-4000-8000-0000000000b4", code: "TROLLEY", name: "Trolley" },
] as const);

const BRANDS = [["Mahindra", "575 DI"], ["Swaraj", "744 FE"], ["Sonalika", "DI 745"], ["John Deere", "5050 D"], ["Eicher", "380"], ["Massey Ferguson", "1035 DI"]] as const;
const LOCALES = ["te", "te", "hi", "kn", "ta", "en"] as const;
const ROUNDING = ["PROPORTIONAL_MINUTE", "THIRTY_MINUTE_BLOCK", "ONE_HOUR_BLOCK"] as const;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** Bookings per active fleet Owner created within one millisecond (concurrent requests). */
export const SAME_MILLISECOND_BURST = 6;

/** Deterministic UUID-shaped identifier from a namespace and ordinal. */
export const seedUuid = (namespace: string, ordinal: number | string): string => {
  const hex = createHash("md5").update(`kt-load-${namespace}-${ordinal}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/** ISO-8601 with microseconds from a fractional epoch-milliseconds value (JS Dates keep only ms). */
export const isoMicros = (epochMs: number): string => {
  const whole = Math.floor(epochMs);
  const micros = Math.min(999, Math.floor((epochMs - whole) * 1_000));
  return `${new Date(whole).toISOString().slice(0, 23)}${String(micros).padStart(3, "0")}Z`;
};

/** A point at most `kilometers` from the origin, uniform over the disc. */
export function scatter(random: () => number, latitude: number, longitude: number, kilometers: number): [number, number] {
  const distance = kilometers * Math.sqrt(random());
  const bearing = random() * 2 * Math.PI;
  const dLat = (distance / 111.32) * Math.cos(bearing);
  const dLon = (distance / (111.32 * Math.cos((latitude * Math.PI) / 180))) * Math.sin(bearing);
  return [Math.round((latitude + dLat) * 1e6) / 1e6, Math.round((longitude + dLon) * 1e6) / 1e6];
}

export interface SeedInput {
  readonly now: Date;
  readonly seed: number;
  readonly activeFarmerIds: readonly string[];
  readonly activeFleetOwnerIds: readonly string[];
  readonly activeOwnerIds: readonly string[];
  readonly fieldEncryptionKey: Uint8Array;
  readonly lookupHashKey: Uint8Array;
}

export interface SeededPricingRule {
  readonly id: string;
  readonly method: PricingMethod;
  readonly ratePaise: number;
}

export interface SeededOffering {
  readonly id: string;
  readonly serviceId: string;
  readonly rules: readonly SeededPricingRule[];
}

export interface SeededTractor {
  readonly id: string;
  readonly ownerId: string;
  readonly district: LaunchDistrict;
  readonly latitude: number;
  readonly longitude: number;
  readonly offerings: readonly SeededOffering[];
}

export interface SeededJob {
  readonly bookingId: string;
  readonly ownerId: string;
  readonly method: PricingMethod;
  readonly quantity: string;
}

export interface RaceGroup {
  readonly tractorId: string;
  readonly ownerId: string;
  readonly overlapping: readonly string[];
  readonly adjacent: readonly string[];
}

export interface SeededDataset {
  readonly counts: Readonly<Record<string, number>>;
  readonly seedSeconds: number;
  /** Bookable Tractors of the active Owners (the load creates bookings against these). */
  readonly activeTractors: readonly SeededTractor[];
  /** Pending future requests per active Owner, version 1. */
  readonly pending: ReadonlyMap<string, readonly SeededJob[]>;
  /** Accepted future per-acre/per-trip jobs per active Owner, ready to start. */
  readonly accepted: ReadonlyMap<string, readonly SeededJob[]>;
  readonly raceGroups: readonly RaceGroup[];
  /** A sample of each active principal's booking ids for detail reads. */
  readonly farmerBookingSamples: ReadonlyMap<string, readonly string[]>;
  readonly ownerBookingSamples: ReadonlyMap<string, readonly string[]>;
  /** Race intervals start this many days out; load-created bookings stay before it. */
  readonly raceDayOffset: number;
}

interface PlannedOffering extends SeededOffering {
  readonly equipmentId: string | null;
  readonly equipmentTypeId: string | null;
  readonly equipmentName: string | null;
}

interface PlannedTractor {
  readonly id: string;
  readonly ordinal: number;
  readonly ownerId: string;
  readonly district: LaunchDistrict;
  readonly latitude: number;
  readonly longitude: number;
  readonly online: boolean;
  readonly eligible: boolean;
  readonly locationAgeMs: number;
  readonly registrationCiphertext: Buffer;
  readonly registrationLookupHash: string;
  readonly brand: string;
  readonly model: string;
  readonly offerings: readonly PlannedOffering[];
}

type PlannedStatus = "COMPLETED" | "REJECTED" | "EXPIRED" | "CANCELLED" | "PENDING_OWNER_RESPONSE" | "ACCEPTED";

interface PlannedBooking {
  readonly id: string;
  readonly customerId: string;
  readonly ownerId: string;
  readonly tractorId: string;
  readonly offeringId: string;
  readonly ruleId: string;
  readonly method: PricingMethod;
  readonly ratePaise: number;
  readonly rounding: string | null;
  readonly quantity: number;
  readonly totalPaise: number;
  readonly startAt: number;
  readonly endAt: number;
  /** Fractional epoch milliseconds: stored with microsecond precision. */
  readonly createdAt: number;
  readonly status: PlannedStatus;
  readonly hasRecipient: boolean;
  readonly district: LaunchDistrict;
  readonly latitude: number;
  readonly longitude: number;
}

interface PlannedOwner {
  readonly id: string;
  readonly district: LaunchDistrict;
  readonly tractors: number;
  readonly active: boolean;
}

const formatQuantity = (value: number): string => (Number.isInteger(value) ? String(value) : value.toFixed(1));

/**
 * Runs one parameterized statement in batches over parallel column arrays ($1..$n), followed by
 * scalar parameters ($n+1..) that every batch shares.
 */
async function insertColumns(
  client: PoolClient,
  sql: string,
  columns: readonly (readonly unknown[])[],
  scalars: readonly unknown[] = [],
  batchSize = 5_000,
): Promise<void> {
  const length = columns[0]?.length ?? 0;
  for (let offset = 0; offset < length; offset += batchSize) {
    await client.query(sql, [...columns.map((column) => column.slice(offset, offset + batchSize)), ...scalars]);
  }
}

export async function seedLoadDataset(client: PoolClient, input: SeedInput): Promise<SeededDataset> {
  const startedAt = performance.now();
  const random = createRandom(input.seed);
  const crypto = new CatalogCrypto({ fieldEncryptionKey: input.fieldEncryptionKey, lookupHashKey: input.lookupHashKey });
  const now = input.now.getTime();
  const today = Math.floor(now / DAY_MS) * DAY_MS;
  const capturedAt = new Date(now - HOUR_MS).toISOString();
  const longAgo = new Date(now - 200 * DAY_MS).toISOString();

  // ---- Owners ---------------------------------------------------------------------------------
  const activeOwnerSet = new Set([...input.activeFleetOwnerIds, ...input.activeOwnerIds]);
  const backgroundFleet = dataVolume.fleetOwners - input.activeFleetOwnerIds.length;
  const backgroundOwnerIds = Array.from({ length: dataVolume.owners - activeOwnerSet.size }, (_, index) => seedUuid("owner", index));
  const backgroundFarmerIds = Array.from({ length: dataVolume.farmers - input.activeFarmerIds.length }, (_, index) => seedUuid("farmer", index));

  const owners: PlannedOwner[] = [];
  input.activeFleetOwnerIds.forEach((id, index) =>
    owners.push({ id, district: launchDistricts[index % launchDistricts.length]!, tractors: dataVolume.fleetSize, active: true }));
  input.activeOwnerIds.forEach((id, index) =>
    owners.push({ id, district: launchDistricts[(index + 3) % launchDistricts.length]!, tractors: activePrincipals.ownerTractors, active: true }));
  const activeTractorCount = owners.reduce((sum, owner) => sum + owner.tractors, 0);
  let remainingTractors = dataVolume.tractors - activeTractorCount - backgroundFleet * dataVolume.fleetSize;
  backgroundOwnerIds.forEach((id, index) => {
    const district = launchDistricts[index % launchDistricts.length]!;
    if (index < backgroundFleet) {
      owners.push({ id, district, tractors: dataVolume.fleetSize, active: false });
      return;
    }
    // Most own one Tractor; the bounds keep every remaining owner at one to four.
    const ownersLeft = backgroundOwnerIds.length - index;
    const minimum = Math.max(1, remainingTractors - (ownersLeft - 1) * 4);
    const maximum = Math.min(4, remainingTractors - (ownersLeft - 1));
    const preferred = random() < 0.45 ? 1 : random() < 0.5 ? 2 : random() < 0.6 ? 3 : 4;
    const tractors = Math.min(maximum, Math.max(minimum, preferred));
    remainingTractors -= tractors;
    owners.push({ id, district, tractors, active: false });
  });

  // ---- Tractors, equipment, offerings, prices -------------------------------------------------
  const tractors: PlannedTractor[] = [];
  for (const owner of owners) {
    for (let index = 0; index < owner.tractors; index += 1) {
      const ordinal = tractors.length;
      const [latitude, longitude] = scatter(random, owner.district.latitude, owner.district.longitude, dataVolume.tractorScatterKilometers);
      const [brand, model] = pick(random, BRANDS);
      const registration = `TS${String(ordinal % 100).padStart(2, "0")}LT${String(ordinal).padStart(4, "0")}`;
      const services = [loadServices[0], ...loadServices.slice(1).filter(() => random() < 0.35)];
      const offerings = services.map((service, serviceIndex): PlannedOffering => {
        const withEquipment = service.equipmentType !== undefined && (service.code !== "PLOUGHING" || random() < 0.6);
        const equipmentType = withEquipment ? loadEquipmentTypes.find((type) => type.code === service.equipmentType) : undefined;
        const key = `${ordinal}-${serviceIndex}`;
        return {
          id: seedUuid("offering", key),
          serviceId: service.id,
          equipmentId: equipmentType === undefined ? null : seedUuid("equipment", key),
          equipmentTypeId: equipmentType?.id ?? null,
          equipmentName: equipmentType?.name ?? null,
          rules: Object.freeze([
            { id: seedUuid("rule-hourly", key), method: "HOURLY" as const, ratePaise: randomInt(random, 14, 24) * 5_000 },
            { id: seedUuid("rule-area", key), method: service.areaMethod as PricingMethod, ratePaise: randomInt(random, 16, 30) * 5_000 },
          ]),
        };
      });
      tractors.push({
        id: seedUuid("tractor", ordinal),
        ordinal,
        ownerId: owner.id,
        district: owner.district,
        latitude,
        longitude,
        online: owner.active || random() < 0.85,
        eligible: owner.active || random() < 0.92,
        locationAgeMs: owner.active ? 30 * 60_000 : randomInt(random, 5, 8 * 60) * 60_000,
        // Active Owners list their Tractors, so those registrations decrypt with the API's key.
        registrationCiphertext: owner.active ? Buffer.from(crypto.encrypt(registration, "registration")) : Buffer.from(`seed-${ordinal}`),
        registrationLookupHash: owner.active ? crypto.registrationLookupHash(registration) : `kt-load-registration-${ordinal}`,
        brand,
        model,
        offerings,
      });
    }
  }
  const activeTractors = tractors.filter((tractor) => activeOwnerSet.has(tractor.ownerId));
  const backgroundTractors = tractors.filter((tractor) => !activeOwnerSet.has(tractor.ownerId));

  // ---- Bookings -------------------------------------------------------------------------------
  const bookings: PlannedBooking[] = [];
  const allFarmerIds = [...input.activeFarmerIds, ...backgroundFarmerIds];
  const plan = (
    customerId: string,
    tractor: PlannedTractor,
    status: PlannedStatus,
    startAt: number,
    createdAt: number,
    options: { readonly methodFilter?: (method: PricingMethod) => boolean; readonly hours?: number } = {},
  ): PlannedBooking => {
    const offering = pick(random, tractor.offerings);
    const rule = pick(random, offering.rules.filter((candidate) => options.methodFilter?.(candidate.method) ?? true));
    const hours = options.hours ?? randomInt(random, 2, 5);
    const quantity = rule.method === "HOURLY" ? hours : rule.method === "PER_TRIP" ? randomInt(random, 1, 4) : randomInt(random, 2, 16) / 2;
    const [latitude, longitude] = scatter(random, tractor.latitude, tractor.longitude, 6);
    const booking: PlannedBooking = {
      id: seedUuid("booking", bookings.length),
      customerId,
      ownerId: tractor.ownerId,
      tractorId: tractor.id,
      offeringId: offering.id,
      ruleId: rule.id,
      method: rule.method,
      ratePaise: rule.ratePaise,
      rounding: rule.method === "HOURLY" ? ROUNDING[bookings.length % ROUNDING.length]! : null,
      quantity,
      totalPaise: Math.round(rule.ratePaise * quantity),
      startAt,
      endAt: startAt + hours * HOUR_MS,
      createdAt,
      status,
      hasRecipient: random() < dataVolume.someoneElseShare,
      district: tractor.district,
      latitude,
      longitude,
    };
    bookings.push(booking);
    return booking;
  };
  const historicalStatus = (): PlannedStatus => {
    const roll = random();
    const { REJECTED, EXPIRED, CANCELLED } = dataVolume.historicalStatusShare;
    if (roll < REJECTED) return "REJECTED";
    if (roll < REJECTED + EXPIRED) return "EXPIRED";
    if (roll < REJECTED + EXPIRED + CANCELLED) return "CANCELLED";
    return "COMPLETED";
  };
  const historical = (customerId: string, tractor: PlannedTractor, createdAt = now - 6 * DAY_MS - random() * (dataVolume.seasonDays - 6) * DAY_MS) =>
    plan(customerId, tractor, historicalStatus(), Math.floor(createdAt / HOUR_MS) * HOUR_MS + randomInt(random, 1, 5) * DAY_MS, createdAt);

  // Active Owners' fleets carry deep dashboard histories from many Farmers.
  for (const ownerId of activeOwnerSet) {
    const fleet = activeTractors.filter((tractor) => tractor.ownerId === ownerId);
    const isFleet = input.activeFleetOwnerIds.includes(ownerId);
    const count = isFleet ? activePrincipals.fleetOwnerBookings : activePrincipals.ownerBookings;
    for (let index = 0; index < count - (isFleet ? SAME_MILLISECOND_BURST : 0); index += 1) {
      historical(pick(random, allFarmerIds), pick(random, fleet));
    }
    if (isFleet) {
      // Concurrent requests can commit within one millisecond; history pages must not skip them.
      const burstAt = Math.floor(now - 30 * DAY_MS - random() * DAY_MS);
      for (let index = 0; index < SAME_MILLISECOND_BURST; index += 1) {
        historical(pick(random, allFarmerIds), pick(random, fleet), burstAt + 0.05 + index * 0.15);
      }
    }
  }
  // Active Farmers book background Tractors in their district, a few of them heavily.
  input.activeFarmerIds.forEach((farmerId, index) => {
    const district = launchDistricts[index % launchDistricts.length]!;
    const nearby = backgroundTractors.filter((tractor) => tractor.district === district);
    const count = index < activePrincipals.heavyFarmers ? activePrincipals.heavyFarmerBookings : activePrincipals.farmerBookings;
    for (let booking = 0; booking < count; booking += 1) historical(farmerId, pick(random, nearby));
  });
  // Everyone else fills the season.
  while (bookings.length < dataVolume.historicalBookings) {
    historical(pick(random, backgroundFarmerIds), pick(random, backgroundTractors));
  }

  // Future work for the active Owners: accepted jobs in free slots, pending requests (some overlap).
  const slotStart = (day: number, block: number) => today + day * DAY_MS + (1 + block * 5) * HOUR_MS;
  const recentCreatedAt = () => now - random() * 3 * DAY_MS;
  const pending = new Map<string, SeededJob[]>();
  const accepted = new Map<string, SeededJob[]>();
  const job = (booking: PlannedBooking): SeededJob =>
    ({ bookingId: booking.id, ownerId: booking.ownerId, method: booking.method, quantity: formatQuantity(booking.quantity) });
  for (const ownerId of activeOwnerSet) {
    const fleet = activeTractors.filter((tractor) => tractor.ownerId === ownerId);
    const used: { tractor: PlannedTractor; day: number; block: number }[] = [];
    const acceptedJobs: SeededJob[] = [];
    for (let index = 0; index < activePrincipals.acceptedPerOwner; index += 1) {
      const round = Math.floor(index / fleet.length);
      const slot = { tractor: fleet[index % fleet.length]!, day: 3 + Math.floor(round / 2), block: round % 2 };
      used.push(slot);
      acceptedJobs.push(job(plan(pick(random, backgroundFarmerIds), slot.tractor, "ACCEPTED", slotStart(slot.day, slot.block),
        recentCreatedAt(), { methodFilter: (method) => method !== "HOURLY", hours: 4 })));
    }
    const pendingJobs: SeededJob[] = [];
    for (let index = 0; index < activePrincipals.pendingPerOwner; index += 1) {
      // One in five overlaps an accepted job, so accepting it must be refused.
      const slot = random() < 0.2 ? pick(random, used) : { tractor: fleet[index % fleet.length]!, day: 20 + index, block: index % 2 };
      pendingJobs.push(job(plan(pick(random, backgroundFarmerIds), slot.tractor, "PENDING_OWNER_RESPONSE",
        slotStart(slot.day, slot.block), recentCreatedAt(), { hours: 4 })));
    }
    accepted.set(ownerId, acceptedJobs);
    pending.set(ownerId, pendingJobs);
  }

  // Concurrent-acceptance race: overlapping requests that all share 12:00-12:30, plus adjacent ones.
  const raceDayOffset = 100;
  const raceTractors = activeTractors
    .filter((tractor) => input.activeFleetOwnerIds.includes(tractor.ownerId))
    .slice(0, trafficProfile.raceTractors);
  const raceGroups: RaceGroup[] = raceTractors.map((tractor, index) => {
    const day = today + (raceDayOffset + (index % 5)) * DAY_MS;
    const farmer = (order: number) => input.activeFarmerIds[(index + order) % input.activeFarmerIds.length]!;
    const overlapping = [10, 11, 10.5, 12].slice(0, trafficProfile.raceOverlappingPerTractor).map((startHour, order) =>
      plan(farmer(order), tractor, "PENDING_OWNER_RESPONSE", day + startHour * HOUR_MS, recentCreatedAt(), { hours: 3 }).id);
    // [15:00, 17:00) touches [12:00, 15:00) without overlapping it.
    const adjacent = Array.from({ length: trafficProfile.raceAdjacentPerTractor }, (_, order) =>
      plan(farmer(7 + order), tractor, "PENDING_OWNER_RESPONSE", day + (15 + order * 2) * HOUR_MS, recentCreatedAt(), { hours: 2 }).id);
    return { tractorId: tractor.id, ownerId: tractor.ownerId, overlapping, adjacent };
  });

  // ---- Write ----------------------------------------------------------------------------------
  await client.query("SET synchronous_commit = off");
  await client.query("DROP TABLE IF EXISTS public.kt_load_booking_plan");

  await insertColumns(client,
    "INSERT INTO public.services (id, stable_code, display_name) SELECT * FROM unnest($1::uuid[], $2::text[], $3::text[])",
    [loadServices.map((service) => service.id), loadServices.map((service) => service.code), loadServices.map((service) => service.name)]);
  await insertColumns(client,
    "INSERT INTO public.equipment_types (id, stable_code, display_name) SELECT * FROM unnest($1::uuid[], $2::text[], $3::text[])",
    [loadEquipmentTypes.map((type) => type.id), loadEquipmentTypes.map((type) => type.code), loadEquipmentTypes.map((type) => type.name)]);

  // Background accounts never sign in, so their phone fields are placeholders, not ciphertext.
  const backgroundUsers = [...backgroundOwnerIds.map((id) => [id, "OWNER"] as const), ...backgroundFarmerIds.map((id) => [id, "FARMER"] as const)];
  await insertColumns(client,
    // 64 hex characters spread over the whole key space, like the real HMAC-SHA256 lookup hash,
    // so the unique index has realistic page fan-out for concurrent sign-ins.
    `INSERT INTO public.users (id, normalized_phone_ciphertext, phone_lookup_hash, created_at)
     SELECT id, convert_to(id::text, 'UTF8'), encode(sha256(convert_to('kt-load-phone-' || id::text, 'UTF8')), 'hex'), $2::timestamptz
     FROM unnest($1::uuid[]) AS u(id)`,
    [backgroundUsers.map(([id]) => id)], [longAgo]);
  await insertColumns(client,
    "INSERT INTO public.user_role_memberships (user_id, role_code) SELECT * FROM unnest($1::uuid[], $2::text[])",
    [backgroundUsers.map(([id]) => id), backgroundUsers.map(([, role]) => role)]);

  const ownerIds = new Set([...backgroundOwnerIds, ...activeOwnerSet]);
  const profileIds = [...backgroundUsers.map(([id]) => id), ...activeOwnerSet, ...input.activeFarmerIds];
  await insertColumns(client,
    `INSERT INTO public.user_profiles (user_id, full_name, preferred_locale, contact_sharing_consent)
     SELECT * FROM unnest($1::uuid[], $2::text[], $3::text[], $4::boolean[]) ON CONFLICT (user_id) DO NOTHING`,
    [profileIds, profileIds.map((id, index) => `${ownerIds.has(id) ? "Owner" : "Farmer"} ${index}`),
      profileIds.map((_, index) => LOCALES[index % LOCALES.length]!), profileIds.map((_, index) => index % 3 === 0)]);

  // Owner operating locations sit at the district headquarters.
  await insertColumns(client,
    `INSERT INTO public.locations (id, owner_user_id, coordinates, state, district, mandal_or_taluk, village, source, captured_at, collection_purpose)
     SELECT md5('kt-load-owner-location-' || o.id::text)::uuid, o.id, ST_SetSRID(ST_MakePoint(o.lon, o.lat), 4326)::geography,
       o.state, o.district, o.district, o.district || ' town', 'MANUAL_ADDRESS', $6::timestamptz, 'TRACTOR_OPERATING_LOCATION'
     FROM unnest($1::uuid[], $2::double precision[], $3::double precision[], $4::text[], $5::text[]) AS o(id, lat, lon, state, district)`,
    [owners.map((owner) => owner.id), owners.map((owner) => owner.district.latitude), owners.map((owner) => owner.district.longitude),
      owners.map((owner) => owner.district.state), owners.map((owner) => owner.district.district)], [capturedAt]);
  await insertColumns(client,
    `INSERT INTO public.owner_profiles (user_id, operating_location_id, verification_status)
     SELECT o.id, md5('kt-load-owner-location-' || o.id::text)::uuid, 'VERIFIED' FROM unnest($1::uuid[]) AS o(id)
     ON CONFLICT (user_id) DO NOTHING`,
    [owners.map((owner) => owner.id)]);

  await insertColumns(client,
    `INSERT INTO public.locations (id, owner_user_id, coordinates, state, district, mandal_or_taluk, village, source, captured_at, collection_purpose)
     SELECT md5('kt-load-tractor-location-' || t.id::text)::uuid, t.owner_id, ST_SetSRID(ST_MakePoint(t.lon, t.lat), 4326)::geography,
       t.state, t.district, t.district, 'Village ' || t.ordinal, 'MANUAL_ADDRESS', $8::timestamptz, 'TRACTOR_OPERATING_LOCATION'
     FROM unnest($1::uuid[], $2::uuid[], $3::double precision[], $4::double precision[], $5::text[], $6::text[], $7::int[])
       AS t(id, owner_id, lat, lon, state, district, ordinal)`,
    [tractors.map((t) => t.id), tractors.map((t) => t.ownerId), tractors.map((t) => t.latitude), tractors.map((t) => t.longitude),
      tractors.map((t) => t.district.state), tractors.map((t) => t.district.district), tractors.map((t) => t.ordinal)], [capturedAt]);

  await insertColumns(client,
    `INSERT INTO public.tractors (id, owner_id, brand, model, registration_number_ciphertext, registration_lookup_hash,
       manufacturing_year, horsepower, operational_status, eligibility_status, current_location_id, location_updated_at, created_at)
     SELECT t.id, t.owner_id, t.brand, t.model, t.ciphertext, t.lookup, 2015 + (t.ordinal % 10), 35 + (t.ordinal % 20),
       CASE WHEN t.online THEN 'ONLINE'::operational_status ELSE 'OFFLINE'::operational_status END,
       CASE WHEN t.eligible THEN 'ELIGIBLE'::eligibility_status ELSE 'INELIGIBLE'::eligibility_status END,
       md5('kt-load-tractor-location-' || t.id::text)::uuid, $11::timestamptz - (t.age_ms * interval '1 millisecond'),
       $11::timestamptz - interval '200 days' + (t.ordinal * interval '1 second')
     FROM unnest($1::uuid[], $2::uuid[], $3::text[], $4::text[], $5::bytea[], $6::text[], $7::boolean[], $8::boolean[], $9::bigint[], $10::int[])
       AS t(id, owner_id, brand, model, ciphertext, lookup, online, eligible, age_ms, ordinal)`,
    [tractors.map((t) => t.id), tractors.map((t) => t.ownerId), tractors.map((t) => t.brand), tractors.map((t) => t.model),
      tractors.map((t) => t.registrationCiphertext), tractors.map((t) => t.registrationLookupHash), tractors.map((t) => t.online),
      tractors.map((t) => t.eligible), tractors.map((t) => t.locationAgeMs), tractors.map((t) => t.ordinal)], [input.now.toISOString()]);
  await insertColumns(client,
    `INSERT INTO public.tractor_availability (tractor_id, operational_status, effective_at, changed_by_user_id)
     SELECT t.id, CASE WHEN t.online THEN 'ONLINE'::operational_status ELSE 'OFFLINE'::operational_status END, $4::timestamptz, t.owner_id
     FROM unnest($1::uuid[], $2::boolean[], $3::uuid[]) AS t(id, online, owner_id)`,
    [tractors.map((t) => t.id), tractors.map((t) => t.online), tractors.map((t) => t.ownerId)], [capturedAt]);

  const offeringRows = tractors.flatMap((tractor) => tractor.offerings.map((offering) => ({ tractor, offering })));
  const equipmentRows = offeringRows.filter(({ offering }) => offering.equipmentId !== null);
  await insertColumns(client,
    `INSERT INTO public.equipment (id, owner_id, tractor_id, equipment_type_id, display_name, availability_status)
     SELECT e.id, e.owner_id, e.tractor_id, e.type_id, e.name,
       CASE WHEN e.available THEN 'AVAILABLE'::equipment_availability_status ELSE 'MAINTENANCE'::equipment_availability_status END
     FROM unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::uuid[], $5::text[], $6::boolean[]) AS e(id, owner_id, tractor_id, type_id, name, available)`,
    [equipmentRows.map(({ offering }) => offering.equipmentId), equipmentRows.map(({ tractor }) => tractor.ownerId),
      equipmentRows.map(({ tractor }) => tractor.id), equipmentRows.map(({ offering }) => offering.equipmentTypeId),
      equipmentRows.map(({ offering }) => offering.equipmentName),
      equipmentRows.map(({ tractor }) => activeOwnerSet.has(tractor.ownerId) || random() < 0.95)]);
  await insertColumns(client,
    `INSERT INTO public.service_offerings (id, tractor_id, service_id, equipment_id, enabled)
     SELECT o.id, o.tractor_id, o.service_id, o.equipment_id, true FROM unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::uuid[]) AS o(id, tractor_id, service_id, equipment_id)`,
    [offeringRows.map(({ offering }) => offering.id), offeringRows.map(({ tractor }) => tractor.id),
      offeringRows.map(({ offering }) => offering.serviceId), offeringRows.map(({ offering }) => offering.equipmentId)]);
  const ruleRows = offeringRows.flatMap(({ offering }, offeringIndex) => offering.rules.map((rule) => ({ offering, rule, offeringIndex })));
  await insertColumns(client,
    `INSERT INTO public.pricing_rules (id, service_offering_id, method, rate_paise, currency, rounding_policy, valid_from, enabled)
     SELECT r.id, r.offering_id, r.method::pricing_method, r.rate, 'INR', r.rounding::rounding_policy, $6::timestamptz, true
     FROM unnest($1::uuid[], $2::uuid[], $3::text[], $4::bigint[], $5::text[]) AS r(id, offering_id, method, rate, rounding)`,
    [ruleRows.map(({ rule }) => rule.id), ruleRows.map(({ offering }) => offering.id), ruleRows.map(({ rule }) => rule.method),
      ruleRows.map(({ rule }) => rule.ratePaise),
      ruleRows.map(({ rule, offeringIndex }) => (rule.method === "HOURLY" ? ROUNDING[offeringIndex % ROUNDING.length]! : null))],
    [longAgo]);

  // The plan table drives set-based inserts of every booking-related row.
  await client.query(`CREATE UNLOGGED TABLE public.kt_load_booking_plan (
    id uuid PRIMARY KEY, customer_id uuid, owner_id uuid, tractor_id uuid, offering_id uuid, rule_id uuid,
    method pricing_method, rate_paise bigint, rounding rounding_policy, quantity numeric(12, 3), total_paise bigint,
    start_at timestamptz, end_at timestamptz, created_at timestamptz, status booking_status, has_recipient boolean, snapshot jsonb)`);
  await insertColumns(client,
    `INSERT INTO public.kt_load_booking_plan
     SELECT p.id, p.customer_id, p.owner_id, p.tractor_id, p.offering_id, p.rule_id, p.method::pricing_method, p.rate,
       p.rounding::rounding_policy, p.quantity, p.total, p.start_at, p.end_at, p.created_at, p.status::booking_status,
       p.has_recipient, p.snapshot::jsonb
     FROM unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::uuid[], $5::uuid[], $6::uuid[], $7::text[], $8::bigint[], $9::text[],
       $10::numeric[], $11::bigint[], $12::timestamptz[], $13::timestamptz[], $14::timestamptz[], $15::text[], $16::boolean[], $17::text[])
       AS p(id, customer_id, owner_id, tractor_id, offering_id, rule_id, method, rate, rounding, quantity, total, start_at, end_at,
         created_at, status, has_recipient, snapshot)`,
    [bookings.map((b) => b.id), bookings.map((b) => b.customerId), bookings.map((b) => b.ownerId), bookings.map((b) => b.tractorId),
      bookings.map((b) => b.offeringId), bookings.map((b) => b.ruleId), bookings.map((b) => b.method), bookings.map((b) => b.ratePaise),
      bookings.map((b) => b.rounding), bookings.map((b) => b.quantity), bookings.map((b) => b.totalPaise),
      bookings.map((b) => new Date(b.startAt).toISOString()), bookings.map((b) => new Date(b.endAt).toISOString()),
      bookings.map((b) => isoMicros(b.createdAt)), bookings.map((b) => b.status), bookings.map((b) => b.hasRecipient),
      bookings.map((b) => JSON.stringify({
        state: b.district.state, district: b.district.district, mandalOrTaluk: b.district.district, village: `Farm near ${b.district.district}`,
        source: "MANUAL_ADDRESS", latitude: b.latitude, longitude: b.longitude, capturedAt: new Date(b.createdAt).toISOString(),
        collectionPurpose: "SERVICE_LOCATION",
      }))], [], 10_000);

  // Identity history: about three consumed sign-in challenges per account over the season and one
  // live or expired session per background account, with hash-shaped keys like the real ones.
  const challengeCount = backgroundUsers.length * 3;
  await client.query(
    `INSERT INTO public.otp_challenges (id, phone_lookup_hash, purpose, code_hash, requester_hash, expires_at, max_attempts,
       attempt_count, consumed_at, created_at)
     SELECT md5('kt-load-otp-' || g)::uuid, encode(sha256(convert_to('kt-load-phone-' || g % $2, 'UTF8')), 'hex'), 'SIGN_IN',
       encode(sha256(convert_to('kt-load-code-' || g, 'UTF8')), 'hex'), encode(sha256(convert_to('kt-load-requester-' || g, 'UTF8')), 'hex'),
       t.created_at + interval '5 minutes', 3, 1, t.created_at + interval '40 seconds', t.created_at
     FROM generate_series(1, $1) AS g
     CROSS JOIN LATERAL (SELECT $3::timestamptz - (g::double precision / $1) * interval '180 days' AS created_at) AS t
     -- otp_challenges is not among the test-utils truncated tables; reruns keep the old rows.
     ON CONFLICT (id) DO NOTHING`,
    [challengeCount, backgroundUsers.length, input.now.toISOString()]);
  await insertColumns(client,
    `INSERT INTO public.auth_sessions (id, user_id, access_token_hash, refresh_token_hash, access_expires_at, refresh_expires_at, created_at)
     SELECT md5('kt-load-session-' || u.id::text)::uuid, u.id,
       encode(sha256(convert_to('kt-load-access-' || u.id::text, 'UTF8')), 'hex'),
       encode(sha256(convert_to('kt-load-refresh-' || u.id::text, 'UTF8')), 'hex'),
       t.created_at + interval '15 minutes', t.created_at + interval '30 days', t.created_at
     FROM unnest($1::uuid[]) WITH ORDINALITY AS u(id, ordinal)
     CROSS JOIN LATERAL (SELECT $2::timestamptz - (u.ordinal % 40) * interval '1 day' - (u.ordinal % 1440) * interval '1 minute' AS created_at) AS t`,
    [backgroundUsers.map(([id]) => id)], [input.now.toISOString()]);

  const steps: readonly string[] = [
    `INSERT INTO public.bookings (id, public_reference, customer_id, owner_id, tractor_id, service_offering_id,
       requested_start_at, requested_end_at, expected_quantity, status, version, created_at, updated_at)
     SELECT id, 'KT-' || upper(substr(md5(id::text), 1, 12)), customer_id, owner_id, tractor_id, offering_id, start_at, end_at,
       quantity, status, CASE status WHEN 'COMPLETED' THEN 7 WHEN 'PENDING_OWNER_RESPONSE' THEN 1 ELSE 2 END,
       created_at, CASE status WHEN 'COMPLETED' THEN end_at + interval '30 minutes' ELSE created_at + interval '2 hours' END
     FROM public.kt_load_booking_plan`,
    `INSERT INTO public.booking_agreements (id, booking_id, agreement_version, pricing_rule_id, pricing_rule_version, method,
       rate_paise, currency, rounding_policy, estimated_quantity, estimated_total_paise, service_location_snapshot, disclosed_at, created_at)
     SELECT md5('kt-load-agreement-' || id::text)::uuid, id, 1, rule_id, 1, method, rate_paise, 'INR', rounding, quantity,
       total_paise, snapshot, created_at, created_at
     FROM public.kt_load_booking_plan`,
    `UPDATE public.bookings b SET current_agreement_id = md5('kt-load-agreement-' || b.id::text)::uuid
     FROM public.kt_load_booking_plan p WHERE p.id = b.id`,
    `INSERT INTO public.booking_recipients (booking_id, name, coordination_consent, service_location_snapshot, landmark_or_directions, created_at)
     SELECT id, 'Recipient ' || substr(md5(id::text), 1, 4), false, snapshot, 'Near the panchayat office', created_at
     FROM public.kt_load_booking_plan WHERE has_recipient`,
    `INSERT INTO public.booking_status_history (booking_id, from_status, to_status, actor_id, actor_channel, reason, occurred_at)
     SELECT p.id, s.from_status::booking_status, s.to_status::booking_status,
       CASE s.actor WHEN 'FARMER' THEN p.customer_id WHEN 'OWNER' THEN p.owner_id END, s.channel::actor_channel, s.reason,
       CASE s.at WHEN 'created' THEN p.created_at WHEN 'decided' THEN p.created_at + interval '2 hours'
         WHEN 'start' THEN p.start_at WHEN 'end' THEN p.end_at ELSE p.end_at + interval '30 minutes' END
     FROM public.kt_load_booking_plan p
     JOIN (VALUES
       ('*', NULL, 'PENDING_OWNER_RESPONSE', 'FARMER', 'WEB', NULL, 'created'),
       ('ACCEPTED', 'PENDING_OWNER_RESPONSE', 'ACCEPTED', 'OWNER', 'WEB', NULL, 'decided'),
       ('COMPLETED', 'PENDING_OWNER_RESPONSE', 'ACCEPTED', 'OWNER', 'WEB', NULL, 'decided'),
       ('COMPLETED', 'ACCEPTED', 'IN_PROGRESS', 'OWNER', 'WEB', NULL, 'start'),
       ('COMPLETED', 'IN_PROGRESS', 'WORK_COMPLETED', 'OWNER', 'WEB', NULL, 'end'),
       ('COMPLETED', 'WORK_COMPLETED', 'FINAL_BILL_GENERATED', 'SYSTEM', 'SYSTEM', NULL, 'end'),
       ('COMPLETED', 'FINAL_BILL_GENERATED', 'PAYMENT_RECORDED', 'SYSTEM', 'SYSTEM', NULL, 'paid'),
       ('COMPLETED', 'PAYMENT_RECORDED', 'COMPLETED', 'SYSTEM', 'SYSTEM', NULL, 'paid'),
       ('REJECTED', 'PENDING_OWNER_RESPONSE', 'REJECTED', 'OWNER', 'WEB', 'Tractor already booked for this slot', 'decided'),
       ('EXPIRED', 'PENDING_OWNER_RESPONSE', 'EXPIRED', 'SYSTEM', 'SYSTEM', 'Owner response deadline elapsed', 'decided'),
       ('CANCELLED', 'PENDING_OWNER_RESPONSE', 'CANCELLED', 'FARMER', 'WEB', 'Plans changed', 'decided')
     ) AS s(applies_to, from_status, to_status, actor, channel, reason, at)
       ON s.applies_to = '*' OR s.applies_to = p.status::text`,
    `INSERT INTO public.work_events (booking_id, event_type, effective_at, received_at, actor_id, actor_channel, idempotency_key)
     SELECT p.id, e.event_type::work_event_type, CASE e.event_type WHEN 'START' THEN p.start_at ELSE p.end_at END,
       CASE e.event_type WHEN 'START' THEN p.start_at ELSE p.end_at END, p.owner_id, 'WEB', 'seed-' || lower(e.event_type) || '-' || p.id::text
     FROM public.kt_load_booking_plan p CROSS JOIN (VALUES ('START'), ('COMPLETE')) AS e(event_type)
     WHERE p.status = 'COMPLETED'`,
    `INSERT INTO public.work_measurements (booking_id, method, quantity, unit, submitted_by_user_id, created_at)
     SELECT id, method, CASE method WHEN 'HOURLY' THEN quantity * 60 ELSE quantity END,
       (CASE method WHEN 'HOURLY' THEN 'MINUTE' WHEN 'PER_ACRE' THEN 'ACRE' ELSE 'TRIP' END)::measurement_unit, owner_id, end_at
     FROM public.kt_load_booking_plan WHERE status = 'COMPLETED'`,
    `INSERT INTO public.invoices (id, booking_id, agreement_id, invoice_version, status, rate_paise, currency, billable_quantity,
       subtotal_paise, adjustments_paise, total_paise, evidence_references, calculation_formula, rounding_trace, created_at)
     SELECT md5('kt-load-invoice-' || id::text)::uuid, id, md5('kt-load-agreement-' || id::text)::uuid, 1, 'ISSUED', rate_paise, 'INR',
       quantity, total_paise, 0, total_paise, '[]'::jsonb,
       quantity::text || ' × ' || rate_paise::text || ' paise = ' || total_paise::text || ' paise',
       jsonb_build_object('rawSubtotalNumerator', total_paise::text, 'rawSubtotalDenominator', '1', 'minorUnitRounding', 'NONE'),
       end_at
     FROM public.kt_load_booking_plan WHERE status = 'COMPLETED'`,
    `INSERT INTO public.payments (id, invoice_id, method, status, amount_paise, currency, recorded_by_user_id, received_at, created_at, updated_at)
     SELECT md5('kt-load-payment-' || id::text)::uuid, md5('kt-load-invoice-' || id::text)::uuid, 'CASH', 'PAID_CASH', total_paise, 'INR',
       owner_id, end_at + interval '30 minutes', end_at + interval '30 minutes', end_at + interval '30 minutes'
     FROM public.kt_load_booking_plan WHERE status = 'COMPLETED'`,
    `INSERT INTO public.payment_events (payment_id, event_type, from_status, to_status, amount_paise, actor_id, actor_channel, occurred_at)
     SELECT md5('kt-load-payment-' || id::text)::uuid, 'CASH_RECORDED', NULL, 'PAID_CASH', total_paise, owner_id, 'WEB', end_at + interval '30 minutes'
     FROM public.kt_load_booking_plan WHERE status = 'COMPLETED'`,
    "DROP TABLE public.kt_load_booking_plan",
  ];
  for (const statement of steps) await client.query(statement);
  await client.query("SET synchronous_commit = on");
  for (const table of ["users", "user_role_memberships", "user_profiles", "owner_profiles", "otp_challenges", "auth_sessions", "locations", "tractors", "tractor_availability",
    "equipment", "service_offerings", "pricing_rules", "bookings", "booking_agreements", "booking_recipients", "booking_status_history",
    "work_events", "work_measurements", "invoices", "payments", "payment_events"]) {
    await client.query(`VACUUM (ANALYZE) public.${table}`);
  }

  const countsResult = await client.query<{ table_name: string; rows: string }>(
    `SELECT 'users' AS table_name, count(*)::text AS rows FROM public.users
     UNION ALL SELECT 'tractors', count(*)::text FROM public.tractors
     UNION ALL SELECT 'service_offerings', count(*)::text FROM public.service_offerings
     UNION ALL SELECT 'pricing_rules', count(*)::text FROM public.pricing_rules
     UNION ALL SELECT 'bookings', count(*)::text FROM public.bookings
     UNION ALL SELECT 'booking_agreements', count(*)::text FROM public.booking_agreements
     UNION ALL SELECT 'booking_status_history', count(*)::text FROM public.booking_status_history
     UNION ALL SELECT 'booking_recipients', count(*)::text FROM public.booking_recipients
     UNION ALL SELECT 'work_events', count(*)::text FROM public.work_events
     UNION ALL SELECT 'invoices', count(*)::text FROM public.invoices
     UNION ALL SELECT 'payments', count(*)::text FROM public.payments`);

  const samples = (key: (booking: PlannedBooking) => string, ids: Iterable<string>) => {
    const wanted = new Set(ids);
    const result = new Map<string, string[]>();
    for (const booking of bookings) {
      const viewer = key(booking);
      if (!wanted.has(viewer)) continue;
      const list = result.get(viewer) ?? [];
      if (list.length < 60) list.push(booking.id);
      result.set(viewer, list);
    }
    return result;
  };

  return {
    counts: Object.fromEntries(countsResult.rows.map((row) => [row.table_name, Number(row.rows)])),
    seedSeconds: Math.round((performance.now() - startedAt) / 100) / 10,
    activeTractors: activeTractors.map((tractor) => ({
      id: tractor.id, ownerId: tractor.ownerId, district: tractor.district, latitude: tractor.latitude, longitude: tractor.longitude,
      offerings: tractor.offerings.map(({ id, serviceId, rules }) => ({ id, serviceId, rules })),
    })),
    pending,
    accepted,
    raceGroups,
    farmerBookingSamples: samples((booking) => booking.customerId, input.activeFarmerIds),
    ownerBookingSamples: samples((booking) => booking.ownerId, activeOwnerSet),
    raceDayOffset,
  };
}
