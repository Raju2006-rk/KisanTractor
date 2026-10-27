BEGIN;

-- UUID equality in a GiST exclusion constraint requires the btree_gist operator class.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Lookup identities and externally visible references.
CREATE UNIQUE INDEX users_active_phone_lookup_hash_uniq
  ON public.users (phone_lookup_hash)
  WHERE status = 'ACTIVE' AND deleted_at IS NULL;

CREATE UNIQUE INDEX tractors_registration_lookup_hash_uniq
  ON public.tractors (registration_lookup_hash);

CREATE INDEX booking_recipients_phone_lookup_idx
  ON public.booking_recipients (phone_lookup_hash)
  WHERE phone_lookup_hash IS NOT NULL;

CREATE INDEX ivr_sessions_caller_phone_lookup_idx
  ON public.ivr_sessions (caller_phone_lookup_hash);

CREATE UNIQUE INDEX bookings_public_reference_uniq
  ON public.bookings (public_reference);

CREATE UNIQUE INDEX provider_events_provider_event_uniq
  ON public.provider_events (provider, provider_event_id);

CREATE UNIQUE INDEX idempotency_records_scope_key_uniq
  ON public.idempotency_records (actor_scope, idempotency_key);

-- Spatial discovery starts from the selected service location and then applies
-- online, eligibility, freshness, offering, pricing, and interval filters.
CREATE INDEX locations_coordinates_gist_idx
  ON public.locations USING gist (coordinates)
  WHERE coordinates IS NOT NULL;

CREATE INDEX tractors_discovery_idx
  ON public.tractors (
    operational_status,
    eligibility_status,
    location_updated_at DESC,
    current_location_id,
    id
  );

CREATE INDEX service_offerings_discovery_idx
  ON public.service_offerings (tractor_id, service_id, equipment_id, id)
  WHERE enabled = true;

CREATE INDEX pricing_rules_active_lookup_idx
  ON public.pricing_rules (service_offering_id, method, valid_from DESC, valid_to, id)
  WHERE enabled = true;

-- Stable cursor indexes keep user-facing and operational history queries bounded.
CREATE INDEX bookings_customer_history_cursor_idx
  ON public.bookings (customer_id, created_at DESC, id DESC);

CREATE INDEX bookings_owner_history_cursor_idx
  ON public.bookings (owner_id, created_at DESC, id DESC);

CREATE INDEX bookings_tractor_schedule_cursor_idx
  ON public.bookings (tractor_id, requested_start_at, requested_end_at, id);

CREATE INDEX booking_status_history_cursor_idx
  ON public.booking_status_history (booking_id, occurred_at DESC, id DESC);

CREATE INDEX tractor_availability_history_cursor_idx
  ON public.tractor_availability_history (tractor_id, occurred_at DESC, id DESC);

CREATE INDEX invoices_booking_history_cursor_idx
  ON public.invoices (booking_id, created_at DESC, id DESC);

CREATE INDEX payments_invoice_history_cursor_idx
  ON public.payments (invoice_id, created_at DESC, id DESC);

CREATE INDEX payment_events_history_cursor_idx
  ON public.payment_events (payment_id, occurred_at DESC, id DESC);

CREATE INDEX notifications_recipient_history_cursor_idx
  ON public.notifications (recipient_user_id, created_at DESC, id DESC)
  WHERE recipient_user_id IS NOT NULL;

CREATE INDEX audit_events_resource_history_cursor_idx
  ON public.audit_events (resource_type, resource_id, occurred_at DESC, id DESC);

CREATE INDEX outbox_events_dispatch_cursor_idx
  ON public.outbox_events (status, available_at, id)
  WHERE status IN ('PENDING', 'FAILED');

-- PostgreSQL's [) range constructor models half-open intervals: an interval that
-- starts exactly when another ends is adjacent and therefore does not overlap.
ALTER TABLE public.bookings
  ADD CONSTRAINT bookings_no_overlapping_blocking_intervals
  EXCLUDE USING gist (
    tractor_id WITH =,
    tstzrange(requested_start_at, requested_end_at, '[)') WITH &&
  )
  WHERE (status IN ('ACCEPTED', 'SCHEDULED', 'IN_PROGRESS'));

COMMIT;
