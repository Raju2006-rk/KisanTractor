BEGIN;

-- Task 19.2: bounded Owner reports join from the Owner to immutable invoices and payment records.
-- These are query indexes only; no mutable earnings total or second financial ledger is created.
CREATE INDEX invoices_created_reporting_idx
  ON public.invoices (created_at, booking_id, invoice_version DESC)
  INCLUDE (status, total_paise);

CREATE INDEX payments_paid_reporting_idx
  ON public.payments ((CASE WHEN method = 'CASH' THEN received_at ELSE verified_at END), invoice_id)
  INCLUDE (method, status, amount_paise)
  WHERE status IN ('PAID_CASH', 'PAID_ONLINE', 'REFUND_PENDING', 'REFUNDED');

CREATE INDEX payment_refunds_resolved_reporting_idx
  ON public.payment_refunds (resolved_at, payment_id)
  INCLUDE (amount_paise)
  WHERE status = 'PROCESSED';

COMMIT;
