import type { OwnerEquipmentProjection, OwnerTractorProjection } from "@kisantractor/domain";
import {
  formatDateTime,
  formatIndianCurrency,
  translate,
  type CatalogLocale,
  type MessageKey,
} from "@kisantractor/i18n";

import type { OwnerPricingConfiguration } from "../../lib/owner-catalog";
import type {
  OwnerBookingProjection,
  OwnerBookingsLoadResult,
  OwnerBookingStatus,
  OwnerDocumentProjection,
  OwnerDocumentStatus,
} from "../../lib/owner-management";
import { attemptScope } from "../../lib/authoritative-action";
import { AuthoritativeActionForm, authoritativeActionMessages } from "../connectivity";
import { OwnerJobPanel, type OwnerJobPanelProps } from "../job";
import { OwnerPaymentPanel, type OwnerPaymentPanelProps } from "../payment";
import { Button, Card, CheckboxField, EmptyState, ErrorState, FormActions, SelectField, StatusChip, TextArea, TextInput, type StatusTone } from "../ui";
import { OwnerPricingScreen } from "./owner-catalog-screens";
import { OwnerDocumentUpload } from "./owner-document-upload";

const bookingStatusKeys: Readonly<Record<OwnerBookingStatus, MessageKey>> = {
  CREATED: "status.booking.created", PENDING_OWNER_RESPONSE: "status.booking.pendingOwnerResponse",
  ACCEPTED: "status.booking.accepted", SCHEDULED: "status.booking.scheduled", IN_PROGRESS: "status.booking.inProgress",
  WORK_COMPLETED: "status.booking.workCompleted", FINAL_BILL_GENERATED: "status.booking.finalBillGenerated",
  PAYMENT_RECORDED: "status.booking.paymentRecorded", COMPLETED: "status.booking.completed", REJECTED: "status.booking.rejected",
  CANCELLED: "status.booking.cancelled", EXPIRED: "status.booking.expired", DISPUTED: "status.booking.disputed",
  REFUND_PENDING: "status.booking.refundPending", REFUNDED: "status.booking.refunded",
};
const pendingStatuses = new Set<OwnerBookingStatus>(["CREATED", "PENDING_OWNER_RESPONSE"]);
const acceptedStatuses = new Set<OwnerBookingStatus>(["ACCEPTED", "SCHEDULED"]);
const activeStatuses = new Set<OwnerBookingStatus>(["IN_PROGRESS", "WORK_COMPLETED", "FINAL_BILL_GENERATED", "PAYMENT_RECORDED"]);
const terminalStatuses = new Set<OwnerBookingStatus>(["COMPLETED", "REJECTED", "CANCELLED", "EXPIRED", "REFUNDED"]);

const bookingTone = (status: OwnerBookingStatus): StatusTone =>
  status === "COMPLETED" || status === "PAYMENT_RECORDED" || status === "REFUNDED" ? "success"
    : status === "REJECTED" || status === "CANCELLED" || status === "EXPIRED" || status === "DISPUTED" ? "danger"
      : pendingStatuses.has(status) || status === "REFUND_PENDING" ? "warning" : "info";

const quoteMethodKeys = {
  HOURLY: "form.hourly",
  PER_ACRE: "form.perAcre",
  PER_TRIP: "form.perTrip",
} as const satisfies Readonly<Record<OwnerBookingProjection["quote"]["method"], MessageKey>>;

const roundingKeys = {
  PROPORTIONAL_MINUTE: "rounding.proportionalMinute",
  THIRTY_MINUTE_BLOCK: "rounding.thirtyMinuteBlock",
  ONE_HOUR_BLOCK: "rounding.oneHourBlock",
} as const satisfies Readonly<Record<NonNullable<OwnerBookingProjection["quote"]["roundingPolicy"]>, MessageKey>>;

