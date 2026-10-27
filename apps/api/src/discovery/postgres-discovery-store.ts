import type { SqlPool } from "@kisantractor/database";
import type { PricingMethod } from "@kisantractor/domain";

import type {
  DiscoveryPricingRule,
  DiscoveryStore,
  DiscoveryStoreRow,
  NormalizedDiscoveryQuery,
} from "./discovery.contracts.js";

interface DiscoveryRow extends Record<string, unknown> {
  readonly tractor_id: string;
  readonly brand: string;
  readonly model: string;
  readonly state: string;
  readonly district: string;
  readonly owner_display_name: string | null;
  readonly photo_alt_text: string | null;
  readonly service_offering_id: string;
  readonly service_id: string;
  readonly service_name: string;
  readonly equipment_id: string | null;
  readonly equipment_type_id: string | null;
  readonly equipment_name: string | null;
  readonly pricing_rules: unknown;
  readonly availability_rank: number;
  readonly distance_meters: number | string;
}

interface PricingJsonRow {
  readonly id: unknown;
  readonly method: unknown;
  readonly ratePaise: unknown;
  readonly currency: unknown;
  readonly roundingPolicy: unknown;
}

const pricingMethodValues: readonly PricingMethod[] = ["HOURLY", "PER_ACRE", "PER_TRIP"];
const roundingPolicyValues = [
  "PROPORTIONAL_MINUTE",
  "THIRTY_MINUTE_BLOCK",
  "ONE_HOUR_BLOCK",
] as const;

const mapPricingRules = (value: unknown): readonly DiscoveryPricingRule[] => {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError("Discovery query returned no active pricing rules");
  }
  return Object.freeze(value.map((item) => {
    const row = item as PricingJsonRow;
    if (
      typeof row.id !== "string" ||
      typeof row.method !== "string" ||
      !pricingMethodValues.includes(row.method as PricingMethod) ||
      typeof row.currency !== "string"
    ) {
      throw new TypeError("Discovery query returned an invalid pricing rule");
    }
    const ratePaise = Number(row.ratePaise);
    if (!Number.isSafeInteger(ratePaise) || ratePaise <= 0) {
      throw new TypeError("Discovery query returned an invalid pricing rate");
    }
    const roundingPolicy = row.roundingPolicy;
    if (
      roundingPolicy !== null &&
      (typeof roundingPolicy !== "string" ||
        !roundingPolicyValues.includes(roundingPolicy as (typeof roundingPolicyValues)[number]))
    ) {
      throw new TypeError("Discovery query returned an invalid rounding policy");
    }
    return Object.freeze({
      id: row.id,
      method: row.method as PricingMethod,
      ratePaise,
      currency: row.currency,
      ...(roundingPolicy === null
        ? {}
        : { roundingPolicy: roundingPolicy as NonNullable<DiscoveryPricingRule["roundingPolicy"]> }),
    });
  }));
};

/**
 * Executes one bounded query. The PostGIS prefilter runs before relational
 * eligibility checks and keyset pagination avoids offset scans.
 */
export class PostgresDiscoveryStore implements DiscoveryStore {
  constructor(private readonly pool: SqlPool) {}

