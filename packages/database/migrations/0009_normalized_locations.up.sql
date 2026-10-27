BEGIN;

ALTER TABLE public.locations
  ADD COLUMN collection_purpose text;

UPDATE public.locations AS l
SET collection_purpose = CASE
  WHEN EXISTS (
    SELECT 1 FROM public.owner_profiles op WHERE op.operating_location_id = l.id
  ) OR EXISTS (
    SELECT 1 FROM public.tractors t WHERE t.current_location_id = l.id
  ) THEN 'TRACTOR_OPERATING_LOCATION'
  ELSE 'SERVICE_LOCATION'
END;

ALTER TABLE public.locations
  ALTER COLUMN collection_purpose SET NOT NULL,
  ALTER COLUMN collection_purpose SET DEFAULT 'SERVICE_LOCATION',
  ADD CONSTRAINT locations_collection_purpose_check
    CHECK (collection_purpose IN ('SERVICE_LOCATION', 'TRACTOR_OPERATING_LOCATION', 'SAVED_LOCATION')),
  ADD CONSTRAINT locations_administrative_parts_check
    CHECK (
      char_length(trim(state)) BETWEEN 1 AND 100
      AND char_length(trim(district)) BETWEEN 1 AND 100
      AND char_length(trim(mandal_or_taluk)) BETWEEN 1 AND 100
      AND char_length(trim(village)) BETWEEN 1 AND 150
      AND state = regexp_replace(trim(state), '\s+', ' ', 'g')
      AND district = regexp_replace(trim(district), '\s+', ' ', 'g')
      AND mandal_or_taluk = regexp_replace(trim(mandal_or_taluk), '\s+', ' ', 'g')
      AND village = regexp_replace(trim(village), '\s+', ' ', 'g')
    ),
  ADD CONSTRAINT locations_optional_parts_check
    CHECK (
      (postal_code IS NULL OR postal_code ~ '^[0-9]{6}$')
      AND (landmark IS NULL OR char_length(trim(landmark)) BETWEEN 1 AND 250)
    ),
  ADD CONSTRAINT locations_coordinate_metadata_check
    CHECK (
      (accuracy_meters IS NULL OR coordinates IS NOT NULL)
      AND (source <> 'DEVICE_GPS' OR (
        coordinates IS NOT NULL
        AND accuracy_meters IS NOT NULL
        AND location_consent_at IS NOT NULL
      ))
      AND (source NOT IN ('MAP_PIN', 'MAP_SEARCH') OR coordinates IS NOT NULL)
    ),
  ADD CONSTRAINT locations_consent_time_check
    CHECK (location_consent_at IS NULL OR location_consent_at <= captured_at);

CREATE INDEX locations_manual_admin_lookup_idx
  ON public.locations (
    lower(state),
    lower(district),
    lower(mandal_or_taluk),
    lower(village),
    id
  );

COMMIT;
