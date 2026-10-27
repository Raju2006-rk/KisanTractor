BEGIN;

CREATE TABLE public.tractor_photos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tractor_id uuid NOT NULL REFERENCES public.tractors(id) ON DELETE RESTRICT,
  object_key_ciphertext bytea NOT NULL,
  mime_type text NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp')),
  alt_text text NOT NULL CHECK (char_length(trim(alt_text)) > 0),
  sort_order smallint NOT NULL CHECK (sort_order BETWEEN 0 AND 7),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tractor_id, sort_order)
);

CREATE INDEX tractor_photos_tractor_idx
  ON public.tractor_photos (tractor_id, sort_order, id);

COMMIT;
