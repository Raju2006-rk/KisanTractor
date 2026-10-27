import { cookies } from "next/headers";

import { accessCookieName, runtimeConfig } from "./server-context";

export type EarningsGroupingView = "DAY" | "MONTH";
export interface EarningsPeriodView {
  readonly period: string;
  readonly invoiceCount: number;
  readonly settledInvoiceCount: number;
  readonly invoicedPaise: number;
  readonly outstandingPaise: number;
  readonly cashCollectedPaise: number;
  readonly onlineCollectedPaise: number;
  readonly refundedPaise: number;
  readonly collectedPaise: number;
  readonly netEarningsPaise: number;
}
export interface OwnerEarningsReportView {
  readonly from: string;
  readonly to: string;
  readonly groupBy: EarningsGroupingView;
  readonly timezone: "Asia/Kolkata";
  readonly currency: "INR";
  readonly source: "AUTHORITATIVE_INVOICE_PAYMENT_RECORDS";
  readonly privacy: "AGGREGATED_NO_PII";
  readonly generatedAt: Date;
  readonly totals: Omit<EarningsPeriodView, "period">;
  readonly periods: readonly EarningsPeriodView[];
}
export interface EarningsReportFilters { readonly from?: string; readonly to?: string; readonly groupBy?: EarningsGroupingView }
export type EarningsReportLoadResult = Readonly<{ state: "READY"; report: OwnerEarningsReportView }> | Readonly<{ state: "ERROR" }>;

const datePattern = /^\d{4}-\d{2}-\d{2}$/u;
const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
const safeWhole = (value: unknown): number | undefined => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const safeSigned = (value: unknown): number | undefined => typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;

const normalizePeriod = (value: unknown, withPeriod: boolean): EarningsPeriodView | Omit<EarningsPeriodView, "period"> | undefined => {
  const item = record(value);
  const period = withPeriod && typeof item?.period === "string" && datePattern.test(item.period) ? item.period : undefined;
  const invoiceCount = safeWhole(item?.invoiceCount);
  const settledInvoiceCount = safeWhole(item?.settledInvoiceCount);
  const invoicedPaise = safeWhole(item?.invoicedPaise);
  const outstandingPaise = safeWhole(item?.outstandingPaise);
  const cashCollectedPaise = safeWhole(item?.cashCollectedPaise);
  const onlineCollectedPaise = safeWhole(item?.onlineCollectedPaise);
  const refundedPaise = safeWhole(item?.refundedPaise);
  const collectedPaise = safeWhole(item?.collectedPaise);
  const netEarningsPaise = safeSigned(item?.netEarningsPaise);
  if ((withPeriod && period === undefined) || invoiceCount === undefined || settledInvoiceCount === undefined || invoicedPaise === undefined
      || outstandingPaise === undefined || cashCollectedPaise === undefined || onlineCollectedPaise === undefined
      || refundedPaise === undefined || collectedPaise === undefined || netEarningsPaise === undefined
      || collectedPaise !== cashCollectedPaise + onlineCollectedPaise || netEarningsPaise !== collectedPaise - refundedPaise) return undefined;
  return Object.freeze({ ...(period === undefined ? {} : { period }), invoiceCount, settledInvoiceCount, invoicedPaise, outstandingPaise,
    cashCollectedPaise, onlineCollectedPaise, refundedPaise, collectedPaise, netEarningsPaise });
};

/** Allowlists the aggregate report response. Any record-level or malformed payload is refused wholesale. */
export function normalizeOwnerEarningsReport(value: unknown): OwnerEarningsReportView | undefined {
  const source = record(value);
  if (typeof source?.from !== "string" || !datePattern.test(source.from) || typeof source.to !== "string" || !datePattern.test(source.to)
      || (source.groupBy !== "DAY" && source.groupBy !== "MONTH") || source.timezone !== "Asia/Kolkata" || source.currency !== "INR"
      || source.source !== "AUTHORITATIVE_INVOICE_PAYMENT_RECORDS" || source.privacy !== "AGGREGATED_NO_PII" || !Array.isArray(source.periods)) return undefined;
  const generatedAt = typeof source.generatedAt === "string" ? new Date(source.generatedAt) : undefined;
  if (generatedAt === undefined || Number.isNaN(generatedAt.getTime()) || source.periods.length > (source.groupBy === "DAY" ? 366 : 13)) return undefined;
  const totals = normalizePeriod(source.totals, false);
  const periods = source.periods.map((period) => normalizePeriod(period, true));
  if (totals === undefined || periods.some((period) => period === undefined)) return undefined;
  return Object.freeze({ from: source.from, to: source.to, groupBy: source.groupBy, timezone: "Asia/Kolkata", currency: "INR",
    source: "AUTHORITATIVE_INVOICE_PAYMENT_RECORDS", privacy: "AGGREGATED_NO_PII", generatedAt,
    totals: totals as Omit<EarningsPeriodView, "period">, periods: Object.freeze(periods as EarningsPeriodView[]) });
}

export async function loadOwnerEarningsReport(filters: EarningsReportFilters = {}): Promise<EarningsReportLoadResult> {
  const credential = (await cookies()).get(accessCookieName)?.value;
  if (!credential) return { state: "ERROR" };
  const query = new URLSearchParams();
  if (filters.from !== undefined) query.set("from", filters.from);
  if (filters.to !== undefined) query.set("to", filters.to);
  if (filters.groupBy !== undefined) query.set("groupBy", filters.groupBy);
  try {
    const response = await fetch(`${runtimeConfig().publicApiOrigin}/owner/reports/earnings${query.size === 0 ? "" : `?${query}`}`, {
      headers: { authorization: `Bearer ${credential}`, accept: "application/json" }, cache: "no-store",
    });
    if (!response.ok) return { state: "ERROR" };
    const report = normalizeOwnerEarningsReport(await response.json());
    return report === undefined ? { state: "ERROR" } : { state: "READY", report };
  } catch {
    return { state: "ERROR" };
  }
}
