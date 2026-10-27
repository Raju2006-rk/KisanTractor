BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TYPE account_status AS ENUM ('ACTIVE', 'SUSPENDED', 'DELETED');
CREATE TYPE verification_status AS ENUM ('UNVERIFIED', 'PENDING', 'VERIFIED', 'REJECTED');
CREATE TYPE location_source AS ENUM ('DEVICE_GPS', 'MAP_PIN', 'MAP_SEARCH', 'MANUAL_ADDRESS', 'SAVED_LOCATION');
CREATE TYPE operational_status AS ENUM ('ONLINE', 'OFFLINE');
CREATE TYPE eligibility_status AS ENUM ('INCOMPLETE', 'ELIGIBLE', 'INELIGIBLE');
CREATE TYPE document_status AS ENUM ('PENDING_UPLOAD', 'PENDING_SCAN', 'ACCEPTED', 'REJECTED', 'EXPIRED');
CREATE TYPE equipment_availability_status AS ENUM ('AVAILABLE', 'UNAVAILABLE', 'MAINTENANCE');
CREATE TYPE pricing_method AS ENUM ('HOURLY', 'PER_ACRE', 'PER_TRIP');
CREATE TYPE rounding_policy AS ENUM ('PROPORTIONAL_MINUTE', 'THIRTY_MINUTE_BLOCK', 'ONE_HOUR_BLOCK');
CREATE TYPE booking_status AS ENUM (
  'CREATED', 'PENDING_OWNER_RESPONSE', 'ACCEPTED', 'SCHEDULED', 'IN_PROGRESS',
  'WORK_COMPLETED', 'FINAL_BILL_GENERATED', 'PAYMENT_RECORDED', 'COMPLETED',
  'REJECTED', 'CANCELLED', 'EXPIRED', 'DISPUTED', 'REFUND_PENDING', 'REFUNDED'
);
CREATE TYPE actor_channel AS ENUM ('WEB', 'PWA', 'MOBILE', 'IVR', 'OPERATOR', 'SYSTEM', 'PROVIDER');
CREATE TYPE work_event_type AS ENUM ('START', 'PAUSE', 'RESUME', 'COMPLETE', 'CORRECTION');
CREATE TYPE measurement_unit AS ENUM ('MINUTE', 'ACRE', 'TRIP');
CREATE TYPE invoice_status AS ENUM ('ISSUED', 'DISPUTED', 'SETTLED', 'VOID');
CREATE TYPE payment_method AS ENUM ('CASH', 'ONLINE');
CREATE TYPE payment_status AS ENUM (
  'PENDING', 'AWAITING_FINAL_BILL', 'PAYMENT_DUE', 'PAID_ONLINE', 'PAID_CASH',
  'PAYMENT_FAILED', 'REFUND_PENDING', 'REFUNDED'
);
CREATE TYPE provider_event_status AS ENUM ('RECEIVED', 'VERIFIED', 'REJECTED', 'APPLIED');
CREATE TYPE notification_channel AS ENUM ('IN_APP', 'SMS', 'PUSH', 'IVR');
CREATE TYPE notification_status AS ENUM ('PENDING', 'PROCESSING', 'DELIVERED', 'FAILED', 'DEAD_LETTER');
CREATE TYPE ivr_session_status AS ENUM ('ACTIVE', 'COMPLETED', 'TRANSFERRED', 'TERMINATED', 'EXPIRED');
CREATE TYPE idempotency_status AS ENUM ('IN_PROGRESS', 'COMPLETED', 'FAILED');
CREATE TYPE outbox_status AS ENUM ('PENDING', 'PROCESSING', 'PUBLISHED', 'FAILED', 'DEAD_LETTER');

CREATE TABLE public.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  normalized_phone_ciphertext bytea NOT NULL,
  phone_lookup_hash text NOT NULL,
  status account_status NOT NULL DEFAULT 'ACTIVE',
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at timestamptz,
  CHECK (deleted_at IS NULL OR deleted_at >= created_at)
);

