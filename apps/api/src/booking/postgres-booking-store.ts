import { createQuoteSnapshot, type ActivePricingRuleProjection, type NormalizedLocation, type QuoteSnapshot } from "@kisantractor/domain";
import { withTransaction, type SqlConnection, type SqlPool } from "@kisantractor/database";

import { isSerializationFailure, retrySerializationFailures } from "../serialization-retry.js";
import { bookingTransitionEventType, bookingTransitionRule } from "./booking-lifecycle.js";
import { BookingAuthorizationError, BookingConflictError, BookingValidationError } from "./booking.service.js";
import type {
  AgreementChangeCommand,
  BookingProjection,
  BookingRequestContext,
  BookingStatus,
  BookingStore,
  ValidatedBookingCreation,
  ValidatedBookingTransition,
} from "./booking.contracts.js";

interface IdempotencyRow extends Record<string, unknown> {
  readonly request_digest: string;
  readonly resource_id: string | null;
  readonly status: string;
}
interface EligibilityRow extends Record<string, unknown> {
  readonly owner_id: string;
  readonly tractor_id: string;
  readonly operational_status: string;
  readonly availability_status: string;
  readonly eligibility_status: string;
  readonly location_updated_at: Date;
  readonly service_offering_id: string;
  readonly pricing_rule_id: string;
  readonly pricing_method: ActivePricingRuleProjection["method"];
  readonly rate_paise: string | number;
  readonly currency: "INR";
  readonly rounding_policy: "PROPORTIONAL_MINUTE" | "THIRTY_MINUTE_BLOCK" | "ONE_HOUR_BLOCK" | null;
  readonly pricing_rule_version: number;
}
interface BookingRow extends Record<string, unknown> {
  readonly id: string;
  readonly public_reference: string;
  readonly customer_id: string;
  readonly owner_id: string;
  readonly tractor_id: string;
  readonly service_offering_id: string;
  readonly requested_start_at: Date;
  readonly requested_end_at: Date;
  readonly status: BookingStatus;
  readonly version: number;
  readonly created_at: Date;
}
interface AgreementRow extends Record<string, unknown> { readonly id: string }
interface RecipientRow extends Record<string, unknown> {
  readonly name: string;
  readonly coordination_consent: boolean;
  readonly landmark_or_directions: string | null;
}

const snapshotJson = (value: object): string => JSON.stringify(value);
/** bookings_no_overlapping_blocking_intervals: the retry re-runs the overlap check instead. */
const EXCLUSION_VIOLATION: ReadonlySet<string> = new Set(["23P01"]);
const idempotencyScope = (customerId: string): string => `farmer:${customerId}:booking:create`;

export class PostgresBookingStore implements BookingStore {
  constructor(
    private readonly pool: SqlPool,
    private readonly maximumTractorLocationAgeMs = 24 * 60 * 60 * 1_000,
    private readonly idempotencyTtlMs = 24 * 60 * 60 * 1_000,
  ) {}

