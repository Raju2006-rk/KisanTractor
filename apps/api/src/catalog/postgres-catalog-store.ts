import type {
  ActivePricingRuleProjection,
  CatalogEligibilityPolicy,
  EquipmentInput,
  EquipmentUpdateInput,
  HourlyRoundingPolicy,
  LocationCollectionPurpose,
  LocationSource,
  OwnerEquipmentProjection,
  OwnerLocationInput,
  OwnerLocationProjection,
  OwnerPricingRuleProjection,
  OwnerProfileInput,
  OwnerProfileProjection,
  OwnerServiceOfferingProjection,
  OwnerTractorPhotoProjection,
  OwnerTractorProjection,
  PricingRuleInput,
  ServiceOfferingInput,
  TractorAvailabilityProjection,
  TractorEligibilityEvaluation,
  TractorEligibilityFacts,
  TractorOperationalStatus,
} from "@kisantractor/domain";
import { defaultCatalogEligibilityPolicy, evaluateTractorEligibility, validateEligibilityPolicy } from "@kisantractor/domain";
import { withDomainTransaction, type DomainTransaction, type SqlExecutor, type SqlPool } from "@kisantractor/database";

import { CatalogCrypto } from "./catalog-crypto.js";
import type {
  CatalogRequestContext,
  CatalogSecrets,
  CatalogStore,
  SetOperationalStatusResult,
  StoredTractorInput,
  StoredTractorUpdateInput,
} from "./catalog.contracts.js";

interface ProfileRow extends Record<string, unknown> {
  readonly user_id: string;
  readonly full_name: string;
  readonly preferred_locale: string;
  readonly contact_sharing_consent: boolean;
  readonly verification_status: OwnerProfileProjection["verificationStatus"];
  readonly version: number;
  readonly location_id: string;
  readonly state: string;
  readonly district: string;
  readonly mandal_or_taluk: string;
  readonly village: string;
  readonly postal_code: string | null;
  readonly landmark: string | null;
  readonly source: LocationSource;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly accuracy_meters: number | null;
  readonly captured_at: Date;
  readonly location_consent_at: Date | null;
  readonly collection_purpose: LocationCollectionPurpose;
}

interface TractorRow extends Record<string, unknown> {
  readonly id: string;
  readonly owner_id: string;
  readonly brand: string;
  readonly model: string;
  readonly registration_number_ciphertext: Uint8Array;
  readonly manufacturing_year: number;
  readonly horsepower: number | null;
  readonly operational_status: OwnerTractorProjection["operationalStatus"];
  readonly eligibility_status: OwnerTractorProjection["eligibilityStatus"];
  readonly version: number;
  readonly location_id: string;
  readonly state: string;
  readonly district: string;
  readonly mandal_or_taluk: string;
  readonly village: string;
  readonly postal_code: string | null;
  readonly landmark: string | null;
  readonly source: LocationSource;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly accuracy_meters: number | null;
  readonly captured_at: Date;
  readonly location_consent_at: Date | null;
  readonly collection_purpose: LocationCollectionPurpose;
}

interface PhotoRow extends Record<string, unknown> {
  readonly id: string;
  readonly tractor_id: string;
  readonly mime_type: OwnerTractorPhotoProjection["mimeType"];
  readonly alt_text: string;
  readonly sort_order: number;
}

interface EquipmentRow extends Record<string, unknown> {
  readonly id: string;
  readonly owner_id: string;
  readonly tractor_id: string | null;
  readonly equipment_type_id: string;
  readonly equipment_type_code: string;
  readonly equipment_type_name: string;
  readonly display_name: string;
  readonly availability_status: OwnerEquipmentProjection["availabilityStatus"];
  readonly version: number;
}

interface ServiceOfferingRow extends Record<string, unknown> {
  readonly id: string;
  readonly tractor_id: string;
  readonly service_id: string;
  readonly service_code: string;
  readonly service_name: string;
  readonly equipment_id: string | null;
  readonly equipment_name: string | null;
  readonly enabled: boolean;
  readonly version: number;
}

interface PricingRuleRow extends Record<string, unknown> {
  readonly id: string;
  readonly service_offering_id: string;
  readonly method: OwnerPricingRuleProjection["method"];
  readonly rate_paise: string | number;
  readonly currency: "INR";
  readonly rounding_policy: HourlyRoundingPolicy | null;
  readonly enabled: boolean;
  readonly version: number;
}

interface EligibilityTractorRow extends Record<string, unknown> {
  readonly id: string;
  readonly brand: string;
  readonly model: string;
  readonly registration_number_ciphertext: Uint8Array;
  readonly manufacturing_year: number;
  readonly operational_status: OwnerTractorProjection["operationalStatus"];
  readonly location_updated_at: Date;
}

interface AvailabilityRow extends Record<string, unknown> {
  readonly tractor_id: string;
  readonly operational_status: TractorOperationalStatus;
  readonly eligibility_status: OwnerTractorProjection["eligibilityStatus"];
  readonly effective_at: Date;
  readonly tractor_version: number;
}

interface AvailabilityCommandRow extends AvailabilityRow {
  readonly availability_version: number;
}

interface DocumentKindRow extends Record<string, unknown> {
  readonly document_kind: string;
}

interface ExistsRow extends Record<string, unknown> {
  readonly found: boolean;
}

interface IdRow extends Record<string, unknown> {
  readonly id: string;
}

const locationProjection = (row: ProfileRow | TractorRow): OwnerLocationProjection => Object.freeze({
  id: row.location_id,
  state: row.state,
  district: row.district,
  mandalOrTaluk: row.mandal_or_taluk,
  village: row.village,
  ...(row.postal_code === null ? {} : { postalCode: row.postal_code }),
  ...(row.landmark === null ? {} : { landmark: row.landmark }),
  source: row.source,
  ...(row.latitude === null ? {} : { latitude: Number(row.latitude) }),
  ...(row.longitude === null ? {} : { longitude: Number(row.longitude) }),
  ...(row.accuracy_meters === null ? {} : { accuracyMeters: Number(row.accuracy_meters) }),
  capturedAt: new Date(row.captured_at),
  ...(row.location_consent_at == null ? {} : { consentedAt: new Date(row.location_consent_at) }),
  collectionPurpose: row.collection_purpose ?? "TRACTOR_OPERATING_LOCATION",
});

