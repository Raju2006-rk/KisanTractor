BEGIN;

CREATE TYPE otp_purpose AS ENUM ('SIGN_IN', 'REGISTER_FARMER', 'REGISTER_OWNER');

CREATE TABLE public.otp_challenges (
  id uuid PRIMARY KEY,
  phone_lookup_hash text NOT NULL,
  purpose otp_purpose NOT NULL,
  code_hash text NOT NULL,
  requester_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  max_attempts integer NOT NULL CHECK (max_attempts BETWEEN 1 AND 20),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0 AND attempt_count <= max_attempts),
  consumed_at timestamptz,
  invalidated_at timestamptz,
  invalidation_reason text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (expires_at > created_at),
  CHECK (consumed_at IS NULL OR invalidated_at IS NULL),
  CHECK (invalidated_at IS NULL OR invalidation_reason IS NOT NULL)
);

CREATE TABLE public.auth_sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  access_token_hash text NOT NULL,
  refresh_token_hash text NOT NULL,
  access_expires_at timestamptz NOT NULL,
  refresh_expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revocation_reason text,
  rotated_from_session_id uuid REFERENCES public.auth_sessions(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_refreshed_at timestamptz,
  CHECK (access_expires_at > created_at),
  CHECK (refresh_expires_at > access_expires_at),
  CHECK (revoked_at IS NULL OR revocation_reason IS NOT NULL)
);

CREATE UNIQUE INDEX user_role_memberships_active_role_uniq
  ON public.user_role_memberships (user_id, role_code)
  WHERE revoked_at IS NULL;

CREATE INDEX otp_challenges_phone_request_window_idx
  ON public.otp_challenges (phone_lookup_hash, created_at DESC);

CREATE INDEX otp_challenges_requester_window_idx
  ON public.otp_challenges (requester_hash, created_at DESC);

CREATE INDEX otp_challenges_expiry_idx
  ON public.otp_challenges (expires_at, id)
  WHERE consumed_at IS NULL AND invalidated_at IS NULL;

CREATE UNIQUE INDEX auth_sessions_access_token_hash_uniq
  ON public.auth_sessions (access_token_hash);

CREATE UNIQUE INDEX auth_sessions_refresh_token_hash_uniq
  ON public.auth_sessions (refresh_token_hash);

CREATE INDEX auth_sessions_user_active_idx
  ON public.auth_sessions (user_id, refresh_expires_at DESC, id)
  WHERE revoked_at IS NULL;

COMMIT;