  async createBooking(input: ValidatedBookingCreation, context: BookingRequestContext): Promise<BookingProjection> {
    try {
      // A retry re-reads the idempotency claim, so a concurrent duplicate returns the same booking.
      return await retrySerializationFailures(() => this.#createBookingOnce(input, context));
    } catch (error) {
      if (isSerializationFailure(error)) {
        throw new BookingConflictError("The Tractor's bookings changed concurrently; refresh availability and retry", "CONCURRENT_RESERVATION");
      }
      throw error;
    }
  }

  #createBookingOnce(input: ValidatedBookingCreation, context: BookingRequestContext): Promise<BookingProjection> {
    return withTransaction(this.pool, async (tx) => {
      const existing = await this.#claimIdempotency(tx, input);
      if (existing.resource_id !== null) {
        return this.#loadBooking(tx, existing.resource_id);
      }

      const eligibility = await this.#lockAndValidateInputs(tx, input);
      const rule: ActivePricingRuleProjection = {
        id: eligibility.pricing_rule_id,
        serviceOfferingId: eligibility.service_offering_id,
        method: eligibility.pricing_method,
        ratePaise: Number(eligibility.rate_paise),
        currency: eligibility.currency,
        ...(eligibility.rounding_policy === null ? {} : { roundingPolicy: eligibility.rounding_policy }),
        version: eligibility.pricing_rule_version,
      };
      if (rule.method !== input.command.pricingMethod) {
        throw new BookingValidationError("pricingMethod", "The selected pricing method is no longer active");
      }
      const quote = createQuoteSnapshot(rule, input.command.expectedQuantity, input.disclosedAt);
      const locationJson = snapshotJson(input.command.serviceLocation);
      const bookingResult = await tx.query<BookingRow>(
        `INSERT INTO public.bookings (
           public_reference, customer_id, owner_id, tractor_id, service_offering_id,
           requested_start_at, requested_end_at, expected_quantity, status
         ) VALUES (
           'KT-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12)),
           $1, $2, $3, $4, $5, $6, $7, 'PENDING_OWNER_RESPONSE'
         ) RETURNING id, public_reference, customer_id, owner_id, tractor_id,
           service_offering_id, requested_start_at, requested_end_at, status, version, created_at`,
        [input.customerId, eligibility.owner_id, eligibility.tractor_id,
          eligibility.service_offering_id, input.command.requestedInterval.start.toISOString(),
          input.command.requestedInterval.end.toISOString(), quote.estimatedQuantity],
      );
      const booking = bookingResult.rows[0];
      if (booking === undefined) throw new Error("Booking insert returned no row");

      const agreementResult = await tx.query<AgreementRow>(
        `INSERT INTO public.booking_agreements (
           booking_id, agreement_version, pricing_rule_id, pricing_rule_version, method,
           rate_paise, currency, rounding_policy, estimated_quantity, estimated_total_paise,
           service_location_snapshot, disclosed_at
         ) VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)
         RETURNING id`,
        [booking.id, quote.pricingRuleId, quote.pricingRuleVersion, quote.method, quote.ratePaise,
          quote.currency, quote.roundingPolicy ?? null, quote.estimatedQuantity,
          quote.estimatedTotalPaise, locationJson, quote.disclosedAt],
      );
      const agreement = agreementResult.rows[0];
      if (agreement === undefined) throw new Error("Booking agreement insert returned no row");
      await tx.query("UPDATE public.bookings SET current_agreement_id = $2 WHERE id = $1", [booking.id, agreement.id]);

      if (input.recipient !== undefined) {
        await tx.query(
          `INSERT INTO public.booking_recipients (
             booking_id, name, phone_ciphertext, phone_lookup_hash, coordination_consent,
             service_location_snapshot, landmark_or_directions
           ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
          [booking.id, input.recipient.name, input.recipient.coordinationPhoneCiphertext ?? null,
            input.recipient.coordinationPhoneLookupHash ?? null, input.recipient.coordinationConsent,
            locationJson, input.recipient.landmarkOrDirections ?? null],
        );
      }
      await tx.query(
        `INSERT INTO public.booking_status_history
           (booking_id, from_status, to_status, actor_id, actor_channel, occurred_at)
         VALUES ($1, NULL, 'PENDING_OWNER_RESPONSE', $2, $3, $4)`,
        [booking.id, input.customerId, context.actorChannel, input.disclosedAt.toISOString()],
      );
      await tx.query(
        `INSERT INTO public.outbox_events
           (aggregate_type, aggregate_id, event_type, event_version, payload)
         VALUES ('Booking', $1, 'BookingRequested', 1, $2::jsonb)`,
        [booking.id, JSON.stringify({ bookingId: booking.id, customerId: input.customerId,
          ownerId: eligibility.owner_id, tractorId: eligibility.tractor_id,
          publicReference: booking.public_reference })],
      );
      await tx.query(
        `UPDATE public.idempotency_records SET status = 'COMPLETED', response_status = 201,
           resource_type = 'Booking', resource_id = $3, response_body = $4::jsonb, updated_at = CURRENT_TIMESTAMP
         WHERE actor_scope = $1 AND idempotency_key = $2`,
        [idempotencyScope(input.customerId), input.idempotencyKey, booking.id,
          JSON.stringify({ bookingId: booking.id, publicReference: booking.public_reference })],
      );
      return this.#projection(booking, input.command.serviceLocation, quote, input.recipient);
    }, { isolation: "SERIALIZABLE", correlationId: context.correlationId });
  }

  async transitionBooking(input: ValidatedBookingTransition, context: BookingRequestContext): Promise<BookingProjection> {
    try {
      // On 40001/23P01 a fresh attempt sees the concurrent winner: an overlapping request then
      // fails with OVERLAP, and an adjacent one that only shared index pages succeeds.
      return await retrySerializationFailures(() => withTransaction(this.pool, async (tx) => {
        const lockedResult = await tx.query<BookingRow>(
          `SELECT id, public_reference, customer_id, owner_id, tractor_id, service_offering_id,
             requested_start_at, requested_end_at, status, version, created_at
           FROM public.bookings WHERE id = $1 FOR UPDATE`,
          [input.bookingId],
        );
        const booking = lockedResult.rows[0];
        if (booking === undefined) throw new BookingAuthorizationError();
        const ownsBooking = input.actorRole === "SYSTEM" || input.actorRole === "SUPPORT"
          || (input.actorRole === "OWNER" ? booking.owner_id === input.actorId : booking.customer_id === input.actorId);
        if (!ownsBooking) throw new BookingAuthorizationError();
        if (booking.version !== input.expectedVersion) {
          throw new BookingConflictError(`Booking version conflict: current version is ${booking.version}`, "VERSION_CONFLICT");
        }

        const targetStatus = this.#targetStatus(input, booking.status);
        if (input.action === "ACCEPT") {
          await tx.query("SELECT id FROM public.tractors WHERE id = $1 FOR UPDATE", [booking.tractor_id]);
          const overlap = await tx.query<{ readonly found: boolean }>(
            `SELECT EXISTS (
               SELECT 1 FROM public.bookings conflicting
               WHERE conflicting.tractor_id = $1 AND conflicting.id <> $2
                 AND conflicting.status IN ('ACCEPTED', 'SCHEDULED', 'IN_PROGRESS')
                 AND conflicting.requested_start_at < $4 AND $3 < conflicting.requested_end_at
             ) AS found`,
            [booking.tractor_id, booking.id, booking.requested_start_at.toISOString(),
              booking.requested_end_at.toISOString()],
          );
          if (overlap.rows[0]?.found === true) {
            throw new BookingConflictError("The Tractor was accepted for an overlapping interval; refresh availability", "OVERLAP");
          }
        }

        const updateResult = await tx.query<BookingRow>(
          `UPDATE public.bookings SET status = $2, version = version + 1, updated_at = $3
           WHERE id = $1 AND version = $4
           RETURNING id, public_reference, customer_id, owner_id, tractor_id, service_offering_id,
             requested_start_at, requested_end_at, status, version, created_at`,
          [booking.id, targetStatus, input.occurredAt.toISOString(), input.expectedVersion],
        );
        const updated = updateResult.rows[0];
        if (updated === undefined) throw new BookingConflictError("Booking changed while the request was being processed", "CONCURRENT_UPDATE");
        await tx.query(
          `INSERT INTO public.booking_status_history
             (booking_id, from_status, to_status, actor_id, actor_channel, reason, occurred_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [booking.id, booking.status, targetStatus, input.actorId, context.actorChannel,
            input.reason ?? null, input.occurredAt.toISOString()],
        );
        if (targetStatus === "DISPUTED") {
          // The dispute opens its support case in the same transaction (task 16.5): the case pins the
          // disputed invoice version, and its first timeline entry is the Farmer's statement.
          await tx.query(
            `WITH current_invoice AS (
               SELECT id FROM public.invoices WHERE booking_id = $1::uuid ORDER BY invoice_version DESC LIMIT 1
             ), opened AS (
               INSERT INTO public.support_cases (booking_id, disputed_invoice_id, opened_at)
               SELECT $1::uuid, id, $2::timestamptz FROM current_invoice
               RETURNING id, disputed_invoice_id
             )
             INSERT INTO public.support_case_entries
               (case_id, entry_type, author_role, author_user_id, statement_code, statement_text,
                evidence_kind, evidence_id, occurred_at)
             SELECT id, 'OPENED', 'FARMER', $3::uuid, 'BILL_DISPUTED', $4::text, 'INVOICE', disputed_invoice_id, $2::timestamptz
             FROM opened`,
            [booking.id, input.occurredAt.toISOString(), input.actorId, input.reason ?? null],
          );
        }
        const eventType = bookingTransitionEventType(targetStatus);
        await tx.query(
          `INSERT INTO public.outbox_events
             (aggregate_type, aggregate_id, event_type, event_version, payload)
           VALUES ('Booking', $1, $2, $3, $4::jsonb)`,
          [booking.id, eventType, updated.version, JSON.stringify({ bookingId: booking.id,
            fromStatus: booking.status, toStatus: targetStatus, actorId: input.actorId,
            notificationRecipients: [booking.customer_id, booking.owner_id] })],
        );
        return this.#loadBooking(tx, booking.id);
      }, { isolation: "SERIALIZABLE", correlationId: context.correlationId }), { alsoRetry: EXCLUSION_VIOLATION });
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : undefined;
      if (code === "23P01" || code === "40001") {
        throw new BookingConflictError("The Tractor interval was reserved concurrently; refresh availability", "CONCURRENT_RESERVATION");
      }
      throw error;
    }
  }

