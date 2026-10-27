import { randomUUID } from "node:crypto";

import { translate, type MessageKey } from "@kisantractor/i18n";
import { notFound } from "next/navigation";

import {
  OwnerBookingDetail,
  OwnerBookingList,
  OwnerDashboard,
  OwnerDocumentsScreen,
  OwnerEarningsReport,
  OwnerEquipmentScreen,
  OwnerProfileScreen,
  OwnerServicesScreen,
  OwnerTractorFormScreen,
  OwnerTractorListScreen,
} from "../../../components/owner";
import { PaymentHistoryScreen, PaymentReceiptScreen } from "../../../components/payment";
import { RouteSurface } from "../../../components/shell";
import { Card } from "../../../components/ui";
import { loadLocale, runtimeConfig } from "../../../lib/server-context";
import { jobActionKeys, loadJobSession, ownerJobStatuses, readJobRetryState } from "../../../lib/job-tracking";
import { loadOwnerDashboard } from "../../../lib/owner-dashboard";
import { loadOwnerEarningsReport, type EarningsGroupingView } from "../../../lib/owner-earnings";
import { billedBookingStatuses, loadBookingSettlement, loadPaymentHistory, loadPaymentReceipt, readCashRetryState } from "../../../lib/payments";
import { loadOwnerPricingConfigurations, loadOwnerProfile, loadOwnerTractor, loadOwnerTractors } from "../../../lib/owner-catalog";
import {
  loadOwnerBooking,
  loadOwnerBookings,
  loadOwnerDocuments,
  loadOwnerEquipment,
} from "../../../lib/owner-management";

const routeTitles: Readonly<Record<string, MessageKey>> = {
  "": "menu.dashboard",
  tractors: "menu.myTractors",
  "tractors/new": "owner.tractor.newTitle",
  pricing: "owner.pricing.title",
  profile: "owner.profile.title",
  bookings: "menu.bookings",
  equipment: "menu.equipment",
  documents: "menu.documents",
  earnings: "menu.earnings",
  payments: "menu.payments",
  help: "help.title",
  account: "menu.account",
};

interface OwnerPageProps {
  readonly params: Promise<{ slug?: string[] }>;
  readonly searchParams: Promise<Readonly<Record<string, string | string[] | undefined>>>;
}

