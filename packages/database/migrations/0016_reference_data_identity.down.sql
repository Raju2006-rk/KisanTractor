BEGIN;
DROP INDEX IF EXISTS public.equipment_types_stable_code_uniq;
DROP INDEX IF EXISTS public.services_stable_code_uniq;
COMMIT;
