BEGIN;

ALTER TABLE public.provider_events DROP COLUMN IF EXISTS payment_refund_id;
ALTER TABLE public.provider_events DROP COLUMN IF EXISTS evidence_source;

DROP TABLE IF EXISTS public.payment_refunds;

DROP INDEX IF EXISTS public.payments_pending_online_recovery_idx;
ALTER TABLE public.payments DROP COLUMN IF EXISTS reconciled_at;
ALTER TABLE public.payments DROP COLUMN IF EXISTS provider_mode;
DROP INDEX IF EXISTS public.payments_provider_payment_id_uniq;
ALTER TABLE public.payments DROP COLUMN IF EXISTS provider_payment_id;

DROP TYPE IF EXISTS provider_evidence_source;
DROP TYPE IF EXISTS payment_refund_status;

COMMIT;
