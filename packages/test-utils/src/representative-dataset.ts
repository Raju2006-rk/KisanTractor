import { canonicalEquipmentTypes, canonicalServices, seedReferenceData, type SqlExecutor } from "@kisantractor/database";

/**
 * One coherent Phase 1 history written with raw SQL: a Farmer and an Owner, profiles, locations,
 * a Tractor with photo, Equipment, private document, offering, price, availability history, and a
 * completed booking with agreement, Recipient, status history, work events and measurement,
 * invoice, cash payment, payment event, notification and delivery event, audit and outbox events,
 * idempotency record, OTP challenge, session, and IVR session.
 *
 * Every statement is valid at schema version 0008 and at the latest version (it names no column
 * added after 0008), so the same dataset proves roll-forward with existing data, backup restore,
 * and account deletion. Identifiers are fixed per `ordinal`, so repeated datasets never collide.
 */
export interface RepresentativeDatasetOptions {
  /** Distinguishes datasets in one database; 1..999999. */
  readonly ordinal?: number;
  /** Reuse an existing Farmer user (for example one created through OTP sign-in). */
  readonly customerId?: string;
  /** Reuse an existing Owner user. */
  readonly ownerId?: string;
  /** Booking status for the seeded booking; defaults to COMPLETED (a closed booking). */
  readonly bookingStatus?: "COMPLETED" | "DISPUTED";
}

export interface RepresentativeDataset {
  readonly customerId: string;
  readonly ownerId: string;
  readonly customerLocationId: string;
  readonly ownerLocationId: string;
  readonly tractorId: string;
  readonly tractorPhotoId: string;
  readonly equipmentId: string;
  readonly documentId: string;
  readonly serviceOfferingId: string;
  readonly pricingRuleId: string;
  readonly bookingId: string;
  readonly agreementId: string;
  readonly recipientId: string;
  readonly invoiceId: string;
  readonly paymentId: string;
  readonly notificationId: string;
  readonly otpChallengeId: string;
  readonly sessionId: string;
  readonly ivrSessionId: string;
  readonly idempotencyScope: string;
  readonly publicReference: string;
}

/** Tables the dataset writes, for checksums and row-count comparisons. */
export const REPRESENTATIVE_TABLES = [
  "users", "user_role_memberships", "locations", "user_profiles", "owner_profiles", "tractors",
  "tractor_photos", "services", "equipment_types", "equipment", "documents", "service_offerings",
  "pricing_rules", "tractor_availability", "tractor_availability_history", "bookings",
  "booking_agreements", "booking_recipients", "booking_status_history", "work_events",
  "work_measurements", "invoices", "payments", "payment_events", "notifications",
  "notification_delivery_events", "audit_events", "outbox_events", "idempotency_records",
  "otp_challenges", "auth_sessions", "ivr_sessions",
] as const;

const id = (entity: string, ordinal: number): string =>
  `${entity}000000-0000-4000-8000-${String(ordinal).padStart(12, "0")}`;

