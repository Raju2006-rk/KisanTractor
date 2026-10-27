BEGIN;

ALTER TABLE public.payment_events DROP CONSTRAINT IF EXISTS payment_events_status_change_chk;
ALTER TABLE public.payments DROP CONSTRAINT IF EXISTS payments_currency_inr_chk;
ALTER TABLE public.payments DROP CONSTRAINT IF EXISTS payments_online_verification_chk;
ALTER TABLE public.payments DROP CONSTRAINT IF EXISTS payments_method_status_chk;

COMMIT;
