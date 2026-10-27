BEGIN;

-- An invoice must link to an agreement version of the same booking.
CREATE UNIQUE INDEX booking_agreements_id_booking_uniq
  ON public.booking_agreements (id, booking_id);

ALTER TABLE public.invoices
  ADD CONSTRAINT invoices_agreement_same_booking_fk
  FOREIGN KEY (agreement_id, booking_id)
  REFERENCES public.booking_agreements (id, booking_id) ON DELETE RESTRICT;

-- Reissued invoices append a new version that names the version it supersedes.
ALTER TABLE public.invoices
  ADD CONSTRAINT invoices_supersession_chk CHECK (
    (invoice_version = 1 AND supersedes_invoice_id IS NULL)
    OR (invoice_version > 1 AND supersedes_invoice_id IS NOT NULL)
  );

CREATE UNIQUE INDEX invoices_supersedes_once_uniq
  ON public.invoices (supersedes_invoice_id)
  WHERE supersedes_invoice_id IS NOT NULL;

-- Every persisted trace carries the exact rational subtotal needed to reproduce the total.
ALTER TABLE public.invoices
  ADD CONSTRAINT invoices_rounding_trace_reproducible_chk CHECK (
    rounding_trace ? 'rawSubtotalNumerator'
    AND rounding_trace ? 'rawSubtotalDenominator'
    AND rounding_trace ? 'minorUnitRounding'
  );

COMMIT;
