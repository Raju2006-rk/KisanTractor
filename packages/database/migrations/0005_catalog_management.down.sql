BEGIN;

DROP INDEX IF EXISTS public.documents_tractor_eligibility_idx;
DROP INDEX IF EXISTS public.equipment_owner_inventory_idx;
DROP INDEX IF EXISTS public.service_offerings_tractor_service_equipment_uniq;

COMMIT;
