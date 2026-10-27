import type { AuthPrincipal, PaymentRecordSource } from "@kisantractor/domain";
import { describe, expect, it } from "vitest";

import type { BookingRequestContext } from "./booking.contracts.js";
import type {
  BookingDetailSource,
  BookingHistorySource,
  BookingListPosition,
  BookingQueryStore,
  BookingViewerRole,
  BookingViewSource,
} from "./booking-query.contracts.js";
import { BookingNotFoundError, BookingQueryService, BookingQueryValidationError, orderStatusHistory } from "./booking-query.service.js";

const FARMER_ID = "10000000-0000-4000-8000-000000000001";
const OWNER_ID = "10000000-0000-4000-8000-000000000002";
const BOOKING_ID = "20000000-0000-4000-8000-000000000001";
const context: BookingRequestContext = { correlationId: "corr-query", actorChannel: "WEB" };
const farmer: AuthPrincipal = { userId: FARMER_ID, sessionId: "s-farmer", roles: ["FARMER"] };
const owner: AuthPrincipal = { userId: OWNER_ID, sessionId: "s-owner", roles: ["OWNER"] };
const at = (minutes: number) => new Date(Date.UTC(2026, 2, 1, 4, minutes));

const booking = (overrides: Partial<BookingViewSource> = {}): BookingViewSource => ({
  id: BOOKING_ID,
  publicReference: "KT-ABC123",
  customerId: FARMER_ID,
  ownerId: OWNER_ID,
  status: "FINAL_BILL_GENERATED",
  version: 6,
  hasRecipient: true,
  requestedInterval: { start: at(0), end: at(240) },
  serviceLocation: {
    state: "Telangana", district: "Karimnagar", mandalOrTaluk: "Karimnagar", village: "Rekurthi",
    source: "MANUAL_ADDRESS", capturedAt: at(0), collectionPurpose: "SERVICE_LOCATION",
  },
  tractor: { id: "30000000-0000-4000-8000-000000000001", brand: "Swaraj", model: "744 FE" },
  serviceName: "Ploughing",
  customerName: "Anita Rao",
  ownerName: "Raju Naik",
  ownerContactSharingConsent: false,
  recipient: { name: "Lakshmi Devi", landmarkOrDirections: "Behind the temple" },
  quoteSnapshot: {
    agreementVersion: 1, pricingRuleId: "40000000-0000-4000-8000-000000000001", pricingRuleVersion: 1,
    method: "PER_ACRE", ratePaise: 120_000, currency: "INR", estimatedQuantity: "3",
    estimatedTotalPaise: 360_000, disclosedAt: at(0),
  },
  invoice: {
    id: "50000000-0000-4000-8000-000000000001", bookingId: BOOKING_ID, invoiceVersion: 1, status: "ISSUED",
    totalPaise: 360_000, currency: "INR", formula: "rate × acres",
  },
  createdAt: at(0),
  updatedAt: at(200),
  ...overrides,
});

const cash = (amountPaise: number, minute: number): PaymentRecordSource => ({
  id: `60000000-0000-4000-8000-00000000000${minute}`,
  invoiceId: "50000000-0000-4000-8000-000000000001",
  method: "CASH", status: "PAID_CASH", amountPaise, currency: "INR",
  recordedByUserId: OWNER_ID, receivedAt: at(minute), createdAt: at(minute),
});

class MemoryQueryStore implements BookingQueryStore {
  readonly listCalls: Array<{ viewerId: string; viewerRole: BookingViewerRole; limit: number; after?: BookingListPosition }> = [];
  constructor(
    private readonly rows: readonly BookingViewSource[],
    private readonly payments: readonly PaymentRecordSource[] = [],
    private readonly history: readonly BookingHistorySource[] = [],
  ) {}

  async loadBookingDetail(query: { viewerId: string; viewerRole: BookingViewerRole; bookingId: string }): Promise<BookingDetailSource | undefined> {
    const row = this.rows.find((candidate) => candidate.id === query.bookingId
      && (query.viewerRole === "FARMER" ? candidate.customerId : candidate.ownerId) === query.viewerId);
    return row === undefined ? undefined : { booking: row, payments: this.payments, history: this.history };
  }

