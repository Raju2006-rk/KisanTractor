# Requirements Document

## Introduction

KisanTractor connects Indian farmers who need agricultural work with tractor owners who provide tractors, equipment, and services. The product comprises a responsive public website/PWA, role-specific Farmer and Owner experiences, one shared backend and database, and phased integrations for payments, communications, IVR, and premium 3D. The initial release prioritizes a trustworthy end-to-end booking, work, and billing journey on accessible low-bandwidth devices.

## Glossary

- **Platform**: The shared KisanTractor clients, backend services, persistence, and configured provider adapters.
- **Farmer**: An authenticated customer who searches for and books tractor services.
- **Owner**: An authenticated tractor owner who publishes eligible tractors and fulfills bookings.
- **Recipient**: A person receiving a service booked by a Farmer; a Recipient does not require a Platform account.
- **Service Location**: The farm or work location used as the origin for tractor discovery and service delivery.
- **Service Offering**: A Tractor, agricultural service, optional Equipment item, and enabled Pricing Rules offered together.
- **Pricing Rule**: An Owner-configured rate using hourly, per-acre, or per-trip pricing, including any disclosed rounding policy.
- **Quote Snapshot**: The immutable pricing method, rate, estimated quantity, rounding policy, and estimate agreed at booking.
- **Blocking Booking**: An accepted, scheduled, or in-progress booking that reserves a Tractor interval.
- **Provider Capability**: OTP, maps/geocoding, online payment, SMS/push, object storage, or telephony functionality supplied externally.
- **Capability State**: `UNCONFIGURED`, `SANDBOX`, `LIVE`, or `DEGRADED`.
- **Authoritative Action**: A state change such as confirming a booking, accepting work, controlling a job, or recording payment.

## Requirements

### Requirement 1: Shared Multi-Channel Product and Delivery Phases

**User Story:** As a Platform operator, I want every client channel to use shared business rules and phased capability gates, so that the product remains consistent and does not imply unfinished services are live.

#### Acceptance Criteria

1. THE Platform SHALL expose Farmer, Owner, responsive web/PWA, and future IVR workflows through the same backend booking, pricing, and payment records.
2. WHEN the same booking is read through two authorized channels, THE Platform SHALL return the same authoritative status, Quote Snapshot, invoice, and payment state.
3. THE Phase 1 release SHALL provide the core responsive booking platform, role experiences, tractor/equipment management, location-based discovery, booking, job tracking, billing, history, localization foundation, and provider-independent audit/outbox foundations.
4. THE Phase 2 release SHALL gate production online payments, receipts/refunds, SMS/push, contact improvements, support/disputes, and expanded translations behind provider and operational readiness.
5. THE Phase 3 release SHALL gate the keypad-phone IVR flow behind a configured phone number, telephony provider, localized prompts, identity verification, and end-to-end tests.
6. THE Phase 4 release SHALL add premium 3D, advanced discovery/maps, analytics, and expanded reporting without making core booking depend on those capabilities.

### Requirement 2: OTP Identity, Roles, and Authorization

**User Story:** As a Farmer or Owner, I want simple mobile-number authentication and strict role access, so that I can use only my own functions and data securely.

#### Acceptance Criteria

1. WHEN a user requests or verifies an OTP, THE Platform SHALL normalize the mobile number, bind the challenge to its phone and purpose, limit requests and attempts, and expire the challenge after a configured short period.
2. WHEN a valid OTP is verified, THE Platform SHALL issue a revocable authenticated session with explicit role memberships.
3. IF a principal lacks an explicit role or resource-ownership permission, THEN THE Platform SHALL deny access and leave persistent state unchanged.
4. WHEN a Farmer requests booking data, THE Platform SHALL return only bookings owned by that Farmer unless an explicit support policy applies.
5. WHEN an Owner requests tractor or booking data, THE Platform SHALL return only Tractors owned by that Owner and bookings assigned to those Tractors unless an explicit support policy applies.
6. THE Platform SHALL enforce authorization on the server independently of route visibility in each client.
7. WHEN authentication or another sensitive action occurs, THE Platform SHALL append a PII-safe audit record.