  async changeAgreement(
    input: AgreementChangeCommand & Readonly<{ actorId: string }>,
    context: BookingRequestContext,
  ): Promise<BookingProjection> {
    return withTransaction(this.pool, async (tx) => {
      const result = await tx.query<BookingRow & { readonly current_agreement_id: string }>(
        `SELECT id, public_reference, customer_id, owner_id, tractor_id, service_offering_id,
           requested_start_at, requested_end_at, status, version, created_at, current_agreement_id
         FROM public.bookings WHERE id = $1 FOR UPDATE`, [input.bookingId]);
      const booking = result.rows[0];
      if (booking === undefined || booking.owner_id !== input.actorId) throw new BookingAuthorizationError();
      if (booking.version !== input.expectedVersion) throw new BookingConflictError(`Booking version conflict: current version is ${booking.version}`);
      if (booking.status !== "ACCEPTED" && booking.status !== "SCHEDULED") {
        throw new BookingConflictError(`An agreement cannot change in ${booking.status}`);
      }
      const quote = input.quoteSnapshot;
      const agreement = await tx.query<AgreementRow>(
        `INSERT INTO public.booking_agreements (
           booking_id, agreement_version, pricing_rule_id, pricing_rule_version, method, rate_paise,
           currency, rounding_policy, estimated_quantity, estimated_total_paise, service_location_snapshot,
           change_reason, approved_by_customer_at, approved_by_owner_at, disclosed_at)
         SELECT $1, COALESCE(MAX(agreement_version), 0) + 1, $2, $3, $4, $5, $6, $7, $8, $9,
           $10::jsonb, $11, $12, $13, $14 FROM public.booking_agreements WHERE booking_id = $1
         RETURNING id`, [booking.id, quote.pricingRuleId, quote.pricingRuleVersion, quote.method,
          quote.ratePaise, quote.currency, quote.roundingPolicy ?? null, quote.estimatedQuantity,
          quote.estimatedTotalPaise, snapshotJson(input.serviceLocationSnapshot), input.reason,
          input.customerApprovedAt.toISOString(), input.ownerApprovedAt.toISOString(), quote.disclosedAt]);
      const agreementId = agreement.rows[0]?.id;
      if (agreementId === undefined) throw new Error("Booking agreement insert returned no row");
      await tx.query(
        `UPDATE public.bookings SET current_agreement_id = $2, version = version + 1, updated_at = $3
         WHERE id = $1 AND version = $4`,
        [booking.id, agreementId, input.ownerApprovedAt.toISOString(), input.expectedVersion]);
      await tx.query(
        `INSERT INTO public.outbox_events (aggregate_type, aggregate_id, event_type, event_version, payload)
         VALUES ('Booking', $1, 'BookingAgreementChanged', $2, $3::jsonb)`,
        [booking.id, booking.version + 1, JSON.stringify({ bookingId: booking.id, agreementId,
          notificationRecipients: [booking.customer_id, booking.owner_id] })]);
      return this.#loadBooking(tx, booking.id);
    }, { isolation: "SERIALIZABLE", correlationId: context.correlationId });
  }

