import {
  formatDateTime,
  formatIndianCurrency,
  localeMetadata,
  translate,
  type CatalogLocale,
  type MessageKey,
} from "@kisantractor/i18n";

import type {
  JobFeedback,
  JobInvoiceStatus,
  JobInvoiceView,
  JobSessionView,
  JobWorkAction,
  JobWorkEventView,
  JobWorkState,
} from "../../lib/job-tracking";
import { attemptScope } from "../../lib/authoritative-action";
import { AuthoritativeActionForm, authoritativeActionMessages, DataFreshness } from "../connectivity";
import { Button, Card, StatusChip, TextArea, TextInput, type StatusTone } from "../ui";

const stateKeys: Readonly<Record<JobWorkState, MessageKey>> = {
  NOT_STARTED: "job.state.notStarted",
  ACTIVE: "job.state.active",
  PAUSED: "job.state.paused",
  COMPLETED: "job.state.completed",
};
const stateTones: Readonly<Record<JobWorkState, StatusTone>> = {
  NOT_STARTED: "neutral",
  ACTIVE: "info",
  PAUSED: "warning",
  COMPLETED: "success",
};
const actionKeys: Readonly<Record<JobWorkAction, MessageKey>> = {
  START: "job.action.start",
  PAUSE: "job.action.pause",
  RESUME: "job.action.resume",
  COMPLETE: "job.action.complete",
};
const eventKeys: Readonly<Record<JobWorkEventView["eventType"], MessageKey>> = {
  START: "job.event.start",
  PAUSE: "job.event.pause",
  RESUME: "job.event.resume",
  COMPLETE: "job.event.complete",
  CORRECTION: "job.event.correction",
};
const invoiceStatusKeys: Readonly<Record<JobInvoiceStatus, MessageKey>> = {
  ISSUED: "bill.status.issued",
  DISPUTED: "bill.status.disputed",
  SETTLED: "bill.status.settled",
  VOID: "bill.status.void",
};
const invoiceStatusTones: Readonly<Record<JobInvoiceStatus, StatusTone>> = {
  ISSUED: "info",
  DISPUTED: "danger",
  SETTLED: "success",
  VOID: "neutral",
};
const methodKeys = { HOURLY: "form.hourly", PER_ACRE: "form.perAcre", PER_TRIP: "form.perTrip" } as const satisfies Readonly<Record<JobInvoiceView["method"], MessageKey>>;
const rateKeys = { HOURLY: "currency.ratePerHour", PER_ACRE: "currency.ratePerAcre", PER_TRIP: "currency.ratePerTrip" } as const satisfies Readonly<Record<JobInvoiceView["method"], MessageKey>>;
const unitKeys = { HOUR: "bill.unit.hour", ACRE: "bill.unit.acre", TRIP: "bill.unit.trip" } as const satisfies Readonly<Record<JobInvoiceView["billableUnit"], MessageKey>>;
const roundingKeys = {
  PROPORTIONAL_MINUTE: "rounding.proportionalMinute",
  THIRTY_MINUTE_BLOCK: "rounding.thirtyMinuteBlock",
  ONE_HOUR_BLOCK: "rounding.oneHourBlock",
} as const satisfies Readonly<Record<NonNullable<JobInvoiceView["roundingPolicy"]>, MessageKey>>;
const jobFeedbackKeys: Readonly<Record<JobFeedback, MessageKey>> = {
  saved: "job.feedback.saved",
  sequence: "job.feedback.sequence",
  conflict: "job.feedback.conflict",
  invalid: "job.feedback.invalid",
  failed: "job.feedback.failed",
  offline: "job.feedback.offline",
};

/** Formats a decimal quantity for the locale without changing its stored precision. */
const formatQuantity = (locale: CatalogLocale, value: string | number): string =>
  new Intl.NumberFormat(localeMetadata[locale].intlLocale, { maximumFractionDigits: 3 }).format(Number(value));
const formatMinutes = (locale: CatalogLocale, milliseconds: number): string =>
  formatQuantity(locale, Math.round(milliseconds / 600) / 100);

