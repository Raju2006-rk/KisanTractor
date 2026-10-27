BEGIN;

-- Widen the persisted notification locale allowlist for the Phase 4 Marathi
-- and Bengali catalog expansion. Existing values and rows remain valid.
ALTER TABLE public.notifications
  DROP CONSTRAINT notifications_template_locale_chk;

ALTER TABLE public.notifications
  ADD CONSTRAINT notifications_template_locale_chk CHECK (
    template_locale IN ('en', 'hi', 'te', 'kn', 'ta', 'mr', 'bn')
  );

COMMIT;
