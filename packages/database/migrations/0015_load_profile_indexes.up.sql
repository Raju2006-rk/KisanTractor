BEGIN;

-- Found by the initial-load suite (task 15.3); see ops/performance/initial-load-profile.md.

-- Discovery reaches Tractors from the spatial candidates by location. Without this index the
-- planner re-scanned every eligible Tractor for each candidate location (25 km: 167 ms).
CREATE INDEX tractors_current_location_idx
  ON public.tractors (current_location_id);

-- Every booking list and detail read left-joins the Recipient snapshot by booking.
CREATE INDEX booking_recipients_booking_idx
  ON public.booking_recipients (booking_id);

-- The Owner dashboard lists the Owner's Tractors newest first (LIMIT 100).
CREATE INDEX tractors_owner_inventory_idx
  ON public.tractors (owner_id, created_at DESC, id DESC);

COMMIT;
