BEGIN;

-- A Pricing Rule update closes the prior version and inserts a new row. Historical
-- rows stay addressable by booking_agreements.pricing_rule_id.
DROP INDEX IF EXISTS public.pricing_rules_offering_method_unique_idx;
CREATE UNIQUE INDEX pricing_rules_current_offering_method_unique_idx
  ON public.pricing_rules (service_offering_id, method)
  WHERE valid_to IS NULL;

COMMIT;