  async expirePendingBookings(
    input: Readonly<{ pendingBefore: Date; occurredAt: Date; limit?: number }>,
    context: BookingRequestContext,
  ): Promise<number> {
    return withTransaction(this.pool, async (tx) => {
      const expired = await tx.query<BookingRow>(
        `WITH candidates AS (
           SELECT id FROM public.bookings
           WHERE status = 'PENDING_OWNER_RESPONSE' AND created_at < $1
           ORDER BY created_at, id FOR UPDATE SKIP LOCKED LIMIT $2
         )
         UPDATE public.bookings b SET status = 'EXPIRED', version = version + 1, updated_at = $3
         FROM candidates c WHERE b.id = c.id
         RETURNING b.id, b.public_reference, b.customer_id, b.owner_id, b.tractor_id,
           b.service_offering_id, b.requested_start_at, b.requested_end_at, b.status, b.version, b.created_at`,
        [input.pendingBefore.toISOString(), input.limit ?? 100, input.occurredAt.toISOString()]);
      for (const booking of expired.rows) {
        await tx.query(
          `INSERT INTO public.booking_status_history
             (booking_id, from_status, to_status, actor_id, actor_channel, reason, occurred_at)
           VALUES ($1, 'PENDING_OWNER_RESPONSE', 'EXPIRED', NULL, 'SYSTEM', 'Owner response deadline elapsed', $2)`,
          [booking.id, input.occurredAt.toISOString()]);
        await tx.query(
          `INSERT INTO public.outbox_events (aggregate_type, aggregate_id, event_type, event_version, payload)
           VALUES ('Booking', $1, 'BookingExpired', $2, $3::jsonb)`,
          [booking.id, booking.version, JSON.stringify({ bookingId: booking.id,
            fromStatus: "PENDING_OWNER_RESPONSE", toStatus: "EXPIRED",
            notificationRecipients: [booking.customer_id, booking.owner_id] })]);
      }
      return expired.rowCount;
    }, { isolation: "READ COMMITTED", correlationId: context.correlationId });
  }

