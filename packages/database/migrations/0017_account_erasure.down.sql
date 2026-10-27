BEGIN;
-- Rows already redacted stay redacted; rollback only restores the strict append-only trigger.
CREATE OR REPLACE TRIGGER booking_recipients_append_only
  BEFORE UPDATE OR DELETE ON public.booking_recipients
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_mutation();
DROP FUNCTION IF EXISTS public.guard_booking_recipient_mutation();
COMMIT;
