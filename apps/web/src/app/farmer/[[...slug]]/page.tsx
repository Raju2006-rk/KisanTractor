import { randomUUID } from "node:crypto";

import { translate, type MessageKey } from "@kisantractor/i18n";
import { notFound } from "next/navigation";

import { FarmerBookingStepper } from "../../../components/farmer/booking-stepper";
import { FarmerBookingDetail, FarmerBookingList } from "../../../components/farmer/bookings";
import {
  FarmerHome,
  FarmerSearchResults,
  FarmerTractorDetails,
} from "../../../components/farmer/discovery";
import { PaymentHistoryScreen, PaymentReceiptScreen } from "../../../components/payment";
import { RouteSurface } from "../../../components/shell";
import { Card } from "../../../components/ui";
import {
  loadFarmerBooking,
  loadFarmerBookings,
  type FarmerBookingDetailLoadResult,
  type FarmerBookingsLoadResult,
} from "../../../lib/farmer-bookings";
import {
  loadFarmerDiscovery,
  type SearchParameters,
} from "../../../lib/farmer-discovery";
import { farmerJobStatuses, loadJobSession, type JobSessionLoadResult } from "../../../lib/job-tracking";
import {
  billedBookingStatuses,
  loadBookingSettlement,
  loadPaymentHistory,
  loadPaymentReceipt,
  readOnlineRetryState,
  type PaymentHistoryLoadResult,
  type ReceiptLoadResult,
  type SettlementLoadResult,
} from "../../../lib/payments";
import { loadLocale, runtimeConfig } from "../../../lib/server-context";

const disputeFeedbacks = ["disputed", "conflict", "invalid", "failed"] as const;

const routeTitles: Readonly<Record<string, MessageKey>> = {
  "": "menu.home",
  search: "menu.searchTractors",
  book: "control.bookNow",
  bookings: "menu.bookings",
  payments: "menu.payments",
  help: "help.title",
  account: "menu.account",
};

interface FarmerPageProps {
  readonly params: Promise<{ slug?: string[] }>;
  readonly searchParams: Promise<SearchParameters>;
}

