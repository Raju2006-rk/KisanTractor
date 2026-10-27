BEGIN;

-- Support and dispute resolution (task 16.5, Requirements 1.4, 10.8, 12.4).

-- One review case per dispute of a booking's bill. A resolution that reopens settlement lets the
-- Farmer dispute again, so a booking can have several cases but at most one OPEN case. Cases are
-- part of the financial and audit record: they are never deleted, including on account deletion.
CREATE TABLE public.support_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL REFERENCES public.bookings(id) ON DELETE RESTRICT,
  disputed_invoice_id uuid NOT NULL REFERENCES public.invoices(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'RESOLVED')),
  opened_at timestamptz NOT NULL,
  -- Explicit, versioned outcomes; the reason is a code, never free text.
  resolution_outcome text CHECK (resolution_outcome IN ('UPHOLD', 'ADJUST', 'REFUND', 'CANCEL')),
  resolution_rules_version integer CHECK (resolution_rules_version > 0),
  resolution_reason_code text CHECK (resolution_reason_code ~ '^[A-Z0-9_]{1,64}$'),
  resolved_invoice_id uuid REFERENCES public.invoices(id) ON DELETE RESTRICT,
  payment_refund_id uuid REFERENCES public.payment_refunds(id) ON DELETE RESTRICT,
  resolved_by_user_id uuid REFERENCES public.users(id) ON DELETE RESTRICT,
  resolved_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT support_cases_resolution_chk CHECK (
    (status = 'OPEN') = (resolved_at IS NULL)
    AND (status = 'OPEN') = (resolution_outcome IS NULL)
    AND (status = 'OPEN') = (resolution_rules_version IS NULL)
    AND (status = 'OPEN') = (resolution_reason_code IS NULL)
  ),
  CONSTRAINT support_cases_refund_chk CHECK (
    (payment_refund_id IS NOT NULL) = (resolution_outcome IS NOT DISTINCT FROM 'REFUND')
  )
);

CREATE UNIQUE INDEX support_cases_one_open_per_booking_uniq
  ON public.support_cases (booking_id)
  WHERE status = 'OPEN';
CREATE UNIQUE INDEX support_cases_id_booking_uniq
  ON public.support_cases (id, booking_id);
CREATE INDEX support_cases_booking_recent_idx
  ON public.support_cases (booking_id, opened_at DESC, id DESC);

-- The case timeline: party statements, evidence references, support notes, and system entries,
-- appended in order. Entries carry codes and record ids. The only free text is an optional
-- statement (statement_text) that may hold personal data: it is never logged, audited, or put in
-- the outbox, and account deletion erases it (statement_redacted_at) while keeping the entry.
CREATE TABLE public.support_case_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES public.support_cases(id) ON DELETE RESTRICT,
  entry_type text NOT NULL CHECK (entry_type IN ('OPENED', 'PARTY_STATEMENT', 'EVIDENCE_REFERENCE', 'SUPPORT_NOTE', 'RESOLVED')),
  author_role text NOT NULL CHECK (author_role IN ('FARMER', 'OWNER', 'SUPPORT', 'SYSTEM')),
  author_user_id uuid REFERENCES public.users(id) ON DELETE RESTRICT,
  statement_code text NOT NULL CHECK (statement_code ~ '^[A-Z0-9_]{1,64}$'),
  statement_text text CHECK (statement_text IS NULL OR char_length(statement_text) BETWEEN 1 AND 500),
  statement_redacted_at timestamptz,
  evidence_kind text CHECK (evidence_kind IN ('INVOICE', 'WORK_EVENT', 'WORK_MEASUREMENT', 'PAYMENT')),
  evidence_id uuid,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT support_case_entries_evidence_chk CHECK (
    (evidence_kind IS NULL) = (evidence_id IS NULL)
    AND (entry_type <> 'EVIDENCE_REFERENCE' OR evidence_id IS NOT NULL)
  ),
  CONSTRAINT support_case_entries_redaction_chk CHECK (statement_redacted_at IS NULL OR statement_text IS NULL)
);

CREATE INDEX support_case_entries_case_timeline_idx
  ON public.support_case_entries (case_id, occurred_at, id);
CREATE INDEX support_case_entries_author_idx
  ON public.support_case_entries (author_user_id)
  WHERE author_user_id IS NOT NULL;

-- Explicit, time-bounded, least-privilege support access: one FUTURE_OPERATOR account may read
-- (READ) or read and resolve (RESOLVE) one case's booking between valid_from and expires_at.
-- Issued and revoked only through the admin CLI with a change-ticket reference; at most 7 days.
CREATE TABLE public.support_access_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL,
  booking_id uuid NOT NULL,
  operator_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  scope text NOT NULL CHECK (scope IN ('READ', 'RESOLVE')),
  ticket_reference text NOT NULL CHECK (ticket_reference ~ '^[A-Za-z0-9][A-Za-z0-9-]{2,39}$'),
  issued_via text NOT NULL CHECK (issued_via IN ('ADMIN_CLI')),
  valid_from timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT support_access_grants_case_booking_fk
    FOREIGN KEY (case_id, booking_id) REFERENCES public.support_cases (id, booking_id) ON DELETE RESTRICT,
  CONSTRAINT support_access_grants_window_chk CHECK (
    expires_at > valid_from AND expires_at <= valid_from + interval '7 days'
  )
);

CREATE INDEX support_access_grants_operator_booking_idx
  ON public.support_access_grants (operator_user_id, booking_id, expires_at)
  WHERE revoked_at IS NULL;
CREATE INDEX support_access_grants_case_idx
  ON public.support_access_grants (case_id);

COMMIT;