function JobStateSummary({ locale, session }: Readonly<{ locale: CatalogLocale; session: JobSessionView }>) {
  return (
    <dl className="kt-owner-booking-facts">
      <div><dt>{translate(locale, "job.currentState")}</dt><dd><StatusChip tone={stateTones[session.state]}>{translate(locale, stateKeys[session.state])}</StatusChip></dd></div>
      {session.pricingMethod === "HOURLY" || session.activeMilliseconds > 0 ? (
        <div><dt>{translate(locale, "job.activeTime")}</dt><dd>{translate(locale, "job.minutes", { minutes: formatMinutes(locale, session.activeMilliseconds) })}</dd></div>
      ) : null}
      {session.openStartedAt ? <div><dt>{translate(locale, "job.openSince")}</dt><dd><time dateTime={session.openStartedAt.toISOString()}>{formatDateTime(locale, session.openStartedAt)}</time></dd></div> : null}
    </dl>
  );
}

/** The append-only work record: original events, corrections with reasons, and measurements. */
export function WorkEvidenceList({ locale, session }: Readonly<{ locale: CatalogLocale; session: JobSessionView }>) {
  if (session.events.length === 0 && session.measurements.length === 0) {
    return <p>{translate(locale, "job.evidenceEmpty")}</p>;
  }
  return (
    <ol className="kt-job-evidence">
      {session.events.map((event) => (
        <li className={event.eventType === "CORRECTION" ? "kt-job-evidence__item kt-job-evidence__item--correction" : "kt-job-evidence__item"} key={event.id}>
          <strong>{translate(locale, eventKeys[event.eventType])}</strong>
          <dl className="kt-job-evidence__facts">
            {event.eventType === "CORRECTION"
              ? <div><dt>{translate(locale, "job.correctedTime")}</dt><dd><time dateTime={event.effectiveAt.toISOString()}>{formatDateTime(locale, event.effectiveAt)}</time></dd></div>
              : null}
            <div><dt>{translate(locale, "job.serverTime")}</dt><dd><time dateTime={event.receivedAt.toISOString()}>{formatDateTime(locale, event.receivedAt)}</time></dd></div>
            {event.deviceObservedAt ? <div><dt>{translate(locale, "job.deviceTime")}</dt><dd><time dateTime={event.deviceObservedAt.toISOString()}>{formatDateTime(locale, event.deviceObservedAt)}</time></dd></div> : null}
            {event.reason ? <div><dt>{translate(locale, "job.correctionReason")}</dt><dd>{event.reason}</dd></div> : null}
          </dl>
        </li>
      ))}
      {session.measurements.map((measurement) => (
        <li className={measurement.correctionOfId ? "kt-job-evidence__item kt-job-evidence__item--correction" : "kt-job-evidence__item"} key={measurement.id}>
          <strong>{translate(locale, measurement.correctionOfId ? "job.measurementCorrection" : "job.measurement")}: {translate(locale, measurement.unit === "ACRE" ? "job.unit.acre" : "job.unit.trip", { quantity: formatQuantity(locale, measurement.quantity) })}</strong>
          <dl className="kt-job-evidence__facts">
            <div><dt>{translate(locale, "job.serverTime")}</dt><dd><time dateTime={measurement.createdAt.toISOString()}>{formatDateTime(locale, measurement.createdAt)}</time></dd></div>
            {measurement.reason ? <div><dt>{translate(locale, "job.correctionReason")}</dt><dd>{measurement.reason}</dd></div> : null}
          </dl>
        </li>
      ))}
    </ol>
  );
}

