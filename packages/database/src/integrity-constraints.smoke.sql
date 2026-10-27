\set ON_ERROR_STOP on

INSERT INTO public.locations (
  id, state, district, mandal_or_taluk, village, source, captured_at
) VALUES (
  '10000000-0000-0000-0000-000000000001',
  'Telangana', 'Warangal', 'Hanamkonda', 'Test Village', 'MANUAL_ADDRESS', CURRENT_TIMESTAMP
);

INSERT INTO public.users (
  id, normalized_phone_ciphertext, phone_lookup_hash
) VALUES
  ('20000000-0000-0000-0000-000000000001', decode('01', 'hex'), 'farmer-phone-hash'),
  ('20000000-0000-0000-0000-000000000002', decode('02', 'hex'), 'owner-phone-hash');

INSERT INTO public.services (id, stable_code, display_name) VALUES
  ('30000000-0000-0000-0000-000000000001', 'PLOUGHING', 'Ploughing');

INSERT INTO public.tractors (
  id, owner_id, brand, model, registration_number_ciphertext,
  registration_lookup_hash, manufacturing_year, current_location_id,
  location_updated_at
) VALUES (
  '40000000-0000-0000-0000-000000000001',
  '20000000-0000-0000-0000-000000000002',
  'Test Brand', 'Test Model', decode('03', 'hex'), 'tractor-registration-hash',
  2024, '10000000-0000-0000-0000-000000000001', CURRENT_TIMESTAMP
);

INSERT INTO public.service_offerings (
  id, tractor_id, service_id, enabled
) VALUES (
  '50000000-0000-0000-0000-000000000001',
  '40000000-0000-0000-0000-000000000001',
  '30000000-0000-0000-0000-000000000001',
  true
);

DO $$
BEGIN
  INSERT INTO public.users (
    normalized_phone_ciphertext, phone_lookup_hash
  ) VALUES (decode('04', 'hex'), 'farmer-phone-hash');
  RAISE EXCEPTION 'active phone lookup hash uniqueness was not enforced';
EXCEPTION WHEN unique_violation THEN
  NULL;
END;
$$;

INSERT INTO public.users (
  normalized_phone_ciphertext, phone_lookup_hash, status, deleted_at
) VALUES (
  decode('05', 'hex'), 'farmer-phone-hash', 'DELETED', CURRENT_TIMESTAMP
);

DO $$
BEGIN
  INSERT INTO public.tractors (
    owner_id, brand, model, registration_number_ciphertext,
    registration_lookup_hash, manufacturing_year, current_location_id,
    location_updated_at
  ) VALUES (
    '20000000-0000-0000-0000-000000000002',
    'Other Brand', 'Other Model', decode('06', 'hex'), 'tractor-registration-hash',
    2023, '10000000-0000-0000-0000-000000000001', CURRENT_TIMESTAMP
  );
  RAISE EXCEPTION 'registration lookup hash uniqueness was not enforced';
EXCEPTION WHEN unique_violation THEN
  NULL;
END;
$$;

INSERT INTO public.bookings (
  id, public_reference, customer_id, owner_id, tractor_id, service_offering_id,
  requested_start_at, requested_end_at, status
) VALUES
  (
    '60000000-0000-0000-0000-000000000001', 'KT-TEST-001',
    '20000000-0000-0000-0000-000000000001',
    '20000000-0000-0000-0000-000000000002',
    '40000000-0000-0000-0000-000000000001',
    '50000000-0000-0000-0000-000000000001',
    '2030-01-01 10:00:00+00', '2030-01-01 11:00:00+00', 'ACCEPTED'
  ),
  (
    '60000000-0000-0000-0000-000000000002', 'KT-TEST-002',
    '20000000-0000-0000-0000-000000000001',
    '20000000-0000-0000-0000-000000000002',
    '40000000-0000-0000-0000-000000000001',
    '50000000-0000-0000-0000-000000000001',
    '2030-01-01 11:00:00+00', '2030-01-01 12:00:00+00', 'SCHEDULED'
  ),
  (
    '60000000-0000-0000-0000-000000000003', 'KT-TEST-003',
    '20000000-0000-0000-0000-000000000001',
    '20000000-0000-0000-0000-000000000002',
    '40000000-0000-0000-0000-000000000001',
    '50000000-0000-0000-0000-000000000001',
    '2030-01-01 10:30:00+00', '2030-01-01 11:30:00+00', 'PENDING_OWNER_RESPONSE'
  );

DO $$
BEGIN
  INSERT INTO public.bookings (
    public_reference, customer_id, owner_id, tractor_id, service_offering_id,
    requested_start_at, requested_end_at, status
  ) VALUES (
    'KT-TEST-OVERLAP',
    '20000000-0000-0000-0000-000000000001',
    '20000000-0000-0000-0000-000000000002',
    '40000000-0000-0000-0000-000000000001',
    '50000000-0000-0000-0000-000000000001',
    '2030-01-01 10:30:00+00', '2030-01-01 11:30:00+00', 'IN_PROGRESS'
  );
  RAISE EXCEPTION 'overlapping blocking booking was not rejected';
EXCEPTION WHEN exclusion_violation THEN
  NULL;
END;
$$;

DO $$
BEGIN
  INSERT INTO public.bookings (
    public_reference, customer_id, owner_id, tractor_id, service_offering_id,
    requested_start_at, requested_end_at
  ) VALUES (
    'KT-TEST-001',
    '20000000-0000-0000-0000-000000000001',
    '20000000-0000-0000-0000-000000000002',
    '40000000-0000-0000-0000-000000000001',
    '50000000-0000-0000-0000-000000000001',
    '2030-01-02 10:00:00+00', '2030-01-02 11:00:00+00'
  );
  RAISE EXCEPTION 'public booking reference uniqueness was not enforced';
EXCEPTION WHEN unique_violation THEN
  NULL;
END;
$$;

INSERT INTO public.provider_events (
  provider, provider_event_id, event_type, payload_digest
) VALUES ('TEST_PROVIDER', 'event-001', 'PAYMENT_CONFIRMED', 'digest-001');

DO $$
BEGIN
  INSERT INTO public.provider_events (
    provider, provider_event_id, event_type, payload_digest
  ) VALUES ('TEST_PROVIDER', 'event-001', 'PAYMENT_CONFIRMED', 'digest-002');
  RAISE EXCEPTION 'provider event uniqueness was not enforced';
EXCEPTION WHEN unique_violation THEN
  NULL;
END;
$$;

INSERT INTO public.idempotency_records (
  actor_scope, idempotency_key, request_digest, expires_at
) VALUES ('farmer:20000000-0000-0000-0000-000000000001', 'request-001', 'digest-001', CURRENT_TIMESTAMP + INTERVAL '1 hour');

DO $$
BEGIN
  INSERT INTO public.idempotency_records (
    actor_scope, idempotency_key, request_digest, expires_at
  ) VALUES ('farmer:20000000-0000-0000-0000-000000000001', 'request-001', 'digest-002', CURRENT_TIMESTAMP + INTERVAL '1 hour');
  RAISE EXCEPTION 'idempotency scope uniqueness was not enforced';
EXCEPTION WHEN unique_violation THEN
  NULL;
END;
$$;
