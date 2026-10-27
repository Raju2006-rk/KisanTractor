BEGIN;

-- Cash and online payments use disjoint statuses, so cash is never labelled paid-online.
ALTER TABLE public.payments
  ADD CONSTRAINT payments_method_status_chk CHECK (
    (method = 'CASH' AND status IN ('PAID_CASH', 'REFUND_PENDING', 'REFUNDED'))
    OR (method = 'ONLINE' AND status IN ('PENDING', 'PAID_ONLINE', 'PAYMENT_FAILED', 'REFUND_PENDING', 'REFUNDED'))
  );

-- Online payments name their provider, and money counts as received only after provider verification.
ALTER TABLE public.payments
  ADD CONSTRAINT payments_online_verification_chk CHECK (
    method <> 'ONLINE'
    OR (
      provider IS NOT NULL
      AND (status IN ('PENDING', 'PAYMENT_FAILED') OR (verified_at IS NOT NULL AND provider_reference IS NOT NULL))
    )
  );

-- Payments are INR minor units only, matching invoices.
ALTER TABLE public.payments
  ADD CONSTRAINT payments_currency_inr_chk CHECK (currency = 'INR');

-- Every payment event belongs to the payment's own status trail.
ALTER TABLE public.payment_events
  ADD CONSTRAINT payment_events_status_change_chk CHECK (from_status IS DISTINCT FROM to_status);

COMMIT;
