BEGIN;

ALTER TABLE public.invoices DROP CONSTRAINT IF EXISTS invoices_rounding_trace_reproducible_chk;
DROP INDEX IF EXISTS public.invoices_supersedes_once_uniq;
ALTER TABLE public.invoices DROP CONSTRAINT IF EXISTS invoices_supersession_chk;
ALTER TABLE public.invoices DROP CONSTRAINT IF EXISTS invoices_agreement_same_booking_fk;
DROP INDEX IF EXISTS public.booking_agreements_id_booking_uniq;

COMMIT;
