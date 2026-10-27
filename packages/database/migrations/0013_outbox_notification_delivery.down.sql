BEGIN;

DROP INDEX IF EXISTS public.outbox_events_expired_lease_idx;
ALTER TABLE public.outbox_events DROP CONSTRAINT IF EXISTS outbox_events_lease_chk;
ALTER TABLE public.outbox_events DROP COLUMN IF EXISTS dead_lettered_at;

DROP INDEX IF EXISTS public.notifications_related_entity_cursor_idx;
DROP INDEX IF EXISTS public.notifications_dedupe_key_uniq;
ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_template_locale_chk;
ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_sandbox_test_only_chk;
ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_capability_state_chk;
ALTER TABLE public.notifications
  DROP COLUMN IF EXISTS last_error_code,
  DROP COLUMN IF EXISTS test_only,
  DROP COLUMN IF EXISTS capability_state,
  DROP COLUMN IF EXISTS dedupe_key,
  DROP COLUMN IF EXISTS outbox_event_id;

-- PostgreSQL cannot drop enum values, so the type is rebuilt. The previous type
-- cannot represent SENT, SANDBOX_SENT, or NOT_SENT; they become FAILED so a
-- rollback never upgrades a record into a delivery claim.
ALTER TABLE public.notifications ALTER COLUMN status DROP DEFAULT;
ALTER TYPE notification_status RENAME TO notification_status_0013;
CREATE TYPE notification_status AS ENUM ('PENDING', 'PROCESSING', 'DELIVERED', 'FAILED', 'DEAD_LETTER');

ALTER TABLE public.notifications
  ALTER COLUMN status TYPE notification_status
  USING (CASE WHEN status::text IN ('SENT', 'SANDBOX_SENT', 'NOT_SENT') THEN 'FAILED' ELSE status::text END)::notification_status;
ALTER TABLE public.notifications ALTER COLUMN status SET DEFAULT 'PENDING';

ALTER TABLE public.notification_delivery_events
  ALTER COLUMN from_status TYPE notification_status
  USING (CASE WHEN from_status::text IN ('SENT', 'SANDBOX_SENT', 'NOT_SENT') THEN 'FAILED' ELSE from_status::text END)::notification_status,
  ALTER COLUMN to_status TYPE notification_status
  USING (CASE WHEN to_status::text IN ('SENT', 'SANDBOX_SENT', 'NOT_SENT') THEN 'FAILED' ELSE to_status::text END)::notification_status;

DROP TYPE notification_status_0013;

COMMIT;
