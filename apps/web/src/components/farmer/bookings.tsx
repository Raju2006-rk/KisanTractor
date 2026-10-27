import {
  formatDateTime,
  formatIndianCurrency,
  translate,
  type CatalogLocale,
  type MessageKey,
} from "@kisantractor/i18n";

import type {
  FarmerBookingProjection,
  FarmerBookingsLoadResult,
  FarmerBookingStatus,
  FarmerPaymentStatus,
} from "../../lib/farmer-bookings";
import type { BookingSettlementView } from "../../lib/payments";
import { DataFreshness } from "../connectivity";
import { FarmerJobPanel, type FarmerJobPanelProps } from "../job";
import { FarmerPaymentPanel, settlementStatusKeys, settlementStatusTone, type FarmerOnlinePaymentProps } from "../payment";
import { Card, EmptyState, ErrorState, StatusChip, type StatusTone } from "../ui";

const statusKeys: Readonly<Record<FarmerBookingStatus, MessageKey>> = {
  CREATED: "status.booking.created", PENDING_OWNER_RESPONSE: "status.booking.pendingOwnerResponse",
  ACCEPTED: "status.booking.accepted", SCHEDULED: "status.booking.scheduled", IN_PROGRESS: "status.booking.inProgress",
  WORK_COMPLETED: "status.booking.workCompleted", FINAL_BILL_GENERATED: "status.booking.finalBillGenerated",
  PAYMENT_RECORDED: "status.booking.paymentRecorded", COMPLETED: "status.booking.completed", REJECTED: "status.booking.rejected",
  CANCELLED: "status.booking.cancelled", EXPIRED: "status.booking.expired", DISPUTED: "status.booking.disputed",
  REFUND_PENDING: "status.booking.refundPending", REFUNDED: "status.booking.refunded",
};
const paymentKeys: Readonly<Record<FarmerPaymentStatus, MessageKey>> = settlementStatusKeys;
const terminalStatuses = new Set<FarmerBookingStatus>(["COMPLETED", "REJECTED", "CANCELLED", "EXPIRED", "REFUNDED"]);

const toneForStatus = (status: FarmerBookingStatus): StatusTone =>
  status === "COMPLETED" || status === "PAYMENT_RECORDED" || status === "REFUNDED" ? "success"
    : status === "CANCELLED" || status === "REJECTED" || status === "EXPIRED" || status === "DISPUTED" ? "danger"
      : status === "CREATED" || status === "PENDING_OWNER_RESPONSE" || status === "REFUND_PENDING" ? "warning" : "info";

function BookingFacts({ booking, locale, detailed = false }: Readonly<{ booking: FarmerBookingProjection; locale: CatalogLocale; detailed?: boolean }>) {
  return <dl className="kt-booking-facts">
    <div><dt>Status</dt><dd><StatusChip tone={toneForStatus(booking.status)}>{translate(locale, statusKeys[booking.status])}</StatusChip></dd></div>
    <div><dt>Tractor</dt><dd>{booking.tractor.brand} {booking.tractor.model}</dd></div>
    <div><dt>Work</dt><dd>{booking.serviceName}</dd></div>
    <div><dt>Schedule</dt><dd>{formatDateTime(locale, booking.requestedInterval.start)} – {formatDateTime(locale, booking.requestedInterval.end)}</dd></div>
    <div><dt>Service location</dt><dd>{booking.serviceLocation.village}, {booking.serviceLocation.district}, {booking.serviceLocation.state}{booking.serviceLocation.landmark ? ` — ${booking.serviceLocation.landmark}` : ""}</dd></div>
    {booking.recipient ? <div><dt>Recipient</dt><dd>{booking.recipient.name}</dd></div> : null}
    <div><dt>Owner</dt><dd>{booking.owner.displayName}</dd></div>
    {booking.owner.contactPhone ? <div><dt>Owner contact</dt><dd><a href={`tel:${booking.owner.contactPhone}`}>{booking.owner.contactPhone}</a></dd></div> : detailed ? <div><dt>Owner contact</dt><dd>Not shared by the Owner</dd></div> : null}
    <div><dt>Agreed estimate</dt><dd>{formatIndianCurrency(locale, booking.quote.estimatedTotalPaise)} · {booking.quote.method.replaceAll("_", " ").toLowerCase()}</dd></div>
  </dl>;
}

function BookingCard({ booking, locale }: Readonly<{ booking: FarmerBookingProjection; locale: CatalogLocale }>) {
  return <Card
    className="kt-booking-card"
    eyebrow={`Booking ${booking.publicReference}`}
    title={`${booking.tractor.brand} ${booking.tractor.model}`}
    actions={<a className="kt-button kt-button--secondary" href={`/farmer/bookings/${encodeURIComponent(booking.id)}`}>{translate(locale, "control.viewDetails")}</a>}
  ><BookingFacts booking={booking} locale={locale} /></Card>;
}