CREATE TABLE public.roles (
  code text PRIMARY KEY,
  description text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO public.roles (code, description) VALUES
  ('FARMER', 'Books agricultural tractor services'),
  ('OWNER', 'Owns tractors and fulfils bookings'),
  ('FUTURE_OPERATOR', 'Reserved for explicitly authorized assisted operations');

CREATE TABLE public.user_role_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  role_code text NOT NULL REFERENCES public.roles(code) ON DELETE RESTRICT,
  granted_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at timestamptz,
  granted_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  CHECK (revoked_at IS NULL OR revoked_at >= granted_at)
);

CREATE TABLE public.locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  coordinates geography(Point, 4326),
  state text NOT NULL,
  district text NOT NULL,
  mandal_or_taluk text NOT NULL,
  village text NOT NULL,
  postal_code text,
  landmark text,
  source location_source NOT NULL,
  accuracy_meters numeric(10, 2) CHECK (accuracy_meters IS NULL OR accuracy_meters >= 0),
  captured_at timestamptz NOT NULL,
  location_consent_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE public.user_profiles (
  user_id uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE RESTRICT,
  full_name text NOT NULL,
  preferred_locale text NOT NULL DEFAULT 'en',
  contact_sharing_consent boolean NOT NULL DEFAULT false,
  default_location_id uuid REFERENCES public.locations(id) ON DELETE SET NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (char_length(trim(full_name)) > 0)
);

CREATE TABLE public.owner_profiles (
  user_id uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE RESTRICT,
  operating_location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE RESTRICT,
  verification_status verification_status NOT NULL DEFAULT 'UNVERIFIED',
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE public.tractors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  brand text NOT NULL,
  model text NOT NULL,
  registration_number_ciphertext bytea NOT NULL,
  registration_lookup_hash text NOT NULL,
  manufacturing_year integer NOT NULL CHECK (manufacturing_year BETWEEN 1900 AND 2200),
  horsepower numeric(7, 2) CHECK (horsepower IS NULL OR horsepower > 0),
  operational_status operational_status NOT NULL DEFAULT 'OFFLINE',
  eligibility_status eligibility_status NOT NULL DEFAULT 'INCOMPLETE',
  current_location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE RESTRICT,
  location_updated_at timestamptz NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE public.equipment_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stable_code text NOT NULL,
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE public.services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stable_code text NOT NULL,
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE public.equipment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  tractor_id uuid REFERENCES public.tractors(id) ON DELETE RESTRICT,
  equipment_type_id uuid NOT NULL REFERENCES public.equipment_types(id) ON DELETE RESTRICT,
  display_name text NOT NULL,
  availability_status equipment_availability_status NOT NULL DEFAULT 'AVAILABLE',
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE public.documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  tractor_id uuid REFERENCES public.tractors(id) ON DELETE RESTRICT,
  equipment_id uuid REFERENCES public.equipment(id) ON DELETE RESTRICT,
  document_kind text NOT NULL,
  object_key text NOT NULL,
  declared_mime_type text NOT NULL,
  detected_mime_type text,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  content_digest text,
  scan_status document_status NOT NULL DEFAULT 'PENDING_UPLOAD',
  expires_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE public.service_offerings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tractor_id uuid NOT NULL REFERENCES public.tractors(id) ON DELETE RESTRICT,
  service_id uuid NOT NULL REFERENCES public.services(id) ON DELETE RESTRICT,
  equipment_id uuid REFERENCES public.equipment(id) ON DELETE RESTRICT,
  enabled boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE public.pricing_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_offering_id uuid NOT NULL REFERENCES public.service_offerings(id) ON DELETE RESTRICT,
  method pricing_method NOT NULL,
  rate_paise bigint NOT NULL CHECK (rate_paise > 0),
  currency char(3) NOT NULL DEFAULT 'INR',
  rounding_policy rounding_policy,
  minimum_quantity numeric(12, 3) CHECK (minimum_quantity IS NULL OR minimum_quantity >= 0),
  valid_from timestamptz NOT NULL,
  valid_to timestamptz,
  enabled boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  CHECK (
    (method = 'HOURLY' AND rounding_policy IS NOT NULL)
    OR (method <> 'HOURLY' AND rounding_policy IS NULL)
  )
);