/** Explains the final bill: agreed rate, billable quantity, adjustments, total, and how it was rounded. */
export function InvoiceBreakdown({ invoice, locale }: Readonly<{ invoice: JobInvoiceView; locale: CatalogLocale }>) {
  const rate = translate(locale, rateKeys[invoice.method], { amount: formatIndianCurrency(locale, invoice.ratePaise) });
  const quantity = translate(locale, unitKeys[invoice.billableUnit], { quantity: formatQuantity(locale, invoice.billableQuantity) });
  return (
    <div className="kt-invoice">
      {invoice.supersedesEarlierVersion ? <p className="kt-invoice__note">{translate(locale, "bill.reissued")}</p> : null}
      <dl className="kt-owner-booking-facts">
        <div><dt>{translate(locale, "bill.status")}</dt><dd><StatusChip tone={invoiceStatusTones[invoice.status]}>{translate(locale, invoiceStatusKeys[invoice.status])}</StatusChip></dd></div>
        <div><dt>{translate(locale, "bill.method")}</dt><dd>{translate(locale, methodKeys[invoice.method])}</dd></div>
        <div><dt>{translate(locale, "bill.rate")}</dt><dd>{rate}</dd></div>
        {invoice.roundingPolicy ? <div><dt>{translate(locale, "bill.rounding")}</dt><dd>{translate(locale, roundingKeys[invoice.roundingPolicy])}</dd></div> : null}
        {invoice.activeMilliseconds !== undefined ? <div><dt>{translate(locale, "bill.activeTime")}</dt><dd>{translate(locale, "bill.minutes", { minutes: formatMinutes(locale, invoice.activeMilliseconds) })}</dd></div> : null}
        {invoice.billableMilliseconds !== undefined ? <div><dt>{translate(locale, "bill.billableTime")}</dt><dd>{translate(locale, "bill.minutes", { minutes: formatMinutes(locale, invoice.billableMilliseconds) })}</dd></div> : null}
        <div><dt>{translate(locale, "bill.quantity")}</dt><dd>{quantity}</dd></div>
        <div><dt>{translate(locale, "bill.subtotal")}</dt><dd>{formatIndianCurrency(locale, invoice.subtotalPaise)}</dd></div>
        <div><dt>{translate(locale, "bill.adjustments")}</dt><dd>{formatIndianCurrency(locale, invoice.adjustmentsPaise)}</dd></div>
        <div className="kt-invoice__total"><dt>{translate(locale, "currency.finalTotal")}</dt><dd>{formatIndianCurrency(locale, invoice.totalPaise)}</dd></div>
        <div><dt>{translate(locale, "bill.agreementVersion")}</dt><dd>{invoice.agreementVersion}</dd></div>
        <div><dt>{translate(locale, "bill.invoiceVersion")}</dt><dd>{invoice.invoiceVersion}</dd></div>
        <div><dt>{translate(locale, "bill.issuedAt")}</dt><dd><time dateTime={invoice.createdAt.toISOString()}>{formatDateTime(locale, invoice.createdAt)}</time></dd></div>
      </dl>
      <section aria-label={translate(locale, "bill.formulaTitle")} className="kt-invoice__formula">
        <h4>{translate(locale, "bill.formulaTitle")}</h4>
        <p>{translate(locale, "bill.formula", { rate, quantity, subtotal: formatIndianCurrency(locale, invoice.subtotalPaise) })}</p>
        <p>{translate(locale, "bill.roundingNote")} {translate(locale, "bill.evidenceCount", { count: invoice.evidenceCount })}</p>
        <details>
          <summary>{translate(locale, "bill.traceTitle")}</summary>
          <code className="kt-invoice__trace">{invoice.formula}</code>
        </details>
      </section>
    </div>
  );
}

const actionPath = (action: JobWorkAction): string => action.toLowerCase();
const feedbackTone = (feedback: JobFeedback): string => feedback === "saved" ? "kt-owner-feedback--success" : "kt-owner-feedback--danger";

export interface OwnerJobPanelProps {
  readonly bookingId: string;
  readonly locale: CatalogLocale;
  readonly session: JobSessionView;
  /** One stable idempotency key per action; a failed attempt's key is reused for its explicit retry. */
  readonly actionKeys: Readonly<Record<JobWorkAction, string>>;
  readonly feedback?: JobFeedback;
  readonly retryAction?: JobWorkAction;
  /** When the server returned this job record and invoice. */
  readonly checkedAt?: Date;
}