const locationValues = (location: OwnerLocationInput): readonly unknown[] => [
  location.state,
  location.district,
  location.mandalOrTaluk,
  location.village,
  location.postalCode ?? null,
  location.landmark ?? null,
  location.source,
  location.longitude ?? null,
  location.latitude ?? null,
  location.accuracyMeters ?? null,
  location.capturedAt.toISOString(),
  location.consentedAt?.toISOString() ?? null,
  location.collectionPurpose ?? "TRACTOR_OPERATING_LOCATION",
];

const insertLocation = async (
  sql: SqlExecutor,
  ownerId: string,
  location: OwnerLocationInput,
): Promise<string> => {
  const result = await sql.query<IdRow>(
    `INSERT INTO public.locations
      (owner_user_id, state, district, mandal_or_taluk, village, postal_code,
       landmark, source, coordinates, accuracy_meters, captured_at, location_consent_at,
       collection_purpose)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
       CASE WHEN $9::double precision IS NULL THEN NULL
            ELSE ST_SetSRID(ST_MakePoint($9, $10), 4326)::geography END,
       $11, $12::timestamptz, $13::timestamptz, $14)
     RETURNING id`,
    [ownerId, ...locationValues(location)],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("Operating location was not created");
  return row.id;
};

const profileSql = `SELECT up.user_id, up.full_name, up.preferred_locale,
       up.contact_sharing_consent, op.verification_status, op.version,
       l.id AS location_id, l.state, l.district, l.mandal_or_taluk, l.village,
       l.postal_code, l.landmark, l.source,
       ST_Y(l.coordinates::geometry) AS latitude,
       ST_X(l.coordinates::geometry) AS longitude,
       l.accuracy_meters, l.captured_at, l.location_consent_at, l.collection_purpose
  FROM public.owner_profiles op
  INNER JOIN public.user_profiles up ON up.user_id = op.user_id
  INNER JOIN public.users u ON u.id = op.user_id AND u.status = 'ACTIVE' AND u.deleted_at IS NULL
  INNER JOIN public.user_role_memberships rm
    ON rm.user_id = op.user_id AND rm.role_code = 'OWNER' AND rm.revoked_at IS NULL
  INNER JOIN public.locations l ON l.id = op.operating_location_id`;

const tractorSql = `SELECT t.id, t.owner_id, t.brand, t.model,
       t.registration_number_ciphertext, t.manufacturing_year, t.horsepower,
       t.operational_status, t.eligibility_status, t.version,
       l.id AS location_id, l.state, l.district, l.mandal_or_taluk, l.village,
       l.postal_code, l.landmark, l.source,
       ST_Y(l.coordinates::geometry) AS latitude,
       ST_X(l.coordinates::geometry) AS longitude,
       l.accuracy_meters, l.captured_at, l.location_consent_at, l.collection_purpose
  FROM public.tractors t
  INNER JOIN public.locations l ON l.id = t.current_location_id`;

const equipmentSql = `SELECT e.id, e.owner_id, e.tractor_id, e.equipment_type_id,
       et.stable_code AS equipment_type_code, et.display_name AS equipment_type_name,
       e.display_name, e.availability_status, e.version
  FROM public.equipment e
  INNER JOIN public.equipment_types et ON et.id = e.equipment_type_id`;

const serviceOfferingSql = `SELECT so.id, so.tractor_id, so.service_id,
       s.stable_code AS service_code, s.display_name AS service_name,
       so.equipment_id, e.display_name AS equipment_name, so.enabled, so.version
  FROM public.service_offerings so
  INNER JOIN public.services s ON s.id = so.service_id
  LEFT JOIN public.equipment e ON e.id = so.equipment_id`;

const pricingRuleSql = `SELECT pr.id, pr.service_offering_id, pr.method,
       pr.rate_paise, pr.currency, pr.rounding_policy, pr.enabled, pr.version
  FROM public.pricing_rules pr`;

const availabilityProjection = (
  row: AvailabilityRow,
  scheduleConflict = false,
): TractorAvailabilityProjection => Object.freeze({
  tractorId: row.tractor_id,
  operationalStatus: row.operational_status,
  eligibilityStatus: row.eligibility_status,
  acceptingNewDemand:
    row.operational_status === "ONLINE" &&
    row.eligibility_status === "ELIGIBLE" &&
    !scheduleConflict,
  existingConfirmedBookingsManageable: true,
  effectiveAt: new Date(row.effective_at),
  version: row.tractor_version,
});

export class PostgresCatalogStore implements CatalogStore {
  readonly #crypto: CatalogCrypto;
  readonly #eligibilityPolicy: CatalogEligibilityPolicy;

  constructor(
    private readonly pool: SqlPool,
    secrets: CatalogSecrets,
    eligibilityPolicy: CatalogEligibilityPolicy = defaultCatalogEligibilityPolicy,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.#crypto = new CatalogCrypto(secrets);
    this.#eligibilityPolicy = validateEligibilityPolicy(eligibilityPolicy);
  }

  async upsertOwnerProfile(
    ownerId: string,
    input: OwnerProfileInput,
    expectedVersion: number | undefined,
    context: CatalogRequestContext,
  ): Promise<OwnerProfileProjection | undefined> {
    const stored = await withDomainTransaction(
      this.pool,
      { correlationId: context.correlationId, isolation: "SERIALIZABLE" },
      async (transaction) => {
        if (expectedVersion !== undefined) {
          const current = await transaction.sql.query<{ readonly version: number }>(
            "SELECT version FROM public.owner_profiles WHERE user_id = $1 FOR UPDATE",
            [ownerId],
          );
          if (current.rows[0]?.version !== expectedVersion) return false;
        }
        const locationId = await insertLocation(transaction.sql, ownerId, input.operatingLocation);
        await transaction.sql.query(
          `INSERT INTO public.user_profiles
             (user_id, full_name, preferred_locale, contact_sharing_consent, default_location_id)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (user_id) DO UPDATE SET
             full_name = EXCLUDED.full_name,
             preferred_locale = EXCLUDED.preferred_locale,
             contact_sharing_consent = EXCLUDED.contact_sharing_consent,
             default_location_id = EXCLUDED.default_location_id,
             version = user_profiles.version + 1,
             updated_at = CURRENT_TIMESTAMP`,
          [ownerId, input.fullName, input.preferredLocale, input.contactSharingConsent, locationId],
        );
        const result = await transaction.sql.query<IdRow>(
          `INSERT INTO public.owner_profiles (user_id, operating_location_id)
           VALUES ($1, $2)
           ON CONFLICT (user_id) DO UPDATE SET
             operating_location_id = EXCLUDED.operating_location_id,
             version = owner_profiles.version + 1,
             updated_at = CURRENT_TIMESTAMP
           WHERE $3::integer IS NULL OR owner_profiles.version = $3
           RETURNING user_id AS id`,
          [ownerId, locationId, expectedVersion ?? null],
        );
        if (result.rowCount !== 1) return false;
        await transaction.appendAudit({
          actorId: ownerId,
          actorChannel: context.actorChannel,
          action: "owner.profile.upsert",
          resourceType: "OWNER_PROFILE",
          resourceId: ownerId,
          outcome: "SUCCESS",
          metadata: { locationSource: input.operatingLocation.source },
        });
        return true;
      },
    );
    return stored ? this.findOwnerProfile(ownerId) : undefined;
  }

  async findOwnerProfile(ownerId: string): Promise<OwnerProfileProjection | undefined> {
    const result = await this.pool.query<ProfileRow>(`${profileSql} WHERE op.user_id = $1 LIMIT 1`, [ownerId]);
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return Object.freeze({
      userId: row.user_id,
      fullName: row.full_name,
      preferredLocale: row.preferred_locale,
      contactSharingConsent: row.contact_sharing_consent,
      mobileVerified: true as const,
      verificationStatus: row.verification_status,
      operatingLocation: locationProjection(row),
      version: row.version,
    });
  }

  async createTractor(
    ownerId: string,
    input: StoredTractorInput,
    context: CatalogRequestContext,
  ): Promise<OwnerTractorProjection> {
    const tractorId = await withDomainTransaction(
      this.pool,
      { correlationId: context.correlationId, isolation: "SERIALIZABLE" },
      async (transaction) => {
        const locationId = await insertLocation(transaction.sql, ownerId, input.operatingLocation);
        const result = await transaction.sql.query<IdRow>(
          `INSERT INTO public.tractors
             (owner_id, brand, model, registration_number_ciphertext,
              registration_lookup_hash, manufacturing_year, horsepower,
              current_location_id, location_updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz)
           RETURNING id`,
          [
            ownerId, input.brand, input.model,
            Buffer.from(input.registrationNumberCiphertext), input.registrationLookupHash,
            input.manufacturingYear, input.horsepower ?? null, locationId,
            input.operatingLocation.capturedAt.toISOString(),
          ],
        );
        const row = result.rows[0];
        if (row === undefined) throw new Error("Tractor was not created");
        await this.#replacePhotos(transaction, row.id, input.photos);
        await transaction.sql.query(
          `INSERT INTO public.tractor_availability
             (tractor_id, operational_status, reason, changed_by_user_id)
           VALUES ($1, 'OFFLINE', 'TRACTOR_SETUP_INCOMPLETE', $2)`,
          [row.id, ownerId],
        );
        await transaction.appendAudit({
          actorId: ownerId,
          actorChannel: context.actorChannel,
          action: "tractor.create",
          resourceType: "TRACTOR",
          resourceId: row.id,
          outcome: "SUCCESS",
          metadata: { photoCount: input.photos.length },
        });
        return row.id;
      },
    );
    const created = await this.findTractor(tractorId);
    if (created === undefined) throw new Error("Created tractor could not be loaded");
    return created;
  }

  async updateTractor(
    ownerId: string,
    tractorId: string,
    input: StoredTractorUpdateInput,
    expectedVersion: number,
    context: CatalogRequestContext,
  ): Promise<OwnerTractorProjection | undefined> {
    const stored = await withDomainTransaction(
      this.pool,
      { correlationId: context.correlationId, isolation: "SERIALIZABLE" },
      async (transaction) => {
        const locationId = await insertLocation(transaction.sql, ownerId, input.operatingLocation);
        const result = await transaction.sql.query<IdRow>(
          `UPDATE public.tractors SET
             brand = $4, model = $5, registration_number_ciphertext = $6,
             registration_lookup_hash = $7, manufacturing_year = $8,
             horsepower = $9, current_location_id = $10,
             location_updated_at = $11::timestamptz,
             version = version + 1, updated_at = CURRENT_TIMESTAMP
           WHERE id = $1 AND owner_id = $2 AND version = $3
           RETURNING id`,
          [
            tractorId, ownerId, expectedVersion, input.brand, input.model,
            Buffer.from(input.registrationNumberCiphertext), input.registrationLookupHash,
            input.manufacturingYear, input.horsepower ?? null, locationId,
            input.operatingLocation.capturedAt.toISOString(),
          ],
        );
        if (result.rowCount !== 1) return false;
        if (input.photos !== undefined) {
          await this.#replacePhotos(transaction, tractorId, input.photos);
        }
        await this.#evaluateAndStoreEligibility(
          transaction,
          ownerId,
          tractorId,
          this.#eligibilityPolicy,
          this.now(),
        );
        await transaction.appendAudit({
          actorId: ownerId,
          actorChannel: context.actorChannel,
          action: "tractor.update",
          resourceType: "TRACTOR",
          resourceId: tractorId,
          outcome: "SUCCESS",
          metadata: { photosChanged: input.photos !== undefined, photoCount: input.photos?.length ?? 0 },
        });
        return true;
      },
    );
    return stored ? this.findTractor(tractorId) : undefined;
  }

  async findTractor(tractorId: string): Promise<OwnerTractorProjection | undefined> {
    const result = await this.pool.query<TractorRow>(`${tractorSql} WHERE t.id = $1 LIMIT 1`, [tractorId]);
    const row = result.rows[0];
    if (row === undefined) return undefined;
    const photos = await this.#findPhotos([row.id]);
    return this.#tractorProjection(row, photos.get(row.id) ?? []);
  }

  async listOwnerTractors(ownerId: string): Promise<readonly OwnerTractorProjection[]> {
    const result = await this.pool.query<TractorRow>(
      `${tractorSql} WHERE t.owner_id = $1 ORDER BY t.created_at DESC, t.id DESC LIMIT 100`,
      [ownerId],
    );
    const photos = await this.#findPhotos(result.rows.map((row) => row.id));
    return Object.freeze(result.rows.map((row) => this.#tractorProjection(row, photos.get(row.id) ?? [])));
  }

  async getTractorAvailability(
    ownerId: string,
    tractorId: string,
  ): Promise<TractorAvailabilityProjection | undefined> {
    const result = await this.pool.query<AvailabilityRow>(
      `SELECT t.id AS tractor_id, t.operational_status, t.eligibility_status,
              ta.effective_at, t.version AS tractor_version
         FROM public.tractors t
         INNER JOIN public.tractor_availability ta ON ta.tractor_id = t.id
        WHERE t.id = $1 AND t.owner_id = $2
        LIMIT 1`,
      [tractorId, ownerId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : availabilityProjection(row);
  }

  async setTractorOperationalStatus(
    ownerId: string,
    tractorId: string,
    status: TractorOperationalStatus,
    expectedVersion: number,
    reason: string | undefined,
    policy: CatalogEligibilityPolicy,
    changedAt: Date,
    context: CatalogRequestContext,
  ): Promise<SetOperationalStatusResult | undefined> {
    return withDomainTransaction(
      this.pool,
      { correlationId: context.correlationId, isolation: "SERIALIZABLE" },
      async (transaction) => {
        const currentResult = await transaction.sql.query<AvailabilityCommandRow>(
          `SELECT t.id AS tractor_id, t.operational_status, t.eligibility_status,
                  t.version AS tractor_version, ta.version AS availability_version,
                  ta.effective_at
             FROM public.tractors t
             INNER JOIN public.tractor_availability ta ON ta.tractor_id = t.id
            WHERE t.id = $1 AND t.owner_id = $2
            FOR UPDATE OF t, ta`,
          [tractorId, ownerId],
        );
        const current = currentResult.rows[0];
        if (current === undefined || current.tractor_version !== expectedVersion) return undefined;

        const evaluation = await this.#evaluateAndStoreEligibility(
          transaction,
          ownerId,
          tractorId,
          policy,
          changedAt,
          status,
        );
        if (evaluation === undefined) return undefined;

        let scheduleConflict = false;
        if (status === "ONLINE") {
          const conflictResult = await transaction.sql.query<ExistsRow>(
            `SELECT EXISTS (
               SELECT 1
                 FROM public.bookings earlier
                 INNER JOIN public.bookings later
                   ON earlier.tractor_id = later.tractor_id AND earlier.id < later.id
                WHERE earlier.tractor_id = $1
                  AND earlier.status IN ('ACCEPTED', 'SCHEDULED', 'IN_PROGRESS')
                  AND later.status IN ('ACCEPTED', 'SCHEDULED', 'IN_PROGRESS')
                  AND earlier.requested_start_at < later.requested_end_at
                  AND later.requested_start_at < earlier.requested_end_at
             ) AS found`,
            [tractorId],
          );
          scheduleConflict = conflictResult.rows[0]?.found === true;
          if (evaluation.status !== "ELIGIBLE" || scheduleConflict) {
            return Object.freeze({ kind: "INELIGIBLE", evaluation, scheduleConflict });
          }
        }

        if (current.operational_status === status) {
          return Object.freeze({
            kind: "UPDATED",
            availability: availabilityProjection({
              ...current,
              eligibility_status: evaluation.status,
            }, scheduleConflict),
          });
        }

        const tractorUpdate = await transaction.sql.query<{
          readonly version: number;
          readonly eligibility_status: OwnerTractorProjection["eligibilityStatus"];
        }>(
          `UPDATE public.tractors
              SET operational_status = $3, version = version + 1,
                  updated_at = $4::timestamptz
            WHERE id = $1 AND owner_id = $2 AND version = $5
            RETURNING version, eligibility_status`,
          [tractorId, ownerId, status, changedAt.toISOString(), expectedVersion],
        );
        const updatedTractor = tractorUpdate.rows[0];
        if (updatedTractor === undefined) return undefined;

        const availabilityUpdate = await transaction.sql.query<{
          readonly effective_at: Date;
          readonly version: number;
        }>(
          `UPDATE public.tractor_availability
              SET operational_status = $2, reason = $3,
                  effective_at = $4::timestamptz, changed_by_user_id = $5,
                  version = version + 1, updated_at = $4::timestamptz
            WHERE tractor_id = $1 AND version = $6
            RETURNING effective_at, version`,
          [tractorId, status, reason ?? null, changedAt.toISOString(), ownerId, current.availability_version],
        );
        const updatedAvailability = availabilityUpdate.rows[0];
        if (updatedAvailability === undefined) return undefined;

        await transaction.sql.query(
          `INSERT INTO public.tractor_availability_history
             (tractor_id, from_status, to_status, reason, actor_id, actor_channel, occurred_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz)`,
          [
            tractorId,
            current.operational_status,
            status,
            reason ?? null,
            ownerId,
            context.actorChannel,
            changedAt.toISOString(),
          ],
        );

        const projection = availabilityProjection({
          tractor_id: tractorId,
          operational_status: status,
          eligibility_status: updatedTractor.eligibility_status,
          effective_at: updatedAvailability.effective_at,
          tractor_version: updatedTractor.version,
        });
        await transaction.appendOutbox({
          aggregateType: "Tractor",
          aggregateId: tractorId,
          eventType: "TractorAvailabilityChanged",
          eventVersion: projection.version,
          payload: {
            tractorId,
            operationalStatus: projection.operationalStatus,
            eligibilityStatus: projection.eligibilityStatus,
            acceptingNewDemand: projection.acceptingNewDemand,
            existingConfirmedBookingsManageable: true,
            effectiveAt: projection.effectiveAt.toISOString(),
            version: projection.version,
          },
        });
        await transaction.appendAudit({
          actorId: ownerId,
          actorChannel: context.actorChannel,
          action: "tractor.availability.changed",
          resourceType: "TRACTOR",
          resourceId: tractorId,
          outcome: "SUCCESS",
          metadata: {
            fromStatus: current.operational_status,
            toStatus: status,
            eligibilityStatus: projection.eligibilityStatus,
            acceptingNewDemand: projection.acceptingNewDemand,
            version: projection.version,
          },
          occurredAt: changedAt,
        });
        return Object.freeze({ kind: "UPDATED", availability: projection });
      },
    );
  }

  async createEquipment(
    ownerId: string,
    input: EquipmentInput,
    context: CatalogRequestContext,
  ): Promise<OwnerEquipmentProjection | undefined> {
    const equipmentId = await withDomainTransaction(
      this.pool,
      { correlationId: context.correlationId, isolation: "SERIALIZABLE" },
      async (transaction) => {
        const result = await transaction.sql.query<IdRow>(
          `INSERT INTO public.equipment
             (owner_id, tractor_id, equipment_type_id, display_name, availability_status)
           SELECT $1, $5::uuid, et.id, $3, $4
             FROM public.equipment_types et
            WHERE et.id = $2
              AND ($5::uuid IS NULL OR EXISTS (
                SELECT 1 FROM public.tractors t WHERE t.id = $5 AND t.owner_id = $1
              ))
           RETURNING id`,
          [ownerId, input.equipmentTypeId, input.displayName, input.availabilityStatus, input.tractorId ?? null],
        );
        const row = result.rows[0];
        if (row === undefined) return undefined;
        if (input.tractorId !== undefined) {
          await this.#evaluateAndStoreEligibility(
            transaction, ownerId, input.tractorId, this.#eligibilityPolicy, this.now(),
          );
        }
        await transaction.appendAudit({
          actorId: ownerId,
          actorChannel: context.actorChannel,
          action: "equipment.create",
          resourceType: "EQUIPMENT",
          resourceId: row.id,
          outcome: "SUCCESS",
          metadata: { assignedToTractor: input.tractorId !== undefined },
        });
        return row.id;
      },
    );
    return equipmentId === undefined ? undefined : this.findEquipment(equipmentId);
  }

  async updateEquipment(
    ownerId: string,
    equipmentId: string,
    input: EquipmentUpdateInput,
    expectedVersion: number,
    context: CatalogRequestContext,
  ): Promise<OwnerEquipmentProjection | undefined> {
    const stored = await withDomainTransaction(
      this.pool,
      { correlationId: context.correlationId, isolation: "SERIALIZABLE" },
      async (transaction) => {
        const result = await transaction.sql.query<{ readonly tractor_id: string | null }>(
          `UPDATE public.equipment SET
             display_name = $4, availability_status = $5,
             version = version + 1, updated_at = CURRENT_TIMESTAMP
           WHERE id = $1 AND owner_id = $2 AND version = $3
           RETURNING tractor_id`,
          [equipmentId, ownerId, expectedVersion, input.displayName, input.availabilityStatus],
        );
        const row = result.rows[0];
        if (row === undefined) return false;
        const impacted = await transaction.sql.query<{ readonly tractor_id: string }>(
          `SELECT DISTINCT tractor_id FROM public.service_offerings
            WHERE equipment_id = $1 AND enabled = true`,
          [equipmentId],
        );
        const impactedTractors = new Set(impacted.rows.map((item) => item.tractor_id));
        if (row.tractor_id !== null) impactedTractors.add(row.tractor_id);
        for (const impactedTractorId of impactedTractors) {
          await this.#evaluateAndStoreEligibility(
            transaction, ownerId, impactedTractorId, this.#eligibilityPolicy, this.now(),
          );
        }
        await transaction.appendAudit({
          actorId: ownerId,
          actorChannel: context.actorChannel,
          action: "equipment.update",
          resourceType: "EQUIPMENT",
          resourceId: equipmentId,
          outcome: "SUCCESS",
          metadata: { availabilityStatus: input.availabilityStatus },
        });
        return true;
      },
    );
    return stored ? this.findEquipment(equipmentId) : undefined;
  }

  async assignEquipment(
    ownerId: string,
    equipmentId: string,
    tractorId: string | undefined,
    expectedVersion: number,
    context: CatalogRequestContext,
  ): Promise<OwnerEquipmentProjection | undefined> {
    const stored = await withDomainTransaction(
      this.pool,
      { correlationId: context.correlationId, isolation: "SERIALIZABLE" },
      async (transaction) => {
        if (tractorId !== undefined) {
          const target = await transaction.sql.query<ExistsRow>(
            "SELECT true AS found FROM public.tractors WHERE id = $1 AND owner_id = $2 FOR UPDATE",
            [tractorId, ownerId],
          );
          if (target.rows[0]?.found !== true) return false;
          const incompatible = await transaction.sql.query<ExistsRow>(
            `SELECT true AS found FROM public.service_offerings
              WHERE equipment_id = $1 AND tractor_id <> $2 AND enabled = true LIMIT 1`,
            [equipmentId, tractorId],
          );
          if (incompatible.rows[0]?.found === true) return false;
        }
        const result = await transaction.sql.query<{ readonly tractor_id: string | null }>(
          `UPDATE public.equipment SET tractor_id = $4::uuid,
             version = version + 1, updated_at = CURRENT_TIMESTAMP
           WHERE id = $1 AND owner_id = $2 AND version = $3
           RETURNING tractor_id`,
          [equipmentId, ownerId, expectedVersion, tractorId ?? null],
        );
        if (result.rowCount !== 1) return false;
        const previous = await transaction.sql.query<{ readonly tractor_id: string }>(
          `SELECT tractor_id FROM public.service_offerings
            WHERE equipment_id = $1 AND enabled = true`,
          [equipmentId],
        );
        const impactedTractors = new Set(previous.rows.map((row) => row.tractor_id));
        if (tractorId !== undefined) impactedTractors.add(tractorId);
        for (const impactedTractorId of impactedTractors) {
          await this.#evaluateAndStoreEligibility(
            transaction, ownerId, impactedTractorId, this.#eligibilityPolicy, this.now(),
          );
        }
        await transaction.appendAudit({
          actorId: ownerId,
          actorChannel: context.actorChannel,
          action: "equipment.assign",
          resourceType: "EQUIPMENT",
          resourceId: equipmentId,
          outcome: "SUCCESS",
          metadata: { assignedToTractor: tractorId !== undefined },
        });
        return true;
      },
    );
    return stored ? this.findEquipment(equipmentId) : undefined;
  }

  async findEquipment(equipmentId: string): Promise<OwnerEquipmentProjection | undefined> {
    const result = await this.pool.query<EquipmentRow>(`${equipmentSql} WHERE e.id = $1 LIMIT 1`, [equipmentId]);
    const row = result.rows[0];
    return row === undefined ? undefined : this.#equipmentProjection(row);
  }

  async listOwnerEquipment(ownerId: string): Promise<readonly OwnerEquipmentProjection[]> {
    const result = await this.pool.query<EquipmentRow>(
      `${equipmentSql} WHERE e.owner_id = $1 ORDER BY e.created_at DESC, e.id DESC LIMIT 100`,
      [ownerId],
    );
    return Object.freeze(result.rows.map((row) => this.#equipmentProjection(row)));
  }

  async upsertServiceOffering(
    ownerId: string,
    tractorId: string,
    input: ServiceOfferingInput,
    expectedVersion: number | undefined,
    context: CatalogRequestContext,
  ): Promise<OwnerServiceOfferingProjection | undefined> {
    const offeringId = await withDomainTransaction(
      this.pool,
      { correlationId: context.correlationId, isolation: "SERIALIZABLE" },
      async (transaction) => {
        const validReferences = await transaction.sql.query<ExistsRow>(
          `SELECT true AS found
             FROM public.tractors t
             INNER JOIN public.services s ON s.id = $3
            WHERE t.id = $1 AND t.owner_id = $2
              AND ($4::uuid IS NULL OR EXISTS (
                SELECT 1 FROM public.equipment e
                 WHERE e.id = $4 AND e.owner_id = $2
                   AND (e.tractor_id IS NULL OR e.tractor_id = $1)
              ))`,
          [tractorId, ownerId, input.serviceId, input.equipmentId ?? null],
        );
        if (validReferences.rows[0]?.found !== true) return undefined;

        const existing = await transaction.sql.query<{ readonly id: string; readonly version: number }>(
          `SELECT id, version FROM public.service_offerings
            WHERE tractor_id = $1 AND service_id = $2
              AND equipment_id IS NOT DISTINCT FROM $3::uuid
            FOR UPDATE`,
          [tractorId, input.serviceId, input.equipmentId ?? null],
        );
        const current = existing.rows[0];
        let id: string;
        if (current === undefined) {
          if (expectedVersion !== undefined) return undefined;
          const inserted = await transaction.sql.query<IdRow>(
            `INSERT INTO public.service_offerings
               (tractor_id, service_id, equipment_id, enabled)
             VALUES ($1, $2, $3::uuid, $4) RETURNING id`,
            [tractorId, input.serviceId, input.equipmentId ?? null, input.enabled],
          );
          const row = inserted.rows[0];
          if (row === undefined) return undefined;
          id = row.id;
        } else {
          if (expectedVersion === undefined || current.version !== expectedVersion) return undefined;
          const updated = await transaction.sql.query<IdRow>(
            `UPDATE public.service_offerings SET enabled = $3,
               version = version + 1, updated_at = CURRENT_TIMESTAMP
             WHERE id = $1 AND version = $2 RETURNING id`,
            [current.id, expectedVersion, input.enabled],
          );
          const row = updated.rows[0];
          if (row === undefined) return undefined;
          id = row.id;
        }
        await this.#evaluateAndStoreEligibility(
          transaction, ownerId, tractorId, this.#eligibilityPolicy, this.now(),
        );
        await transaction.appendAudit({
          actorId: ownerId,
          actorChannel: context.actorChannel,
          action: "service-offering.configure",
          resourceType: "SERVICE_OFFERING",
          resourceId: id,
          outcome: "SUCCESS",
          metadata: { enabled: input.enabled, hasEquipment: input.equipmentId !== undefined },
        });
        return id;
      },
    );
    if (offeringId === undefined) return undefined;
    const result = await this.pool.query<ServiceOfferingRow>(
      `${serviceOfferingSql} WHERE so.id = $1 LIMIT 1`,
      [offeringId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : this.#serviceOfferingProjection(row);
  }

  async listTractorServiceOfferings(
    ownerId: string,
    tractorId: string,
  ): Promise<readonly OwnerServiceOfferingProjection[]> {
    const result = await this.pool.query<ServiceOfferingRow>(
      `${serviceOfferingSql}
       INNER JOIN public.tractors t ON t.id = so.tractor_id
       WHERE so.tractor_id = $1 AND t.owner_id = $2
       ORDER BY so.created_at DESC, so.id DESC LIMIT 100`,
      [tractorId, ownerId],
    );
    return Object.freeze(result.rows.map((row) => this.#serviceOfferingProjection(row)));
  }

  async findServiceOffering(serviceOfferingId: string): Promise<OwnerServiceOfferingProjection | undefined> {
    const result = await this.pool.query<ServiceOfferingRow>(
      `${serviceOfferingSql} WHERE so.id = $1 LIMIT 1`,
      [serviceOfferingId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : this.#serviceOfferingProjection(row);
  }

  async upsertPricingRule(
    ownerId: string,
    serviceOfferingId: string,
    input: PricingRuleInput,
    expectedVersion: number | undefined,
    context: CatalogRequestContext,
  ): Promise<OwnerPricingRuleProjection | undefined> {
    const ruleId = await withDomainTransaction(
      this.pool,
      { correlationId: context.correlationId, isolation: "SERIALIZABLE" },
      async (transaction) => {
        const offering = await transaction.sql.query<{ readonly tractor_id: string }>(
          `SELECT so.tractor_id
             FROM public.service_offerings so
             INNER JOIN public.tractors t ON t.id = so.tractor_id
            WHERE so.id = $1 AND t.owner_id = $2
            FOR UPDATE OF so`,
          [serviceOfferingId, ownerId],
        );
        const tractorId = offering.rows[0]?.tractor_id;
        if (tractorId === undefined) return undefined;

        const existing = await transaction.sql.query<{ readonly id: string; readonly version: number }>(
          `SELECT id, version FROM public.pricing_rules
            WHERE service_offering_id = $1 AND method = $2 AND valid_to IS NULL
            FOR UPDATE`,
          [serviceOfferingId, input.method],
        );
        const current = existing.rows[0];
        let id: string;
        if (current === undefined) {
          if (expectedVersion !== undefined) return undefined;
          const inserted = await transaction.sql.query<IdRow>(
            `INSERT INTO public.pricing_rules
               (service_offering_id, method, rate_paise, currency, rounding_policy,
                valid_from, valid_to, enabled, version)
             VALUES ($1, $2, $3, 'INR', $4, CURRENT_TIMESTAMP, NULL, $5, 1)
             RETURNING id`,
            [serviceOfferingId, input.method, input.ratePaise, input.roundingPolicy ?? null, input.enabled],
          );
          const row = inserted.rows[0];
          if (row === undefined) return undefined;
          id = row.id;
        } else {
          if (expectedVersion === undefined || current.version !== expectedVersion) return undefined;
          await transaction.sql.query(
            `UPDATE public.pricing_rules
                SET valid_to = CURRENT_TIMESTAMP
              WHERE id = $1 AND version = $2 AND valid_to IS NULL`,
            [current.id, expectedVersion],
          );
          const inserted = await transaction.sql.query<IdRow>(
            `INSERT INTO public.pricing_rules
               (service_offering_id, method, rate_paise, currency, rounding_policy,
                valid_from, valid_to, enabled, version)
             VALUES ($1, $2, $3, 'INR', $4, CURRENT_TIMESTAMP, NULL, $5, $6)
             RETURNING id`,
            [
              serviceOfferingId,
              input.method,
              input.ratePaise,
              input.roundingPolicy ?? null,
              input.enabled,
              current.version + 1,
            ],
          );
          const row = inserted.rows[0];
          if (row === undefined) return undefined;
          id = row.id;
        }

        await this.#evaluateAndStoreEligibility(
          transaction, ownerId, tractorId, this.#eligibilityPolicy, this.now(),
        );
        await transaction.appendAudit({
          actorId: ownerId,
          actorChannel: context.actorChannel,
          action: "pricing-rule.configure",
          resourceType: "PRICING_RULE",
          resourceId: id,
          outcome: "SUCCESS",
          metadata: {
            method: input.method,
            enabled: input.enabled,
            hasRoundingPolicy: input.roundingPolicy !== undefined,
          },
        });
        return id;
      },
    );
    if (ruleId === undefined) return undefined;
    const result = await this.pool.query<PricingRuleRow>(
      `${pricingRuleSql} WHERE pr.id = $1 LIMIT 1`,
      [ruleId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : this.#pricingRuleProjection(row);
  }

  async listServiceOfferingPricingRules(
    ownerId: string,
    serviceOfferingId: string,
  ): Promise<readonly OwnerPricingRuleProjection[]> {
    const result = await this.pool.query<PricingRuleRow>(
      `${pricingRuleSql}
       INNER JOIN public.service_offerings so ON so.id = pr.service_offering_id
       INNER JOIN public.tractors t ON t.id = so.tractor_id
       WHERE pr.service_offering_id = $1 AND t.owner_id = $2
         AND pr.valid_to IS NULL
       ORDER BY pr.method ASC, pr.id ASC LIMIT 3`,
      [serviceOfferingId, ownerId],
    );
    return Object.freeze(result.rows.map((row) => this.#pricingRuleProjection(row)));
  }

  async listActivePricingRules(
    serviceOfferingId: string,
    activeAt: Date,
  ): Promise<readonly ActivePricingRuleProjection[]> {
    const result = await this.pool.query<PricingRuleRow>(
      `${pricingRuleSql}
       INNER JOIN public.service_offerings so ON so.id = pr.service_offering_id
       WHERE pr.service_offering_id = $1
         AND so.enabled = true
         AND pr.enabled = true
         AND pr.valid_from <= $2
         AND (pr.valid_to IS NULL OR pr.valid_to > $2)
       ORDER BY pr.method ASC, pr.version DESC, pr.id ASC LIMIT 3`,
      [serviceOfferingId, activeAt.toISOString()],
    );
    return Object.freeze(result.rows.map((row) => this.#activePricingRuleProjection(row)));
  }

  async findActivePricingRule(
    serviceOfferingId: string,
    pricingRuleId: string,
    activeAt: Date,
  ): Promise<ActivePricingRuleProjection | undefined> {
    const result = await this.pool.query<PricingRuleRow>(
      `${pricingRuleSql}
       INNER JOIN public.service_offerings so ON so.id = pr.service_offering_id
       WHERE pr.service_offering_id = $1
         AND pr.id = $2
         AND so.enabled = true
         AND pr.enabled = true
         AND pr.valid_from <= $3
         AND (pr.valid_to IS NULL OR pr.valid_to > $3)
       LIMIT 1`,
      [serviceOfferingId, pricingRuleId, activeAt.toISOString()],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : this.#activePricingRuleProjection(row);
  }

  async evaluateTractorEligibility(
    ownerId: string,
    tractorId: string,
    policy: CatalogEligibilityPolicy,
    evaluatedAt: Date,
    context: CatalogRequestContext,
  ): Promise<TractorEligibilityEvaluation | undefined> {
    return withDomainTransaction(
      this.pool,
      { correlationId: context.correlationId, isolation: "SERIALIZABLE" },
      async (transaction) => {
        const evaluation = await this.#evaluateAndStoreEligibility(
          transaction, ownerId, tractorId, policy, evaluatedAt,
        );
        if (evaluation === undefined) return undefined;
        await transaction.appendAudit({
          actorId: ownerId,
          actorChannel: context.actorChannel,
          action: "tractor.eligibility.evaluate",
          resourceType: "TRACTOR",
          resourceId: tractorId,
          outcome: "SUCCESS",
          metadata: {
            eligibilityStatus: evaluation.status,
            discoverable: evaluation.discoverable,
            reasonCodes: evaluation.reasons.map((reason) => reason.code),
          },
        });
        return evaluation;
      },
    );
  }

  async #replacePhotos(
    transaction: DomainTransaction,
    tractorId: string,
    photos: StoredTractorInput["photos"],
  ): Promise<void> {
    await transaction.sql.query("DELETE FROM public.tractor_photos WHERE tractor_id = $1", [tractorId]);
    for (const photo of photos) {
      await transaction.sql.query(
        `INSERT INTO public.tractor_photos
           (tractor_id, object_key_ciphertext, mime_type, alt_text, sort_order)
         VALUES ($1, $2, $3, $4, $5)`,
        [tractorId, Buffer.from(photo.objectKeyCiphertext), photo.mimeType, photo.altText, photo.sortOrder],
      );
    }
  }

  async #findPhotos(tractorIds: readonly string[]): Promise<Map<string, readonly OwnerTractorPhotoProjection[]>> {
    if (tractorIds.length === 0) return new Map();
    const result = await this.pool.query<PhotoRow>(
      `SELECT id, tractor_id, mime_type, alt_text, sort_order
         FROM public.tractor_photos
        WHERE tractor_id = ANY($1::uuid[])
        ORDER BY tractor_id, sort_order, id`,
      [tractorIds],
    );
    const grouped = new Map<string, OwnerTractorPhotoProjection[]>();
    for (const row of result.rows) {
      const group = grouped.get(row.tractor_id) ?? [];
      group.push(Object.freeze({
        id: row.id,
        mimeType: row.mime_type,
        altText: row.alt_text,
        sortOrder: row.sort_order,
      }));
      grouped.set(row.tractor_id, group);
    }
    return grouped;
  }

  async #evaluateAndStoreEligibility(
    transaction: DomainTransaction,
    ownerId: string,
    tractorId: string,
    policy: CatalogEligibilityPolicy,
    evaluatedAt: Date,
    operationalStatusOverride?: TractorOperationalStatus,
  ): Promise<TractorEligibilityEvaluation | undefined> {
    const tractorResult = await transaction.sql.query<EligibilityTractorRow>(
      `SELECT id, brand, model, registration_number_ciphertext, manufacturing_year,
              operational_status, location_updated_at
         FROM public.tractors
        WHERE id = $1 AND owner_id = $2
        FOR UPDATE`,
      [tractorId, ownerId],
    );
    const tractor = tractorResult.rows[0];
    if (tractor === undefined) return undefined;

    const documents = await transaction.sql.query<DocumentKindRow>(
      `SELECT DISTINCT upper(document_kind) AS document_kind
         FROM public.documents
        WHERE tractor_id = $1 AND owner_id = $2 AND scan_status = 'ACCEPTED'
          AND (expires_at IS NULL OR expires_at > $3::timestamptz)`,
      [tractorId, ownerId, evaluatedAt.toISOString()],
    );
    const acceptedKinds = new Set(documents.rows.map((row) => row.document_kind));
    const missingRequiredDocumentKinds = policy.requiredDocumentKinds
      .map((kind) => kind.trim().toUpperCase())
      .filter((kind) => !acceptedKinds.has(kind));

    const enabledOffering = await transaction.sql.query<ExistsRow>(
      `SELECT true AS found
         FROM public.service_offerings so
         LEFT JOIN public.equipment e ON e.id = so.equipment_id
        WHERE so.tractor_id = $1 AND so.enabled = true
          AND (so.equipment_id IS NULL OR (
            e.owner_id = $2 AND e.availability_status = 'AVAILABLE'
            AND (e.tractor_id IS NULL OR e.tractor_id = so.tractor_id)
          ))
        LIMIT 1`,
      [tractorId, ownerId],
    );
    const activePricing = await transaction.sql.query<ExistsRow>(
      `SELECT true AS found
         FROM public.service_offerings so
         INNER JOIN public.pricing_rules pr ON pr.service_offering_id = so.id
         LEFT JOIN public.equipment e ON e.id = so.equipment_id
        WHERE so.tractor_id = $1 AND so.enabled = true AND pr.enabled = true
          AND pr.valid_from <= $3::timestamptz
          AND (pr.valid_to IS NULL OR pr.valid_to > $3::timestamptz)
          AND (so.equipment_id IS NULL OR (
            e.owner_id = $2 AND e.availability_status = 'AVAILABLE'
            AND (e.tractor_id IS NULL OR e.tractor_id = so.tractor_id)
          ))
        LIMIT 1`,
      [tractorId, ownerId, evaluatedAt.toISOString()],
    );

    const facts: TractorEligibilityFacts = {
      hasRequiredTractorInformation:
        tractor.brand.trim().length > 0 &&
        tractor.model.trim().length > 0 &&
        tractor.registration_number_ciphertext.byteLength > 0 &&
        Number.isInteger(Number(tractor.manufacturing_year)),
      missingRequiredDocumentKinds,
      hasEnabledServiceOffering: enabledOffering.rows[0]?.found === true,
      hasActiveServicePricing: activePricing.rows[0]?.found === true,
      locationUpdatedAt: new Date(tractor.location_updated_at),
      operationalStatus: operationalStatusOverride ?? tractor.operational_status,
    };
    const evaluation = evaluateTractorEligibility(tractorId, facts, policy, evaluatedAt);
    await transaction.sql.query(
      `UPDATE public.tractors SET eligibility_status = $3, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND owner_id = $2`,
      [tractorId, ownerId, evaluation.status],
    );
    return evaluation;
  }

  #equipmentProjection(row: EquipmentRow): OwnerEquipmentProjection {
    return Object.freeze({
      id: row.id,
      ownerId: row.owner_id,
      ...(row.tractor_id === null ? {} : { tractorId: row.tractor_id }),
      equipmentTypeId: row.equipment_type_id,
      equipmentTypeCode: row.equipment_type_code,
      equipmentTypeName: row.equipment_type_name,
      displayName: row.display_name,
      availabilityStatus: row.availability_status,
      version: row.version,
    });
  }

  #activePricingRuleProjection(row: PricingRuleRow): ActivePricingRuleProjection {
    const ownerProjection = this.#pricingRuleProjection(row);
    return Object.freeze({
      id: ownerProjection.id,
      serviceOfferingId: ownerProjection.serviceOfferingId,
      method: ownerProjection.method,
      ratePaise: ownerProjection.ratePaise,
      currency: ownerProjection.currency,
      ...(ownerProjection.roundingPolicy === undefined
        ? {}
        : { roundingPolicy: ownerProjection.roundingPolicy }),
      version: ownerProjection.version,
    });
  }

  #pricingRuleProjection(row: PricingRuleRow): OwnerPricingRuleProjection {
    const ratePaise = Number(row.rate_paise);
    if (!Number.isSafeInteger(ratePaise) || ratePaise <= 0) {
      throw new Error("Stored Pricing Rule rate is outside the supported paise range");
    }
    return Object.freeze({
      id: row.id,
      serviceOfferingId: row.service_offering_id,
      method: row.method,
      ratePaise,
      currency: row.currency,
      ...(row.rounding_policy === null ? {} : { roundingPolicy: row.rounding_policy }),
      enabled: row.enabled,
      version: row.version,
    });
  }

  #serviceOfferingProjection(row: ServiceOfferingRow): OwnerServiceOfferingProjection {
    return Object.freeze({
      id: row.id,
      tractorId: row.tractor_id,
      serviceId: row.service_id,
      serviceCode: row.service_code,
      serviceName: row.service_name,
      ...(row.equipment_id === null ? {} : { equipmentId: row.equipment_id }),
      ...(row.equipment_name === null ? {} : { equipmentName: row.equipment_name }),
      enabled: row.enabled,
      version: row.version,
    });
  }

  #tractorProjection(
    row: TractorRow,
    photos: readonly OwnerTractorPhotoProjection[],
  ): OwnerTractorProjection {
    return Object.freeze({
      id: row.id,
      ownerId: row.owner_id,
      brand: row.brand,
      model: row.model,
      registrationNumber: this.#crypto.decrypt(row.registration_number_ciphertext, "registration"),
      manufacturingYear: row.manufacturing_year,
      ...(row.horsepower === null ? {} : { horsepower: Number(row.horsepower) }),
      operationalStatus: row.operational_status,
      eligibilityStatus: row.eligibility_status,
      operatingLocation: locationProjection(row),
      photos: Object.freeze([...photos]),
      version: row.version,
    });
  }
}