function OwnerBookingFacts({ booking, locale }: Readonly<{ booking: OwnerBookingProjection; locale: CatalogLocale }>) {
  const location = [booking.serviceLocation.village, booking.serviceLocation.mandalOrTaluk, booking.serviceLocation.district, booking.serviceLocation.state]
    .filter(Boolean).join(", ");
  return (
    <dl className="kt-owner-booking-facts">
      <div><dt>{translate(locale, "owner.bookings.status")}</dt><dd><StatusChip tone={bookingTone(booking.status)}>{translate(locale, bookingStatusKeys[booking.status])}</StatusChip></dd></div>
      <div><dt>{translate(locale, "owner.bookings.bookedBy")}</dt><dd>{booking.customer.displayName}</dd></div>
      {booking.recipient ? <div><dt>{translate(locale, "owner.bookings.recipient")}</dt><dd>{booking.recipient.name}</dd></div> : null}
      <div><dt>{translate(locale, "form.tractor")}</dt><dd>{booking.tractor.brand} {booking.tractor.model}</dd></div>
      <div><dt>{translate(locale, "form.farmingWork")}</dt><dd>{booking.serviceName}</dd></div>
      {booking.equipmentName ? <div><dt>{translate(locale, "form.equipment")}</dt><dd>{booking.equipmentName}</dd></div> : null}
      <div><dt>{translate(locale, "form.serviceLocation")}</dt><dd>{location}{booking.serviceLocation.landmark ? ` — ${booking.serviceLocation.landmark}` : ""}</dd></div>
      <div><dt>{translate(locale, "form.quantity")}</dt><dd>{booking.quote.estimatedQuantity}</dd></div>
      <div><dt>{translate(locale, "owner.bookings.interval")}</dt><dd>{formatDateTime(locale, booking.requestedInterval.start)} – {formatDateTime(locale, booking.requestedInterval.end)}</dd></div>
      <div><dt>{translate(locale, "owner.bookings.paymentExpectation")}</dt><dd>{booking.paymentExpectation}</dd></div>
    </dl>
  );
}

function OwnerQuoteSnapshot({ booking, locale }: Readonly<{ booking: OwnerBookingProjection; locale: CatalogLocale }>) {
  const quote = booking.quote;
  return (
    <section aria-labelledby={`quote-${booking.id}`} className="kt-owner-quote">
      <div className="kt-owner-quote__heading">
        <h3 id={`quote-${booking.id}`}>{translate(locale, "owner.bookings.agreedQuote")}</h3>
        <StatusChip tone="info">{translate(locale, "owner.bookings.immutableAgreement")}</StatusChip>
      </div>
      <dl className="kt-owner-booking-facts">
        <div><dt>{translate(locale, "form.pricingMethod")}</dt><dd>{translate(locale, quoteMethodKeys[quote.method])}</dd></div>
        <div><dt>{translate(locale, "owner.bookings.agreedRate")}</dt><dd>{formatIndianCurrency(locale, quote.ratePaise)}</dd></div>
        {quote.roundingPolicy ? <div><dt>{translate(locale, "owner.pricing.roundingPolicy")}</dt><dd>{translate(locale, roundingKeys[quote.roundingPolicy])}</dd></div> : null}
        <div><dt>{translate(locale, "form.quantity")}</dt><dd>{quote.estimatedQuantity}</dd></div>
        <div><dt>{translate(locale, "currency.estimatedTotal")}</dt><dd>{formatIndianCurrency(locale, quote.estimatedTotalPaise)}</dd></div>
        <div><dt>{translate(locale, "owner.bookings.agreementVersion")}</dt><dd>{quote.pricingRuleVersion}</dd></div>
        {quote.disclosedAt ? <div><dt>{translate(locale, "owner.bookings.disclosedAt")}</dt><dd>{formatDateTime(locale, quote.disclosedAt)}</dd></div> : null}
      </dl>
    </section>
  );
}

function OwnerBookingCard({ booking, locale }: Readonly<{ booking: OwnerBookingProjection; locale: CatalogLocale }>) {
  return (
    <Card
      actions={<a className="kt-button kt-button--secondary" href={`/owner/bookings/${encodeURIComponent(booking.id)}`}>{translate(locale, "control.viewDetails")}</a>}
      className="kt-owner-booking-card"
      eyebrow={`${translate(locale, "owner.bookings.reference")} ${booking.publicReference}`}
      title={booking.serviceName}
    >
      <OwnerBookingFacts booking={booking} locale={locale} />
      <p className="kt-owner-booking-card__estimate"><strong>{translate(locale, "currency.estimatedTotal")}:</strong> {formatIndianCurrency(locale, booking.quote.estimatedTotalPaise)}</p>
    </Card>
  );
}

