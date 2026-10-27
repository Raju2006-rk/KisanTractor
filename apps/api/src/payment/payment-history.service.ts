import { appliedPaymentStatuses, projectPaymentRecord, type AuthPrincipal, type PaymentViewerRole } from "@kisantractor/domain";

import type {
  PaymentHistoryItem,
  PaymentHistoryPage,
  PaymentHistoryPosition,
  PaymentHistoryStore,
  PaymentRequestContext,
} from "./payment.contracts.js";
import { PaymentNotFoundError, PaymentValidationError } from "./payment.service.js";

export const DEFAULT_PAYMENT_HISTORY_PAGE_SIZE = 20;
export const MAXIMUM_PAYMENT_HISTORY_PAGE_SIZE = 50;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
/** UTC ISO-8601 with up to microsecond precision, as PostgreSQL stores timestamptz. */
const CURSOR_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/u;

const encodeCursor = (position: PaymentHistoryPosition): string =>
  Buffer.from(JSON.stringify({ c: position.createdAt, i: position.id }), "utf8").toString("base64url");

/**
 * Cursors only carry a position. The store always filters by the viewer, so a tampered cursor can
 * move the page boundary but never widen what the viewer may read.
 */
const decodeCursor = (cursor: string): PaymentHistoryPosition => {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { c?: unknown; i?: unknown };
    if (typeof parsed.i !== "string" || !UUID_PATTERN.test(parsed.i) || typeof parsed.c !== "string"
      || !CURSOR_INSTANT_PATTERN.test(parsed.c) || Number.isNaN(new Date(parsed.c).getTime())) {
      throw new Error("invalid");
    }
    return { createdAt: parsed.c, id: parsed.i };
  } catch {
    throw new PaymentValidationError("cursor", "The page cursor is invalid; reload the first page");
  }
};

export interface PaymentHistoryOptions {
  readonly cursor?: string;
  readonly limit?: number;
}

/**
 * Authorized payment history (task 16.2): every payment on the viewer's own bookings (the booking
 * Farmer's, or the assigned Owner's), newest first, keyset-paginated and bounded. Items are the
 * party-safe payment projection plus the booking reference and whether a receipt is available.
 */
export class PaymentHistoryService {
  constructor(private readonly store: PaymentHistoryStore) {}

  async list(
    principal: AuthPrincipal,
    viewerRole: PaymentViewerRole,
    options: PaymentHistoryOptions,
    context: PaymentRequestContext,
  ): Promise<PaymentHistoryPage> {
    if (!principal.roles.includes(viewerRole)) throw new PaymentNotFoundError();
    const limit = options.limit ?? DEFAULT_PAYMENT_HISTORY_PAGE_SIZE;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAXIMUM_PAYMENT_HISTORY_PAGE_SIZE) {
      throw new PaymentValidationError("limit", `limit must be from 1 to ${MAXIMUM_PAYMENT_HISTORY_PAGE_SIZE}`);
    }
    const after = options.cursor === undefined ? undefined : decodeCursor(options.cursor);
    // One extra row tells whether another page exists without a count query.
    const rows = await this.store.listPaymentHistory({
      partyRole: viewerRole, partyId: principal.userId, ...(after === undefined ? {} : { after }), limit: limit + 1,
    }, context);
    const page = rows.slice(0, limit);
    const items = page.flatMap((row): PaymentHistoryItem[] => {
      const party = viewerRole === "FARMER" ? row.booking.customerId : row.booking.ownerId;
      // Defence in depth: a row for another party is never projected, even if a store misbehaves.
      if (party !== principal.userId) return [];
      return [Object.freeze({
        ...projectPaymentRecord(row.payment, row.booking),
        bookingId: row.booking.id,
        bookingReference: row.booking.reference,
        invoiceVersion: row.invoiceVersion,
        receiptAvailable: appliedPaymentStatuses.includes(row.payment.status) && row.invoiceAppliedPaise === row.invoiceTotalPaise,
      })];
    });
    const last = page.at(-1);
    return Object.freeze({
      items: Object.freeze(items),
      ...(rows.length > limit && last !== undefined
        ? { nextCursor: encodeCursor({ createdAt: last.cursorCreatedAt, id: last.payment.id }) }
        : {}),
    });
  }
}