  async search(query: NormalizedDiscoveryQuery): Promise<readonly DiscoveryStoreRow[]> {
    const cursor = query.cursor;
    const result = await this.pool.query<DiscoveryRow>(
      `WITH origin AS (
         SELECT ST_SetSRID(ST_MakePoint($1::double precision, $2::double precision), 4326)::geography AS point
       ), eligible AS (
         SELECT
           t.id AS tractor_id,
           t.brand,
           t.model,
           l.state,
           l.district,
           CASE WHEN up.contact_sharing_consent THEN up.full_name ELSE NULL END AS owner_display_name,
           photo.alt_text AS photo_alt_text,
           offering.service_offering_id,
           offering.service_id,
           offering.service_name,
           offering.equipment_id,
           offering.equipment_type_id,
           offering.equipment_name,
           prices.pricing_rules,
           0::integer AS availability_rank,
           ST_Distance(l.coordinates, origin.point) AS distance_meters
         FROM origin
         INNER JOIN public.locations l
           ON l.coordinates IS NOT NULL
          AND ST_DWithin(l.coordinates, origin.point, $3::double precision)
         -- PostGIS estimates the geography ST_DWithin filter at one row whatever the radius, so a
         -- plain join let the planner rescan every Tractor once per candidate location (100 km:
         -- 1,261 x 4,000 rows, about 0.8 s at launch volume). The zero offset below stops the
         -- planner flattening this subquery, so each spatial candidate is one lookup on
         -- tractors_current_location_idx and the availability primary key.
         INNER JOIN LATERAL (
           SELECT t.id, t.brand, t.model, t.owner_id
           FROM public.tractors t
           INNER JOIN public.tractor_availability ta ON ta.tractor_id = t.id
           WHERE t.current_location_id = l.id
             AND t.operational_status = 'ONLINE'
             AND ta.operational_status = 'ONLINE'
             AND t.eligibility_status = 'ELIGIBLE'
             AND t.location_updated_at >= $8
             AND t.location_updated_at <= $10
           OFFSET 0
         ) t ON true
         INNER JOIN public.user_profiles up ON up.user_id = t.owner_id
         INNER JOIN LATERAL (
           SELECT
             so.id AS service_offering_id,
             s.id AS service_id,
             s.display_name AS service_name,
             e.id AS equipment_id,
             e.equipment_type_id,
             e.display_name AS equipment_name
           FROM public.service_offerings so
           INNER JOIN public.services s ON s.id = so.service_id
           LEFT JOIN public.equipment e ON e.id = so.equipment_id
           WHERE so.tractor_id = t.id
             AND so.service_id = $4
             AND so.enabled = true
             AND (so.equipment_id IS NULL OR (
               e.availability_status = 'AVAILABLE'
               AND e.owner_id = t.owner_id
               AND (e.tractor_id IS NULL OR e.tractor_id = t.id)
             ))
             AND ($5::uuid IS NULL OR e.equipment_type_id = $5)
             AND EXISTS (
               SELECT 1
               FROM public.pricing_rules active_pr
               WHERE active_pr.service_offering_id = so.id
                 AND active_pr.enabled = true
                 AND active_pr.valid_from <= $6
                 AND (active_pr.valid_to IS NULL OR active_pr.valid_to > $6)
                 AND ($9::pricing_method IS NULL OR active_pr.method = $9)
             )
           ORDER BY CASE WHEN so.equipment_id IS NULL THEN 1 ELSE 0 END, so.id
           LIMIT 1
         ) offering ON true
         INNER JOIN LATERAL (
           SELECT jsonb_agg(
             jsonb_build_object(
               'id', pr.id,
               'method', pr.method,
               'ratePaise', pr.rate_paise::text,
               'currency', pr.currency,
               'roundingPolicy', pr.rounding_policy
             ) ORDER BY pr.method, pr.id
           ) AS pricing_rules
           FROM public.pricing_rules pr
           WHERE pr.service_offering_id = offering.service_offering_id
             AND pr.enabled = true
             AND pr.valid_from <= $6
             AND (pr.valid_to IS NULL OR pr.valid_to > $6)
             AND ($9::pricing_method IS NULL OR pr.method = $9)
         ) prices ON prices.pricing_rules IS NOT NULL
         LEFT JOIN LATERAL (
           SELECT tp.alt_text
           FROM public.tractor_photos tp
           WHERE tp.tractor_id = t.id
           ORDER BY tp.sort_order, tp.id
           LIMIT 1
         ) photo ON true
         WHERE NOT EXISTS (
             SELECT 1
             FROM public.bookings blocking
             WHERE blocking.tractor_id = t.id
               AND blocking.status IN ('ACCEPTED', 'SCHEDULED', 'IN_PROGRESS')
               AND blocking.requested_start_at < $7
               AND $6 < blocking.requested_end_at
           )
       )
       SELECT *
       FROM eligible
       WHERE $11::integer IS NULL
          OR availability_rank > $11
          OR (availability_rank = $11 AND distance_meters > $12::double precision)
          OR (availability_rank = $11 AND distance_meters = $12::double precision AND tractor_id > $13::uuid)
       ORDER BY availability_rank ASC, distance_meters ASC, tractor_id ASC
       LIMIT $14`,
      [
        query.serviceLocation.longitude,
        query.serviceLocation.latitude,
        query.radiusKilometers * 1_000,
        query.serviceId,
        query.equipmentTypeId ?? null,
        query.requestedInterval.start.toISOString(),
        query.requestedInterval.end.toISOString(),
        query.staleBefore.toISOString(),
        query.pricingMethod ?? null,
        query.evaluatedAt.toISOString(),
        cursor?.availabilityRank ?? null,
        cursor?.distanceMeters ?? null,
        cursor?.tractorId ?? null,
        query.pageSize + 1,
      ],
    );

    return Object.freeze(result.rows.map((row) => {
      const distanceMeters = Number(row.distance_meters);
      if (!Number.isFinite(distanceMeters) || distanceMeters < 0) {
        throw new TypeError("Discovery query returned an invalid distance");
      }
      return Object.freeze({
        tractorId: row.tractor_id,
        brand: row.brand,
        model: row.model,
        state: row.state,
        district: row.district,
        ...(row.owner_display_name === null ? {} : { ownerDisplayName: row.owner_display_name }),
        ...(row.photo_alt_text === null ? {} : { photoAltText: row.photo_alt_text }),
        serviceOfferingId: row.service_offering_id,
        serviceId: row.service_id,
        serviceName: row.service_name,
        ...(row.equipment_id === null ? {} : { equipmentId: row.equipment_id }),
        ...(row.equipment_type_id === null ? {} : { equipmentTypeId: row.equipment_type_id }),
        ...(row.equipment_name === null ? {} : { equipmentName: row.equipment_name }),
        pricingRules: mapPricingRules(row.pricing_rules),
        availabilityRank: row.availability_rank,
        distanceMeters,
      });
    }));
  }
}