function BookingSection({ bookings, id, locale, title }: Readonly<{ bookings: readonly OwnerBookingProjection[]; id: string; locale: CatalogLocale; title: string }>) {
  if (bookings.length === 0) return null;
  return <section aria-labelledby={id} className="kt-owner-bookings__section"><h2 id={id}>{title}</h2><div className="kt-owner-booking-grid">{bookings.map((booking) => <OwnerBookingCard booking={booking} key={booking.id} locale={locale} />)}</div></section>;
}

export function OwnerBookingList({ locale, result, view = "all" }: Readonly<{ locale: CatalogLocale; result: OwnerBookingsLoadResult; view?: "all" | "active" }>) {
  if (result.state === "ERROR") return <ErrorState message={result.message} title={translate(locale, "owner.bookings.loadError")} />;
  if (result.items.length === 0) return <EmptyState message={translate(locale, "owner.bookings.emptyHelp")} title={translate(locale, "owner.bookings.empty")} />;

  const requests = result.items.filter((booking) => pendingStatuses.has(booking.status));
  const accepted = result.items.filter((booking) => acceptedStatuses.has(booking.status));
  const active = result.items.filter((booking) => activeStatuses.has(booking.status));
  const history = result.items.filter((booking) => terminalStatuses.has(booking.status) || booking.status === "DISPUTED" || booking.status === "REFUND_PENDING");
  return (
    <div className="kt-owner-bookings">
      <p className="kt-route-surface__lead">{translate(locale, view === "active" ? "owner.bookings.activeIntro" : "owner.bookings.intro")}</p>
      {view === "all" ? <BookingSection bookings={requests} id="owner-booking-requests" locale={locale} title={translate(locale, "menu.bookingRequests")} /> : null}
      <BookingSection bookings={accepted} id="owner-accepted-jobs" locale={locale} title={translate(locale, "owner.bookings.acceptedJobs")} />
      <BookingSection bookings={active} id="owner-active-jobs" locale={locale} title={translate(locale, "owner.bookings.activeJobs")} />
      {view === "all" ? <BookingSection bookings={history} id="owner-booking-history" locale={locale} title={translate(locale, "owner.bookings.history")} /> : null}
      {view === "active" && accepted.length + active.length === 0 ? <EmptyState message={translate(locale, "owner.bookings.noActiveHelp")} title={translate(locale, "owner.bookings.noActive")} /> : null}
    </div>
  );
}

