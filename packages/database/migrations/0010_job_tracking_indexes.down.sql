BEGIN;

DROP INDEX IF EXISTS public.work_measurements_booking_order_idx;
DROP INDEX IF EXISTS public.work_measurements_one_original_completion_uniq;
DROP INDEX IF EXISTS public.work_events_booking_order_idx;
DROP INDEX IF EXISTS public.work_events_booking_actor_key_uniq;

COMMIT;