/** Owner job controls, work completion, work record, and the invoice preview the Farmer will review. */
export function OwnerJobPanel({ actionKeys: keys, bookingId, checkedAt, feedback, locale, retryAction, session }: OwnerJobPanelProps) {
  const base = `/api/owner/bookings/${encodeURIComponent(bookingId)}/job`;
  const controlActions = session.validNextActions.filter((action) => action !== "COMPLETE");
  const canComplete = session.validNextActions.includes("COMPLETE");
  const family = attemptScope("job", bookingId);
  // Any job feedback on this page means the server answered the last job request.
  const outcomeReported = feedback !== undefined;
  const actionForm = (action: JobWorkAction, variant: "primary" | "secondary") => {
    const label = translate(locale, actionKeys[action]);
    return (
      <AuthoritativeActionForm
        action={`${base}/${actionPath(action)}`}
        actionId={`${family}:${actionPath(action)}`}
        family={family}
        idempotencyKey={keys[action]}
        key={action}
        messages={authoritativeActionMessages(locale, label)}
        outcomeReported={outcomeReported}
      >
        <Button type="submit" variant={variant}>{label}</Button>
      </AuthoritativeActionForm>
    );
  };
  return (
    <div className="kt-job">
      {feedback ? (
        <div className={`kt-owner-feedback ${feedbackTone(feedback)}`} id="job-feedback" role={feedback === "saved" ? "status" : "alert"}>
          <p>{translate(locale, jobFeedbackKeys[feedback])}</p>
          {retryAction ? <p>{translate(locale, "job.retryReady", { action: translate(locale, actionKeys[retryAction]) })}</p> : null}
        </div>
      ) : null}
      <section aria-labelledby="job-controls" className="kt-job__panel" id="job-controls-section">
        <h2 id="job-controls">{translate(locale, "job.title")}</h2>
        <JobStateSummary locale={locale} session={session} />
        <p>{translate(locale, "job.controlsHelp")}</p>
        {session.validNextActions.length > 0 ? (
          <p className="kt-job__next"><strong>{translate(locale, "job.validNextActions")}:</strong> {session.validNextActions.map((action) => translate(locale, actionKeys[action])).join(", ")}</p>
        ) : <p>{translate(locale, "job.noActions")}</p>}
        {controlActions.length > 0 ? <div className="kt-job__actions">{controlActions.map((action) => actionForm(action, action === "START" || action === "RESUME" ? "primary" : "secondary"))}</div> : null}
      </section>
      {canComplete ? (
        <section aria-labelledby="work-completion" className="kt-job__panel" id="work-completion-section">
          <h2 id="work-completion">{translate(locale, "job.completionTitle")}</h2>
          <AuthoritativeActionForm
            action={`${base}/complete`}
            actionId={`${family}:complete`}
            className="kt-owner-form"
            draftFields={["completedQuantity"]}
            family={family}
            idempotencyKey={keys.COMPLETE}
            messages={authoritativeActionMessages(locale, translate(locale, "job.action.complete"))}
            outcomeReported={outcomeReported}
          >
            {session.pricingMethod === "HOURLY" ? <p>{translate(locale, "job.completionHourlyHelp")}</p> : (
              <>
                <p>{translate(locale, "job.completionMeasuredHelp")}</p>
                {session.pricingMethod === "PER_ACRE" ? (
                  <TextInput hint={translate(locale, "job.completedAcresHint")} id="completedAcres" inputMode="decimal" label={translate(locale, "job.completedAcres")} min="0" name="completedQuantity" required step="0.001" type="number" />
                ) : (
                  <TextInput hint={translate(locale, "job.completedTripsHint")} id="completedTrips" inputMode="numeric" label={translate(locale, "job.completedTrips")} min="0" name="completedQuantity" required step="1" type="number" />
                )}
              </>
            )}
            <Button type="submit">{translate(locale, "job.action.complete")}</Button>
          </AuthoritativeActionForm>
        </section>
      ) : null}
      <section aria-labelledby="work-evidence" className="kt-job__panel">
        <h2 id="work-evidence">{translate(locale, "job.evidenceTitle")}</h2>
        <WorkEvidenceList locale={locale} session={session} />
      </section>
      <section aria-labelledby="invoice-preview" className="kt-job__panel kt-job__panel--bill">
        <h2 id="invoice-preview">{translate(locale, "bill.previewTitle")}</h2>
        {session.invoice ? (
          <>
            <p>{translate(locale, "bill.previewHelp")}</p>
            {session.bookingStatus === "DISPUTED" ? <p className="kt-owner-feedback kt-owner-feedback--danger" role="status">{translate(locale, "bill.ownerDisputedHelp")}</p> : null}
            {checkedAt ? <DataFreshness checkedAt={checkedAt} kind="invoice" locale={locale} /> : null}
            <InvoiceBreakdown invoice={session.invoice} locale={locale} />
          </>
        ) : <p>{translate(locale, "bill.notReady")}</p>}
      </section>
    </div>
  );
}