export function OwnerBookingDetail({ booking, decisionNotConfirmed = false, decisionOutcomeReported = false, job, jobError, locale, payment, paymentError, scheduleConflict = false }: Readonly<{
  booking: OwnerBookingProjection;
  /** Authoritative job controls and invoice preview, present once the booking is accepted. */
  job?: Omit<OwnerJobPanelProps, "bookingId" | "locale">;
  jobError?: string;
  locale: CatalogLocale;
  /** Authoritative settlement and the cash-received form, present once the booking is billed. */
  payment?: Omit<OwnerPaymentPanelProps, "bookingId" | "locale">;
  paymentError?: string;
  scheduleConflict?: boolean;
  /** True when this page reports the server's answer to an accept or reject request. */
  decisionOutcomeReported?: boolean;
  /** The last accept or reject request failed with an unknown outcome; nothing was queued. */
  decisionNotConfirmed?: boolean;
}>) {
  const canDecide = pendingStatuses.has(booking.status);
  const decisionFamily = attemptScope("decision", booking.id);
  const isAccepted = acceptedStatuses.has(booking.status);
  return (
    <div className="kt-owner-booking-detail">
      <a className="kt-button kt-button--quiet" href="/owner/bookings">← {translate(locale, "owner.bookings.back")}</a>
      {decisionNotConfirmed ? (
        <div className="kt-owner-feedback kt-owner-feedback--danger" role="alert">
          <p>{translate(locale, "owner.bookings.decisionNotConfirmed")}</p>
        </div>
      ) : null}
      {scheduleConflict ? (
        <div className="kt-owner-feedback kt-owner-feedback--danger" role="alert">
          <p>{translate(locale, "owner.bookings.decisionHelp")}</p>
          <a className="kt-button kt-button--secondary" href={`/owner/bookings/${encodeURIComponent(booking.id)}`}>
            {translate(locale, "control.retry")}
          </a>
        </div>
      ) : null}
      <Card eyebrow={`${translate(locale, "owner.bookings.reference")} ${booking.publicReference}`} title={booking.serviceName}>
        <OwnerBookingFacts booking={booking} locale={locale} />
      </Card>
      <OwnerQuoteSnapshot booking={booking} locale={locale} />
      {isAccepted ? <Card title={translate(locale, "owner.bookings.acceptedJobTitle")}><p>{translate(locale, "owner.bookings.acceptedJobHelp")}</p><a className="kt-button kt-button--primary" href={`/owner/bookings/${encodeURIComponent(booking.id)}${job ? "#job-controls" : "#service-location"}`}>{translate(locale, "owner.bookings.reviewJob")}</a></Card> : null}
      {job ? <OwnerJobPanel bookingId={booking.id} locale={locale} {...job} /> : null}
      {jobError ? <ErrorState message={jobError} title={translate(locale, "job.title")} /> : null}
      {payment ? <OwnerPaymentPanel bookingId={booking.id} locale={locale} {...payment} /> : null}
      {paymentError ? <ErrorState message={paymentError} title={translate(locale, "payment.ownerTitle")} /> : null}
      {canDecide ? (
        <section aria-labelledby="owner-booking-decision" className="kt-owner-booking-decision">
          <h2 id="owner-booking-decision">{translate(locale, "owner.bookings.decisionTitle")}</h2>
          <p>{translate(locale, "owner.bookings.decisionHelp")}</p>
          <div className="kt-owner-booking-decision__actions">
            {/* The expected version is the stable request identity: a repeated decision is a conflict, never a second one. */}
            <AuthoritativeActionForm
              action={`/api/owner/bookings/${encodeURIComponent(booking.id)}/accept`}
              actionId={`${decisionFamily}:accept`}
              family={decisionFamily}
              messages={authoritativeActionMessages(locale, translate(locale, "control.accept"))}
              outcomeReported={decisionOutcomeReported}
            >
              <input name="expectedVersion" type="hidden" value={booking.version} />
              <Button type="submit">{translate(locale, "control.accept")}</Button>
            </AuthoritativeActionForm>
            <AuthoritativeActionForm
              action={`/api/owner/bookings/${encodeURIComponent(booking.id)}/reject`}
              actionId={`${decisionFamily}:reject`}
              className="kt-owner-booking-reject"
              draftFields={["reason"]}
              family={decisionFamily}
              messages={authoritativeActionMessages(locale, translate(locale, "control.reject"))}
              outcomeReported={decisionOutcomeReported}
            >
              <input name="expectedVersion" type="hidden" value={booking.version} />
              <TextArea id="rejectionReason" label={translate(locale, "owner.bookings.rejectionReason")} maxLength={500} name="reason" required />
              <Button type="submit" variant="danger">{translate(locale, "control.reject")}</Button>
            </AuthoritativeActionForm>
          </div>
        </section>
      ) : null}
    </div>
  );
}

const equipmentStatuses = ["AVAILABLE", "UNAVAILABLE", "MAINTENANCE"] as const;

