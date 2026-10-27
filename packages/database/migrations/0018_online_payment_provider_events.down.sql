BEGIN;

DROP INDEX IF EXISTS public.provider_events_payload_digest_idx;
DROP INDEX IF EXISTS public.payments_provider_reference_uniq;

COMMIT;