export default async function FarmerRoute({ params, searchParams }: FarmerPageProps) {
  const [{ slug }, query, locale] = await Promise.all([params, searchParams, loadLocale()]);
  const route = slug?.join("/") ?? "";
  const tractorId = slug?.[0] === "tractors" && slug.length === 2 ? slug[1] : undefined;
  const bookingId = slug?.[0] === "bookings" && slug.length === 2 ? slug[1] : undefined;
  const receiptRoute = slug?.[0] === "bookings" && slug.length === 4 && slug[2] === "receipts"
    ? { bookingId: slug[1]!, paymentId: slug[3]! }
    : undefined;
  const titleKey = tractorId ? "farmer.search.tractorDetails" : bookingId ? "menu.bookings"
    : receiptRoute ? "payment.receiptTitle" : routeTitles[route];
  if (!titleKey) notFound();

  let discovery;
  let bookings: FarmerBookingsLoadResult | undefined;
  let bookingDetail: FarmerBookingDetailLoadResult | undefined;
  let jobResult: JobSessionLoadResult | undefined;
  let settlementResult: SettlementLoadResult | undefined;
  let receiptResult: ReceiptLoadResult | undefined;
  let historyResult: PaymentHistoryLoadResult | undefined;
  const historyCursor = typeof query.cursor === "string" ? query.cursor : undefined;
  if (route === "payments") {
    historyResult = await loadPaymentHistory("farmer", historyCursor);
  } else if (route === "search" || route === "book" || tractorId) {
    const searchQuery = tractorId || route === "book" ? { ...query, search: "1" } : query;
    discovery = await loadFarmerDiscovery(searchQuery);
  } else if (route === "bookings") {
    bookings = await loadFarmerBookings();
  } else if (bookingId) {
    bookingDetail = await loadFarmerBooking(bookingId);
    if (bookingDetail.state === "NOT_FOUND") notFound();
    if (bookingDetail.state === "READY") {
      const booking = bookingDetail.booking;
      [jobResult, settlementResult] = await Promise.all([
        farmerJobStatuses.has(booking.status) ? loadJobSession("farmer", booking.id) : undefined,
        billedBookingStatuses.has(booking.status) ? loadBookingSettlement("farmer", booking.id) : undefined,
      ]);
    }
  } else if (receiptRoute) {
    receiptResult = await loadPaymentReceipt("farmer", receiptRoute.paymentId);
    if (receiptResult.state === "NOT_FOUND" ||
        (receiptResult.state === "READY" && receiptResult.receipt.bookingId !== receiptRoute.bookingId)) notFound();
  }
  // Every record below was just read with `no-store`; this is when the screen's data was checked.
  const checkedAt = new Date();
  const disputeQuery = typeof query.dispute === "string" ? query.dispute : query.dispute?.[0];
  const disputeFeedback = disputeFeedbacks.find((value) => value === disputeQuery);
  const onlineState = readOnlineRetryState(query);
  const online = {
    key: randomUUID(),
    ...(onlineState.feedback ? { feedback: onlineState.feedback } : {}),
    ...(onlineState.retry ? { retry: onlineState.retry } : {}),
  };

  const requestedTractorId = tractorId ?? (typeof query.tractorId === "string" ? query.tractorId : query.tractorId?.[0]);
  const selectedTractor = requestedTractorId && discovery?.state === "READY"
    ? discovery.page.items.find((tractor) => tractor.id === requestedTractorId)
    : undefined;
  if (tractorId && (!discovery || discovery.state !== "READY" || !selectedTractor)) notFound();

  return (
    <RouteSurface eyebrow={translate(locale, "shell.farmer")} title={translate(locale, titleKey)}>
      {route === "" ? <FarmerHome locale={locale} /> : null}
      {route === "search" && discovery ? <FarmerSearchResults locale={locale} mapsCapability={runtimeConfig().capabilities.MAPS_GEOCODING} result={discovery} /> : null}
      {route === "book" ? (
        <FarmerBookingStepper
          checkedAt={discovery?.state === "READY" ? discovery.page.evaluatedAt.toISOString() : undefined}
          locale={locale}
          parameters={query}
          tractor={selectedTractor}
        />
      ) : null}
      {tractorId && selectedTractor && discovery?.state === "READY" ? <FarmerTractorDetails checkedAt={discovery.page.evaluatedAt} criteria={discovery.criteria} locale={locale} tractor={selectedTractor} /> : null}
      {route === "bookings" && bookings ? <FarmerBookingList locale={locale} result={bookings} /> : null}
      {bookingDetail?.state === "READY" ? (
        <FarmerBookingDetail
          booking={bookingDetail.booking}
          locale={locale}
          checkedAt={checkedAt}
          {...(jobResult?.state === "READY"
            ? { job: { session: jobResult.session, checkedAt, ...(disputeFeedback ? { feedback: disputeFeedback } : {}) } }
            : {})}
          {...(jobResult?.state === "ERROR" ? { jobError: jobResult.message } : {})}
          {...(settlementResult?.state === "READY" ? { settlement: settlementResult.settlement, online } : {})}
          {...(settlementResult?.state === "ERROR" ? { paymentError: settlementResult.message } : {})}
        />
      ) : null}
      {historyResult?.state === "READY" ? (
        <PaymentHistoryScreen history={historyResult.history} locale={locale} role="farmer" {...(historyCursor ? { cursor: historyCursor } : {})} />
      ) : null}
      {historyResult?.state === "ERROR" ? <p className="kt-farmer-search__error" role="alert">{historyResult.message}</p> : null}
      {bookingDetail?.state === "ERROR" ? <p className="kt-farmer-search__error" role="alert">{bookingDetail.message}</p> : null}
      {receiptResult?.state === "READY" ? <PaymentReceiptScreen locale={locale} receipt={receiptResult.receipt} role="farmer" /> : null}
      {receiptResult?.state === "UNAVAILABLE" ? <p className="kt-farmer-search__error" role="alert">{translate(locale, "payment.receipt.unavailable")}</p> : null}
      {receiptResult?.state === "ERROR" ? <p className="kt-farmer-search__error" role="alert">{receiptResult.message}</p> : null}
      {route === "help" ? (
        <div className="kt-help-grid">
          {["help.gettingStarted", "help.booking", "help.payment", "help.contactSupport"].map((key) => (
            <Card key={key} title={translate(locale, key)}><p>{translate(locale, "shell.routePending")}</p></Card>
          ))}
        </div>
      ) : null}
      {route === "account" ? (
        <div className="kt-account-links">
          <p>{translate(locale, "shell.accountIntro")}</p>
          <a className="kt-button kt-button--secondary" href="/farmer/payments">{translate(locale, "menu.payments")}</a>
          <a className="kt-button kt-button--secondary" href="/language">{translate(locale, "control.chooseLanguage")}</a>
          <a className="kt-button kt-button--secondary" href="/farmer/help">{translate(locale, "menu.help")}</a>
        </div>
      ) : null}
    </RouteSurface>
  );
}
