import {
  MAX_PAYMENT_RECORDS_PER_INVOICE,
  summarizeInvoiceSettlement,
  type AuthPrincipal,
} from "@kisantractor/domain";

import { toLedgerEntry, toPayableInvoice } from "../payment/payment.service.js";
import type { BookingRequestContext } from "./booking.contracts.js";
import type {
  BookingDetailSource,
  BookingHistoryActor,
  BookingHistorySource,
  BookingListPosition,
  BookingPartyView,
  BookingPartyViewPage,
  BookingPaymentSummary,
  BookingQueryStore,
  BookingStatusHistoryEntry,
  BookingViewerRole,
  BookingViewSource,
  SharedBookingView,
} from "./booking-query.contracts.js";

/** Missing, malformed, and unrelated bookings are indistinguishable to the caller. */
export class BookingNotFoundError extends Error {
  readonly code = "NOT_FOUND";
  constructor() {
    super("The booking is unavailable for this account");
    this.name = "BookingNotFoundError";
  }
}

export class BookingQueryValidationError extends Error {
  readonly code = "BOOKING_QUERY_INVALID";
  constructor(readonly field: string, message: string) {
    super(message);
    this.name = "BookingQueryValidationError";
  }
}

export const DEFAULT_BOOKING_PAGE_SIZE = 20;
export const MAXIMUM_BOOKING_PAGE_SIZE = 50;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
/** Shown when a party has not registered a profile name; the UI never receives an empty name. */
const FALLBACK_FARMER_NAME = "Farmer";
const FALLBACK_OWNER_NAME = "Tractor Owner";

export interface BookingListOptions {
  readonly limit?: number;
  readonly cursor?: string;
}

/** UTC ISO-8601 with up to microsecond precision, as PostgreSQL stores timestamptz. */
const CURSOR_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/u;

const encodeCursor = (position: BookingListPosition): string =>
  Buffer.from(JSON.stringify({ c: position.createdAt, i: position.id }), "utf8").toString("base64url");

/**
 * Cursors only carry a position. The store always filters by the viewer, so a tampered cursor
 * can move the page boundary but can never widen what the viewer may read.
 */
const decodeCursor = (cursor: string): BookingListPosition => {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { c?: unknown; i?: unknown };
    if (typeof parsed.i !== "string" || !UUID_PATTERN.test(parsed.i) || typeof parsed.c !== "string"
      || !CURSOR_INSTANT_PATTERN.test(parsed.c) || Number.isNaN(new Date(parsed.c).getTime())) {
      throw new Error("invalid");
    }
    return { createdAt: parsed.c, id: parsed.i };
  } catch {
    throw new BookingQueryValidationError("cursor", "The page cursor is invalid; reload the first page");
  }
};

const historyActor = (source: BookingHistorySource, booking: BookingViewSource): BookingHistoryActor =>
  source.actorId === undefined ? "SYSTEM"
    : source.actorId === booking.customerId ? "FARMER"
      : source.actorId === booking.ownerId ? "OWNER" : "OTHER";

/**
 * Orders history by time, and events recorded at the same instant (for example work completion
 * followed by the system final bill) by following the status chain.
 */
export function orderStatusHistory<T extends Pick<BookingHistorySource, "fromStatus" | "toStatus" | "occurredAt">>(
  entries: readonly T[],
): T[] {
  const remaining = [...entries].sort((left, right) => left.occurredAt.getTime() - right.occurredAt.getTime());
  const ordered: T[] = [];
  let current: T["toStatus"] | undefined;
  while (remaining.length > 0) {
    const earliest = remaining[0]!.occurredAt.getTime();
    const tied = remaining.filter((entry) => entry.occurredAt.getTime() === earliest);
    const next = tied.find((entry) => entry.fromStatus === current) ?? tied[0]!;
    remaining.splice(remaining.indexOf(next), 1);
    ordered.push(next);
    current = next.toStatus;
  }
  return ordered;
}

const paymentSummary = (detail: BookingDetailSource): BookingPaymentSummary => {
  const { booking, payments } = detail;
  const settlement = summarizeInvoiceSettlement(
    booking.invoice === undefined ? undefined : toPayableInvoice(booking.invoice, false),
    payments.map(toLedgerEntry),
    { disputed: booking.status === "DISPUTED" },
  );
  const latest = [...payments].sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0];
  return Object.freeze({
    status: settlement.status,
    totalPaise: settlement.totalPaise,
    amountPaise: settlement.appliedPaise,
    outstandingPaise: settlement.outstandingPaise,
    settled: settlement.settled,
    settlementBlocked: settlement.settlementBlocked,
    methods: settlement.settlementMethods,
    ...(settlement.settlementMethods.length === 1 ? { method: settlement.settlementMethods[0]! } : {}),
    ...(latest === undefined ? {} : { recordedAt: new Date(latest.createdAt) }),
  });
};

