BEGIN;

-- Push channel (task 16.4): FCM registration tokens per user and device. Tokens are personal
-- data: stored encrypted, looked up by keyed hash, deleted on unregister, on an FCM
-- UNREGISTERED answer, and on account deletion. Re-registering a token moves it to the
-- registering account.
CREATE TABLE public.push_device_registrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  platform text NOT NULL CHECK (platform IN ('WEB', 'ANDROID', 'IOS')),
  token_ciphertext bytea NOT NULL CHECK (octet_length(token_ciphertext) > 0),
  token_lookup_hash text NOT NULL CHECK (token_lookup_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_registered_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0)
);

CREATE UNIQUE INDEX push_device_registrations_token_uniq
  ON public.push_device_registrations (token_lookup_hash);

CREATE INDEX push_device_registrations_user_recent_idx
  ON public.push_device_registrations (user_id, last_registered_at DESC);

-- The template contract version a notification was rendered with (registered SMS templates are
-- keyed by it). Nullable: rows written before 0020 have none.
ALTER TABLE public.notifications ADD COLUMN template_version integer;

COMMIT;