export type DisputeFeedback = "disputed" | "conflict" | "invalid" | "failed";
const disputeFeedbackKeys: Readonly<Record<DisputeFeedback, MessageKey>> = {
  disputed: "bill.feedback.disputed",
  conflict: "bill.feedback.conflict",
  invalid: "bill.feedback.invalid",
  failed: "bill.feedback.failed",
};

export interface FarmerJobPanelProps {
  readonly bookingId: string;
  readonly locale: CatalogLocale;
  readonly session: JobSessionView;
  readonly feedback?: DisputeFeedback;
  /** When the server returned this job record and final bill. */
  readonly checkedAt?: Date;
}

/** Farmer active-job view, final bill, and the bill review with a reasoned dispute. */
export function FarmerJobPanel({ bookingId, checkedAt, feedback, locale, session }: FarmerJobPanelProps) {
  const reviewable = (session.bookingStatus === "FINAL_BILL_GENERATED" || session.bookingStatus === "PAYMENT_RECORDED") && session.invoice !== undefined;
  const disputed = session.bookingStatus === "DISPUTED";
  return (
    <div className="kt-job">
      {feedback ? (
        <p id="job-feedback" className={`kt-owner-feedback ${feedback === "disputed" ? "kt-owner-feedback--success" : "kt-owner-feedback--danger"}`} role={feedback === "disputed" ? "status" : "alert"}>
          {translate(locale, disputeFeedbackKeys[feedback])}
        </p>
      ) : null}
      <Card className="kt-job__card" title={translate(locale, "job.farmerTitle")}>
        <p>{translate(locale, "job.farmerHelp")}</p>
        <JobStateSummary locale={locale} session={session} />
        <h3>{translate(locale, "job.evidenceTitle")}</h3>
        <WorkEvidenceList locale={locale} session={session} />
      </Card>
      <Card className="kt-job__card kt-job__card--bill" title={translate(locale, "bill.title")}>
        {session.invoice && checkedAt ? <DataFreshness checkedAt={checkedAt} kind="invoice" locale={locale} /> : null}
        {session.invoice ? <InvoiceBreakdown invoice={session.invoice} locale={locale} /> : <p>{translate(locale, "bill.notReady")}</p>}
      </Card>
      {reviewable ? (
        <section aria-labelledby="bill-review" className="kt-job__panel kt-job__review">
          <h2 id="bill-review">{translate(locale, "bill.reviewTitle")}</h2>
          <p>{translate(locale, "bill.reviewHelp")}</p>
          {/* The expected version makes a repeated dispute a conflict, never a second dispute. */}
          <AuthoritativeActionForm
            action={`/api/farmer/bookings/${encodeURIComponent(bookingId)}/dispute`}
            actionId={`${attemptScope("dispute", bookingId)}:submit`}
            className="kt-owner-form"
            draftFields={["reason"]}
            family={attemptScope("dispute", bookingId)}
            messages={authoritativeActionMessages(locale, translate(locale, "bill.disputeSubmit"))}
            outcomeReported={feedback !== undefined}
          >
            <input name="expectedVersion" type="hidden" value={session.bookingVersion} />
            <TextArea hint={translate(locale, "bill.disputeHint")} id="disputeReason" label={translate(locale, "bill.disputeReason")} maxLength={500} name="reason" required />
            <Button type="submit" variant="danger">{translate(locale, "bill.disputeSubmit")}</Button>
          </AuthoritativeActionForm>
        </section>
      ) : null}
      {disputed ? (
        <section aria-labelledby="bill-disputed" className="kt-job__panel kt-job__review">
          <h2 id="bill-disputed">{translate(locale, "bill.disputedTitle")}</h2>
          <StatusChip tone="danger">{translate(locale, "status.booking.disputed")}</StatusChip>
          <p>{translate(locale, "bill.disputedHelp")}</p>
        </section>
      ) : null}
    </div>
  );
}
