BEGIN;

DROP INDEX IF EXISTS public.payment_refunds_resolved_reporting_idx;
DROP INDEX IF EXISTS public.payments_paid_reporting_idx;
DROP INDEX IF EXISTS public.invoices_created_reporting_idx;

COMMIT;
