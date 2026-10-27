BEGIN;

-- Refuse rollback while expanded-locale notification records exist instead of
-- silently rewriting their locale or deleting delivery history.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.notifications WHERE template_locale IN ('mr', 'bn')
  ) THEN
    RAISE EXCEPTION 'Cannot roll back expanded notification locales while Marathi or Bengali notifications exist';
  END IF;
END
$$;

ALTER TABLE public.notifications
  DROP CONSTRAINT notifications_template_locale_chk;

ALTER TABLE public.notifications
  ADD CONSTRAINT notifications_template_locale_chk CHECK (
    template_locale IN ('en', 'hi', 'te', 'kn', 'ta')
  );

COMMIT;