CREATE TABLE public.tractor_availability (
  tractor_id uuid PRIMARY KEY REFERENCES public.tractors(id) ON DELETE RESTRICT,
  operational_status operational_status NOT NULL DEFAULT 'OFFLINE',
  reason text,
  effective_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  changed_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE public.tractor_availability_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tractor_id uuid NOT NULL REFERENCES public.tractors(id) ON DELETE RESTRICT,
  from_status operational_status,
  to_status operational_status NOT NULL,
  reason text,
  actor_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  actor_channel actor_channel NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE public.bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_reference text NOT NULL,
  customer_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  owner_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  tractor_id uuid NOT NULL REFERENCES public.tractors(id) ON DELETE RESTRICT,
  service_offering_id uuid NOT NULL REFERENCES public.service_offerings(id) ON DELETE RESTRICT,
  requested_start_at timestamptz NOT NULL,
  requested_end_at timestamptz NOT NULL,
  expected_quantity numeric(12, 3) CHECK (expected_quantity IS NULL OR expected_quantity >= 0),
  status booking_status NOT NULL DEFAULT 'CREATED',
  current_agreement_id uuid,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (requested_start_at < requested_end_at)
);

CREATE TABLE public.booking_recipients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL REFERENCES public.bookings(id) ON DELETE RESTRICT,
  name text NOT NULL,
  phone_ciphertext bytea,
  phone_lookup_hash text,
  coordination_consent boolean NOT NULL DEFAULT false,
  service_location_snapshot jsonb NOT NULL,
  landmark_or_directions text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (char_length(trim(name)) > 0),
  CHECK (jsonb_typeof(service_location_snapshot) = 'object')
);

CREATE TABLE public.booking_agreements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL REFERENCES public.bookings(id) ON DELETE RESTRICT,
  agreement_version integer NOT NULL CHECK (agreement_version > 0),
  pricing_rule_id uuid NOT NULL REFERENCES public.pricing_rules(id) ON DELETE RESTRICT,
  pricing_rule_version integer NOT NULL CHECK (pricing_rule_version > 0),
  method pricing_method NOT NULL,
  rate_paise bigint NOT NULL CHECK (rate_paise > 0),
  currency char(3) NOT NULL DEFAULT 'INR',
  rounding_policy rounding_policy,
  estimated_quantity numeric(12, 3) NOT NULL CHECK (estimated_quantity >= 0),
  estimated_total_paise bigint NOT NULL CHECK (estimated_total_paise >= 0),
  service_location_snapshot jsonb NOT NULL,
  change_reason text,
  approved_by_customer_at timestamptz,
  approved_by_owner_at timestamptz,
  disclosed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (booking_id, agreement_version),
  CHECK (jsonb_typeof(service_location_snapshot) = 'object'),
  CHECK (
    (method = 'HOURLY' AND rounding_policy IS NOT NULL)
    OR (method <> 'HOURLY' AND rounding_policy IS NULL)
  )
);

ALTER TABLE public.bookings
  ADD CONSTRAINT bookings_current_agreement_fk
  FOREIGN KEY (current_agreement_id) REFERENCES public.booking_agreements(id) ON DELETE RESTRICT;

CREATE TABLE public.booking_status_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL REFERENCES public.bookings(id) ON DELETE RESTRICT,
  from_status booking_status,
  to_status booking_status NOT NULL,
  actor_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  actor_channel actor_channel NOT NULL,
  reason text,
  occurred_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE public.work_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL REFERENCES public.bookings(id) ON DELETE RESTRICT,
  event_type work_event_type NOT NULL,
  effective_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  device_observed_at timestamptz,
  actor_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  actor_channel actor_channel NOT NULL,
  idempotency_key text NOT NULL,
  correction_of_id uuid REFERENCES public.work_events(id) ON DELETE RESTRICT,
  reason text,
  CHECK (
    (correction_of_id IS NULL AND event_type <> 'CORRECTION')
    OR (correction_of_id IS NOT NULL AND event_type = 'CORRECTION' AND reason IS NOT NULL)
  )
);

