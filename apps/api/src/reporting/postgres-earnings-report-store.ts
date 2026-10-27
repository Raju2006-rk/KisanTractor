import { withTransaction, type SqlPool } from "@kisantractor/database";

import type { PaymentRequestContext } from "../payment/index.js";
import type { EarningsReportQuery, EarningsReportRow, EarningsReportStore } from "./earnings-report.contracts.js";

interface EarningsRow {
  readonly period: string;
  readonly invoice_count: string | number;
  readonly settled_invoice_count: string | number;
  readonly invoiced_paise: string | number;
  readonly outstanding_paise: string | number;
  readonly cash_collected_paise: string | number;
  readonly online_collected_paise: string | number;
  readonly refunded_paise: string | number;
}

const whole = (value: string | number, field: string): number => {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`Invalid ${field} in earnings projection`);
  return parsed;
};

/**
 * Read-only aggregate over append-only invoices/payment history. It creates no report table and
 * never selects customer, recipient, contact, location, provider payload, or record identifiers.
 */
export class PostgresEarningsReportStore implements EarningsReportStore {
  constructor(private readonly pool: SqlPool) {}

  queryEarnings(query: EarningsReportQuery, context: PaymentRequestContext): Promise<readonly EarningsReportRow[]> {
    return withTransaction(this.pool, async (sql) => {
      const result = await sql.query<EarningsRow>(
        `WITH bounds AS (
           SELECT $2::date AS from_date, $3::date AS to_date,
             ($2::date::timestamp AT TIME ZONE 'Asia/Kolkata') AS from_instant,
             (($3::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata') AS to_instant
         ), current_invoices AS (
           SELECT i.id, i.total_paise, i.created_at,
             COALESCE(SUM(p.amount_paise) FILTER (WHERE p.status IN ('PAID_CASH', 'PAID_ONLINE', 'REFUND_PENDING')), 0) AS applied_paise
           FROM public.invoices i
           JOIN public.bookings b ON b.id = i.booking_id
           CROSS JOIN bounds x
           LEFT JOIN public.payments p ON p.invoice_id = i.id
           WHERE b.owner_id = $1::uuid AND i.status <> 'VOID'
             AND i.created_at >= x.from_instant AND i.created_at < x.to_instant
             AND NOT EXISTS (SELECT 1 FROM public.invoices newer WHERE newer.booking_id = i.booking_id AND newer.invoice_version > i.invoice_version)
           GROUP BY i.id, i.total_paise, i.created_at
         ), invoice_periods AS (
           SELECT date_trunc($4, created_at AT TIME ZONE 'Asia/Kolkata')::date AS period,
             COUNT(*) AS invoice_count,
             COUNT(*) FILTER (WHERE applied_paise = total_paise) AS settled_invoice_count,
             SUM(total_paise) AS invoiced_paise,
             SUM(GREATEST(total_paise - applied_paise, 0)) AS outstanding_paise
           FROM current_invoices GROUP BY 1
         ), collection_periods AS (
           SELECT date_trunc($4, paid_at AT TIME ZONE 'Asia/Kolkata')::date AS period,
             COALESCE(SUM(amount_paise) FILTER (WHERE method = 'CASH'), 0) AS cash_collected_paise,
             COALESCE(SUM(amount_paise) FILTER (WHERE method = 'ONLINE'), 0) AS online_collected_paise
           FROM (
             SELECT p.method, p.amount_paise,
               CASE WHEN p.method = 'CASH' THEN p.received_at ELSE p.verified_at END AS paid_at
             FROM public.payments p
             JOIN public.invoices i ON i.id = p.invoice_id
             JOIN public.bookings b ON b.id = i.booking_id
             CROSS JOIN bounds x
             WHERE b.owner_id = $1::uuid
               AND p.status IN ('PAID_CASH', 'PAID_ONLINE', 'REFUND_PENDING', 'REFUNDED')
               AND (CASE WHEN p.method = 'CASH' THEN p.received_at ELSE p.verified_at END) >= x.from_instant
               AND (CASE WHEN p.method = 'CASH' THEN p.received_at ELSE p.verified_at END) < x.to_instant
           ) paid GROUP BY 1
         ), refund_periods AS (
           SELECT date_trunc($4, r.resolved_at AT TIME ZONE 'Asia/Kolkata')::date AS period,
             SUM(r.amount_paise) AS refunded_paise
           FROM public.payment_refunds r
           JOIN public.payments p ON p.id = r.payment_id
           JOIN public.invoices i ON i.id = p.invoice_id
           JOIN public.bookings b ON b.id = i.booking_id
           CROSS JOIN bounds x
           WHERE b.owner_id = $1::uuid AND r.status = 'PROCESSED'
             AND r.resolved_at >= x.from_instant AND r.resolved_at < x.to_instant
           GROUP BY 1
         ), periods AS (
           SELECT generate_series(
             date_trunc($4, from_date::timestamp)::date,
             date_trunc($4, to_date::timestamp)::date,
             CASE WHEN $4 = 'day' THEN interval '1 day' ELSE interval '1 month' END
           )::date AS period FROM bounds
         )
         SELECT to_char(periods.period, 'YYYY-MM-DD') AS period,
           COALESCE(i.invoice_count, 0) AS invoice_count,
           COALESCE(i.settled_invoice_count, 0) AS settled_invoice_count,
           COALESCE(i.invoiced_paise, 0) AS invoiced_paise,
           COALESCE(i.outstanding_paise, 0) AS outstanding_paise,
           COALESCE(c.cash_collected_paise, 0) AS cash_collected_paise,
           COALESCE(c.online_collected_paise, 0) AS online_collected_paise,
           COALESCE(r.refunded_paise, 0) AS refunded_paise
         FROM periods
         LEFT JOIN invoice_periods i USING (period)
         LEFT JOIN collection_periods c USING (period)
         LEFT JOIN refund_periods r USING (period)
         ORDER BY periods.period ASC`,
        [query.ownerId, query.from, query.to, query.groupBy.toLowerCase()],
      );
      return Object.freeze(result.rows.map((row) => Object.freeze({
        period: row.period,
        invoiceCount: whole(row.invoice_count, "invoice count"),
        settledInvoiceCount: whole(row.settled_invoice_count, "settled invoice count"),
        invoicedPaise: whole(row.invoiced_paise, "invoiced amount"),
        outstandingPaise: whole(row.outstanding_paise, "outstanding amount"),
        cashCollectedPaise: whole(row.cash_collected_paise, "cash collection"),
        onlineCollectedPaise: whole(row.online_collected_paise, "online collection"),
        refundedPaise: whole(row.refunded_paise, "refund"),
      })));
    }, { isolation: "REPEATABLE READ", readOnly: true, correlationId: context.correlationId });
  }
}
