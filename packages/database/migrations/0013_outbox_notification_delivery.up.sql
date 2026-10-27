BEGIN;

-- Honest, provider-independent delivery states. SENT means a live provider
-- accepted the message, SANDBOX_SENT is test-only, and NOT_SENT records that no
-- external attempt happened (for example an unconfigured channel). These values
-- are added only; nothing below uses them in this transaction.
ALTER TYPE notification_status ADD VALUE IF NOT EXISTS 'SENT';
ALTER TYPE notification_status ADD VALUE IF NOT EXISTS 'SANDBOX_SENT';
ALTER TYPE notification_status ADD VALUE IF NOT EXISTS 'NOT_SENT';

ALTER TABLE public.notifications
  ADD COLUMN outbox_event_id uuid REFERENCES public.outbox_events(id) ON DELETE RESTRICT,
  ADD COLUMN dedupe_key text,
  ADD COLUMN capability_state text,
  ADD COLUMN test_only boolean NOT NULL DEFAULT false,
  ADD COLUMN last_error_code text;

ALTER TABLE public.notifications
  ADD CONSTRAINT notifications_capability_state_chk CHECK (
    capability_state IS NULL OR capability_state IN ('UNCONFIGURED', 'SANDBOX', 'LIVE', 'DEGRADED')
  );

-- Sandbox results are always labelled test-only, and only sandbox results are.
ALTER TABLE public.notifications
  ADD CONSTRAINT notifications_sandbox_test_only_chk CHECK (
    test_only = (capability_state IS NOT DISTINCT FROM 'SANDBOX')
  );

ALTER TABLE public.notifications
  ADD CONSTRAINT notifications_template_locale_chk CHECK (
    template_locale IN ('en', 'hi', 'te', 'kn', 'ta')
  );

-- One notification per outbox event, template, channel, and recipient.
CREATE UNIQUE INDEX notifications_dedupe_key_uniq
  ON public.notifications (dedupe_key)
  WHERE dedupe_key IS NOT NULL;

CREATE INDEX notifications_related_entity_cursor_idx
  ON public.notifications (related_entity_type, related_entity_id, created_at DESC, id DESC);

ALTER TABLE public.outbox_events
  ADD COLUMN dead_lettered_at timestamptz;

-- A claimed event always names its lease holder and lease start.
ALTER TABLE public.outbox_events
  ADD CONSTRAINT outbox_events_lease_chk CHECK (
    status <> 'PROCESSING' OR (locked_at IS NOT NULL AND locked_by IS NOT NULL)
  );

-- Lets workers reclaim events whose lease expired after a crash.
CREATE INDEX outbox_events_expired_lease_idx
  ON public.outbox_events (locked_at, id)
  WHERE status = 'PROCESSING';

COMMIT;