CREATE TABLE public.work_measurements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL REFERENCES public.bookings(id) ON DELETE RESTRICT,
  method pricing_method NOT NULL,
  quantity numeric(12, 3) NOT NULL CHECK (quantity >= 0),
  unit measurement_unit NOT NULL,
  submitted_by_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  correction_of_id uuid REFERENCES public.work_measurements(id) ON DELETE RESTRICT,
  reason text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (correction_of_id IS NULL OR reason IS NOT NULL),
  CHECK (
    (method = 'HOURLY' AND unit = 'MINUTE')
    OR (method = 'PER_ACRE' AND unit = 'ACRE')
    OR (method = 'PER_TRIP' AND unit = 'TRIP' AND quantity = trunc(quantity))
  )
);

CREATE TABLE public.invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL REFERENCES public.bookings(id) ON DELETE RESTRICT,
  supersedes_invoice_id uuid REFERENCES public.invoices(id) ON DELETE RESTRICT,
  agreement_id uuid NOT NULL REFERENCES public.booking_agreements(id) ON DELETE RESTRICT,
  invoice_version integer NOT NULL CHECK (invoice_version > 0),
  status invoice_status NOT NULL DEFAULT 'ISSUED',
  rate_paise bigint NOT NULL CHECK (rate_paise > 0),
  currency char(3) NOT NULL DEFAULT 'INR',
  billable_quantity numeric(12, 3) NOT NULL CHECK (billable_quantity >= 0),
  subtotal_paise bigint NOT NULL CHECK (subtotal_paise >= 0),
  adjustments_paise bigint NOT NULL DEFAULT 0,
  total_paise bigint NOT NULL CHECK (total_paise >= 0),
  evidence_references jsonb NOT NULL DEFAULT '[]'::jsonb,
  calculation_formula text NOT NULL,
  rounding_trace jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (booking_id, invoice_version),
  CHECK (jsonb_typeof(evidence_references) = 'array'),
  CHECK (jsonb_typeof(rounding_trace) = 'object'),
  CHECK (total_paise = subtotal_paise + adjustments_paise)
);

CREATE TABLE public.payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES public.invoices(id) ON DELETE RESTRICT,
  method payment_method NOT NULL,
  status payment_status NOT NULL DEFAULT 'PENDING',
  amount_paise bigint NOT NULL CHECK (amount_paise > 0),
  currency char(3) NOT NULL DEFAULT 'INR',
  provider text,
  provider_reference text,
  recorded_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  received_at timestamptz,
  verified_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (
    (method = 'CASH' AND recorded_by_user_id IS NOT NULL AND received_at IS NOT NULL AND provider_reference IS NULL)
    OR method = 'ONLINE'
  )
);

CREATE TABLE public.payment_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id uuid NOT NULL REFERENCES public.payments(id) ON DELETE RESTRICT,
  event_type text NOT NULL,
  from_status payment_status,
  to_status payment_status NOT NULL,
  amount_paise bigint CHECK (amount_paise IS NULL OR amount_paise > 0),
  actor_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  actor_channel actor_channel NOT NULL,
  reason text,
  occurred_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE public.provider_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id uuid REFERENCES public.payments(id) ON DELETE RESTRICT,
  provider text NOT NULL,
  provider_event_id text NOT NULL,
  provider_reference text,
  event_type text NOT NULL,
  status provider_event_status NOT NULL DEFAULT 'RECEIVED',
  signature_verified boolean NOT NULL DEFAULT false,
  amount_paise bigint CHECK (amount_paise IS NULL OR amount_paise >= 0),
  currency char(3),
  payload_digest text NOT NULL,
  occurred_at timestamptz,
  received_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  applied_at timestamptz
);