### Requirement 3: Farmer Experience

**User Story:** As a Farmer with limited technical experience, I want a clear, localized, mobile-first journey, so that I can find and book a tractor with few steps.

#### Acceptance Criteria

1. THE Farmer navigation SHALL provide Home, Search Tractors, Bookings, Help, and Account destinations on supported screen sizes.
2. THE Farmer home SHALL provide labeled actions for service location, farming work, date/time, pricing method, nearby tractors, current bookings, history, help, and language.
3. WHEN a Farmer views a Tractor card, THE Platform SHALL show a redacted photo, brand/model, approximate distance, Owner name where policy permits, available service/equipment, enabled pricing, availability, details action, and booking action.
4. WHEN contact sharing is not enabled by the Owner, THE Platform SHALL omit direct Owner contact information from Farmer views.
5. WHEN a Farmer loses connectivity during a non-authoritative form step, THE client SHALL preserve only a safe draft and SHALL require explicit retry before any Authoritative Action.

### Requirement 4: Owner Registration, Tractors, Equipment, and Documents

**User Story:** As an Owner, I want to register and manage my tractors, equipment, services, and documents, so that Farmers can book only valid offerings.

#### Acceptance Criteria

1. WHEN an Owner registers, THE Platform SHALL collect name, verified mobile number, operating location, and required Owner profile details.
2. WHEN an Owner adds a Tractor, THE Platform SHALL support brand, model, registration number, manufacturing year, horsepower, images, operating location, documents, Equipment, services, and Pricing Rules.
3. THE Platform SHALL allow an Owner to manage one or more Tractors and associate available Equipment with a specific Tractor or Owner inventory.
4. WHEN required Tractor information, required documents, active service pricing, or location freshness is missing, THE Platform SHALL prevent the Tractor from becoming discoverable and SHALL explain the unmet eligibility condition to the Owner.
5. WHEN a user requests a Tractor document, THE Platform SHALL authorize ownership or an explicit support permission before issuing a short-lived private access grant.
6. WHEN an upload is submitted, THE Platform SHALL validate declared type, content signature, size, and security scan result before marking the document accepted.

### Requirement 5: Owner Dashboard and Online/Offline Availability

**User Story:** As an Owner, I want an obvious operational-status control and dashboard, so that I can control new demand while continuing existing work.

#### Acceptance Criteria

1. THE Owner dashboard SHALL place a labeled online/offline availability control before dashboard summaries and SHALL show total Tractors, requests, accepted/active/completed jobs, earnings, payments, Equipment, documents, profile, and help.
2. WHEN an Owner sets a Tractor to `OFFLINE`, THE Platform SHALL exclude that Tractor from new search results and new booking eligibility.
3. WHEN an Owner sets a Tractor to `OFFLINE`, THE Platform SHALL retain and permit authorized management of existing confirmed bookings.
4. WHEN an Owner sets a Tractor to `ONLINE`, THE Platform SHALL make it eligible only after validating documents, service/pricing configuration, location freshness, and schedule conflicts.
5. WHEN operational status changes, THE Platform SHALL make the authoritative value visible across clients after refresh or real-time update and SHALL append an audit event.

### Requirement 6: Owner-Configured Pricing and Quote Transparency

**User Story:** As an Owner, I want service-specific rates, and as a Farmer, I want transparent choices, so that both parties agree on how work will be billed.

#### Acceptance Criteria

1. THE Platform SHALL support `HOURLY`, `PER_ACRE`, and `PER_TRIP` Pricing Rules using positive integer paise rates.
2. WHEN an Owner configures a Service Offering, THE Platform SHALL allow one or more pricing methods with rates specific to that Tractor, service, and optional Equipment.
3. WHEN hourly pricing is enabled, THE Platform SHALL require a disclosed policy of proportional-minute, 30-minute-block, or one-hour-block billing.
4. WHEN a Farmer books a Service Offering, THE Platform SHALL show only currently enabled Pricing Rules for that offering.
5. BEFORE booking confirmation, THE Platform SHALL show the method, rate, rounding rule when applicable, estimated quantity, and estimated total.
6. WHEN a booking is confirmed, THE Platform SHALL store an immutable Quote Snapshot including the Pricing Rule version.
7. WHEN an Owner later changes catalog pricing, THE Platform SHALL retain the confirmed booking's Quote Snapshot and SHALL use it for billing unless both parties explicitly approve a versioned agreement change.

