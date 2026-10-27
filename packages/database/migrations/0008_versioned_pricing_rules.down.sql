BEGIN;

DROP INDEX IF EXISTS public.pricing_rules_current_offering_method_unique_idx;
CREATE UNIQUE INDEX pricing_rules_offering_method_unique_idx
  ON public.pricing_rules (service_offering_id, method);

COMMIT;