export async function seedRepresentativeDataset(
  executor: SqlExecutor,
  options: RepresentativeDatasetOptions = {},
): Promise<RepresentativeDataset> {
  const ordinal = options.ordinal ?? 1;
  if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > 999_999) throw new RangeError("ordinal must be 1..999999");
  const base = Date.UTC(2026, 0, 10, 3, 0, 0) + ordinal * 86_400_000;
  const at = (minutes: number): string => new Date(base + minutes * 60_000).toISOString();
  const service = canonicalServices[0]!;
  const equipmentType = canonicalEquipmentTypes[0]!;
  const ids: RepresentativeDataset = {
    customerId: options.customerId ?? id("a1", ordinal),
    ownerId: options.ownerId ?? id("a2", ordinal),
    customerLocationId: id("b1", ordinal),
    ownerLocationId: id("b2", ordinal),
    tractorId: id("c1", ordinal),
    tractorPhotoId: id("c2", ordinal),
    equipmentId: id("c3", ordinal),
    documentId: id("c4", ordinal),
    serviceOfferingId: id("c5", ordinal),
    pricingRuleId: id("c6", ordinal),
    bookingId: id("d1", ordinal),
    agreementId: id("d2", ordinal),
    recipientId: id("d3", ordinal),
    invoiceId: id("d4", ordinal),
    paymentId: id("d5", ordinal),
    notificationId: id("e1", ordinal),
    otpChallengeId: id("e2", ordinal),
    sessionId: id("e3", ordinal),
    ivrSessionId: id("e4", ordinal),
    idempotencyScope: `booking:create:${options.customerId ?? id("a1", ordinal)}`,
    publicReference: `KT-FX${String(ordinal).padStart(6, "0")}`,
  };
  const customerHash = `fixture-phone-farmer-${ordinal}`;
  const snapshot = JSON.stringify({
    state: "Telangana", district: "Warangal", mandalOrTaluk: "Hanamkonda", village: "Kazipet",
    latitude: 17.9784, longitude: 79.5941, source: "MAP_PIN",
  });

  await seedReferenceData(executor);

  if (options.customerId === undefined) {
    await executor.query(
      `INSERT INTO public.users (id, normalized_phone_ciphertext, phone_lookup_hash, created_at) VALUES ($1, $2, $3, $4)`,
      [ids.customerId, Buffer.from(`fixture-farmer-${ordinal}`), customerHash, at(-10_000)],
    );
    await executor.query(`INSERT INTO public.user_role_memberships (user_id, role_code) VALUES ($1, 'FARMER')`, [ids.customerId]);
  }
  if (options.ownerId === undefined) {
    await executor.query(
      `INSERT INTO public.users (id, normalized_phone_ciphertext, phone_lookup_hash, created_at) VALUES ($1, $2, $3, $4)`,
      [ids.ownerId, Buffer.from(`fixture-owner-${ordinal}`), `fixture-phone-owner-${ordinal}`, at(-10_000)],
    );
    await executor.query(`INSERT INTO public.user_role_memberships (user_id, role_code) VALUES ($1, 'OWNER')`, [ids.ownerId]);
  }

  await executor.query(
    `INSERT INTO public.locations
       (id, owner_user_id, coordinates, state, district, mandal_or_taluk, village, postal_code, landmark,
        source, accuracy_meters, captured_at, location_consent_at)
     VALUES
       ($1, $2, ST_SetSRID(ST_MakePoint(79.5941, 17.9784), 4326)::geography, 'Telangana', 'Warangal', 'Hanamkonda',
        'Kazipet', '506003', 'Behind the cotton market', 'DEVICE_GPS', 12.50, $4, $5),
       ($3, $6, ST_SetSRID(ST_MakePoint(79.5800, 17.9700), 4326)::geography, 'Telangana', 'Warangal', 'Hanamkonda',
        'Hanamkonda', NULL, NULL, 'MAP_PIN', NULL, $4, NULL)`,
    [ids.customerLocationId, ids.customerId, ids.ownerLocationId, at(-9_000), at(-9_001), ids.ownerId],
  );
  await executor.query(
    `INSERT INTO public.user_profiles (user_id, full_name, preferred_locale, contact_sharing_consent, default_location_id)
     VALUES ($1, 'Anita Rao', 'te', true, $2), ($3, 'Raju Naik', 'te', true, NULL)
     ON CONFLICT (user_id) DO NOTHING`,
    [ids.customerId, ids.customerLocationId, ids.ownerId],
  );
  await executor.query(
    `INSERT INTO public.owner_profiles (user_id, operating_location_id, verification_status) VALUES ($1, $2, 'VERIFIED')
     ON CONFLICT (user_id) DO NOTHING`,
    [ids.ownerId, ids.ownerLocationId],
  );
  await executor.query(
    `INSERT INTO public.tractors
       (id, owner_id, brand, model, registration_number_ciphertext, registration_lookup_hash, manufacturing_year,
        horsepower, operational_status, eligibility_status, current_location_id, location_updated_at)
     VALUES ($1, $2, 'Mahindra', '575 DI', $3, $4, 2019, 47.00, 'ONLINE', 'ELIGIBLE', $5, $6)`,
    [ids.tractorId, ids.ownerId, Buffer.from(`fixture-registration-${ordinal}`), `fixture-registration-${ordinal}`, ids.ownerLocationId, at(-8_000)],
  );
  await executor.query(
    `INSERT INTO public.tractor_photos (id, tractor_id, object_key_ciphertext, mime_type, alt_text, sort_order)
     VALUES ($1, $2, $3, 'image/jpeg', 'Red tractor in a field', 0)`,
    [ids.tractorPhotoId, ids.tractorId, Buffer.from(`fixture-photo-key-${ordinal}`)],
  );
  await executor.query(
    `INSERT INTO public.equipment (id, owner_id, tractor_id, equipment_type_id, display_name) VALUES ($1, $2, $3, $4, '9-tine cultivator')`,
    [ids.equipmentId, ids.ownerId, ids.tractorId, equipmentType.id],
  );
  await executor.query(
    `INSERT INTO public.documents
       (id, owner_id, tractor_id, document_kind, object_key, declared_mime_type, detected_mime_type, size_bytes,
        content_digest, scan_status, original_file_name, uploaded_size_bytes, object_encryption_algorithm,
        scan_completed_at, accepted_at)
     VALUES ($1, $2, $3, 'REGISTRATION_CERTIFICATE', $4, 'application/pdf', 'application/pdf', 2048,
        'sha256:fixture', 'ACCEPTED', 'raju-rc.pdf', 2048, 'AES256', $5, $5)`,
    [ids.documentId, ids.ownerId, ids.tractorId, `private/documents/fixture-${ordinal}`, at(-7_000)],
  );
  await executor.query(
    `INSERT INTO public.service_offerings (id, tractor_id, service_id, equipment_id, enabled) VALUES ($1, $2, $3, $4, true)`,
    [ids.serviceOfferingId, ids.tractorId, service.id, ids.equipmentId],
  );
  await executor.query(
    `INSERT INTO public.pricing_rules (id, service_offering_id, method, rate_paise, rounding_policy, valid_from)
     VALUES ($1, $2, 'HOURLY', 80000, 'PROPORTIONAL_MINUTE', $3)`,
    [ids.pricingRuleId, ids.serviceOfferingId, at(-6_000)],
  );
  await executor.query(
    `INSERT INTO public.tractor_availability (tractor_id, operational_status, reason, effective_at, changed_by_user_id)
     VALUES ($1, 'ONLINE', NULL, $2, $3)`,
    [ids.tractorId, at(-5_000), ids.ownerId],
  );
  await executor.query(
    `INSERT INTO public.tractor_availability_history (tractor_id, from_status, to_status, actor_id, actor_channel, occurred_at)
     VALUES ($1, 'OFFLINE', 'ONLINE', $2, 'WEB', $3)`,
    [ids.tractorId, ids.ownerId, at(-5_000)],
  );

  const status = options.bookingStatus ?? "COMPLETED";
  await executor.query(
    `INSERT INTO public.bookings
       (id, public_reference, customer_id, owner_id, tractor_id, service_offering_id, requested_start_at,
        requested_end_at, expected_quantity, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 2.000, $9, $10, $10)`,
    [ids.bookingId, ids.publicReference, ids.customerId, ids.ownerId, ids.tractorId, ids.serviceOfferingId, at(0), at(240), status, at(-1_000)],
  );
  await executor.query(
    `INSERT INTO public.booking_agreements
       (id, booking_id, agreement_version, pricing_rule_id, pricing_rule_version, method, rate_paise, rounding_policy,
        estimated_quantity, estimated_total_paise, service_location_snapshot, approved_by_customer_at, disclosed_at)
     VALUES ($1, $2, 1, $3, 1, 'HOURLY', 80000, 'PROPORTIONAL_MINUTE', 2.000, 160000, $4::jsonb, $5, $5)`,
    [ids.agreementId, ids.bookingId, ids.pricingRuleId, snapshot, at(-1_000)],
  );
  await executor.query(`UPDATE public.bookings SET current_agreement_id = $2 WHERE id = $1`, [ids.bookingId, ids.agreementId]);
  await executor.query(
    `INSERT INTO public.booking_recipients
       (id, booking_id, name, phone_ciphertext, phone_lookup_hash, coordination_consent, service_location_snapshot, landmark_or_directions)
     VALUES ($1, $2, 'Suresh Rao', $3, $4, true, $5::jsonb, 'Near the water tank')`,
    [ids.recipientId, ids.bookingId, Buffer.from(`fixture-recipient-${ordinal}`), `fixture-phone-recipient-${ordinal}`, snapshot],
  );
  const transitions: ReadonlyArray<readonly [string | null, string, string | null, string, number]> = [
    [null, "CREATED", ids.customerId, "WEB", -1_000],
    ["CREATED", "PENDING_OWNER_RESPONSE", ids.customerId, "WEB", -1_000],
    ["PENDING_OWNER_RESPONSE", "ACCEPTED", ids.ownerId, "WEB", -900],
    ["ACCEPTED", "IN_PROGRESS", ids.ownerId, "WEB", 0],
    ["IN_PROGRESS", "WORK_COMPLETED", ids.ownerId, "WEB", 120],
    ["WORK_COMPLETED", "FINAL_BILL_GENERATED", null, "SYSTEM", 120],
    ["FINAL_BILL_GENERATED", "PAYMENT_RECORDED", null, "SYSTEM", 130],
    status === "COMPLETED"
      ? ["PAYMENT_RECORDED", "COMPLETED", null, "SYSTEM", 130]
      : ["PAYMENT_RECORDED", "DISPUTED", ids.customerId, "WEB", 140],
  ];
  for (const [from, to, actor, channel, minute] of transitions) {
    await executor.query(
      `INSERT INTO public.booking_status_history (booking_id, from_status, to_status, actor_id, actor_channel, reason, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [ids.bookingId, from, to, actor, channel, to === "DISPUTED" ? "Acreage was lower" : null, at(minute)],
    );
  }
  await executor.query(
    `INSERT INTO public.work_events (booking_id, event_type, effective_at, received_at, actor_id, actor_channel, idempotency_key)
     VALUES ($1, 'START', $2, $2, $3, 'WEB', 'fixture-start'), ($1, 'COMPLETE', $4, $4, $3, 'WEB', 'fixture-complete')`,
    [ids.bookingId, at(0), ids.ownerId, at(120)],
  );
  await executor.query(
    `INSERT INTO public.work_measurements (booking_id, method, quantity, unit, submitted_by_user_id) VALUES ($1, 'HOURLY', 120.000, 'MINUTE', $2)`,
    [ids.bookingId, ids.ownerId],
  );
  await executor.query(
    `INSERT INTO public.invoices
       (id, booking_id, agreement_id, invoice_version, status, rate_paise, billable_quantity, subtotal_paise,
        adjustments_paise, total_paise, evidence_references, calculation_formula, rounding_trace)
     VALUES ($1, $2, $3, 1, 'ISSUED', 80000, 2.000, 160000, 0, 160000, '[]'::jsonb,
        '120 min x ₹800.00/h = ₹1,600.00', '{"rawSubtotalNumerator":"160000","rawSubtotalDenominator":"1","minorUnitRounding":"HALF_UP"}'::jsonb)`,
    [ids.invoiceId, ids.bookingId, ids.agreementId],
  );
  await executor.query(
    `INSERT INTO public.payments (id, invoice_id, method, status, amount_paise, recorded_by_user_id, received_at)
     VALUES ($1, $2, 'CASH', 'PAID_CASH', 160000, $3, $4)`,
    [ids.paymentId, ids.invoiceId, ids.ownerId, at(130)],
  );
  await executor.query(
    `INSERT INTO public.payment_events (payment_id, event_type, from_status, to_status, amount_paise, actor_id, actor_channel, occurred_at)
     VALUES ($1, 'CASH_RECORDED', NULL, 'PAID_CASH', 160000, $2, 'WEB', $3)`,
    [ids.paymentId, ids.ownerId, at(130)],
  );
  await executor.query(
    `INSERT INTO public.notifications
       (id, recipient_user_id, booking_id, channel, status, template_key, template_locale, related_entity_type, related_entity_id)
     VALUES ($1, $2, $3, 'IN_APP', 'DELIVERED', 'notification.bill.ready', 'en', 'Booking', $3)`,
    [ids.notificationId, ids.customerId, ids.bookingId],
  );
  await executor.query(
    `INSERT INTO public.notification_delivery_events (notification_id, from_status, to_status) VALUES ($1, 'PENDING', 'DELIVERED')`,
    [ids.notificationId],
  );
  await executor.query(
    `INSERT INTO public.audit_events (actor_id, actor_channel, action, resource_type, resource_id, outcome, correlation_id, pii_safe_metadata, occurred_at)
     VALUES ($1, 'WEB', 'booking.create', 'Booking', $3, 'SUCCESS', $4, '{}'::jsonb, $5),
            ($2, 'WEB', 'payment.cash.record', 'Payment', $6, 'SUCCESS', $4, '{"amountPaise":160000}'::jsonb, $7)`,
    [ids.customerId, ids.ownerId, ids.bookingId, `fixture-correlation-${ordinal}`, at(-1_000), ids.paymentId, at(130)],
  );
  await executor.query(
    `INSERT INTO public.outbox_events (aggregate_type, aggregate_id, event_type, event_version, payload, status, published_at)
     VALUES ('Booking', $1, 'CashPaymentRecorded', 1, $2::jsonb, 'PUBLISHED', $3)`,
    [ids.bookingId, JSON.stringify({ bookingId: ids.bookingId, paymentId: ids.paymentId }), at(131)],
  );
  await executor.query(
    `INSERT INTO public.idempotency_records
       (actor_scope, idempotency_key, request_digest, status, response_status, response_body, resource_type, resource_id, created_at, expires_at)
     VALUES ($1, 'fixture-create', 'sha256:request', 'COMPLETED', 201, $2::jsonb, 'Booking', $3, $4, $5)`,
    [ids.idempotencyScope, JSON.stringify({ bookingId: ids.bookingId, publicReference: ids.publicReference }), ids.bookingId, at(-1_000), at(440)],
  );
  await executor.query(
    `INSERT INTO public.otp_challenges (id, phone_lookup_hash, purpose, code_hash, requester_hash, expires_at, max_attempts, consumed_at, created_at)
     SELECT $1::uuid, phone_lookup_hash, 'SIGN_IN'::otp_purpose, 'fixture-code-hash', 'fixture-requester', $3::timestamptz, 3,
            $2::timestamptz, $2::timestamptz
     FROM public.users WHERE id = $4::uuid`,
    [ids.otpChallengeId, at(-2_000), at(-1_995), ids.customerId],
  );
  await executor.query(
    `INSERT INTO public.auth_sessions (id, user_id, access_token_hash, refresh_token_hash, access_expires_at, refresh_expires_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [ids.sessionId, ids.customerId, `fixture-access-${ordinal}`, `fixture-refresh-${ordinal}`, at(-1_985), at(40_000), at(-2_000)],
  );
  await executor.query(
    `INSERT INTO public.ivr_sessions
       (id, provider, provider_call_id, caller_phone_ciphertext, caller_phone_lookup_hash, verified_user_id, prompt_tree_version,
        state, status, expires_at, created_at)
     SELECT $1::uuid, 'sandbox-telephony', $2::text, normalized_phone_ciphertext, phone_lookup_hash, id, 1, 'COMPLETED',
            'COMPLETED'::ivr_session_status, $4::timestamptz, $3::timestamptz
     FROM public.users WHERE id = $5::uuid`,
    [ids.ivrSessionId, `fixture-call-${ordinal}`, at(-3_000), at(-2_990), ids.customerId],
  );
  return Object.freeze(ids);
}