### Requirement 7: Service Location and Geospatial Discovery

**User Story:** As a Farmer, I want Tractors near the actual farm, so that search results are relevant whether I book for myself or another person.

#### Acceptance Criteria

1. THE Platform SHALL accept a Service Location from consented device GPS, configured map pin/search, manual administrative address, or a saved location.
2. WHEN a Farmer searches, THE Platform SHALL use the selected Service Location as the distance origin and SHALL not substitute the Farmer's current or profile location.
3. WHEN the Farmer books for someone else, THE Platform SHALL use the Recipient's Service Location for discovery and service delivery.
4. THE initial search radius SHALL default to a configurable 5 kilometres and SHALL allow expansion when no suitable Tractor is found.
5. WHEN producing results, THE Platform SHALL include only Tractors within the radius that are online, eligible, location-fresh, service/equipment compatible, actively priced, and free of Blocking Bookings for the requested interval.
6. WHEN displaying distance, THE Platform SHALL identify it as an estimate and SHALL avoid exposing exact private coordinates.
7. IF maps or geocoding are unavailable, THEN THE Platform SHALL provide manual state, district, mandal/taluk, village, landmark, and approved coordinate-entry alternatives without claiming map resolution succeeded.
8. WHEN discovery results are ordered, THE Platform SHALL use deterministic availability and distance ordering with a stable tie-breaker.

### Requirement 8: Booking Creation, Recipient Semantics, and Lifecycle

**User Story:** As a Farmer, I want to book for myself or another person and track a predictable lifecycle, so that the correct customer, recipient, place, and agreement are preserved.

#### Acceptance Criteria

1. WHEN booking begins, THE Platform SHALL offer `Book for Myself` and `Book for Someone Else` inside the Farmer booking flow.
2. WHEN `Book for Someone Else` is selected, THE Platform SHALL require Recipient name and Service Location and SHALL support optional coordination phone, landmark/directions, work, Equipment, schedule, and pricing quantity fields as applicable.
3. WHEN a booking for someone else is created, THE Platform SHALL store the authenticated Farmer as booking customer and the Recipient as a separate snapshot without requiring a Recipient account.
4. BEFORE committing a booking, THE Platform SHALL revalidate Tractor online/eligibility state, Service Offering, current Pricing Rule, requested interval, and Quote Snapshot inputs on the server.
5. WHEN equivalent create requests use the same Farmer-scoped idempotency key, THE Platform SHALL create one booking, return the same result, and emit one booking-request side effect.
6. WHEN an Owner accepts a request, THE Platform SHALL atomically prevent another Blocking Booking whose half-open interval overlaps for the same Tractor.
7. WHEN two booking intervals are adjacent but do not overlap, THE Platform SHALL permit both if all other rules pass.
8. THE Platform SHALL enforce an explicit lifecycle covering created, pending response, accepted, scheduled, in progress, work completed, final bill generated, payment recorded, and completed, with rejected, cancelled, expired, disputed, refund-pending, and refunded outcomes.
9. IF an actor or current status does not permit a requested transition, THEN THE Platform SHALL reject it without state mutation.
10. WHEN a status transition succeeds, THE Platform SHALL append exactly one status-history event with actor, channel, time, and optional reason.
11. WHEN a confirmed booking agreement changes, THE Platform SHALL retain the prior version, record the approved change, and notify affected parties through configured channels.
12. WHEN confirmation is shown, THE Platform SHALL display booked-by, Recipient when present, Service Location, Tractor/Owner, work, pricing, estimate, schedule, and payment expectation.

### Requirement 9: Job Tracking and Work Evidence

**User Story:** As an Owner and Farmer, I want transparent work records, so that the final bill reflects actual completed work.

#### Acceptance Criteria

