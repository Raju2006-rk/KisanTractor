BEGIN;
-- Canonical reference data (Services, Equipment Types) is seeded with fixed UUIDs and stable
-- codes from packages/database/src/reference-data.ts. A stable code names exactly one row for
-- the life of the platform, so the seed can detect identity drift instead of silently creating
-- a second row for the same concept. Additive: indexes only; no column or row changes.
CREATE UNIQUE INDEX services_stable_code_uniq
  ON public.services (stable_code);
CREATE UNIQUE INDEX equipment_types_stable_code_uniq
  ON public.equipment_types (stable_code);
COMMIT;
