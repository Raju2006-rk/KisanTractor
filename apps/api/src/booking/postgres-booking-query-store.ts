import type {
  HourlyRoundingPolicy,
  InvoiceRecordStatus,
  NormalizedLocation,
  PaymentMethod,
  PaymentRecordSource,
  PaymentRecordStatus,
  PricingMethod,
} from "@kisantractor/domain";
import { MAX_PAYMENT_RECORDS_PER_INVOICE } from "@kisantractor/domain";
import { withTransaction, type SqlConnection, type SqlPool } from "@kisantractor/database";

import type { BookingRequestContext, BookingStatus } from "./booking.contracts.js";
import type {
  BookingDetailSource,
  BookingHistorySource,
  BookingListPosition,
  BookingQueryStore,
  BookingViewerRole,
  BookingViewQuery,
  BookingViewSource,
} from "./booking-query.contracts.js";

interface BookingViewRow extends Record<string, unknown> {
  readonly id: string;
  readonly public_reference: string;
  readonly customer_id: string;
  readonly owner_id: string;
  readonly tractor_id: string;
  readonly status: BookingStatus;
  readonly version: number;
  readonly requested_start_at: Date;
  readonly requested_end_at: Date;
  readonly created_at: Date;
  /** created_at with microseconds; node-postgres Dates truncate to milliseconds. */
  readonly created_at_cursor?: string | null;
  readonly updated_at: Date;
  readonly agreement_version: number;
  readonly pricing_rule_id: string;
  readonly pricing_rule_version: number;
  readonly method: PricingMethod;
  /** bigint and numeric columns arrive as strings from node-postgres. */
  readonly rate_paise: string | number;
  readonly currency: string;
  readonly rounding_policy: HourlyRoundingPolicy | null;
  readonly estimated_quantity: string | number;
  readonly estimated_total_paise: string | number;
  readonly disclosed_at: Date;
  readonly service_location_snapshot: NormalizedLocation;
  readonly tractor_brand: string;
  readonly tractor_model: string;
  readonly service_name: string;
  readonly equipment_name: string | null;
  readonly customer_name: string | null;
  readonly owner_name: string | null;
  readonly owner_contact_sharing_consent: boolean | null;
  readonly has_recipient: boolean;
  readonly recipient_name: string | null;
  readonly recipient_directions: string | null;
  readonly invoice_id: string | null;
  readonly invoice_version: number | null;
  readonly invoice_status: InvoiceRecordStatus | null;
  readonly invoice_total_paise: string | number | null;
  readonly invoice_currency: string | null;
  readonly invoice_formula: string | null;
}

interface HistoryRow extends Record<string, unknown> {
  readonly from_status: BookingStatus | null;
  readonly to_status: BookingStatus;
  readonly actor_id: string | null;
  readonly actor_channel: string;
  readonly reason: string | null;
  readonly occurred_at: Date;
}

interface PaymentRow extends Record<string, unknown> {
  readonly id: string;
  readonly invoice_id: string;
  readonly method: PaymentMethod;
  readonly status: PaymentRecordStatus;
  readonly amount_paise: string | number;
  readonly currency: string;
  readonly recorded_by_user_id: string | null;
  readonly received_at: Date | null;
  readonly verified_at: Date | null;
  readonly created_at: Date;
}

/**
 * Every party read joins the same booking, current agreement, and current invoice rows. The
 * viewer filter is a fixed column per role (never interpolated input), so a Farmer reads only
 * bookings it created and an Owner reads only bookings assigned to its Tractors.
 */