1. THE Platform SHALL allow the assigned Owner to start, pause, resume, and complete an accepted/scheduled job through valid ordered events.
2. WHEN a work event is recorded, THE Platform SHALL store server-received time, optional device-observed time, actor, and idempotency identity.
3. IF a work event is out of sequence, THEN THE Platform SHALL reject it without partial mutation and SHALL report the valid next action.
4. WHEN hourly work is completed, THE Platform SHALL derive active minutes from closed, non-overlapping start/resume to pause/complete intervals and SHALL exclude paused time.
5. WHEN per-acre work is completed, THE Platform SHALL require a nonnegative completed-acre measurement with configured precision.
6. WHEN per-trip work is completed, THE Platform SHALL require a nonnegative integer completed-trip count.
7. WHEN work evidence is corrected, THE Platform SHALL retain the original event or measurement, require a reason, append the correction, and audit the actor.

### Requirement 10: Final Billing and Disputes

**User Story:** As a Farmer, I want a reproducible final bill, so that I can understand and challenge the amount due.

#### Acceptance Criteria

1. WHEN proportional hourly work completes, THE Platform SHALL calculate `total = agreed hourly rate × active minutes ÷ 60` and SHALL not silently round active minutes upward.
2. WHEN block hourly billing was disclosed in the Quote Snapshot, THE Platform SHALL round billable minutes to the least configured block multiple that is greater than or equal to active minutes.
3. WHEN per-acre work completes, THE Platform SHALL calculate `total = agreed per-acre rate × completed acres`.
4. WHEN per-trip work completes, THE Platform SHALL calculate `total = agreed per-trip rate × completed trips`.
5. THE Platform SHALL store monetary amounts as integer paise, use decimal quantities with configured precision, and round only once at the final minor-unit boundary.
6. WHEN an invoice is generated, THE Platform SHALL record the agreement version, rate, billable quantity, subtotal, adjustments, total, evidence references, formula, and rounding trace.
7. WHEN 90 proportional minutes are billed at ₹800 per hour, THE Platform SHALL produce ₹1,200; WHEN 3 acres are billed at ₹1,200 per acre, THE Platform SHALL produce ₹3,600; WHEN 2 trips are billed at ₹1,500 per trip, THE Platform SHALL produce ₹3,000.
8. WHEN a Farmer disputes a bill, THE Platform SHALL preserve invoice and evidence history, mark the booking disputed, and prevent unreviewed settlement finalization.

### Requirement 11: Payment Records, Verification, and Receipts

**User Story:** As a Farmer or Owner, I want accurate cash and online payment records, so that settlement history is trustworthy.

#### Acceptance Criteria

1. THE Platform SHALL distinguish pending, awaiting-final-bill, payment-due, paid-online, paid-cash, payment-failed, refund-pending, and refunded states.
2. WHEN cash is recorded, THE Platform SHALL set the method to cash and record who confirmed receipt and when; it SHALL NOT label the payment paid-online.
3. WHEN online payment is initiated, THE Platform SHALL create a provider-linked intent only if the capability is configured for sandbox or live use.
4. WHEN a browser redirect reports payment success, THE Platform SHALL NOT mark the payment paid-online without a verified provider event.
5. WHEN a provider event is received, THE Platform SHALL verify its signature, provider reference, amount, and currency before applying a financial effect.
6. WHEN the same verified provider event is delivered more than once, THE Platform SHALL apply its financial effect exactly once.
7. THE Platform SHALL prevent applied successful non-refunded payments from exceeding the invoice total and SHALL mark an invoice settled if and only if applied payments equal the total.
8. WHEN settlement is complete, THE Platform SHALL make an authorized receipt available with booking, invoice, method, amount, status, and timestamp.

### Requirement 12: Privacy, Data Integrity, and Auditability

**User Story:** As a Platform user, I want my identity, location, documents, and financial data protected, so that using KisanTractor does not expose sensitive information.

#### Acceptance Criteria

