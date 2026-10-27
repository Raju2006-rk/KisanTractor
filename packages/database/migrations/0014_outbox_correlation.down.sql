BEGIN;

ALTER TABLE public.outbox_events DROP CONSTRAINT IF EXISTS outbox_events_correlation_id_chk;
ALTER TABLE public.outbox_events DROP COLUMN IF EXISTS correlation_id;

COMMIT;
