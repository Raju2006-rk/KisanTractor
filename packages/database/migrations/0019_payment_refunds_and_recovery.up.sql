BEGIN;

-- Online refunds, pending-intent recovery, and reconciliation (task 16.2, Requirements 11.1, 11.7, 11.8, 12.4).

CREATE TYPE payment_refund_status AS ENUM ('REQUESTED', 'SUBMITTED', 'PROCESSED', 'FAILED');
CREATE TYPE provider_evidence_source AS ENUM ('WEBHOOK', 'PROVIDER_API');

-- The captured provider payment (for example a Razorpay pay_ id) a refund reverses. One captured
-- provider payment settles at most one payment record. NULLs stay distinct, so cash rows and
-- pending intents (no capture yet) never collide.
ALTER TABLE public.payments ADD COLUMN provider_payment_id text;
CREATE UNIQUE INDEX payments_provider_payment_id_uniq
  ON public.payments (provider_payment_id);

-- Whether an online intent was created against a provider sandbox or a live provider, so test
-- money stays labelled as test money after the environment changes mode.
ALTER TABLE public.payments ADD COLUMN provider_mode text
  CONSTRAINT payments_provider_mode_chk CHECK (provider_mode IS NULL OR provider_mode IN ('SANDBOX', 'LIVE'));

-- When reconciliation last asked the provider about a pending intent; recovery visits the
-- least recently checked intents first, so one stuck intent cannot starve the others.
ALTER TABLE public.payments ADD COLUMN reconciled_at timestamptz;
CREATE INDEX payments_pending_online_recovery_idx
  ON public.payments (reconciled_at NULLS FIRST, created_at, id)
  WHERE method = 'ONLINE' AND status = 'PENDING';

-- One refund request per row. Full refunds only: the amount equals the payment amount, and at most
-- one refund per payment can be in flight or processed, so a payment is never refunded twice.
CREATE TABLE public.payment_refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id uuid NOT NULL REFERENCES public.payments(id) ON DELETE RESTRICT,
  provider text NOT NULL,
  provider_payment_id text NOT NULL,
  provider_refund_id text,
  -- Sent to the provider as its idempotency key and receipt; derived from the refund id.
  refund_key text NOT NULL UNIQUE CHECK (refund_key ~ '^[A-Za-z0-9_-]{10,40}$'),
  amount_paise bigint NOT NULL CHECK (amount_paise > 0),
  currency char(3) NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
  status payment_refund_status NOT NULL DEFAULT 'REQUESTED',
  -- A reason code, never free text, so refund records carry no personal data.
  reason_code text NOT NULL CHECK (reason_code IN ('DISPUTE_RESOLVED', 'DUPLICATE_PAYMENT', 'SERVICE_NOT_DELIVERED', 'OTHER')),
  requested_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  requested_by_role text NOT NULL CHECK (requested_by_role IN ('SUPPORT', 'SYSTEM')),
  submit_attempts integer NOT NULL DEFAULT 0 CHECK (submit_attempts >= 0),
  last_error_code text CHECK (last_error_code IS NULL OR last_error_code ~ '^[A-Z0-9_]{1,64}$'),
  requested_at timestamptz NOT NULL,
  submitted_at timestamptz,
  resolved_at timestamptz,
  checked_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ((status IN ('SUBMITTED', 'PROCESSED')) <= (provider_refund_id IS NOT NULL)),
  CHECK ((status IN ('PROCESSED', 'FAILED')) = (resolved_at IS NOT NULL))
);

CREATE UNIQUE INDEX payment_refunds_provider_refund_uniq
  ON public.payment_refunds (provider, provider_refund_id)
  WHERE provider_refund_id IS NOT NULL;
CREATE UNIQUE INDEX payment_refunds_one_open_or_processed_uniq
  ON public.payment_refunds (payment_id)
  WHERE status IN ('REQUESTED', 'SUBMITTED', 'PROCESSED');
CREATE INDEX payment_refunds_reconciliation_idx
  ON public.payment_refunds (checked_at NULLS FIRST, requested_at, id)
  WHERE status IN ('REQUESTED', 'SUBMITTED');
CREATE INDEX payment_refunds_payment_idx
  ON public.payment_refunds (payment_id, created_at DESC, id DESC);

-- Provider evidence is either a signed webhook or an authenticated provider API read made by the
-- server (reconciliation, status checks, refund submission). Existing rows are webhooks.
ALTER TABLE public.provider_events
  ADD COLUMN evidence_source provider_evidence_source NOT NULL DEFAULT 'WEBHOOK';
ALTER TABLE public.provider_events
  ADD COLUMN payment_refund_id uuid REFERENCES public.payment_refunds(id) ON DELETE RESTRICT;

COMMIT;
