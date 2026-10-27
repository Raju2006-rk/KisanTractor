BEGIN;

ALTER TABLE public.documents
  ADD COLUMN original_file_name text,
  ADD COLUMN uploaded_size_bytes bigint CHECK (uploaded_size_bytes >= 0),
  ADD COLUMN object_encryption_algorithm text,
  ADD COLUMN upload_grant_expires_at timestamptz,
  ADD COLUMN scan_completed_at timestamptz,
  ADD COLUMN accepted_at timestamptz,
  ADD COLUMN rejection_code text;

ALTER TABLE public.documents
  ADD CONSTRAINT documents_private_metadata_consistency CHECK (
    (scan_status <> 'PENDING_SCAN' OR (
      detected_mime_type IS NOT NULL AND
      uploaded_size_bytes IS NOT NULL AND
      content_digest IS NOT NULL AND
      object_encryption_algorithm IS NOT NULL
    )) AND
    (scan_status <> 'ACCEPTED' OR (
      detected_mime_type IS NOT NULL AND
      uploaded_size_bytes IS NOT NULL AND
      content_digest IS NOT NULL AND
      object_encryption_algorithm IS NOT NULL AND
      scan_completed_at IS NOT NULL AND
      accepted_at IS NOT NULL
    )) AND
    (scan_status <> 'REJECTED' OR rejection_code IS NOT NULL)
  );

CREATE UNIQUE INDEX documents_private_object_key_uniq
  ON public.documents (object_key);

CREATE INDEX documents_owner_history_cursor_idx
  ON public.documents (owner_id, created_at DESC, id DESC);

COMMIT;
