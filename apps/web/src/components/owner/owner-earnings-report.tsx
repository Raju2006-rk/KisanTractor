import { formatDate, formatDateTime, formatIndianCurrency, translate, type CatalogLocale } from "@kisantractor/i18n";

import type { OwnerEarningsReportView } from "../../lib/owner-earnings";

const periodLabel = (locale: CatalogLocale, period: string, groupBy: "DAY" | "MONTH"): string => {
  const date = new Date(`${period}T00:00:00.000Z`);
  return groupBy === "MONTH"
    ? new Intl.DateTimeFormat(locale === "en" ? "en-IN" : locale, { year: "numeric", month: "long", timeZone: "UTC" }).format(date)
    : formatDate(locale, date);
};

export function OwnerEarningsReport({ locale, report }: Readonly<{ locale: CatalogLocale; report: OwnerEarningsReportView }>) {
  const money = (value: number) => formatIndianCurrency(locale, value);
  const summaries = [
    ["owner.earnings.invoiced", money(report.totals.invoicedPaise)],
    ["owner.earnings.collected", money(report.totals.collectedPaise)],
    ["owner.earnings.refunds", money(report.totals.refundedPaise)],
    ["owner.earnings.net", money(report.totals.netEarningsPaise)],
    ["owner.earnings.outstanding", money(report.totals.outstandingPaise)],
    ["owner.earnings.invoices", new Intl.NumberFormat("en-IN").format(report.totals.invoiceCount)],
  ] as const;
  const noActivity = report.totals.invoiceCount === 0 && report.totals.collectedPaise === 0 && report.totals.refundedPaise === 0;
  return (
    <div className="kt-owner-earnings">
      <p>{translate(locale, "owner.earnings.intro")}</p>
      <form action="/owner/earnings" className="kt-owner-earnings__filters" method="get">
        <label className="kt-field"><span className="kt-field__label">{translate(locale, "owner.earnings.from")}</span><input defaultValue={report.from} max={report.to} name="from" required type="date" /></label>
        <label className="kt-field"><span className="kt-field__label">{translate(locale, "owner.earnings.to")}</span><input defaultValue={report.to} min={report.from} name="to" required type="date" /></label>
        <label className="kt-field"><span className="kt-field__label">{translate(locale, "owner.earnings.groupBy")}</span><select defaultValue={report.groupBy} name="groupBy"><option value="DAY">{translate(locale, "owner.earnings.day")}</option><option value="MONTH">{translate(locale, "owner.earnings.month")}</option></select></label>
        <button className="kt-button kt-button--primary" type="submit">{translate(locale, "owner.earnings.apply")}</button>
      </form>
      <p className="kt-owner-earnings__source" role="note">{translate(locale, "owner.earnings.sourceNotice")}</p>
      <div className="kt-owner-earnings__summary">
        {summaries.map(([key, value]) => <article key={key}><span>{translate(locale, key)}</span><strong>{value}</strong></article>)}
      </div>
      {noActivity ? <p>{translate(locale, "owner.earnings.noActivity")}</p> : (
        <div className="kt-owner-earnings__table-wrap" tabIndex={0} role="region" aria-label={translate(locale, "owner.earnings.breakdown")}>
          <table className="kt-owner-earnings__table">
            <thead><tr>
              <th scope="col">{translate(locale, "owner.earnings.period")}</th><th scope="col">{translate(locale, "owner.earnings.invoiced")}</th>
              <th scope="col">{translate(locale, "owner.earnings.cash")}</th><th scope="col">{translate(locale, "owner.earnings.online")}</th>
              <th scope="col">{translate(locale, "owner.earnings.refunds")}</th><th scope="col">{translate(locale, "owner.earnings.net")}</th>
              <th scope="col">{translate(locale, "owner.earnings.outstanding")}</th>
            </tr></thead>
            <tbody>{report.periods.map((period) => (
              <tr key={period.period}><th scope="row">{periodLabel(locale, period.period, report.groupBy)}</th><td>{money(period.invoicedPaise)}</td>
                <td>{money(period.cashCollectedPaise)}</td><td>{money(period.onlineCollectedPaise)}</td><td>{money(period.refundedPaise)}</td>
                <td>{money(period.netEarningsPaise)}</td><td>{money(period.outstandingPaise)}</td></tr>
            ))}</tbody>
          </table>
        </div>
      )}
      <p className="kt-owner-earnings__generated"><small>{translate(locale, "owner.earnings.generatedAt", { date: formatDateTime(locale, report.generatedAt) })}</small></p>
    </div>
  );
}