export default async function OwnerRoute({ params, searchParams }: OwnerPageProps) {
  const [{ slug }, query, locale] = await Promise.all([params, searchParams, loadLocale()]);
  const route = slug?.join("/") ?? "";
  const tractorId = slug?.length === 2 && slug[0] === "tractors" && slug[1] !== "new" ? slug[1] : undefined;
  const bookingId = slug?.length === 2 && slug[0] === "bookings" ? slug[1] : undefined;
  const receipt = slug?.length === 4 && slug[0] === "bookings" && slug[2] === "receipts"
    ? { bookingId: slug[1]!, paymentId: slug[3]! }
    : undefined;
  const titleKey = routeTitles[route] ?? (tractorId ? "owner.tractor.editTitle" : bookingId ? "menu.bookings"
    : receipt ? "payment.receiptTitle" : undefined);
  if (!titleKey) notFound();

  const mapsCapability = runtimeConfig().capabilities.MAPS_GEOCODING;
  let content;
  if (route === "") {
    const dashboard = await loadOwnerDashboard();
    content = <OwnerDashboard availabilities={dashboard.availabilities} locale={locale} summary={dashboard.summary} />;
  } else if (route === "profile") {
    const profile = await loadOwnerProfile();
    content = <OwnerProfileScreen locale={locale} mapsCapability={mapsCapability} {...(profile === undefined ? {} : { profile })} />;
  } else if (route === "tractors") {
    content = <OwnerTractorListScreen locale={locale} tractors={await loadOwnerTractors()} />;
  } else if (route === "tractors/new") {
    content = <OwnerTractorFormScreen locale={locale} mapsCapability={mapsCapability} />;
  } else if (route === "pricing") {
    const [configurations, tractors, equipment] = await Promise.all([
      loadOwnerPricingConfigurations(),
      loadOwnerTractors(),
      loadOwnerEquipment(),
    ]);
    content = <OwnerServicesScreen configurations={configurations} equipment={equipment} locale={locale} tractors={tractors} />;
  } else if (route === "equipment") {
    const [equipment, tractors] = await Promise.all([loadOwnerEquipment(), loadOwnerTractors()]);
    content = <OwnerEquipmentScreen equipment={equipment} locale={locale} tractors={tractors} />;
  } else if (route === "documents") {
    const [documents, tractors] = await Promise.all([loadOwnerDocuments(), loadOwnerTractors()]);
    content = <OwnerDocumentsScreen documents={documents} locale={locale} tractors={tractors} />;
  } else if (route === "bookings") {
    const requestedView = Array.isArray(query.view) ? query.view[0] : query.view;
    content = <OwnerBookingList locale={locale} result={await loadOwnerBookings()} view={requestedView === "active" ? "active" : "all"} />;
  } else if (bookingId) {
    const result = await loadOwnerBooking(bookingId);
    if (result.state === "NOT_FOUND") notFound();
    if (result.state === "READY") {
      const jobResult = ownerJobStatuses.has(result.booking.status) ? await loadJobSession("owner", result.booking.id) : undefined;
      const jobCheckedAt = new Date();
      const retry = readJobRetryState(query);
      const job = jobResult?.state === "READY"
        ? {
            session: jobResult.session,
            actionKeys: jobActionKeys(retry, randomUUID),
            checkedAt: jobCheckedAt,
            ...(retry.feedback ? { feedback: retry.feedback } : {}),
            ...(retry.retryAction ? { retryAction: retry.retryAction } : {}),
          }
        : undefined;
      const settlementResult = billedBookingStatuses.has(result.booking.status)
        ? await loadBookingSettlement("owner", result.booking.id)
        : undefined;
      const cash = readCashRetryState(query);
      const settlementCheckedAt = new Date();
      const payment = settlementResult?.state === "READY"
        ? {
            settlement: settlementResult.settlement,
            cashKey: randomUUID(),
            now: settlementCheckedAt,
            checkedAt: settlementCheckedAt,
            ...(cash.feedback ? { feedback: cash.feedback } : {}),
            ...(cash.retry ? { retry: cash.retry } : {}),
          }
        : undefined;
      const decisionError = Array.isArray(query.error) ? query.error[0] : query.error;
      content = (
        <OwnerBookingDetail
          booking={result.booking}
          decisionNotConfirmed={decisionError === "save-failed" || decisionError === "service-unavailable"}
          decisionOutcomeReported={query.saved === "1" || decisionError !== undefined}
          locale={locale}
          scheduleConflict={query.error === "schedule-conflict"}
          {...(job ? { job } : {})}
          {...(jobResult?.state === "ERROR" ? { jobError: jobResult.message } : {})}
          {...(payment ? { payment } : {})}
          {...(settlementResult?.state === "ERROR" ? { paymentError: settlementResult.message } : {})}
        />
      );
    } else {
      content = <p className="kt-owner-feedback kt-owner-feedback--danger" role="alert">{result.message}</p>;
    }
  } else if (route === "earnings") {
    const from = typeof query.from === "string" ? query.from : undefined;
    const to = typeof query.to === "string" ? query.to : undefined;
    const groupBy: EarningsGroupingView | undefined = query.groupBy === "MONTH" ? "MONTH" : query.groupBy === "DAY" ? "DAY" : undefined;
    const earnings = await loadOwnerEarningsReport({ ...(from ? { from } : {}), ...(to ? { to } : {}), ...(groupBy ? { groupBy } : {}) });
    content = earnings.state === "READY"
      ? <OwnerEarningsReport locale={locale} report={earnings.report} />
      : <p className="kt-owner-feedback kt-owner-feedback--danger" role="alert">{translate(locale, "owner.earnings.loadError")}</p>;
  } else if (route === "payments") {
    const cursor = typeof query.cursor === "string" ? query.cursor : undefined;
    const history = await loadPaymentHistory("owner", cursor);
    content = history.state === "READY"
      ? <PaymentHistoryScreen history={history.history} locale={locale} role="owner" {...(cursor ? { cursor } : {})} />
      : <p className="kt-owner-feedback kt-owner-feedback--danger" role="alert">{history.message}</p>;
  } else if (receipt) {
    const result = await loadPaymentReceipt("owner", receipt.paymentId);
    if (result.state === "NOT_FOUND" || (result.state === "READY" && result.receipt.bookingId !== receipt.bookingId)) notFound();
    content = result.state === "READY"
      ? <PaymentReceiptScreen locale={locale} receipt={result.receipt} role="owner" />
      : <p className="kt-owner-feedback kt-owner-feedback--danger" role="alert">{result.state === "UNAVAILABLE" ? translate(locale, "payment.receipt.unavailable") : result.message}</p>;
  } else if (tractorId) {
    const tractor = await loadOwnerTractor(tractorId);
    if (!tractor) notFound();
    content = <OwnerTractorFormScreen locale={locale} mapsCapability={mapsCapability} tractor={tractor} />;
  } else if (route === "help") {
    content = (
      <div className="kt-help-grid">
        {(["help.gettingStarted", "help.booking", "help.payment", "help.contactSupport"] as const).map((key) => (
          <Card key={key} title={translate(locale, key)}><p>{translate(locale, "shell.routePending")}</p></Card>
        ))}
      </div>
    );
  } else if (route === "account") {
    content = (
      <div className="kt-account-links">
        <p>{translate(locale, "shell.accountIntro")}</p>
        <a className="kt-button kt-button--secondary" href="/owner/profile">{translate(locale, "menu.profileAndSettings")}</a>
        <a className="kt-button kt-button--secondary" href="/owner/pricing">{translate(locale, "menu.pricingAndServices")}</a>
        <a className="kt-button kt-button--secondary" href="/owner/equipment">{translate(locale, "menu.equipment")}</a>
        <a className="kt-button kt-button--secondary" href="/owner/documents">{translate(locale, "menu.documents")}</a>
        <a className="kt-button kt-button--secondary" href="/owner/payments">{translate(locale, "menu.payments")}</a>
        <a className="kt-button kt-button--secondary" href="/language">{translate(locale, "control.chooseLanguage")}</a>
        <a className="kt-button kt-button--secondary" href="/owner/help">{translate(locale, "menu.help")}</a>
      </div>
    );
  } else {
    content = <p className="kt-route-surface__lead">{translate(locale, route === "" ? "shell.ownerWelcome" : "shell.routePending")}</p>;
  }

  return (
    <RouteSurface eyebrow={translate(locale, "shell.owner")} title={translate(locale, titleKey)}>
      {content}
    </RouteSurface>
  );
}