export function OwnerEquipmentScreen({ equipment, locale, tractors }: Readonly<{ equipment: readonly OwnerEquipmentProjection[]; locale: CatalogLocale; tractors: readonly OwnerTractorProjection[] }>) {
  const tractorOptions = [{ value: "", label: translate(locale, "owner.equipment.inventory") }, ...tractors.map((tractor) => ({ value: tractor.id, label: `${tractor.brand} ${tractor.model}` }))];
  return (
    <div className="kt-owner-workflow">
      <p className="kt-route-surface__lead">{translate(locale, "owner.equipment.intro")}</p>
      <section aria-labelledby="add-equipment" className="kt-owner-management-panel">
        <h2 id="add-equipment">{translate(locale, "owner.equipment.add")}</h2>
        <form action="/api/owner/equipment" className="kt-owner-form" method="post">
          <div className="kt-owner-form__grid">
            <TextInput id="equipmentTypeId" label={translate(locale, "owner.equipment.typeId")} maxLength={100} name="equipmentTypeId" required />
            <TextInput id="equipmentDisplayName" label={translate(locale, "owner.equipment.displayName")} maxLength={150} name="displayName" required />
            <SelectField id="equipmentTractor" label={translate(locale, "owner.equipment.assignment")} name="tractorId" options={tractorOptions} />
            <SelectField id="equipmentStatus" label={translate(locale, "owner.equipment.availability")} name="availabilityStatus" options={equipmentStatuses.map((status) => ({ value: status, label: translate(locale, `owner.equipment.status.${status.toLowerCase()}` as MessageKey) }))} />
          </div>
          <FormActions><Button type="submit">{translate(locale, "owner.equipment.add")}</Button></FormActions>
        </form>
      </section>
      {equipment.length === 0 ? <EmptyState message={translate(locale, "owner.equipment.emptyHelp")} title={translate(locale, "owner.equipment.empty")} /> : (
        <div className="kt-owner-equipment-grid">
          {equipment.map((item) => (
            <Card eyebrow={item.equipmentTypeName} key={item.id} title={item.displayName}>
              <form action={`/api/owner/equipment/${encodeURIComponent(item.id)}`} className="kt-owner-form" method="post">
                <input name="expectedVersion" type="hidden" value={item.version} />
                <TextInput defaultValue={item.displayName} id={`equipment-name-${item.id}`} label={translate(locale, "owner.equipment.displayName")} maxLength={150} name="displayName" required />
                <SelectField defaultValue={item.availabilityStatus} id={`equipment-status-${item.id}`} label={translate(locale, "owner.equipment.availability")} name="availabilityStatus" options={equipmentStatuses.map((status) => ({ value: status, label: translate(locale, `owner.equipment.status.${status.toLowerCase()}` as MessageKey) }))} />
                <FormActions><Button type="submit" variant="secondary">{translate(locale, "control.save")}</Button></FormActions>
              </form>
              <form action={`/api/owner/equipment/${encodeURIComponent(item.id)}/assignment`} className="kt-owner-form" method="post">
                <input name="expectedVersion" type="hidden" value={item.version} />
                <SelectField defaultValue={item.tractorId ?? ""} id={`equipment-assignment-${item.id}`} label={translate(locale, "owner.equipment.assignment")} name="tractorId" options={tractorOptions} />
                <FormActions><Button type="submit" variant="secondary">{translate(locale, "owner.equipment.assign")}</Button></FormActions>
              </form>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

const documentStatusKeys: Readonly<Record<OwnerDocumentStatus, MessageKey>> = {
  PENDING_UPLOAD: "status.document.pending",
  PENDING_SCAN: "status.document.pending",
  ACCEPTED: "status.document.accepted",
  REJECTED: "status.document.rejected",
  EXPIRED: "owner.documents.expired",
};

export function OwnerDocumentsScreen({ documents, locale, tractors }: Readonly<{ documents: readonly OwnerDocumentProjection[]; locale: CatalogLocale; tractors: readonly OwnerTractorProjection[] }>) {
  const tractorNames = new Map(tractors.map((tractor) => [tractor.id, `${tractor.brand} ${tractor.model}`]));
  return (
    <div className="kt-owner-workflow">
      <p className="kt-route-surface__lead">{translate(locale, "owner.documents.intro")}</p>
      <section aria-labelledby="upload-document" className="kt-owner-management-panel"><h2 id="upload-document">{translate(locale, "owner.documents.uploadTitle")}</h2><OwnerDocumentUpload locale={locale} tractorOptions={tractors.map((tractor) => ({ id: tractor.id, label: `${tractor.brand} ${tractor.model}` }))} /></section>
      {documents.length === 0 ? <EmptyState message={translate(locale, "owner.documents.emptyHelp")} title={translate(locale, "owner.documents.empty")} /> : (
        <div className="kt-owner-document-grid">
          {documents.map((document) => <Card eyebrow={document.documentKind.replaceAll("_", " ")} key={document.id} title={document.fileName}>
            <dl className="kt-owner-booking-facts">
              <div><dt>{translate(locale, "owner.bookings.status")}</dt><dd><StatusChip tone={document.scanStatus === "ACCEPTED" ? "success" : document.scanStatus === "REJECTED" || document.scanStatus === "EXPIRED" ? "danger" : "warning"}>{translate(locale, documentStatusKeys[document.scanStatus])}</StatusChip></dd></div>
              <div><dt>{translate(locale, "form.tractor")}</dt><dd>{document.tractorId ? tractorNames.get(document.tractorId) ?? document.tractorId : translate(locale, "owner.documents.ownerLevel")}</dd></div>
              <div><dt>{translate(locale, "owner.documents.fileType")}</dt><dd>{document.declaredMimeType}</dd></div>
              <div><dt>{translate(locale, "owner.documents.fileSize")}</dt><dd>{new Intl.NumberFormat(locale).format(document.declaredSizeBytes)} bytes</dd></div>
              {document.expiresAt ? <div><dt>{translate(locale, "owner.documents.expires")}</dt><dd>{formatDateTime(locale, document.expiresAt)}</dd></div> : null}
            </dl>
            {document.scanStatus === "ACCEPTED" ? <a className="kt-button kt-button--secondary" href={`/api/owner/documents/${encodeURIComponent(document.id)}/download-grant`}>{translate(locale, "owner.documents.download")}</a> : null}
          </Card>)}
        </div>
      )}
    </div>
  );
}

export function OwnerServicesScreen({ configurations, equipment, locale, tractors }: Readonly<{ configurations: readonly OwnerPricingConfiguration[]; equipment: readonly OwnerEquipmentProjection[]; locale: CatalogLocale; tractors: readonly OwnerTractorProjection[] }>) {
  return (
    <div className="kt-owner-services">
      <section aria-labelledby="owner-service-offerings" className="kt-owner-management-panel">
        <h2 id="owner-service-offerings">{translate(locale, "owner.services.title")}</h2>
        <p>{translate(locale, "owner.services.help")}</p>
        {configurations.length > 0 ? <div className="kt-owner-service-grid">
          {configurations.map(({ tractor, offering }) => <form action={`/api/owner/tractors/${encodeURIComponent(tractor.id)}/service-offerings`} className="kt-owner-form" key={`existing-${offering.id}`} method="post">
            <h3>{offering.serviceName} · {tractor.brand} {tractor.model}</h3>
            <input name="serviceId" type="hidden" value={offering.serviceId} />
            {offering.equipmentId ? <input name="equipmentId" type="hidden" value={offering.equipmentId} /> : null}
            <input name="expectedVersion" type="hidden" value={offering.version} />
            <CheckboxField defaultChecked={offering.enabled} id={`existing-service-enabled-${offering.id}`} label={translate(locale, "owner.services.enabled")} name="enabled" value="true" />
            <FormActions><Button type="submit" variant="secondary">{translate(locale, "control.save")}</Button></FormActions>
          </form>)}
        </div> : null}
        <h3>{translate(locale, "owner.services.addTitle")}</h3>
        <div className="kt-owner-service-grid">
          {tractors.map((tractor) => {
            const availableEquipment = equipment.filter((item) => item.tractorId === undefined || item.tractorId === tractor.id);
            return <form action={`/api/owner/tractors/${encodeURIComponent(tractor.id)}/service-offerings`} className="kt-owner-form" key={tractor.id} method="post">
              <h3>{tractor.brand} {tractor.model}</h3>
              <TextInput id={`service-${tractor.id}`} label={translate(locale, "owner.services.serviceId")} maxLength={100} name="serviceId" required />
              <SelectField id={`service-equipment-${tractor.id}`} label={translate(locale, "form.equipment")} name="equipmentId" options={[{ value: "", label: translate(locale, "owner.pricing.noEquipment") }, ...availableEquipment.map((item) => ({ value: item.id, label: item.displayName }))]} />
              <CheckboxField defaultChecked id={`service-enabled-${tractor.id}`} label={translate(locale, "owner.services.enabled")} name="enabled" value="true" />
              <FormActions><Button type="submit">{translate(locale, "owner.services.save")}</Button></FormActions>
            </form>;
          })}
        </div>
      </section>
      <OwnerPricingScreen configurations={configurations} locale={locale} />
    </div>
  );
}