CREATE TABLE public.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  booking_id uuid REFERENCES public.bookings(id) ON DELETE RESTRICT,
  channel notification_channel NOT NULL,
  status notification_status NOT NULL DEFAULT 'PENDING',
  template_key text NOT NULL,
  template_locale text NOT NULL,
  related_entity_type text NOT NULL,
  related_entity_id uuid NOT NULL,
  provider_reference text,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE public.notification_delivery_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id uuid NOT NULL REFERENCES public.notifications(id) ON DELETE RESTRICT,
  from_status notification_status,
  to_status notification_status NOT NULL,
  provider_reference text,
  error_code text,
  occurred_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE public.ivr_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  provider_call_id text NOT NULL,
  caller_phone_ciphertext bytea NOT NULL,
  caller_phone_lookup_hash text NOT NULL,
  verified_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  locale text NOT NULL DEFAULT 'en',
  prompt_tree_version integer NOT NULL CHECK (prompt_tree_version > 0),
  prompt_version integer NOT NULL DEFAULT 1 CHECK (prompt_version > 0),
  state text NOT NULL,
  retry_count integer NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  status ivr_session_status NOT NULL DEFAULT 'ACTIVE',
  booking_id uuid REFERENCES public.bookings(id) ON DELETE RESTRICT,
  expires_at timestamptz NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (expires_at > created_at)
);

CREATE TABLE public.idempotency_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_scope text NOT NULL,
  idempotency_key text NOT NULL,
  request_digest text NOT NULL,
  status idempotency_status NOT NULL DEFAULT 'IN_PROGRESS',
  response_status integer,
  response_body jsonb,
  resource_type text,
  resource_id uuid,
  expires_at timestamptz NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (expires_at > created_at)
);

CREATE TABLE public.audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  actor_channel actor_channel NOT NULL,
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id uuid,
  outcome text NOT NULL,
  reason_code text,
  correlation_id text NOT NULL,
  pii_safe_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (jsonb_typeof(pii_safe_metadata) = 'object')
);

CREATE TABLE public.outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  event_type text NOT NULL,
  event_version integer NOT NULL CHECK (event_version > 0),
  payload jsonb NOT NULL,
  status outbox_status NOT NULL DEFAULT 'PENDING',
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  locked_at timestamptz,
  locked_by text,
  published_at timestamptz,
  last_error_code text,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (jsonb_typeof(payload) = 'object')
);

CREATE FUNCTION public.reject_append_only_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER tractor_availability_history_append_only
  BEFORE UPDATE OR DELETE ON public.tractor_availability_history
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_mutation();
CREATE TRIGGER booking_recipients_append_only
  BEFORE UPDATE OR DELETE ON public.booking_recipients
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_mutation();
CREATE TRIGGER booking_agreements_append_only
  BEFORE UPDATE OR DELETE ON public.booking_agreements
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_mutation();
CREATE TRIGGER booking_status_history_append_only
  BEFORE UPDATE OR DELETE ON public.booking_status_history
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_mutation();
CREATE TRIGGER work_events_append_only
  BEFORE UPDATE OR DELETE ON public.work_events
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_mutation();
CREATE TRIGGER work_measurements_append_only
  BEFORE UPDATE OR DELETE ON public.work_measurements
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_mutation();
CREATE TRIGGER invoices_append_only
  BEFORE UPDATE OR DELETE ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_mutation();
CREATE TRIGGER payment_events_append_only
  BEFORE UPDATE OR DELETE ON public.payment_events
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_mutation();
CREATE TRIGGER provider_events_append_only
  BEFORE UPDATE OR DELETE ON public.provider_events
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_mutation();
CREATE TRIGGER notification_delivery_events_append_only
  BEFORE UPDATE OR DELETE ON public.notification_delivery_events
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_mutation();
CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE ON public.audit_events
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_mutation();

COMMIT;