export function FarmerBookingList({ locale, result }: Readonly<{ locale: CatalogLocale; result: FarmerBookingsLoadResult }>) {
  if (result.state === "ERROR") return <ErrorState title="Could not load bookings" message={result.message} />;
  if (result.items.length === 0) return <EmptyState title="No bookings yet" message="Search for a tractor and your booking updates will appear here." action={<a className="kt-button kt-button--primary" href="/farmer/search">{translate(locale, "menu.searchTractors")}</a>} />;
  const current = result.items.filter((booking) => !terminalStatuses.has(booking.status));
  const history = result.items.filter((booking) => terminalStatuses.has(booking.status));
  return <div className="kt-bookings">
    <p className="kt-route-surface__lead">Track requests, active work, bills, disputes, payments, and completed bookings.</p>
    <a className="kt-button kt-button--quiet" href="/farmer/payments">{translate(locale, "payment.history.open")}</a>
    {current.length ? <section aria-labelledby="current-bookings"><h2 id="current-bookings">Current bookings</h2><div className="kt-booking-grid">{current.map((booking) => <BookingCard booking={booking} key={booking.id} locale={locale} />)}</div></section> : null}
    {history.length ? <section aria-labelledby="booking-history"><h2 id="booking-history">Booking history</h2><div className="kt-booking-grid">{history.map((booking) => <BookingCard booking={booking} key={booking.id} locale={locale} />)}</div></section> : null}
  </div>;
}

export function FarmerBookingDetail({ booking, checkedAt, job, jobError, locale, online, paymentError, settlement }: Readonly<{
  booking: FarmerBookingProjection;
  /** When the server returned this booking, bill, and payment data. */
  checkedAt?: Date;
  /** Authoritative active-job record, final bill, and review once work has started. */
  job?: Omit<FarmerJobPanelProps, "bookingId" | "locale">;
  jobError?: string;
  locale: CatalogLocale;
  /** Authoritative settlement, payment records, and receipt links once the booking is billed. */
  settlement?: BookingSettlementView;
  /** Online payment key, feedback, and retry state for the payment panel. */
  online?: FarmerOnlinePaymentProps;
  paymentError?: string;
}>) {
  return <div className="kt-booking-detail">
    <a className="kt-button kt-button--quiet" href="/farmer/bookings">← Back to bookings</a>
    <Card eyebrow={`Booking ${booking.publicReference}`} title={`${booking.tractor.brand} ${booking.tractor.model}`}><BookingFacts booking={booking} detailed locale={locale} /></Card>
    {job ? <FarmerJobPanel bookingId={booking.id} locale={locale} {...job} /> : null}
    {jobError ? <ErrorState message={jobError} title={translate(locale, "job.farmerTitle")} /> : null}
    {!job && (booking.status === "IN_PROGRESS" || booking.status === "WORK_COMPLETED") ? <Card title="Work progress"><p>{booking.status === "IN_PROGRESS" ? "The Owner has started work. Recorded active work will be used for the final bill." : "Work is complete. The final bill will use the agreed pricing and recorded evidence."}</p></Card> : null}
    {!job && booking.invoice ? <Card title="Final bill">
      {checkedAt ? <DataFreshness checkedAt={checkedAt} kind="invoice" locale={locale} /> : null}
      <dl className="kt-booking-facts"><div><dt>Status</dt><dd>{booking.invoice.status}</dd></div><div><dt>{translate(locale, "currency.finalTotal")}</dt><dd>{formatIndianCurrency(locale, booking.invoice.totalPaise)}</dd></div>{booking.invoice.formula ? <div><dt>Calculation</dt><dd>{booking.invoice.formula}</dd></div> : null}{booking.invoice.evidenceSummary ? <div><dt>Work evidence</dt><dd>{booking.invoice.evidenceSummary}</dd></div> : null}</dl>
    </Card> : null}
    {!job && booking.dispute ? <Card title="Dispute"><StatusChip tone="danger">{translate(locale, "status.booking.disputed")}</StatusChip><p>{booking.dispute.note ?? "This bill is under review. Settlement cannot be finalized until the dispute is reviewed."}</p></Card> : null}
    {settlement ? <FarmerPaymentPanel locale={locale} settlement={settlement} {...(checkedAt ? { checkedAt } : {})} {...(online ? { online } : {})} /> : null}
    {paymentError ? <ErrorState message={paymentError} title={translate(locale, "payment.title")} /> : null}
    {!settlement && booking.payment ? <Card title="Payment">{checkedAt ? <DataFreshness checkedAt={checkedAt} kind="payment" locale={locale} pending={booking.payment.status === "PENDING" || booking.payment.status === "REFUND_PENDING"} /> : null}<dl className="kt-booking-facts"><div><dt>Status</dt><dd><StatusChip tone={settlementStatusTone(booking.payment.status)}>{translate(locale, paymentKeys[booking.payment.status])}</StatusChip></dd></div>{booking.payment.method ? <div><dt>Method</dt><dd>{booking.payment.method === "CASH" ? "Cash" : "Online"}</dd></div> : null}{booking.payment.amountPaise !== undefined ? <div><dt>Amount</dt><dd>{formatIndianCurrency(locale, booking.payment.amountPaise)}</dd></div> : null}{booking.payment.recordedAt ? <div><dt>Recorded</dt><dd>{formatDateTime(locale, booking.payment.recordedAt)}</dd></div> : null}</dl></Card> : null}
  </div>;
}