const sharedView = (booking: BookingViewSource): SharedBookingView => ({
  id: booking.id,
  publicReference: booking.publicReference,
  status: booking.status,
  version: booking.version,
  bookingTarget: booking.hasRecipient ? "SOMEONE_ELSE" : "MYSELF",
  requestedInterval: { start: booking.requestedInterval.start, end: booking.requestedInterval.end },
  serviceLocation: booking.serviceLocation,
  tractor: booking.tractor,
  serviceName: booking.serviceName,
  ...(booking.equipmentName === undefined ? {} : { equipmentName: booking.equipmentName }),
  ...(booking.recipient === undefined ? {} : { recipient: booking.recipient }),
  quoteSnapshot: booking.quoteSnapshot,
  ...(booking.invoice === undefined ? {} : {
    invoice: Object.freeze({
      id: booking.invoice.id,
      invoiceVersion: booking.invoice.invoiceVersion,
      status: booking.invoice.status,
      totalPaise: booking.invoice.totalPaise,
      currency: "INR" as const,
      formula: booking.invoice.formula,
    }),
  }),
  createdAt: booking.createdAt,
  updatedAt: booking.updatedAt,
});

/** Applies the viewer's redaction: each party sees the other only through allowlisted fields. */
export function projectBookingView(
  viewerRole: BookingViewerRole,
  booking: BookingViewSource,
  detail?: Readonly<{ payment: BookingPaymentSummary; statusHistory: readonly BookingStatusHistoryEntry[] }>,
): BookingPartyView {
  const shared = {
    ...sharedView(booking),
    ...(detail === undefined ? {} : { payment: detail.payment, statusHistory: detail.statusHistory }),
  };
  return Object.freeze(viewerRole === "FARMER"
    ? {
        ...shared,
        viewerRole,
        // Same policy as discovery: the Owner's name is shared only with contact-sharing consent.
        owner: Object.freeze({
          displayName: booking.ownerContactSharingConsent && booking.ownerName !== undefined
            ? booking.ownerName
            : FALLBACK_OWNER_NAME,
        }),
        ownerContact: Object.freeze({ sharingPermitted: booking.ownerContactSharingConsent }),
      }
    : {
        ...shared,
        viewerRole,
        customer: Object.freeze({ displayName: booking.customerName ?? FALLBACK_FARMER_NAME }),
      });
}

/**
 * Party-scoped booking reads for the Farmer and Owner clients. Both parties read the same stored
 * booking, agreement, invoice, payment, and history rows, so the authoritative state they see is
 * identical; only the counterpart details differ.
 */
export class BookingQueryService {
  constructor(private readonly store: BookingQueryStore) {}

  async getBooking(
    principal: AuthPrincipal,
    bookingId: string,
    viewerRole: BookingViewerRole,
    context: BookingRequestContext,
  ): Promise<BookingPartyView> {
    if (!principal.roles.includes(viewerRole)) throw new BookingNotFoundError();
    const id = bookingId.trim();
    if (!UUID_PATTERN.test(id)) throw new BookingNotFoundError();
    const detail = await this.store.loadBookingDetail({ viewerId: principal.userId, viewerRole, bookingId: id }, context);
    if (detail === undefined) throw new BookingNotFoundError();
    if (detail.payments.length > MAX_PAYMENT_RECORDS_PER_INVOICE) {
      throw new Error("Invoice payment history exceeds the bounded read size");
    }
    const statusHistory = Object.freeze(orderStatusHistory(detail.history).map((entry) => Object.freeze({
      ...(entry.fromStatus === undefined ? {} : { fromStatus: entry.fromStatus }),
      toStatus: entry.toStatus,
      actor: historyActor(entry, detail.booking),
      actorChannel: entry.actorChannel,
      ...(entry.reason === undefined ? {} : { reason: entry.reason }),
      occurredAt: entry.occurredAt,
    })));
    return projectBookingView(viewerRole, detail.booking, { payment: paymentSummary(detail), statusHistory });
  }

  async listBookings(
    principal: AuthPrincipal,
    viewerRole: BookingViewerRole,
    options: BookingListOptions,
    context: BookingRequestContext,
  ): Promise<BookingPartyViewPage> {
    if (!principal.roles.includes(viewerRole)) throw new BookingNotFoundError();
    const limit = options.limit ?? DEFAULT_BOOKING_PAGE_SIZE;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAXIMUM_BOOKING_PAGE_SIZE) {
      throw new BookingQueryValidationError("limit", `limit must be from 1 to ${MAXIMUM_BOOKING_PAGE_SIZE}`);
    }
    const after = options.cursor === undefined ? undefined : decodeCursor(options.cursor);
    // One extra row tells whether another page exists without a count query.
    const rows = await this.store.listBookings({
      viewerId: principal.userId,
      viewerRole,
      limit: limit + 1,
      ...(after === undefined ? {} : { after }),
    }, context);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return Object.freeze({
      items: Object.freeze(page.map((row) => projectBookingView(viewerRole, row))),
      ...(rows.length > limit && last !== undefined
        ? { nextCursor: encodeCursor({ createdAt: last.cursorCreatedAt ?? last.createdAt.toISOString(), id: last.id }) }
        : {}),
    });
  }
}
