BEGIN;

DROP INDEX IF EXISTS public.documents_owner_history_cursor_idx;
DROP INDEX IF EXISTS public.documents_private_object_key_uniq;

ALTER TABLE public.documents
  DROP CONSTRAINT IF EXISTS documents_private_metadata_consistency,
  DROP COLUMN IF EXISTS rejection_code,
  DROP COLUMN IF EXISTS accepted_at,
  DROP COLUMN IF EXISTS scan_completed_at,
  DROP COLUMN IF EXISTS upload_grant_expires_at,
  DROP COLUMN IF EXISTS object_encryption_algorithm,
  DROP COLUMN IF EXISTS uploaded_size_bytes,
  DROP COLUMN IF EXISTS original_file_name;

COMMIT;