const VIEW_SELECT = `
  SELECT b.id, b.public_reference, b.customer_id, b.owner_id, b.tractor_id, b.status, b.version,
    b.requested_start_at, b.requested_end_at, b.created_at, b.updated_at,
    to_char(b.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_cursor,
    ba.agreement_version, ba.pricing_rule_id, ba.pricing_rule_version, ba.method, ba.rate_paise,
    ba.currency, ba.rounding_policy, ba.estimated_quantity, ba.estimated_total_paise, ba.disclosed_at,
    ba.service_location_snapshot,
    t.brand AS tractor_brand, t.model AS tractor_model,
    s.display_name AS service_name, e.display_name AS equipment_name,
    cp.full_name AS customer_name,
    op.full_name AS owner_name, op.contact_sharing_consent AS owner_contact_sharing_consent,
    (br.booking_id IS NOT NULL) AS has_recipient, br.name AS recipient_name,
    br.landmark_or_directions AS recipient_directions,
    inv.id AS invoice_id, inv.invoice_version, inv.status AS invoice_status,
    inv.total_paise AS invoice_total_paise, inv.currency AS invoice_currency,
    inv.calculation_formula AS invoice_formula
  FROM public.bookings b
  JOIN public.booking_agreements ba ON ba.id = b.current_agreement_id
  JOIN public.tractors t ON t.id = b.tractor_id
  JOIN public.service_offerings so ON so.id = b.service_offering_id
  JOIN public.services s ON s.id = so.service_id
  LEFT JOIN public.equipment e ON e.id = so.equipment_id
  LEFT JOIN public.user_profiles cp ON cp.user_id = b.customer_id
  LEFT JOIN public.user_profiles op ON op.user_id = b.owner_id
  LEFT JOIN public.booking_recipients br ON br.booking_id = b.id
  LEFT JOIN LATERAL (
    SELECT i.id, i.invoice_version, i.status, i.total_paise, i.currency, i.calculation_formula
    FROM public.invoices i WHERE i.booking_id = b.id
    ORDER BY i.invoice_version DESC LIMIT 1
  ) inv ON true`;

const viewerColumn: Readonly<Record<BookingViewerRole, string>> = Object.freeze({
  FARMER: "b.customer_id",
  OWNER: "b.owner_id",
});

const detailSql = (role: BookingViewerRole): string =>
  `${VIEW_SELECT} WHERE b.id = $1 AND ${viewerColumn[role]} = $2`;

const listSql = (role: BookingViewerRole, paged: boolean): string =>
  `${VIEW_SELECT} WHERE ${viewerColumn[role]} = $1
   ${paged ? "AND (b.created_at, b.id) < ($3::timestamptz, $4::uuid)" : ""}
   ORDER BY b.created_at DESC, b.id DESC LIMIT $2`;

const safeWhole = (value: string | number, field: string): number => {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`Stored ${field} is not a safe whole number`);
  return parsed;
};

/** numeric(12,3) arrives as "3.000"; the Quote Snapshot uses the canonical "3". */
const canonicalQuantity = (value: string | number): string => {
  const text = String(value);
  if (!text.includes(".")) return text;
  const trimmed = text.replace(/0+$/u, "");
  return trimmed.endsWith(".") ? trimmed.slice(0, -1) : trimmed;
};

const toSource = (row: BookingViewRow): BookingViewSource => {
  const invoice = row.invoice_id === null || row.invoice_version === null || row.invoice_status === null
    || row.invoice_total_paise === null || row.invoice_formula === null
    ? undefined
    : Object.freeze({
        id: row.invoice_id,
        bookingId: row.id,
        invoiceVersion: Number(row.invoice_version),
        status: row.invoice_status,
        totalPaise: safeWhole(row.invoice_total_paise, "invoice total"),
        currency: (row.invoice_currency ?? "INR").trim(),
        formula: row.invoice_formula,
      });
  return Object.freeze({
    id: row.id,
    publicReference: row.public_reference,
    customerId: row.customer_id,
    ownerId: row.owner_id,
    status: row.status,
    version: Number(row.version),
    hasRecipient: row.has_recipient,
    requestedInterval: Object.freeze({ start: new Date(row.requested_start_at), end: new Date(row.requested_end_at) }),
    serviceLocation: row.service_location_snapshot,
    tractor: Object.freeze({ id: row.tractor_id, brand: row.tractor_brand, model: row.tractor_model }),
    serviceName: row.service_name,
    ...(row.equipment_name === null ? {} : { equipmentName: row.equipment_name }),
    ...(row.customer_name === null ? {} : { customerName: row.customer_name }),
    ...(row.owner_name === null ? {} : { ownerName: row.owner_name }),
    ownerContactSharingConsent: row.owner_contact_sharing_consent === true,
    ...(row.recipient_name === null ? {} : {
      recipient: Object.freeze({
        name: row.recipient_name,
        ...(row.recipient_directions === null ? {} : { landmarkOrDirections: row.recipient_directions }),
      }),
    }),
    quoteSnapshot: Object.freeze({
      agreementVersion: Number(row.agreement_version),
      pricingRuleId: row.pricing_rule_id,
      pricingRuleVersion: Number(row.pricing_rule_version),
      method: row.method,
      ratePaise: safeWhole(row.rate_paise, "agreed rate"),
      currency: "INR" as const,
      ...(row.rounding_policy === null ? {} : { roundingPolicy: row.rounding_policy }),
      estimatedQuantity: canonicalQuantity(row.estimated_quantity),
      estimatedTotalPaise: safeWhole(row.estimated_total_paise, "estimated total"),
      disclosedAt: new Date(row.disclosed_at),
    }),
    ...(invoice === undefined ? {} : { invoice }),
    createdAt: new Date(row.created_at),
    ...(typeof row.created_at_cursor === "string" ? { cursorCreatedAt: row.created_at_cursor } : {}),
    updatedAt: new Date(row.updated_at),
  });
};

