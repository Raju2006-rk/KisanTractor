import "reflect-metadata";

import { randomUUID } from "node:crypto";

import { createTestDatabaseFactory, type TestDatabase } from "@kisantractor/test-utils";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { formatIndianCurrency } from "@kisantractor/i18n";

import { findBrowserExecutable, HeadlessBrowser } from "../../../web/quality/cdp.js";
import { startProductionServer, type ProductionServer } from "../../../web/quality/production-server.js";
import { AppModule } from "../app.module.js";
import { BOOKING_TRANSITION_TABLE } from "../booking/index.js";
import { PgPoolAdapter } from "../sql-pool.js";
import {
  ApiClient,
  DomainClock,
  ephemeralSecrets,
  listeningBaseUrl,
  partyOnlyFields,
  SandboxObjectStorage,
  sandboxCleanScanner,
  sharedBookingState,
  verticalSliceConfig,
} from "./vertical-slice-harness.js";

/**
 * Phase 1 vertical slice over real HTTP against the composed Nest application and a real
 * PostgreSQL/PostGIS database. Gated like the other database suites; see src/e2e/README.md.
 *
 * Validates: Requirements 1.1, 1.2, 1.3, 8.8, 11.8
 */
const databaseUrl = process.env.VERTICAL_SLICE_E2E_DATABASE_URL;
const describeDatabase = databaseUrl === undefined ? describe.skip : describe;

const SERVICE_PLOUGHING = "30000000-0000-4000-8000-000000000001";
const EQUIPMENT_CULTIVATOR = "50000000-0000-4000-8000-000000000001";
const PHONES = { owner: "+91 98480 22338", farmer: "98765 43210", otherFarmer: "9000000001", recipient: "9123456780" };

const PDF_BYTES = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n", "ascii");
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(PDF_BYTES.length - 8, 1),
]);

type Json = Record<string, any>;