1. THE Platform SHALL encrypt transport, private object storage, backups, and designated sensitive database fields and SHALL store secrets outside source code.
2. WHEN an anonymous or unrelated principal views public data, THE Platform SHALL redact phone plaintext, exact private coordinates, document access, OTP material, and payment-provider payloads.
3. THE Platform SHALL enforce foreign keys and uniqueness for active phone identities, Tractor registration identities, public booking references, provider events, and idempotency scopes.
4. THE Platform SHALL preserve append-only booking agreement, status, work correction, invoice, payment, and audit history according to the retention policy.
5. WHEN a user requests account deletion, THE Platform SHALL remove or anonymize eligible personal data while preserving legally required financial and audit records.
6. THE Platform SHALL collect location and contact data only for disclosed purposes and SHALL store consent where required.
7. THE Platform SHALL provide backup, restore, error monitoring, and incident-response procedures before production release.

### Requirement 13: Localization and Accessibility

**User Story:** As a Farmer using my preferred language or assistive technology, I want understandable and operable screens, so that I can complete essential tasks independently.

#### Acceptance Criteria

1. THE initial localization system SHALL support Telugu, Hindi, English, Kannada, and Tamil catalogs and SHALL allow further languages without screen rewrites.
2. WHEN a user chooses a supported locale during onboarding or Settings, THE Platform SHALL store the preference and localize menus, controls, statuses, forms, help, dates, and currency presentation.
3. IF a locale entry is missing, THEN THE Platform SHALL fall back to a nonempty English message and SHALL record translation telemetry without displaying a raw key.
4. THE user interface SHALL provide at least 44 by 44 CSS-pixel targets, readable script-appropriate fonts, WCAG 2.2 AA contrast, visible focus, keyboard operability, and icons paired with text.
5. WHEN content is zoomed to 200 percent or displayed on supported mobile widths, THE Platform SHALL preserve content and task completion without two-dimensional scrolling for ordinary application screens.
6. WHEN reduced motion is requested, THE Platform SHALL remove nonessential motion while preserving information and controls.
7. THE Platform SHALL use clear, simple, localized validation and error messages and SHALL not rely on color alone for status.

### Requirement 14: External Capability Honesty and Resilience

**User Story:** As a user, I want truthful integration states, so that I know whether an OTP, map, payment, message, upload, or phone action really occurred.

#### Acceptance Criteria

1. THE Platform SHALL represent every Provider Capability as `UNCONFIGURED`, `SANDBOX`, `LIVE`, or `DEGRADED`.
2. WHEN a capability is `UNCONFIGURED`, THE Platform SHALL disable or reject its live operation, explain the unavailable state, and produce no external side effect.
3. WHEN a capability is `SANDBOX`, THE Platform SHALL label its test status anywhere a user could otherwise mistake it for live service.
4. WHEN a capability is `DEGRADED`, THE Platform SHALL preserve domain consistency and offer a safe retry or permitted manual alternative.
5. THE production environment SHALL refuse development-only OTP codes, unsigned provider events, fake phone numbers, and test payment success paths.
6. WHEN an external notification fails after a domain transaction, THE Platform SHALL retain the committed domain state, retry through the transactional outbox, and expose delivery status where useful.

### Requirement 15: Keypad-Phone IVR Booking

**User Story:** As a Farmer with a keypad phone, I want to request and check a booking by voice and digits, so that I do not need an app, internet, or GPS.

#### Acceptance Criteria

1. WHERE the telephony capability is `LIVE`, THE Platform SHALL accept calls through the configured dedicated number and provide a keypad flow using the shared backend.
2. WHEN an IVR call begins, THE Platform SHALL offer configured regional languages before collecting booking details.
3. THE IVR SHALL support caller verification, manual state/district/mandal/village or PIN-based location, service selection, date/time, applicable quantity, booking confirmation, and status retrieval.
4. THE IVR SHALL use short prompts, bounded retries, repeat/help options, and assisted transfer or safe termination when configured automation cannot continue.
5. WHEN an IVR booking is submitted repeatedly with the same call-scoped idempotency identity, THE Platform SHALL create no duplicate booking.
6. WHEN IVR accesses or changes an existing booking, THE Platform SHALL verify the caller's identity and booking ownership first.
7. IF confirmation SMS is configured, THEN THE Platform SHALL send the booking reference through the outbox; otherwise THE IVR SHALL not claim an SMS was sent.
8. WHILE telephony is not live, THE public site SHALL not show a fabricated booking number or imply that phone booking is operational.

