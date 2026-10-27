BEGIN;

ALTER TABLE public.notifications DROP COLUMN IF EXISTS template_version;

DROP INDEX IF EXISTS public.push_device_registrations_user_recent_idx;
DROP INDEX IF EXISTS public.push_device_registrations_token_uniq;
DROP TABLE IF EXISTS public.push_device_registrations;

COMMIT;
