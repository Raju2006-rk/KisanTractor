BEGIN;

CREATE UNIQUE INDEX work_events_booking_actor_key_uniq
  ON public.work_events (booking_id, actor_id, idempotency_key);

CREATE INDEX work_events_booking_order_idx
  ON public.work_events (booking_id, received_at, id);

CREATE UNIQUE INDEX work_measurements_one_original_completion_uniq
  ON public.work_measurements (booking_id)
  WHERE correction_of_id IS NULL;

CREATE INDEX work_measurements_booking_order_idx
  ON public.work_measurements (booking_id, created_at, id);

COMMIT;
