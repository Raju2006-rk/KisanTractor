import type { AuthPrincipal } from "@kisantractor/domain";

import type { PaymentRequestContext, PaymentSessionAuthenticator } from "../payment/index.js";

export const earningsGroupings = ["DAY", "MONTH"] as const;
export type EarningsGrouping = (typeof earningsGroupings)[number];

export interface EarningsReportQuery {
  readonly ownerId: string;
  /** Inclusive India-calendar dates. */
  readonly from: string;
  readonly to: string;
  readonly groupBy: EarningsGrouping;
}

export interface EarningsReportRow {
  readonly period: string;
  readonly invoiceCount: number;
  readonly settledInvoiceCount: number;
  readonly invoicedPaise: number;
  readonly outstandingPaise: number;
  readonly cashCollectedPaise: number;
  readonly onlineCollectedPaise: number;
  readonly refundedPaise: number;
}

export interface EarningsReportPeriod extends EarningsReportRow {
  readonly collectedPaise: number;
  readonly netEarningsPaise: number;
}

export interface OwnerEarningsReport {
  readonly from: string;
  readonly to: string;
  readonly groupBy: EarningsGrouping;
  readonly timezone: "Asia/Kolkata";
  readonly currency: "INR";
  readonly source: "AUTHORITATIVE_INVOICE_PAYMENT_RECORDS";
  readonly privacy: "AGGREGATED_NO_PII";
  readonly generatedAt: Date;
  readonly totals: Readonly<Omit<EarningsReportPeriod, "period">>;
  readonly periods: readonly EarningsReportPeriod[];
}

export interface EarningsReportOptions {
  readonly from?: string;
  readonly to?: string;
  readonly groupBy?: string;
}

export interface EarningsReportStore {
  /** One bounded aggregate query; implementations must not read a mutable reporting total. */
  queryEarnings(query: EarningsReportQuery, context: PaymentRequestContext): Promise<readonly EarningsReportRow[]>;
}

export interface EarningsReportSessionAuthenticator extends PaymentSessionAuthenticator {}
export type EarningsReportPrincipal = AuthPrincipal;