const toHistory = (row: HistoryRow): BookingHistorySource => Object.freeze({
  ...(row.from_status === null ? {} : { fromStatus: row.from_status }),
  toStatus: row.to_status,
  ...(row.actor_id === null ? {} : { actorId: row.actor_id }),
  actorChannel: row.actor_channel,
  ...(row.reason === null ? {} : { reason: row.reason }),
  occurredAt: new Date(row.occurred_at),
});

const toPayment = (row: PaymentRow): PaymentRecordSource => Object.freeze({
  id: row.id,
  invoiceId: row.invoice_id,
  method: row.method,
  status: row.status,
  amountPaise: safeWhole(row.amount_paise, "payment amount"),
  currency: row.currency.trim(),
  ...(row.recorded_by_user_id === null ? {} : { recordedByUserId: row.recorded_by_user_id }),
  ...(row.received_at === null ? {} : { receivedAt: new Date(row.received_at) }),
  ...(row.verified_at === null ? {} : { verifiedAt: new Date(row.verified_at) }),
  createdAt: new Date(row.created_at),
});

/** The history of one booking is bounded by its lifecycle; this cap guards against corruption. */
const MAX_HISTORY_ROWS = 200;

export class PostgresBookingQueryStore implements BookingQueryStore {
  constructor(private readonly pool: SqlPool) {}

  loadBookingDetail(
    query: BookingViewQuery & Readonly<{ bookingId: string }>,
    context: BookingRequestContext,
  ): Promise<BookingDetailSource | undefined> {
    // One snapshot so status, agreement, invoice, payments, and history describe the same moment.
    return withTransaction(this.pool, async (sql) => {
      const result = await sql.query<BookingViewRow>(detailSql(query.viewerRole), [query.bookingId, query.viewerId]);
      const row = result.rows[0];
      if (row === undefined) return undefined;
      const booking = toSource(row);
      const payments = booking.invoice === undefined ? [] : await this.#payments(sql, booking.invoice.id);
      const history = await this.#history(sql, booking.id);
      return Object.freeze({ booking, payments: Object.freeze(payments), history: Object.freeze(history) });
    }, { isolation: "REPEATABLE READ", readOnly: true, correlationId: context.correlationId });
  }

  async listBookings(
    query: BookingViewQuery & Readonly<{ limit: number; after?: BookingListPosition }>,
    context: BookingRequestContext,
  ): Promise<readonly BookingViewSource[]> {
    return withTransaction(this.pool, async (sql) => {
      const paged = query.after !== undefined;
      const result = await sql.query<BookingViewRow>(
        listSql(query.viewerRole, paged),
        paged
          ? [query.viewerId, query.limit, query.after!.createdAt, query.after!.id]
          : [query.viewerId, query.limit],
      );
      return Object.freeze(result.rows.map(toSource));
    }, { isolation: "REPEATABLE READ", readOnly: true, correlationId: context.correlationId });
  }

  async #payments(sql: SqlConnection, invoiceId: string): Promise<PaymentRecordSource[]> {
    const result = await sql.query<PaymentRow>(
      `SELECT id, invoice_id, method, status, amount_paise, currency, recorded_by_user_id,
         received_at, verified_at, created_at
       FROM public.payments WHERE invoice_id = $1 ORDER BY created_at, id LIMIT $2`,
      [invoiceId, MAX_PAYMENT_RECORDS_PER_INVOICE + 1],
    );
    return result.rows.map(toPayment);
  }

  async #history(sql: SqlConnection, bookingId: string): Promise<BookingHistorySource[]> {
    const result = await sql.query<HistoryRow>(
      `SELECT from_status, to_status, actor_id, actor_channel, reason, occurred_at
       FROM public.booking_status_history WHERE booking_id = $1
       ORDER BY occurred_at, id LIMIT $2`,
      [bookingId, MAX_HISTORY_ROWS],
    );
    return result.rows.map(toHistory);
  }
}
