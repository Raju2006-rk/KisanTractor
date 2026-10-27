-- One owner-configured rate per pricing method and Service Offering.
-- Optimistic updates change that rule's version rather than creating ambiguous duplicates.
CREATE UNIQUE INDEX pricing_rules_offering_method_unique_idx
  ON public.pricing_rules (service_offering_id, method);