  async listBookings(query: { viewerId: string; viewerRole: BookingViewerRole; limit: number; after?: BookingListPosition }) {
    this.listCalls.push(query);
    return this.rows
      .filter((row) => (query.viewerRole === "FARMER" ? row.customerId : row.ownerId) === query.viewerId)
      // Compares like PostgreSQL: (created_at, id) < cursor, at microsecond precision.
      .filter((row) => {
        if (query.after === undefined) return true;
        const position = row.cursorCreatedAt ?? row.createdAt.toISOString();
        return position < query.after.createdAt || (position === query.after.createdAt && row.id < query.after.id);
      })
      .slice(0, query.limit);
  }
}

const history: BookingHistorySource[] = [
  // Stored out of order; the two FINAL bill rows share one instant.
  { fromStatus: "WORK_COMPLETED", toStatus: "FINAL_BILL_GENERATED", actorChannel: "SYSTEM", occurredAt: at(200) },
  { toStatus: "PENDING_OWNER_RESPONSE", actorId: FARMER_ID, actorChannel: "WEB", occurredAt: at(0) },
  { fromStatus: "IN_PROGRESS", toStatus: "WORK_COMPLETED", actorId: OWNER_ID, actorChannel: "WEB", occurredAt: at(200) },
  { fromStatus: "PENDING_OWNER_RESPONSE", toStatus: "ACCEPTED", actorId: OWNER_ID, actorChannel: "WEB", occurredAt: at(5) },
  { fromStatus: "ACCEPTED", toStatus: "IN_PROGRESS", actorId: OWNER_ID, actorChannel: "WEB", occurredAt: at(80) },
];