describeDatabase("Phase 1 vertical slice: OTP sandbox to receipt over HTTP and PostgreSQL", () => {
  const clock = new DomainClock();
  const storage = new SandboxObjectStorage();
  let database: TestDatabase;
  let pool: PgPoolAdapter;
  let app: INestApplication;
  let anonymous: ApiClient;
  let owner: ApiClient;
  let farmer: ApiClient;
  let otherFarmer: ApiClient;
  const ids: Record<string, string> = {};
  const bookings: Record<"self" | "other" | "overlap" | "adjacent", string> = { self: "", other: "", overlap: "", adjacent: "" };

  const location = (village: string, district: string, latitude: number, longitude: number, landmark?: string) => ({
    state: "Telangana",
    district,
    mandalOrTaluk: district,
    village,
    ...(landmark === undefined ? {} : { landmark }),
    source: "MANUAL_ADDRESS",
    latitude,
    longitude,
    capturedAt: clock.now().toISOString(),
  });
  // Tractor A works around Hanamkonda (Warangal); Tractor B ~70 km away in Karimnagar.
  const places = {
    tractorA: () => location("Hanamkonda", "Warangal", 17.9784, 79.53),
    tractorB: () => location("Karimnagar", "Karimnagar", 18.4386, 79.1288),
    farmerFarm: () => location("Kazipet", "Warangal", 17.99, 79.54, "Near the canal"),
    recipientFarm: () => location("Rekurthi", "Karimnagar", 18.45, 79.14, "Behind the Hanuman temple"),
    farmerHomeCity: () => location("Madhapur", "Hyderabad", 17.385, 78.4867),
  };
  // Booking day starts one day after the domain clock's start, on the hour.
  const day = new Date(Math.ceil(clock.now().getTime() / 3_600_000) * 3_600_000 + 24 * 3_600_000);
  const at = (hours: number) => new Date(day.getTime() + hours * 3_600_000).toISOString();
  const interval = (from: number, to: number) => ({ start: at(from), end: at(to) });

  const signIn = async (phone: string, purpose: "REGISTER_FARMER" | "REGISTER_OWNER", userAgent: string) => {
    const client = new ApiClient(anonymous.baseUrl, userAgent);
    const challenge = await client.post("/identity/otp/challenges", { phone, purpose });
    expect(challenge.status).toBe(201);
    expect(challenge.headers.get("cache-control")).toBe("no-store");
    // The sandbox code is visible only because the adapter is labelled test-only.
    expect(challenge.body).toMatchObject({ accepted: true, testOnly: true, message: expect.stringContaining("Development OTP") });
    expect(challenge.body.developmentCode).toMatch(/^\d{6}$/u);
    const wrongCode = String((Number(challenge.body.developmentCode) + 1) % 1_000_000).padStart(6, "0");
    const rejected = await client.post("/identity/otp/verify", { challengeId: challenge.body.challengeId, phone, purpose, code: wrongCode });
    expect(rejected.status).toBe(401);
    expect(rejected.body).toMatchObject({ code: "AUTHENTICATION_REJECTED" });
    const verified = await client.post("/identity/otp/verify", {
      challengeId: challenge.body.challengeId, phone, purpose, code: challenge.body.developmentCode,
    });
    expect(verified.status).toBe(200);
    expect(typeof verified.body.accessCredential).toBe("string");
    const authenticated = client.withCredential(verified.body.accessCredential);
    const session = await authenticated.get("/identity/session");
    expect(session.status).toBe(200);
    expect(session.body.principal).toEqual(verified.body.principal);
    return { client: authenticated, principal: verified.body.principal as { userId: string; roles: string[] } };
  };

  const farmerView = async (bookingId: string, client = farmer) => client.get(`/farmer/bookings/${bookingId}`);
  const ownerView = async (bookingId: string) => owner.get(`/owner/bookings/${bookingId}`);

  /** Reads one booking through both clients and proves they agree on authoritative state. */
  const expectSharedState = async (bookingId: string): Promise<{ farmer: Json; owner: Json }> => {
    const [fromFarmer, fromOwner] = await Promise.all([farmerView(bookingId), ownerView(bookingId)]);
    expect(fromFarmer.status).toBe(200);
    expect(fromOwner.status).toBe(200);
    expect(sharedBookingState(fromFarmer.body)).toEqual(sharedBookingState(fromOwner.body));
    // Role-specific redaction: each party sees only its allowlisted counterpart fields.
    expect(partyOnlyFields(fromFarmer.body)).toEqual(["owner", "ownerContact", "viewerRole"]);
    expect(partyOnlyFields(fromOwner.body)).toEqual(["customer", "viewerRole"]);
    expect(fromFarmer.body.ownerContact).toEqual({ sharingPermitted: false });
    for (const body of [fromFarmer.body, fromOwner.body]) {
      const serialized = JSON.stringify(body);
      expect(serialized).not.toMatch(/customerId|ownerId|Ciphertext|LookupHash|phone/iu);
      expect(serialized).not.toContain("+91");
    }
    // Settlement and job views are party-independent projections of the same rows.
    const [farmerSettlement, ownerSettlement] = await Promise.all([
      farmer.get(`/farmer/bookings/${bookingId}/payments`), owner.get(`/owner/bookings/${bookingId}/payments`),
    ]);
    expect(farmerSettlement.status).toBe(200);
    expect(farmerSettlement.body).toEqual(ownerSettlement.body);
    expect(farmerSettlement.body.bookingStatus).toBe(fromFarmer.body.status);
    expect(farmerSettlement.body.settlement.status).toBe(fromFarmer.body.payment.status);
    return { farmer: fromFarmer.body, owner: fromOwner.body };
  };

  const expectJobViewsAgree = async (bookingId: string): Promise<Json> => {
    const [fromFarmer, fromOwner] = await Promise.all([
      farmer.get(`/farmer/bookings/${bookingId}/job`), owner.get(`/owner/bookings/${bookingId}/job`),
    ]);
    expect(fromFarmer.status).toBe(200);
    expect(fromOwner.status).toBe(200);
    for (const field of ["bookingStatus", "bookingVersion", "state", "activeMinutes", "invoice"]) {
      expect(fromFarmer.body[field]).toEqual(fromOwner.body[field]);
    }
    // Same measurements; the Farmer's copy omits the Owner's account identifier (Requirement 12.2).
    expect(fromFarmer.body.measurements).toEqual(
      fromOwner.body.measurements.map(({ submittedByUserId: _owner, ...measurement }: Json) => measurement));
    expect(JSON.stringify(fromFarmer.body)).not.toContain(ids.owner);
    return fromOwner.body;
  };

  const jobAction = async (bookingId: string, action: string, extra: Json = {}) => {
    const response = await owner.post(`/owner/bookings/${bookingId}/job/${action}`, { idempotencyKey: `job-${action}-${randomUUID()}`, ...extra });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return response.body;
  };

  const uploadDocument = async (tractorId: string, documentKind: string, bytes: Buffer, declaredMimeType = "application/pdf") => {
    const grant = await owner.post("/owner/documents/upload-grants", {
      tractorId, documentKind, fileName: `${documentKind.toLowerCase()}.pdf`, declaredMimeType, sizeBytes: bytes.length,
    });
    expect(grant.status, JSON.stringify(grant.body)).toBe(201);
    expect(grant.body.capabilityState).toBe("SANDBOX");
    expect(JSON.stringify(grant.body.document)).not.toMatch(/objectKey/iu);
    storage.upload(grant.body.grant.url, bytes, declaredMimeType);
    const completed = await owner.post(`/owner/documents/${grant.body.document.id}/complete`);
    expect(completed.status, JSON.stringify(completed.body)).toBe(201);
    return completed.body;
  };

  beforeAll(async () => {
    pool = new PgPoolAdapter(new Pool({ connectionString: databaseUrl, max: 8 }));
    database = await createTestDatabaseFactory({ databaseUrl: databaseUrl!, createPool: async () => pool })();
    // Reference data is operator-seeded (no API manages it): one service and one equipment type.
    await pool.query(
      `INSERT INTO public.services (id, stable_code, display_name) VALUES ($1, 'PLOUGHING', 'Ploughing')`,
      [SERVICE_PLOUGHING],
    );
    await pool.query(
      `INSERT INTO public.equipment_types (id, stable_code, display_name) VALUES ($1, 'CULTIVATOR', 'Cultivator')`,
      [EQUIPMENT_CULTIVATOR],
    );
    app = await NestFactory.create(AppModule.register({
      config: verticalSliceConfig(databaseUrl!),
      sqlPool: pool,
      secrets: ephemeralSecrets(),
      sandboxProviders: { OBJECT_STORAGE: storage },
      documentScanner: sandboxCleanScanner,
      domainClock: clock.now,
    }), { logger: false });
    await app.listen(0, "127.0.0.1");
    anonymous = new ApiClient(listeningBaseUrl(app), "kisan-e2e-anonymous");
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await database?.dispose();
  });

  it("signs the Owner and Farmers in through the labelled OTP sandbox with explicit roles", async () => {
    const signedOwner = await signIn(PHONES.owner, "REGISTER_OWNER", "kisan-e2e-owner");
    const signedFarmer = await signIn(PHONES.farmer, "REGISTER_FARMER", "kisan-e2e-farmer");
    const signedOther = await signIn(PHONES.otherFarmer, "REGISTER_FARMER", "kisan-e2e-other-farmer");
    owner = signedOwner.client;
    farmer = signedFarmer.client;
    otherFarmer = signedOther.client;
    ids.owner = signedOwner.principal.userId;
    ids.farmer = signedFarmer.principal.userId;
    expect(signedOwner.principal.roles).toEqual(["OWNER"]);
    expect(signedFarmer.principal.roles).toEqual(["FARMER"]);
    expect(new Set([ids.owner, ids.farmer, signedOther.principal.userId]).size).toBe(3);

    expect((await anonymous.get("/identity/session")).status).toBe(401);
    // Sign-in is audited without plaintext phone numbers or OTP material.
    const audits = await pool.query<{ action: string; outcome: string; text: string }>(
      "SELECT action, outcome, row_to_json(a)::text AS text FROM public.audit_events a WHERE action LIKE 'otp.%'");
    expect(audits.rows.filter((row) => row.action === "otp.verify" && row.outcome === "SUCCESS")).toHaveLength(3);
    expect(audits.rows.filter((row) => row.action === "otp.verify" && row.outcome === "REJECTED")).toHaveLength(3);
    for (const row of audits.rows) expect(row.text).not.toMatch(/98480|98765|9000000001/u);
  });

  it("onboards the Owner catalog until both Tractors are eligible, documented, priced, and online", async () => {
    const profile = await owner.put("/owner/profile", {
      fullName: "Raju Naik", preferredLocale: "te", contactSharingConsent: false, operatingLocation: places.tractorA(),
    });
    expect(profile.status, JSON.stringify(profile.body)).toBe(200);
    expect(profile.body).toMatchObject({ fullName: "Raju Naik", mobileVerified: true });

    const tractorA = await owner.post("/owner/tractors", {
      brand: "Mahindra", model: "575 DI", registrationNumber: "TS03AB1234", manufacturingYear: 2021, horsepower: 47,
      operatingLocation: places.tractorA(),
    });
    const tractorB = await owner.post("/owner/tractors", {
      brand: "Swaraj", model: "744 FE", registrationNumber: "TS02CD5678", manufacturingYear: 2020, horsepower: 48,
      operatingLocation: places.tractorB(),
    });
    expect([tractorA.status, tractorB.status]).toEqual([201, 201]);
    ids.tractorA = tractorA.body.id;
    ids.tractorB = tractorB.body.id;
    expect(tractorA.body).toMatchObject({ operationalStatus: "OFFLINE", eligibilityStatus: "INCOMPLETE" });

    // A new Tractor explains every unmet eligibility condition.
    const incomplete = await owner.post(`/owner/tractors/${ids.tractorA}/eligibility/evaluate`);
    expect(incomplete.body.discoverable).toBe(false);
    expect(incomplete.body.reasons.map((reason: Json) => reason.code)).toEqual(expect.arrayContaining([
      "REQUIRED_DOCUMENTS_MISSING", "ENABLED_SERVICE_OFFERING_MISSING", "ACTIVE_SERVICE_PRICING_MISSING",
    ]));

    const cultivator = await owner.post("/owner/equipment", {
      equipmentTypeId: EQUIPMENT_CULTIVATOR, displayName: "9-tine cultivator", tractorId: ids.tractorA,
    });
    expect(cultivator.status, JSON.stringify(cultivator.body)).toBe(201);

    const offeringA = await owner.put(`/owner/tractors/${ids.tractorA}/service-offerings`, {
      serviceId: SERVICE_PLOUGHING, equipmentId: cultivator.body.id, enabled: true,
    });
    const offeringB = await owner.put(`/owner/tractors/${ids.tractorB}/service-offerings`, {
      serviceId: SERVICE_PLOUGHING, enabled: true,
    });
    expect([offeringA.status, offeringB.status]).toEqual([200, 200]);
    ids.offeringA = offeringA.body.id;
    ids.offeringB = offeringB.body.id;

    const price = async (offeringId: string, rule: Json) => {
      const response = await owner.put(`/owner/service-offerings/${offeringId}/pricing-rules`, { enabled: true, ...rule });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      return response.body.id as string;
    };
    // PRD rates: ₹800/hour (proportional minutes), ₹1,200/acre, ₹1,500/trip.
    ids.hourlyA = await price(ids.offeringA, { method: "HOURLY", ratePaise: 80_000, roundingPolicy: "PROPORTIONAL_MINUTE" });
    ids.perTripA = await price(ids.offeringA, { method: "PER_TRIP", ratePaise: 150_000 });
    ids.perAcreB = await price(ids.offeringB, { method: "PER_ACRE", ratePaise: 120_000 });

    // Uploads are validated against the stored bytes: a PNG declared as PDF is rejected.
    const mislabelled = await uploadDocument(ids.tractorA, "INSURANCE", PNG_BYTES);
    expect(mislabelled).toMatchObject({ scanStatus: "REJECTED", rejectionCode: "MIME_SIGNATURE_MISMATCH" });
    for (const tractorId of [ids.tractorA, ids.tractorB]) {
      for (const kind of ["REGISTRATION_CERTIFICATE", "INSURANCE"]) {
        expect(await uploadDocument(tractorId, kind, PDF_BYTES)).toMatchObject({ scanStatus: "ACCEPTED", detectedMimeType: "application/pdf" });
      }
    }

    for (const tractorId of [ids.tractorA, ids.tractorB]) {
      const evaluated = await owner.post(`/owner/tractors/${tractorId}/eligibility/evaluate`);
      expect(evaluated.body, JSON.stringify(evaluated.body)).toMatchObject({ status: "ELIGIBLE", reasons: [] });
      const availability = await owner.get(`/owner/tractors/${tractorId}/availability`);
      const online = await owner.put(`/owner/tractors/${tractorId}/availability`, {
        status: "ONLINE", expectedVersion: availability.body.version,
      });
      expect(online.status, JSON.stringify(online.body)).toBe(200);
      expect(online.body).toMatchObject({ operationalStatus: "ONLINE", acceptingNewDemand: true });
    }

    // The Farmer client sees only enabled pricing for the offering (Requirement 6.4).
    const active = await farmer.get(`/farmer/service-offerings/${ids.offeringA}/pricing-rules`);
    expect(active.body.map((rule: Json) => rule.method).sort()).toEqual(["HOURLY", "PER_TRIP"]);
  });

  it("discovers from the selected Service Location, never the Farmer's own location", async () => {
    const search = (serviceLocation: Json, requestedInterval: Json, extra: Json = {}) =>
      farmer.post("/farmer/discovery/search", { serviceLocation, serviceId: SERVICE_PLOUGHING, requestedInterval, ...extra });

    const nearFarm = await search(places.farmerFarm(), interval(0, 3));
    expect(nearFarm.status, JSON.stringify(nearFarm.body)).toBe(201);
    expect(nearFarm.body.items.map((card: Json) => card.id)).toEqual([ids.tractorA]);
    expect(nearFarm.body).toMatchObject({ radiusKilometers: 5, defaultRadiusApplied: true });
    const card = nearFarm.body.items[0];
    expect(card.approximateDistance).toMatchObject({ isEstimate: true, exactCoordinatesExposed: false });
    expect(card.ownerDisplayName).toBeUndefined();
    expect(JSON.stringify(card)).not.toMatch(/latitude|longitude|registration|phone/iu);

    // Booking for someone else searches from the Recipient's farm in another city.
    const nearRecipient = await search(places.recipientFarm(), interval(0, 4), { pricingMethod: "PER_ACRE" });
    expect(nearRecipient.body.items.map((item: Json) => item.id)).toEqual([ids.tractorB]);

    const fromHomeCity = await search(places.farmerHomeCity(), interval(0, 4));
    expect(fromHomeCity.body.items).toEqual([]);
    expect(fromHomeCity.body.canExpandRadius).toBe(true);
  });

  it("creates self and someone-else bookings with Quote Snapshots and Farmer-scoped idempotency", async () => {
    const create = (body: Json, key: string) => farmer.post("/farmer/bookings", body, { "idempotency-key": key });
    const selfBody = {
      bookingTarget: "MYSELF", tractorId: ids.tractorA, serviceOfferingId: ids.offeringA, pricingRuleId: ids.hourlyA,
      pricingMethod: "HOURLY", expectedQuantity: "1.5", requestedInterval: interval(0, 3), serviceLocation: places.farmerFarm(),
    };
    const self = await create(selfBody, "farmer-self-1");
    expect(self.status, JSON.stringify(self.body)).toBe(201);
    expect(self.body).toMatchObject({
      viewerRole: "FARMER", status: "PENDING_OWNER_RESPONSE", bookingTarget: "MYSELF", version: 1,
      // The Owner did not consent to contact sharing, so the name is withheld as in discovery.
      owner: { displayName: "Tractor Owner" }, tractor: { id: ids.tractorA, brand: "Mahindra", model: "575 DI" },
      serviceName: "Ploughing", equipmentName: "9-tine cultivator",
      quoteSnapshot: {
        agreementVersion: 1, pricingRuleId: ids.hourlyA, method: "HOURLY", ratePaise: 80_000,
        roundingPolicy: "PROPORTIONAL_MINUTE", estimatedQuantity: "1.5", estimatedTotalPaise: 120_000,
      },
      payment: { status: "AWAITING_FINAL_BILL" },
    });
    expect(self.body.recipient).toBeUndefined();
    bookings.self = self.body.id;

    const overlap = await create({ ...selfBody, requestedInterval: interval(2, 4), expectedQuantity: "2" }, "farmer-overlap-1");
    expect(overlap.status).toBe(201);
    bookings.overlap = overlap.body.id;

    const otherBody = {
      bookingTarget: "SOMEONE_ELSE", tractorId: ids.tractorB, serviceOfferingId: ids.offeringB, pricingRuleId: ids.perAcreB,
      pricingMethod: "PER_ACRE", expectedQuantity: "3", requestedInterval: interval(0, 4), serviceLocation: places.recipientFarm(),
      recipient: { name: "Lakshmi Devi", coordinationPhone: PHONES.recipient, coordinationConsent: true, landmarkOrDirections: "Behind the Hanuman temple" },
    };
    const other = await create(otherBody, "farmer-other-1");
    expect(other.status, JSON.stringify(other.body)).toBe(201);
    expect(other.body).toMatchObject({
      bookingTarget: "SOMEONE_ELSE",
      recipient: { name: "Lakshmi Devi", landmarkOrDirections: "Behind the Hanuman temple" },
      serviceLocation: { district: "Karimnagar", village: "Rekurthi" },
      quoteSnapshot: { method: "PER_ACRE", ratePaise: 120_000, estimatedQuantity: "3", estimatedTotalPaise: 360_000 },
    });
    expect(JSON.stringify(other.body)).not.toContain(PHONES.recipient);
    bookings.other = other.body.id;

    // An equivalent retry returns the same booking; a changed request under the same key conflicts.
    const replay = await create(otherBody, "farmer-other-1");
    expect(replay.status).toBe(201);
    expect(sharedBookingState(replay.body)).toEqual(sharedBookingState(other.body));
    const reused = await create({ ...otherBody, expectedQuantity: "4" }, "farmer-other-1");
    expect(reused.status).toBe(409);

    const stored = await pool.query<{ customer_id: string; requests: string; recipients: string; plaintext: string }>(
      `SELECT b.customer_id,
         (SELECT count(*) FROM public.outbox_events o WHERE o.aggregate_id = b.id AND o.event_type = 'BookingRequested') AS requests,
         (SELECT count(*) FROM public.booking_recipients r WHERE r.booking_id = b.id) AS recipients,
         (SELECT count(*) FROM public.booking_recipients r WHERE r.booking_id = b.id
            AND position('9123456780' in encode(r.phone_ciphertext, 'escape')) > 0) AS plaintext
       FROM public.bookings b WHERE b.id = $1`, [bookings.other]);
    // The authenticated Farmer is the customer; the Recipient is a snapshot, not an account.
    expect(stored.rows[0]).toEqual({ customer_id: ids.farmer, requests: "1", recipients: "1", plaintext: "0" });
    expect((await pool.query("SELECT count(*)::int AS n FROM public.bookings")).rows[0]).toEqual({ n: 3 });
  });

  it("lets the Owner accept, refuses an overlapping acceptance, rejects with a reason, and permits adjacency", async () => {
    const requests = await owner.get("/owner/bookings");
    expect(requests.status).toBe(200);
    expect(requests.body.items.map((item: Json) => item.id).sort()).toEqual([bookings.self, bookings.overlap, bookings.other].sort());
    expect(requests.body.items.every((item: Json) => item.customer.displayName === "Farmer")).toBe(true);

    const pending = await expectSharedState(bookings.self);
    expect(pending.owner.status).toBe("PENDING_OWNER_RESPONSE");

    const accept = (bookingId: string, expectedVersion: number) => owner.post(`/owner/bookings/${bookingId}/accept`, { expectedVersion });
    const accepted = await accept(bookings.self, pending.owner.version);
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(201);
    expect(accepted.body).toMatchObject({ viewerRole: "OWNER", status: "ACCEPTED", version: pending.owner.version + 1 });

    const overlapBefore = await ownerView(bookings.overlap);
    const conflict = await accept(bookings.overlap, overlapBefore.body.version);
    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({ code: "BOOKING_CONFLICT", reason: "OVERLAP" });
    const overlapAfter = await ownerView(bookings.overlap);
    expect(sharedBookingState(overlapAfter.body)).toEqual(sharedBookingState(overlapBefore.body));

    expect((await owner.post(`/owner/bookings/${bookings.overlap}/reject`, { expectedVersion: overlapAfter.body.version })).status).toBe(422);
    const rejected = await owner.post(`/owner/bookings/${bookings.overlap}/reject`, {
      expectedVersion: overlapAfter.body.version, reason: "Tractor already booked for this slot",
    });
    expect(rejected.body).toMatchObject({ status: "REJECTED" });

    const other = await ownerView(bookings.other);
    expect((await accept(bookings.other, other.body.version)).body).toMatchObject({ status: "ACCEPTED" });

    // Adjacent half-open intervals remain discoverable and acceptable (Requirement 8.7).
    const adjacentSearch = await farmer.post("/farmer/discovery/search", {
      serviceLocation: places.farmerFarm(), serviceId: SERVICE_PLOUGHING, requestedInterval: interval(3, 5), pricingMethod: "PER_TRIP",
    });
    expect(adjacentSearch.body.items.map((item: Json) => item.id)).toEqual([ids.tractorA]);
    const overlappingSearch = await farmer.post("/farmer/discovery/search", {
      serviceLocation: places.farmerFarm(), serviceId: SERVICE_PLOUGHING, requestedInterval: interval(2, 4),
    });
    expect(overlappingSearch.body.items).toEqual([]);
    const adjacent = await farmer.post("/farmer/bookings", {
      bookingTarget: "MYSELF", tractorId: ids.tractorA, serviceOfferingId: ids.offeringA, pricingRuleId: ids.perTripA,
      pricingMethod: "PER_TRIP", expectedQuantity: "2", requestedInterval: interval(3, 5), serviceLocation: places.farmerFarm(),
    }, { "idempotency-key": "farmer-adjacent-1" });
    expect(adjacent.status, JSON.stringify(adjacent.body)).toBe(201);
    bookings.adjacent = adjacent.body.id;
    expect((await accept(bookings.adjacent, adjacent.body.version)).body).toMatchObject({ status: "ACCEPTED" });
  });

  it("denies unrelated principals and wrong roles without revealing the booking", async () => {
    expect((await farmerView(bookings.self, otherFarmer)).status).toBe(404);
    expect((await otherFarmer.get("/farmer/bookings")).body).toEqual({ items: [] });
    expect((await otherFarmer.get(`/farmer/bookings/${bookings.self}/payments`)).status).toBe(404);
    expect((await farmer.get(`/owner/bookings/${bookings.self}`)).status).toBe(404);
    expect((await owner.get(`/farmer/bookings/${bookings.self}`)).status).toBe(404);
    expect((await farmer.post(`/owner/bookings/${bookings.other}/accept`, { expectedVersion: 1 })).status).toBe(404);
    expect((await anonymous.get(`/farmer/bookings/${bookings.self}`)).status).toBe(401);
    expect((await farmer.get("/farmer/bookings/not-a-booking-id")).status).toBe(404);
  });

  it("tracks work and issues PRD final bills for hourly, per-acre, and per-trip agreements", async () => {
    // 40 active minutes, a 10-minute pause, then 50 more: 90 billable proportional minutes.
    await jobAction(bookings.self, "start");
    clock.advanceMinutes(40);
    await jobAction(bookings.self, "pause");
    clock.advanceMinutes(10);
    await jobAction(bookings.self, "resume");
    clock.advanceMinutes(50);
    const hourly = await jobAction(bookings.self, "complete");
    expect(hourly).toMatchObject({ state: "COMPLETED", activeMinutes: 90, bookingStatus: "FINAL_BILL_GENERATED" });
    expect(hourly.invoice).toMatchObject({ method: "HOURLY", ratePaise: 80_000, totalPaise: 120_000, invoiceVersion: 1, status: "ISSUED" });

    const late = await owner.post(`/owner/bookings/${bookings.self}/job/pause`, { idempotencyKey: "late-pause" });
    expect(late.status).toBe(409);
    expect(late.body).toMatchObject({ code: "WORK_EVENT_OUT_OF_SEQUENCE", validNextActions: [] });

    await jobAction(bookings.other, "start");
    clock.advanceMinutes(120);
    const perAcre = await jobAction(bookings.other, "complete", { completedQuantity: "3" });
    // Quantities are stored with the configured three-decimal precision.
    expect(perAcre.invoice).toMatchObject({ method: "PER_ACRE", ratePaise: 120_000, billableQuantity: "3.000", totalPaise: 360_000 });

    await jobAction(bookings.adjacent, "start");
    clock.advanceMinutes(90);
    const perTrip = await jobAction(bookings.adjacent, "complete", { completedQuantity: 2 });
    expect(perTrip.invoice).toMatchObject({ method: "PER_TRIP", ratePaise: 150_000, totalPaise: 300_000 });
    expect(Number(perTrip.invoice.billableQuantity)).toBe(2);

    for (const bookingId of [bookings.self, bookings.other, bookings.adjacent]) {
      const job = await expectJobViewsAgree(bookingId);
      const views = await expectSharedState(bookingId);
      expect(views.farmer.status).toBe("FINAL_BILL_GENERATED");
      expect(views.farmer.invoice).toMatchObject({ id: job.invoice.id, totalPaise: job.invoice.totalPaise, status: "ISSUED" });
      expect(views.farmer.payment).toMatchObject({ status: "PAYMENT_DUE", totalPaise: job.invoice.totalPaise, outstandingPaise: job.invoice.totalPaise });
    }
  });

  it("records the Farmer's dispute, preserves the bill, and blocks unreviewed settlement", async () => {
    const before = await farmerView(bookings.other);
    expect((await farmer.post(`/farmer/bookings/${bookings.other}/dispute`, { expectedVersion: before.body.version })).status).toBe(422);
    const disputed = await farmer.post(`/farmer/bookings/${bookings.other}/dispute`, {
      expectedVersion: before.body.version, reason: "Only 2.5 acres were ploughed",
    });
    expect(disputed.status, JSON.stringify(disputed.body)).toBe(201);
    expect(disputed.body.status).toBe("DISPUTED");

    const cash = await owner.post(`/owner/bookings/${bookings.other}/payments/cash`, {
      invoiceId: before.body.invoice.id, amountPaise: 360_000, idempotencyKey: "cash-disputed-1",
    });
    expect(cash.status).toBe(409);
    expect(cash.body.code).toBe("PAYMENT_SETTLEMENT_BLOCKED");

    const views = await expectSharedState(bookings.other);
    expect(views.farmer.status).toBe("DISPUTED");
    expect(views.farmer.invoice).toEqual(before.body.invoice);
    expect(views.farmer.payment).toMatchObject({ settlementBlocked: true, settled: false, amountPaise: 0 });
    const job = await expectJobViewsAgree(bookings.other);
    expect(job.invoice).toMatchObject({ id: before.body.invoice.id, invoiceVersion: 1, totalPaise: 360_000 });
    expect((await pool.query("SELECT count(*)::int AS n FROM public.payments")).rows[0]).toEqual({ n: 0 });
  });

  it("records cash once per key, completes settled bookings, and issues matching receipts to both parties", async () => {
    const self = await farmerView(bookings.self);
    const cash = (bookingId: string, invoiceId: string, amountPaise: number, idempotencyKey: string) =>
      owner.post(`/owner/bookings/${bookingId}/payments/cash`, { invoiceId, amountPaise, idempotencyKey });

    const paid = await cash(bookings.self, self.body.invoice.id, 120_000, "cash-self-1");
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    expect(paid.body.payment).toMatchObject({ method: "CASH", status: "PAID_CASH", amountPaise: 120_000, confirmedBy: "OWNER" });
    expect(paid.body.settlement).toMatchObject({ bookingStatus: "COMPLETED", settlement: { settled: true, status: "PAID_CASH" } });
    const retried = await cash(bookings.self, self.body.invoice.id, 120_000, "cash-self-1");
    expect(retried.body.payment.id).toBe(paid.body.payment.id);

    const adjacent = await farmerView(bookings.adjacent);
    const partial = await cash(bookings.adjacent, adjacent.body.invoice.id, 100_000, "cash-adjacent-1");
    expect(partial.body.settlement).toMatchObject({ bookingStatus: "PAYMENT_RECORDED", settlement: { settled: false, outstandingPaise: 200_000 } });
    // A receipt exists only once the bill is fully settled (Requirement 11.8).
    const early = await farmer.get(`/farmer/payments/${partial.body.payment.id}/receipt`);
    expect(early.status).toBe(409);
    expect((await cash(bookings.adjacent, adjacent.body.invoice.id, 250_000, "cash-adjacent-over")).body.code).toBe("PAYMENT_OVERPAYMENT");
    const rest = await cash(bookings.adjacent, adjacent.body.invoice.id, 200_000, "cash-adjacent-2");
    expect(rest.body.settlement).toMatchObject({ bookingStatus: "COMPLETED", settlement: { settled: true, appliedPaise: 300_000 } });

    for (const [bookingId, paymentId, amount, total] of [
      [bookings.self, paid.body.payment.id, 120_000, 120_000],
      [bookings.adjacent, rest.body.payment.id, 200_000, 300_000],
    ] as const) {
      const views = await expectSharedState(bookingId);
      expect(views.farmer.status).toBe("COMPLETED");
      expect(views.farmer.payment).toMatchObject({ status: "PAID_CASH", settled: true, method: "CASH", amountPaise: total, outstandingPaise: 0 });
      const [farmerReceipt, ownerReceipt] = await Promise.all([
        farmer.get(`/farmer/payments/${paymentId}/receipt`), owner.get(`/owner/payments/${paymentId}/receipt`),
      ]);
      expect(farmerReceipt.status).toBe(200);
      expect(farmerReceipt.body).toEqual(ownerReceipt.body);
      expect(farmerReceipt.body).toMatchObject({
        bookingId, bookingReference: views.farmer.publicReference, invoiceId: views.farmer.invoice.id,
        invoiceVersion: 1, invoiceTotalPaise: total, paymentId, method: "CASH", status: "PAID_CASH",
        settlementStatus: "PAID_CASH", amountPaise: amount, currency: "INR", confirmedBy: "OWNER",
      });
      expect(Number.isNaN(new Date(farmerReceipt.body.paidAt).getTime())).toBe(false);
      expect((await otherFarmer.get(`/farmer/payments/${paymentId}/receipt`)).status).toBe(404);
    }
    expect((await pool.query("SELECT count(*)::int AS n FROM public.payments")).rows[0]).toEqual({ n: 3 });
  });

  it("keeps a lifecycle-valid status history that both parties read identically", async () => {
    const expected: Record<string, readonly string[]> = {
      [bookings.self]: ["PENDING_OWNER_RESPONSE", "ACCEPTED", "IN_PROGRESS", "WORK_COMPLETED", "FINAL_BILL_GENERATED", "PAYMENT_RECORDED", "COMPLETED"],
      [bookings.adjacent]: ["PENDING_OWNER_RESPONSE", "ACCEPTED", "IN_PROGRESS", "WORK_COMPLETED", "FINAL_BILL_GENERATED", "PAYMENT_RECORDED", "COMPLETED"],
      [bookings.other]: ["PENDING_OWNER_RESPONSE", "ACCEPTED", "IN_PROGRESS", "WORK_COMPLETED", "FINAL_BILL_GENERATED", "DISPUTED"],
      [bookings.overlap]: ["PENDING_OWNER_RESPONSE", "REJECTED"],
    };
    const actorFor: Readonly<Record<string, string>> = {
      PENDING_OWNER_RESPONSE: "FARMER", ACCEPTED: "OWNER", REJECTED: "OWNER", IN_PROGRESS: "OWNER", WORK_COMPLETED: "OWNER",
      FINAL_BILL_GENERATED: "SYSTEM", PAYMENT_RECORDED: "SYSTEM", COMPLETED: "SYSTEM", DISPUTED: "FARMER",
    };
    const visited = new Set<string>();
    for (const [bookingId, statuses] of Object.entries(expected)) {
      const { farmer: view } = await expectSharedState(bookingId);
      const history = view.statusHistory as Json[];
      expect(history.map((entry) => entry.toStatus)).toEqual(statuses);
      expect(history[0]!.fromStatus).toBeUndefined();
      history.forEach((entry, index) => {
        visited.add(entry.toStatus);
        expect(entry.actor).toBe(actorFor[entry.toStatus]);
        if (index === 0) return;
        // Every recorded edge is a permitted transition from the previous status (Requirement 8.8).
        expect(entry.fromStatus).toBe(history[index - 1]!.toStatus);
        expect(BOOKING_TRANSITION_TABLE.some((rule) => rule.from === entry.fromStatus && rule.to === entry.toStatus)).toBe(true);
        expect(new Date(entry.occurredAt).getTime()).toBeGreaterThanOrEqual(new Date(history[index - 1]!.occurredAt).getTime());
      });
      expect(view.status).toBe(statuses.at(-1));
    }
    expect((await farmerView(bookings.overlap)).body.statusHistory.at(-1)).toMatchObject({ reason: "Tractor already booked for this slot" });
    expect([...visited].sort()).toEqual([
      "ACCEPTED", "COMPLETED", "DISPUTED", "FINAL_BILL_GENERATED", "IN_PROGRESS", "PAYMENT_RECORDED",
      "PENDING_OWNER_RESPONSE", "REJECTED", "WORK_COMPLETED",
    ]);

    // The history list is cursor-paginated, newest first, and complete across pages.
    const first = await farmer.get("/farmer/bookings?limit=3");
    expect(first.body.items).toHaveLength(3);
    const second = await farmer.get(`/farmer/bookings?limit=3&cursor=${encodeURIComponent(first.body.nextCursor)}`);
    expect(second.body.nextCursor).toBeUndefined();
    const listed = [...first.body.items, ...second.body.items];
    expect(listed.map((item: Json) => item.id).sort()).toEqual(Object.values(bookings).sort());
    expect(listed.map((item: Json) => item.createdAt)).toEqual([...listed.map((item: Json) => item.createdAt)].sort().reverse());
    expect((await farmer.get("/farmer/bookings?limit=0")).status).toBe(422);
  });

  it("wrote one outbox event per domain transition in the same transactions", async () => {
    const result = await pool.query<{ aggregate_id: string; event_type: string }>(
      "SELECT aggregate_id, event_type FROM public.outbox_events ORDER BY created_at, event_type");
    const eventsFor = (aggregateId: string) => result.rows.filter((row) => row.aggregate_id === aggregateId).map((row) => row.event_type).sort();
    const settledEvents = [
      "BookingAccepted", "BookingCompleted", "BookingPaymentRecorded", "BookingRequested", "FinalBillGenerated",
      "WorkComplete", "WorkStart",
    ];
    expect(eventsFor(bookings.self)).toEqual([...settledEvents, "WorkPause", "WorkResume"].sort());
    expect(eventsFor(bookings.adjacent)).toEqual(settledEvents);
    expect(eventsFor(bookings.other)).toEqual(["BookingAccepted", "BookingDisputed", "BookingRequested", "FinalBillGenerated", "WorkComplete", "WorkStart"]);
    expect(eventsFor(bookings.overlap)).toEqual(["BookingRejected", "BookingRequested"]);
    expect(result.rows.filter((row) => row.event_type === "CashPaymentRecorded")).toHaveLength(3);
    expect(eventsFor(ids.tractorA)).toEqual(["TractorAvailabilityChanged"]);
    expect(eventsFor(ids.tractorB)).toEqual(["TractorAvailabilityChanged"]);
  });

  it("reveals the Owner's name to the booking Farmer only after the Owner enables contact sharing", async () => {
    const profile = await owner.get("/owner/profile");
    const updated = await owner.put("/owner/profile", {
      fullName: "Raju Naik", preferredLocale: "te", contactSharingConsent: true,
      operatingLocation: places.tractorA(), expectedVersion: profile.body.version,
    });
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    const view = await farmerView(bookings.self);
    expect(view.body.owner).toEqual({ displayName: "Raju Naik" });
    expect(view.body.ownerContact).toEqual({ sharingPermitted: true });
    // Phase 1 never returns a phone number; consent-aware phone sharing is a Phase 2 capability.
    expect(JSON.stringify(view.body)).not.toMatch(/phone|\+91/iu);
  });

  // Thin UI smoke: the built web app renders the same booking for both roles from this API.
  const browserPath = findBrowserExecutable();
  const itBrowser = process.env.VERTICAL_SLICE_E2E_BROWSER === "1" && browserPath !== undefined ? it : it.skip;
  itBrowser("renders the same booking, quote, and final bill in the Farmer and Owner web screens", async () => {
    const previousApiOrigin = process.env.PUBLIC_API_ORIGIN;
    process.env.PUBLIC_API_ORIGIN = anonymous.baseUrl;
    let web: ProductionServer | undefined;
    let browser: HeadlessBrowser | undefined;
    try {
      web = await startProductionServer();
      browser = await HeadlessBrowser.launch(browserPath!);
      const render = async (credential: string, path: string): Promise<string> => {
        const page = await browser!.newPage();
        await page.send("Network.setCookie", { name: "kt_access_token", value: credential, url: web!.origin });
        await page.send("Network.setCookie", { name: "kt_locale", value: "en", url: web!.origin });
        await page.navigate(`${web!.origin}${path}`);
        const text = await page.evaluate<string>("document.body.innerText");
        await page.close();
        return text.replace(/\s+/gu, " ");
      };
      const view = (await farmerView(bookings.self)).body;
      const finalTotal = formatIndianCurrency("en", view.invoice.totalPaise).replace(/\s+/gu, " ");
      const estimate = formatIndianCurrency("en", view.quoteSnapshot.estimatedTotalPaise).replace(/\s+/gu, " ");
      const farmerScreen = await render(farmer.accessCredential!, `/farmer/bookings/${bookings.self}`);
      const ownerScreen = await render(owner.accessCredential!, `/owner/bookings/${bookings.self}`);
      for (const screen of [farmerScreen, ownerScreen]) {
        expect(screen).toContain(view.publicReference);
        expect(screen).toContain(estimate);
        expect(screen).toContain(finalTotal);
        expect(screen).not.toContain("+91");
      }
      expect(farmerScreen).toContain("Mahindra 575 DI");
      // Cross-role pages stay closed in the browser too.
      expect(await render(farmer.accessCredential!, `/owner/bookings/${bookings.self}`)).not.toContain(view.publicReference);
    } finally {
      await browser?.close();
      await web?.stop();
      if (previousApiOrigin === undefined) delete process.env.PUBLIC_API_ORIGIN;
      else process.env.PUBLIC_API_ORIGIN = previousApiOrigin;
    }
  }, 180_000);

  it("revokes a session so the same credential stops working", async () => {
    expect((await otherFarmer.post("/identity/session/revoke")).status).toBe(204);
    expect((await otherFarmer.get("/identity/session")).status).toBe(401);
    expect((await otherFarmer.get("/farmer/bookings")).status).toBe(401);
  });

  it("refuses account deletion while bookings are open and erases an account without them (Requirement 12.5)", async () => {
    // The Farmer still has a disputed booking, so deletion waits and nothing changes.
    const refused = await farmer.post("/account/deletion", { confirmation: "DELETE_MY_ACCOUNT" });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: "ACCOUNT_HAS_OPEN_BOOKINGS" });
    expect((await farmer.get("/identity/session")).status).toBe(200);
    expect((await farmerView(bookings.self)).status).toBe(200);

    const phone = "9555512345";
    const leaving = await signIn(phone, "REGISTER_FARMER", "kisan-e2e-leaving");
    expect((await leaving.client.post("/account/deletion", {})).status).toBe(422);
    const erased = await leaving.client.post("/account/deletion", { confirmation: "DELETE_MY_ACCOUNT" });
    expect(erased.status).toBe(200);
    expect(erased.headers.get("cache-control")).toBe("no-store");
    expect(erased.body).toMatchObject({ status: "ERASED", erased: { sessionsRevoked: 1, rolesRevoked: 1 }, retained: { bookings: 0 } });
    expect(JSON.stringify(erased.body)).not.toContain(phone);
    expect((await leaving.client.get("/identity/session")).status).toBe(401);
    // The number can register again as a new, unlinked account.
    const returning = await signIn(phone, "REGISTER_FARMER", "kisan-e2e-returning");
    expect(returning.principal.userId).not.toBe(leaving.principal.userId);
  });
});