  #targetStatus(input: ValidatedBookingTransition, currentStatus: BookingStatus): BookingStatus {
    const rule = bookingTransitionRule(currentStatus, input.action, input.actorRole);
    if (rule === undefined) {
      throw new BookingConflictError(`The ${input.actorRole.toLowerCase()} cannot ${input.action.toLowerCase()} a booking in ${currentStatus}`, "INVALID_TRANSITION");
    }
    if (rule.reasonRequired === true && input.reason === undefined) {
      throw new BookingValidationError("reason", `A reason is required to ${input.action.toLowerCase()} this booking`);
    }
    return rule.to;
  }

  async #claimIdempotency(tx: SqlConnection, input: ValidatedBookingCreation): Promise<IdempotencyRow> {
    const scope = idempotencyScope(input.customerId);
    await tx.query(
      `INSERT INTO public.idempotency_records
         (actor_scope, idempotency_key, request_digest, expires_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (actor_scope, idempotency_key) DO NOTHING`,
      [scope, input.idempotencyKey, input.requestDigest,
        new Date(input.disclosedAt.getTime() + this.idempotencyTtlMs).toISOString()],
    );
    const result = await tx.query<IdempotencyRow>(
      `SELECT request_digest, resource_id, status FROM public.idempotency_records
       WHERE actor_scope = $1 AND idempotency_key = $2 FOR UPDATE`,
      [scope, input.idempotencyKey],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error("Unable to claim booking idempotency key");
    if (row.request_digest !== input.requestDigest) {
      throw new BookingConflictError("The idempotency key was already used for a different booking request");
    }
    if (row.status === "COMPLETED" && row.resource_id === null) {
      throw new Error("Completed booking idempotency record has no resource");
    }
    return row;
  }

  async #lockAndValidateInputs(tx: SqlConnection, input: ValidatedBookingCreation): Promise<EligibilityRow> {
    const result = await tx.query<EligibilityRow>(
      `SELECT t.owner_id, t.id AS tractor_id, t.operational_status,
         ta.operational_status AS availability_status, t.eligibility_status, t.location_updated_at,
         so.id AS service_offering_id, pr.id AS pricing_rule_id, pr.method AS pricing_method,
         pr.rate_paise, pr.currency, pr.rounding_policy, pr.version AS pricing_rule_version
       FROM public.tractors t
       INNER JOIN public.tractor_availability ta ON ta.tractor_id = t.id
       INNER JOIN public.service_offerings so ON so.id = $2 AND so.tractor_id = t.id AND so.enabled = true
       LEFT JOIN public.equipment e ON e.id = so.equipment_id
       INNER JOIN public.pricing_rules pr ON pr.id = $3 AND pr.service_offering_id = so.id
         AND pr.enabled = true AND pr.valid_from <= $4
         AND (pr.valid_to IS NULL OR pr.valid_to > $4)
       WHERE t.id = $1
         AND (so.equipment_id IS NULL OR (e.availability_status = 'AVAILABLE'
           AND e.owner_id = t.owner_id AND (e.tractor_id IS NULL OR e.tractor_id = t.id)))
       FOR UPDATE OF t, ta, so, pr`,
      [input.command.tractorId, input.command.serviceOfferingId, input.command.pricingRuleId,
        input.disclosedAt.toISOString()],
    );
    const row = result.rows[0];
    if (row === undefined) throw new BookingValidationError("offering", "The selected Tractor, offering, or price is unavailable");
    if (row.operational_status !== "ONLINE" || row.availability_status !== "ONLINE" || row.eligibility_status !== "ELIGIBLE") {
      throw new BookingConflictError("The selected Tractor is no longer online and eligible");
    }
    if (input.disclosedAt.getTime() - new Date(row.location_updated_at).getTime() > this.maximumTractorLocationAgeMs ||
        new Date(row.location_updated_at).getTime() > input.disclosedAt.getTime()) {
      throw new BookingConflictError("The selected Tractor location is stale");
    }
    const overlap = await tx.query<{ readonly found: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM public.bookings b WHERE b.tractor_id = $1
           AND b.status IN ('ACCEPTED', 'SCHEDULED', 'IN_PROGRESS')
           AND b.requested_start_at < $3 AND $2 < b.requested_end_at
       ) AS found`,
      [row.tractor_id, input.command.requestedInterval.start.toISOString(), input.command.requestedInterval.end.toISOString()],
    );
    if (overlap.rows[0]?.found === true) throw new BookingConflictError("The selected interval is no longer available");
    return row;
  }

  async #loadBooking(tx: SqlConnection, id: string): Promise<BookingProjection> {
    const result = await tx.query<BookingRow & { service_location_snapshot: NormalizedLocation; quote_snapshot: QuoteSnapshot; recipient_name: string | null; coordination_consent: boolean | null; landmark_or_directions: string | null }>(
      `SELECT b.id, b.public_reference, b.customer_id, b.owner_id, b.tractor_id,
         b.service_offering_id, b.requested_start_at, b.requested_end_at, b.status, b.version, b.created_at,
         ba.service_location_snapshot,
         jsonb_build_object('pricingRuleId', ba.pricing_rule_id, 'pricingRuleVersion', ba.pricing_rule_version,
           'method', ba.method, 'ratePaise', ba.rate_paise, 'currency', ba.currency,
           'roundingPolicy', ba.rounding_policy, 'estimatedQuantity', ba.estimated_quantity,
           'estimatedTotalPaise', ba.estimated_total_paise, 'disclosedAt', ba.disclosed_at) AS quote_snapshot,
         br.name AS recipient_name, br.coordination_consent, br.landmark_or_directions
       FROM public.bookings b JOIN public.booking_agreements ba ON ba.id = b.current_agreement_id
       LEFT JOIN public.booking_recipients br ON br.booking_id = b.id WHERE b.id = $1`, [id]);
    const row = result.rows[0];
    if (row === undefined) throw new Error("Idempotent booking result no longer exists");
    return Object.freeze({
      id: row.id, publicReference: row.public_reference, customerId: row.customer_id, ownerId: row.owner_id,
      tractorId: row.tractor_id, serviceOfferingId: row.service_offering_id, status: row.status,
      requestedInterval: { start: row.requested_start_at, end: row.requested_end_at },
      serviceLocationSnapshot: row.service_location_snapshot,
      ...(row.recipient_name === null ? {} : { recipient: { name: row.recipient_name,
        coordinationConsent: row.coordination_consent ?? false,
        ...(row.landmark_or_directions === null ? {} : { landmarkOrDirections: row.landmark_or_directions }) } }),
      quoteSnapshot: row.quote_snapshot, version: row.version, createdAt: row.created_at,
    });
  }

  #projection(booking: BookingRow, location: NormalizedLocation, quote: QuoteSnapshot,
    recipient: ValidatedBookingCreation["recipient"]): BookingProjection {
    return Object.freeze({
      id: booking.id, publicReference: booking.public_reference, customerId: booking.customer_id,
      ownerId: booking.owner_id, tractorId: booking.tractor_id, serviceOfferingId: booking.service_offering_id,
      status: booking.status, requestedInterval: { start: booking.requested_start_at, end: booking.requested_end_at },
      serviceLocationSnapshot: location,
      ...(recipient === undefined ? {} : { recipient: { name: recipient.name,
        coordinationConsent: recipient.coordinationConsent,
        ...(recipient.landmarkOrDirections === undefined ? {} : { landmarkOrDirections: recipient.landmarkOrDirections }) } }),
      quoteSnapshot: quote, version: booking.version, createdAt: booking.created_at,
    });
  }
}
