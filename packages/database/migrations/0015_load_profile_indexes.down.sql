BEGIN;

DROP INDEX IF EXISTS public.tractors_owner_inventory_idx;
DROP INDEX IF EXISTS public.booking_recipients_booking_idx;
DROP INDEX IF EXISTS public.tractors_current_location_idx;

COMMIT;
