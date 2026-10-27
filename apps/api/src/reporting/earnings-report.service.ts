import type { AuthPrincipal } from "@kisantractor/domain";

import { PaymentNotFoundError, PaymentValidationError, type PaymentRequestContext } from "../payment/index.js";
import {
  earningsGroupings,
  type EarningsGrouping,
  type EarningsReportOptions,
  type EarningsReportPeriod,
  type EarningsReportRow,
  type EarningsReportStore,
  type OwnerEarningsReport,
} from "./earnings-report.contracts.js";

export const DEFAULT_EARNINGS_REPORT_DAYS = 30;
export const MAXIMUM_EARNINGS_REPORT_DAYS = 366;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;
const DAY_MS = 86_400_000;
const IST_OFFSET_MS = 330 * 60_000;

const indiaDate = (instant: Date): string => new Date(instant.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);

const dayNumber = (value: string, field: "from" | "to"): number => {
  const match = DATE_PATTERN.exec(value);
  if (match === null) throw new PaymentValidationError(field, `${field} must use YYYY-MM-DD`);
  const [year, month, day] = match.slice(1).map(Number) as [number, number, number];
  const timestamp = Date.UTC(year, month - 1, day);
  const date = new Date(timestamp);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new PaymentValidationError(field, `${field} must be a valid calendar date`);
  }
  return timestamp / DAY_MS;
};

const safeAmount = (value: number, field: string): number => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Authoritative earnings projection returned an invalid ${field}`);
  }
  return value;
};

const addSafe = (left: number, right: number, field: string): number => safeAmount(left + right, field);

export interface NormalizedEarningsReportRange {
  readonly from: string;
  readonly to: string;
  readonly groupBy: EarningsGrouping;
}

/** Validates a small, fixed report window in India calendar time. */
export function normalizeEarningsReportRange(options: EarningsReportOptions, now: Date): NormalizedEarningsReportRange {
  if (Number.isNaN(now.getTime())) throw new TypeError("now must be a valid instant");
  const today = indiaDate(now);
  const todayDay = dayNumber(today, "to");
  const defaultFrom = new Date((todayDay - (DEFAULT_EARNINGS_REPORT_DAYS - 1)) * DAY_MS).toISOString().slice(0, 10);
  const from = options.from ?? defaultFrom;
  const to = options.to ?? today;
  const first = dayNumber(from, "from");
  const last = dayNumber(to, "to");
  if (first > last) throw new PaymentValidationError("from", "from must not be after to");
  if (last - first + 1 > MAXIMUM_EARNINGS_REPORT_DAYS) {
    throw new PaymentValidationError("from", `Reports are limited to ${MAXIMUM_EARNINGS_REPORT_DAYS} days`);
  }
  if (last > todayDay) throw new PaymentValidationError("to", "to must not be in the future");
  const groupBy = options.groupBy ?? "DAY";
  if (!(earningsGroupings as readonly string[]).includes(groupBy)) {
    throw new PaymentValidationError("groupBy", "groupBy must be DAY or MONTH");
  }
  return Object.freeze({ from, to, groupBy: groupBy as EarningsGrouping });
}

const projectPeriod = (row: EarningsReportRow): EarningsReportPeriod => {
  const cash = safeAmount(row.cashCollectedPaise, "cash collection");
  const online = safeAmount(row.onlineCollectedPaise, "online collection");
  const refunded = safeAmount(row.refundedPaise, "refund");
  const collected = addSafe(cash, online, "collection");
  const net = collected - refunded;
  if (!Number.isSafeInteger(net)) throw new Error("Authoritative earnings projection exceeds safe integer limits");
  return Object.freeze({
    period: row.period,
    invoiceCount: safeAmount(row.invoiceCount, "invoice count"),
    settledInvoiceCount: safeAmount(row.settledInvoiceCount, "settled invoice count"),
    invoicedPaise: safeAmount(row.invoicedPaise, "invoiced amount"),
    outstandingPaise: safeAmount(row.outstandingPaise, "outstanding amount"),
    cashCollectedPaise: cash,
    onlineCollectedPaise: online,
    refundedPaise: refunded,
    collectedPaise: collected,
    netEarningsPaise: net,
  });
};

/** Owner-only, PII-free earnings projection computed on demand from the financial ledger. */
export class OwnerEarningsReportService {
  constructor(private readonly store: EarningsReportStore, private readonly clock: () => Date = () => new Date()) {}

  async get(
    principal: AuthPrincipal,
    options: EarningsReportOptions,
    context: PaymentRequestContext,
  ): Promise<OwnerEarningsReport> {
    if (!principal.roles.includes("OWNER")) throw new PaymentNotFoundError();
    const generatedAt = this.clock();
    const range = normalizeEarningsReportRange(options, generatedAt);
    const rows = await this.store.queryEarnings({ ownerId: principal.userId, ...range }, context);
    const maximumRows = range.groupBy === "DAY" ? MAXIMUM_EARNINGS_REPORT_DAYS : 13;
    if (rows.length > maximumRows) throw new Error("Authoritative earnings projection exceeded its bounded period count");
    const periods = Object.freeze(rows.map(projectPeriod));
    const totals = periods.reduce<Omit<EarningsReportPeriod, "period">>((total, period) => Object.freeze({
      invoiceCount: addSafe(total.invoiceCount, period.invoiceCount, "invoice count"),
      settledInvoiceCount: addSafe(total.settledInvoiceCount, period.settledInvoiceCount, "settled invoice count"),
      invoicedPaise: addSafe(total.invoicedPaise, period.invoicedPaise, "invoiced amount"),
      outstandingPaise: addSafe(total.outstandingPaise, period.outstandingPaise, "outstanding amount"),
      cashCollectedPaise: addSafe(total.cashCollectedPaise, period.cashCollectedPaise, "cash collection"),
      onlineCollectedPaise: addSafe(total.onlineCollectedPaise, period.onlineCollectedPaise, "online collection"),
      refundedPaise: addSafe(total.refundedPaise, period.refundedPaise, "refund"),
      collectedPaise: addSafe(total.collectedPaise, period.collectedPaise, "collection"),
      netEarningsPaise: total.netEarningsPaise + period.netEarningsPaise,
    }), Object.freeze({
      invoiceCount: 0, settledInvoiceCount: 0, invoicedPaise: 0, outstandingPaise: 0,
      cashCollectedPaise: 0, onlineCollectedPaise: 0, refundedPaise: 0, collectedPaise: 0, netEarningsPaise: 0,
    }));
    if (!Number.isSafeInteger(totals.netEarningsPaise)) throw new Error("Authoritative earnings projection exceeds safe integer limits");
    return Object.freeze({
      ...range,
      timezone: "Asia/Kolkata",
      currency: "INR",
      source: "AUTHORITATIVE_INVOICE_PAYMENT_RECORDS",
      privacy: "AGGREGATED_NO_PII",
      generatedAt,
      totals,
      periods,
    });
  }
}