describe("BookingQueryService", () => {
  it("returns identical authoritative state to both parties with party-specific redaction", async () => {
    const service = new BookingQueryService(new MemoryQueryStore([booking()], [cash(100_000, 210)], history));
    const fromFarmer = await service.getBooking(farmer, BOOKING_ID, "FARMER", context) as unknown as Record<string, unknown>;
    const fromOwner = await service.getBooking(owner, BOOKING_ID, "OWNER", context) as unknown as Record<string, unknown>;

    const { viewerRole: _farmerRole, owner: ownerName, ownerContact, ...farmerShared } = fromFarmer;
    const { viewerRole: _ownerRole, customer, ...ownerShared } = fromOwner;
    expect(farmerShared).toEqual(ownerShared);
    // Without contact-sharing consent the Owner's name is withheld, as in discovery.
    expect(ownerName).toEqual({ displayName: "Tractor Owner" });
    expect(ownerContact).toEqual({ sharingPermitted: false });
    expect(customer).toEqual({ displayName: "Anita Rao" });
    for (const view of [fromFarmer, fromOwner]) {
      expect(JSON.stringify(view)).not.toMatch(/customerId|ownerId|actorId|10000000-0000/u);
    }
    expect(fromFarmer.payment).toEqual({
      status: "PAYMENT_DUE", totalPaise: 360_000, amountPaise: 100_000, outstandingPaise: 260_000, settled: false,
      settlementBlocked: false, methods: ["CASH"], method: "CASH", recordedAt: at(210),
    });
    expect((fromFarmer.statusHistory as Array<{ toStatus: string; actor: string }>).map((entry) => [entry.toStatus, entry.actor])).toEqual([
      ["PENDING_OWNER_RESPONSE", "FARMER"], ["ACCEPTED", "OWNER"], ["IN_PROGRESS", "OWNER"],
      ["WORK_COMPLETED", "OWNER"], ["FINAL_BILL_GENERATED", "SYSTEM"],
    ]);
  });

  it("shows the Owner's name once contact sharing is enabled and blocks settlement while disputed", async () => {
    const service = new BookingQueryService(new MemoryQueryStore([booking({ ownerContactSharingConsent: true, status: "DISPUTED", customerName: undefined })]));
    const fromFarmer = await service.getBooking(farmer, BOOKING_ID, "FARMER", context);
    expect(fromFarmer).toMatchObject({ owner: { displayName: "Raju Naik" }, ownerContact: { sharingPermitted: true } });
    expect(fromFarmer.payment).toMatchObject({ settlementBlocked: true, status: "PAYMENT_DUE" });
    expect(await service.getBooking(owner, BOOKING_ID, "OWNER", context)).toMatchObject({ customer: { displayName: "Farmer" } });
  });

  it("treats unrelated principals, wrong roles, and malformed identifiers as not found", async () => {
    const service = new BookingQueryService(new MemoryQueryStore([booking()]));
    const stranger: AuthPrincipal = { userId: "10000000-0000-4000-8000-000000000009", sessionId: "s", roles: ["FARMER", "OWNER"] };
    await expect(service.getBooking(stranger, BOOKING_ID, "FARMER", context)).rejects.toBeInstanceOf(BookingNotFoundError);
    await expect(service.getBooking(stranger, BOOKING_ID, "OWNER", context)).rejects.toBeInstanceOf(BookingNotFoundError);
    await expect(service.getBooking(farmer, BOOKING_ID, "OWNER", context)).rejects.toBeInstanceOf(BookingNotFoundError);
    await expect(service.getBooking(farmer, "not-a-uuid", "FARMER", context)).rejects.toBeInstanceOf(BookingNotFoundError);
  });

  it("pages newest first with an opaque cursor and bounded page sizes", async () => {
    const rows = [3, 2, 1].map((index) => booking({ id: `20000000-0000-4000-8000-00000000000${index}`, createdAt: at(index) }));
    const store = new MemoryQueryStore(rows);
    const service = new BookingQueryService(store);
    const first = await service.listBookings(farmer, "FARMER", { limit: 2 }, context);
    expect(first.items.map((item) => item.id)).toEqual([rows[0]!.id, rows[1]!.id]);
    expect(first.items[0]).not.toHaveProperty("statusHistory");
    expect(store.listCalls[0]).toMatchObject({ viewerId: FARMER_ID, viewerRole: "FARMER", limit: 3 });
    const second = await service.listBookings(farmer, "FARMER", { limit: 2, cursor: first.nextCursor! }, context);
    expect(second.items.map((item) => item.id)).toEqual([rows[2]!.id]);
    expect(second.nextCursor).toBeUndefined();
    await expect(service.listBookings(farmer, "FARMER", { limit: 51 }, context)).rejects.toBeInstanceOf(BookingQueryValidationError);
    await expect(service.listBookings(farmer, "FARMER", { cursor: "%%%" }, context)).rejects.toBeInstanceOf(BookingQueryValidationError);
    expect((await service.listBookings(owner, "OWNER", {}, context)).items).toHaveLength(3);
  });

  it("keeps microsecond cursor positions so bookings committed in the same millisecond are not skipped", async () => {
    // Three bookings in one millisecond, newest first; a JS Date sees them all as .123.
    const rows = ["789", "456", "123"].map((micros, index) => booking({
      id: `20000000-0000-4000-8000-00000000001${index}`,
      createdAt: new Date("2025-03-01T10:00:00.123Z"),
      cursorCreatedAt: `2025-03-01T10:00:00.123${micros}Z`,
    }));
    const service = new BookingQueryService(new MemoryQueryStore(rows));
    const first = await service.listBookings(farmer, "FARMER", { limit: 1 }, context);
    expect(JSON.parse(Buffer.from(first.nextCursor!, "base64url").toString("utf8")).c).toBe("2025-03-01T10:00:00.123789Z");
    const second = await service.listBookings(farmer, "FARMER", { limit: 1, cursor: first.nextCursor! }, context);
    const third = await service.listBookings(farmer, "FARMER", { limit: 1, cursor: second.nextCursor! }, context);
    expect([...first.items, ...second.items, ...third.items].map((item) => item.id)).toEqual(rows.map((row) => row.id));
    expect(third.nextCursor).toBeUndefined();
    // Cursors issued before this change carried milliseconds and still decode.
    const legacy = Buffer.from(JSON.stringify({ c: "2025-03-01T10:00:00.124Z", i: rows[0]!.id }), "utf8").toString("base64url");
    expect((await service.listBookings(farmer, "FARMER", { cursor: legacy }, context)).items).toHaveLength(3);
    const local = Buffer.from(JSON.stringify({ c: "2025-03-01 10:00:00", i: rows[0]!.id }), "utf8").toString("base64url");
    await expect(service.listBookings(farmer, "FARMER", { cursor: local }, context)).rejects.toBeInstanceOf(BookingQueryValidationError);
  });
});

describe("orderStatusHistory", () => {
  it("orders by time and resolves same-instant transitions by the status chain", () => {
    expect(orderStatusHistory(history).map((entry) => entry.toStatus)).toEqual([
      "PENDING_OWNER_RESPONSE", "ACCEPTED", "IN_PROGRESS", "WORK_COMPLETED", "FINAL_BILL_GENERATED",
    ]);
  });
});
