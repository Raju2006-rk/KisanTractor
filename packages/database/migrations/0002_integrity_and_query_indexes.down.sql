BEGIN;

ALTER TABLE public.bookings
  DROP CONSTRAINT IF EXISTS bookings_no_overlapping_blocking_intervals;

DROP INDEX IF EXISTS public.outbox_events_dispatch_cursor_idx;
DROP INDEX IF EXISTS public.audit_events_resource_history_cursor_idx;
DROP INDEX IF EXISTS public.notifications_recipient_history_cursor_idx;
DROP INDEX IF EXISTS public.payment_events_history_cursor_idx;
DROP INDEX IF EXISTS public.payments_invoice_history_cursor_idx;
DROP INDEX IF EXISTS public.invoices_booking_history_cursor_idx;
DROP INDEX IF EXISTS public.tractor_availability_history_cursor_idx;
DROP INDEX IF EXISTS public.booking_status_history_cursor_idx;
DROP INDEX IF EXISTS public.bookings_tractor_schedule_cursor_idx;
DROP INDEX IF EXISTS public.bookings_owner_history_cursor_idx;
DROP INDEX IF EXISTS public.bookings_customer_history_cursor_idx;
DROP INDEX IF EXISTS public.pricing_rules_active_lookup_idx;
DROP INDEX IF EXISTS public.service_offerings_discovery_idx;
DROP INDEX IF EXISTS public.tractors_discovery_idx;
DROP INDEX IF EXISTS public.locations_coordinates_gist_idx;
DROP INDEX IF EXISTS public.idempotency_records_scope_key_uniq;
DROP INDEX IF EXISTS public.provider_events_provider_event_uniq;
DROP INDEX IF EXISTS public.bookings_public_reference_uniq;
DROP INDEX IF EXISTS public.ivr_sessions_caller_phone_lookup_idx;
DROP INDEX IF EXISTS public.booking_recipients_phone_lookup_idx;
DROP INDEX IF EXISTS public.tractors_registration_lookup_hash_uniq;
DROP INDEX IF EXISTS public.users_active_phone_lookup_hash_uniq;

-- btree_gist may be shared by other schemas or migrations, so rollback leaves the
-- extension installed while removing every task-owned constraint and index.

COMMIT;
