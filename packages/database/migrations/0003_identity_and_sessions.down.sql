BEGIN;

DROP INDEX IF EXISTS public.auth_sessions_user_active_idx;
DROP INDEX IF EXISTS public.auth_sessions_refresh_token_hash_uniq;
DROP INDEX IF EXISTS public.auth_sessions_access_token_hash_uniq;
DROP INDEX IF EXISTS public.otp_challenges_expiry_idx;
DROP INDEX IF EXISTS public.otp_challenges_requester_window_idx;
DROP INDEX IF EXISTS public.otp_challenges_phone_request_window_idx;
DROP INDEX IF EXISTS public.user_role_memberships_active_role_uniq;

DROP TABLE IF EXISTS public.auth_sessions;
DROP TABLE IF EXISTS public.otp_challenges;
DROP TYPE IF EXISTS otp_purpose;

COMMIT;