### Requirement 16: Public Landing Page and Progressive 3D

**User Story:** As a prospective user, I want a fast, trustworthy agricultural landing page, so that I understand the service and can begin the correct role journey on any capable device.

#### Acceptance Criteria

1. THE landing page SHALL retain the showcase's agricultural green/cream identity, Indian farm imagery, readable modern typography, role-specific calls to action, and desktop character while meeting accessibility requirements.
2. THE landing page SHALL include hero, how-it-works, farming services, Owner benefits, pricing methods, phone-booking availability, regional languages, final call to action, and required footer links.
3. THE Phase 1 landing page SHALL deliver all essential content and booking/Owner registration links without requiring 3D.
4. WHERE Phase 4 3D is enabled, THE Platform SHALL lazy-load compressed models and textures after essential content and SHALL keep the 3D runtime out of booking routes.
5. IF reduced motion, data saver, low device capability, model failure, timeout, or disabled scripting applies, THEN THE landing page SHALL render a static equivalent with the same essential content and operable primary links.
6. THE landing page SHALL target 75th-percentile LCP at or below 2.5 seconds, CLS at or below 0.1, and INP at or below 200 milliseconds on the defined representative mobile profile.
7. THE initial optional 3D model payload SHALL target at most 1.5 MB compressed and SHALL not violate the core booking performance budget.

### Requirement 17: Responsive PWA, Connectivity, and Notifications

**User Story:** As a mobile or desktop user with unreliable connectivity, I want responsive and honest network behavior, so that I do not accidentally create duplicate or stale actions.

#### Acceptance Criteria

1. THE web application SHALL adapt Farmer and Owner screens to supported Android/mobile, tablet, laptop, and desktop dimensions.
2. THE PWA SHALL cache only safe shell assets, static public assets, and translation catalogs and SHALL not public-cache tokens, private documents, payment responses, or sensitive booking data.
3. WHEN availability, quote, invoice, or payment data is shown, THE client SHALL obtain or revalidate authoritative server data and SHALL expose meaningful freshness or pending state.
4. WHEN connectivity fails during an Authoritative Action, THE client SHALL not silently queue it; it SHALL preserve a safe draft where applicable and require an explicit retry using the same idempotency key.
5. IF PWA installation or push permission is unavailable, THEN all core browser booking and management workflows SHALL remain operable.
6. WHEN a configured notification is generated, THE Platform SHALL record its channel, delivery state, template locale, and related entity without changing domain state based solely on delivery success.

### Requirement 18: Operational Quality and Evolution

**User Story:** As a Platform operator, I want observable, maintainable, and safely deployable services, so that KisanTractor can expand across India without weakening booking integrity.

#### Acceptance Criteria

1. THE Platform SHALL emit PII-redacted structured logs, metrics, and traces with correlation identifiers for client requests, domain transactions, outbox jobs, and provider callbacks.
2. THE Platform SHALL monitor OTP abuse/failure, zero-result discovery, booking conversion, acceptance conflicts, invalid transitions, invoice disputes, payment verification failures, outbox lag, IVR abandonment, translation misses, web vitals, and 3D fallback rate.
3. THE Platform SHALL use cursor pagination and bounded queries for discovery, bookings, payments, and dashboard histories.
4. THE Platform SHALL target 95th-percentile backend read latency below 500 milliseconds and state-changing latency below 800 milliseconds under the documented initial load, excluding asynchronous provider completion.
5. THE Platform SHALL use forward-compatible versioned APIs, additive database migrations, stable seed identifiers, and tested backup restoration and roll-forward procedures.
6. WHEN a module is later extracted from the modular monolith, THE Platform SHALL preserve booking, invoice, and payment invariants through versioned contracts and an explicit consistency/reconciliation design.
7. BEFORE a production release enables a Provider Capability, THE Platform SHALL pass security, contract, sandbox, failure-mode, operational, and rollback readiness checks for that capability.
