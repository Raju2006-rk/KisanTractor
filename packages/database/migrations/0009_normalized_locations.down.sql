BEGIN;

DROP INDEX IF EXISTS public.locations_manual_admin_lookup_idx;

ALTER TABLE public.locations
  DROP CONSTRAINT IF EXISTS locations_consent_time_check,
  DROP CONSTRAINT IF EXISTS locations_coordinate_metadata_check,
  DROP CONSTRAINT IF EXISTS locations_optional_parts_check,
  DROP CONSTRAINT IF EXISTS locations_administrative_parts_check,
  DROP CONSTRAINT IF EXISTS locations_collection_purpose_check,
  DROP COLUMN IF EXISTS collection_purpose;

COMMIT;
