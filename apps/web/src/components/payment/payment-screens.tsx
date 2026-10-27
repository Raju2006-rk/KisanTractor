import {
  formatDateTime,
  formatIndianCurrency,
  translate,
  type CatalogLocale,
  type MessageKey,
} from "@kisantractor/i18n";

import {
  appliedPaymentStatuses,
  cashRecordablePaise,
  formatRupeesInput,
  lastOnlinePaymentNotCompleted,
  onlinePayablePaise,
  parseRupeesToPaise,
  pendingOnlinePayment,
  toIndiaLocalDateTime,
  type BookingSettlementView,
  type CashFeedback,
  type CashRetry,
  type OnlineFeedback,
  type OnlineRetry,
  type PaymentConfirmerView,
  type PaymentHistoryView,
  type PaymentReceiptView,
  type PaymentRecordStatusView,
  type PaymentRole,
  type SettlementStatusView,
} from "../../lib/payments";
import { attemptScope } from "../../lib/authoritative-action";
import { AuthoritativeActionForm, authoritativeActionMessages, DataFreshness } from "../connectivity";
import { Button, Card, StatusChip, TextInput, type StatusTone } from "../ui";

/** Every settlement state, including cash-and-online (`PAID_MIXED`) and zero-total (`NOTHING_DUE`) bills. */
export const settlementStatusKeys: Readonly<Record<SettlementStatusView, MessageKey>> = {
  PENDING: "status.payment.pending",
  AWAITING_FINAL_BILL: "status.payment.awaitingFinalBill",
  PAYMENT_DUE: "status.payment.due",
  PAID_ONLINE: "status.payment.paidOnline",
  PAID_CASH: "status.payment.paidCash",
  PAYMENT_FAILED: "status.payment.failed",
  REFUND_PENDING: "status.payment.refundPending",
  REFUNDED: "status.payment.refunded",
  PAID_MIXED: "status.payment.paidMixed",
  NOTHING_DUE: "status.payment.nothingDue",
};

export const settlementStatusTone = (status: SettlementStatusView): StatusTone =>
  status === "PAID_CASH" || status === "PAID_ONLINE" || status === "PAID_MIXED" || status === "NOTHING_DUE" || status === "REFUNDED"
    ? "success"
    : status === "PAYMENT_FAILED" ? "danger"
      : status === "AWAITING_FINAL_BILL" ? "neutral" : "warning";

const recordStatusTone = (status: PaymentRecordStatusView): StatusTone => settlementStatusTone(status);

const confirmerKeys: Readonly<Record<PaymentConfirmerView, MessageKey>> = {
  OWNER: "payment.confirmedBy.owner",
  FARMER: "payment.confirmedBy.farmer",
  OTHER: "payment.confirmedBy.other",
  PAYMENT_PROVIDER: "payment.confirmedBy.provider",
};
const methodKeys = { CASH: "payment.method.cash", ONLINE: "payment.method.online" } as const satisfies Readonly<Record<string, MessageKey>>;

const cashFeedbackKeys: Readonly<Record<CashFeedback, MessageKey>> = {
  recorded: "payment.feedback.recorded",
  invalid: "payment.feedback.invalid",
  overpayment: "payment.feedback.overpayment",
  blocked: "payment.feedback.blocked",
  conflict: "payment.feedback.conflict",
  failed: "payment.feedback.failed",
  offline: "payment.feedback.offline",
};

const receiptHref = (role: PaymentRole, bookingId: string, paymentId: string): string =>
  `/${role}/bookings/${encodeURIComponent(bookingId)}/receipts/${encodeURIComponent(paymentId)}`;

/** Marks online money that moved through a provider sandbox, so it is never mistaken for a real payment. */
function SandboxPaymentNotice({ locale }: Readonly<{ locale: CatalogLocale }>) {
  return (
    <p>
      <StatusChip tone="info">{translate(locale, "capability.sandboxLabel")}</StatusChip>{" "}
      {translate(locale, "payment.testModeHelp")}
    </p>
  );
}

/** The bill total, what is paid, what awaits confirmation, and what is still to pay. */
export function SettlementSummary({ locale, settlement }: Readonly<{ locale: CatalogLocale; settlement: BookingSettlementView }>) {
  return (
    <>
      <dl className="kt-owner-booking-facts">
        <div><dt>{translate(locale, "payment.status")}</dt><dd><StatusChip tone={settlementStatusTone(settlement.status)}>{translate(locale, settlementStatusKeys[settlement.status])}</StatusChip></dd></div>
        {settlement.status !== "AWAITING_FINAL_BILL" ? (
          <>
            <div><dt>{translate(locale, "payment.billTotal")}</dt><dd>{formatIndianCurrency(locale, settlement.totalPaise)}</dd></div>
            <div><dt>{translate(locale, "payment.paid")}</dt><dd>{formatIndianCurrency(locale, settlement.appliedPaise)}</dd></div>
            {settlement.pendingPaise > 0 ? <div><dt>{translate(locale, "payment.pendingAmount")}</dt><dd>{formatIndianCurrency(locale, settlement.pendingPaise)}</dd></div> : null}
            <div><dt>{translate(locale, "payment.outstanding")}</dt><dd>{formatIndianCurrency(locale, settlement.outstandingPaise)}</dd></div>
          </>
        ) : null}
      </dl>
      {settlement.status === "AWAITING_FINAL_BILL" ? <p>{translate(locale, "payment.notBilled")}</p> : null}
      {settlement.settlementBlocked ? <p className="kt-owner-feedback kt-owner-feedback--danger" role="status">{translate(locale, "payment.blocked")}</p> : null}
      {settlement.settled && settlement.bookingStatus === "COMPLETED" ? <p role="status">{translate(locale, "payment.settledHelp")}</p> : null}
    </>
  );
}

/** Each payment record with its method, status, amount, and confirmation; receipts once the bill is settled. */
export function PaymentRecordList({ locale, role, settlement }: Readonly<{ locale: CatalogLocale; role: PaymentRole; settlement: BookingSettlementView }>) {
  if (settlement.payments.length === 0) return <p>{translate(locale, "payment.noRecords")}</p>;
  return (
    <ol className="kt-job-evidence">
      {settlement.payments.map((payment) => (
        <li className="kt-job-evidence__item" key={payment.id}>
          <strong>{translate(locale, methodKeys[payment.method])}: {formatIndianCurrency(locale, payment.amountPaise)}</strong>
          {payment.method === "ONLINE" && (payment.testMode === true || settlement.onlineTestMode) ? <SandboxPaymentNotice locale={locale} /> : null}
          <dl className="kt-job-evidence__facts">
            <div><dt>{translate(locale, "payment.status")}</dt><dd><StatusChip tone={recordStatusTone(payment.status)}>{translate(locale, settlementStatusKeys[payment.status])}</StatusChip></dd></div>
            {payment.paidAt ? <div><dt>{translate(locale, "payment.paidAt")}</dt><dd><time dateTime={payment.paidAt.toISOString()}>{formatDateTime(locale, payment.paidAt)}</time></dd></div> : null}
            <div><dt>{translate(locale, "payment.recordedAt")}</dt><dd><time dateTime={payment.recordedAt.toISOString()}>{formatDateTime(locale, payment.recordedAt)}</time></dd></div>
            {payment.confirmedBy ? <div><dt>{translate(locale, "payment.confirmedBy")}</dt><dd>{translate(locale, confirmerKeys[payment.confirmedBy])}</dd></div> : null}
          </dl>
          {settlement.settled && appliedPaymentStatuses.has(payment.status) ? (
            <a className="kt-button kt-button--secondary" href={receiptHref(role, settlement.bookingId, payment.id)}>{translate(locale, "payment.viewReceipt")}</a>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

export interface OwnerPaymentPanelProps {
  readonly bookingId: string;
  readonly locale: CatalogLocale;
  readonly settlement: BookingSettlementView;
  /** Fresh stable key for a new cash record; an unknown-outcome retry reuses `retry.key` instead. */
  readonly cashKey: string;
  readonly feedback?: CashFeedback;
  readonly retry?: CashRetry;
  /** Server time used to bound the receipt-time input; the API enforces the bound authoritatively. */
  readonly now: Date;
  /** When the server returned this settlement; defaults to `now`. */
  readonly checkedAt?: Date;
}

/** Payment data awaiting a server-side confirmation, so the screen shows a pending state. */
export const settlementIsPending = (settlement: BookingSettlementView): boolean =>
  settlement.pendingPaise > 0 || settlement.status === "PENDING" || settlement.status === "REFUND_PENDING";

/** Owner settlement view with the cash-received form and an explicit, same-key retry after an unknown outcome. */
export function OwnerPaymentPanel({ bookingId, cashKey, checkedAt, feedback, locale, now, retry, settlement }: OwnerPaymentPanelProps) {
  const action = `/api/owner/bookings/${encodeURIComponent(bookingId)}/payments/cash`;
  const recordable = cashRecordablePaise(settlement);
  const retryPaise = retry === undefined ? undefined : parseRupeesToPaise(retry.amountRupees);
  const family = attemptScope("cash", bookingId);
  const cashLabel = translate(locale, "payment.cashSubmit");
  return (
    <section aria-labelledby="owner-payment" className="kt-job__panel kt-job__panel--bill" id="payment-section">
      <h2 id="owner-payment">{translate(locale, "payment.ownerTitle")}</h2>
      {feedback ? (
        <div className={`kt-owner-feedback ${feedback === "recorded" ? "kt-owner-feedback--success" : "kt-owner-feedback--danger"}`} id="payment-feedback" role={feedback === "recorded" ? "status" : "alert"}>
          <p>{translate(locale, cashFeedbackKeys[feedback])}</p>
        </div>
      ) : null}
      {retry && retryPaise !== undefined && settlement.invoiceId ? (
        <div className="kt-owner-form" role="group" aria-labelledby="cash-retry">
          <h3 id="cash-retry">{translate(locale, "payment.cashRetryTitle")}</h3>
          <p>{translate(locale, "payment.cashRetryHelp", { amount: formatIndianCurrency(locale, retryPaise) })}</p>
          <AuthoritativeActionForm
            action={action}
            actionId={`${family}:retry`}
            family={family}
            idempotencyKey={retry.key}
            messages={authoritativeActionMessages(locale, translate(locale, "payment.cashRetrySubmit", { amount: formatIndianCurrency(locale, retryPaise) }))}
            outcomeReported={feedback !== undefined}
          >
            <input name="invoiceId" type="hidden" value={settlement.invoiceId} />
            <input name="amountRupees" type="hidden" value={retry.amountRupees} />
            {retry.receivedAt ? <input name="receivedAt" type="hidden" value={retry.receivedAt} /> : null}
            <Button type="submit">{translate(locale, "payment.cashRetrySubmit", { amount: formatIndianCurrency(locale, retryPaise) })}</Button>
          </AuthoritativeActionForm>
          <a className="kt-button kt-button--quiet" href={`/owner/bookings/${encodeURIComponent(bookingId)}#payment-section`}>{translate(locale, "payment.cashRetryDiscard")}</a>
        </div>
      ) : null}
      <DataFreshness checkedAt={checkedAt ?? now} kind="payment" locale={locale} pending={settlementIsPending(settlement)} />
      <SettlementSummary locale={locale} settlement={settlement} />
      {settlement.pendingPaise > 0 ? <p>{translate(locale, "payment.ownerPendingHelp")}</p> : null}
      {recordable > 0 && !retry && settlement.invoiceId ? (
        <AuthoritativeActionForm
          action={action}
          actionId={`${family}:record`}
          aria-labelledby="cash-record"
          className="kt-owner-form"
          draftFields={["amountRupees", "receivedAt"]}
          family={family}
          idempotencyKey={cashKey}
          messages={authoritativeActionMessages(locale, cashLabel)}
          outcomeReported={feedback !== undefined}
        >
          <h3 id="cash-record">{translate(locale, "payment.cashTitle")}</h3>
          <p>{translate(locale, "payment.cashHelp")}</p>
          <input name="invoiceId" type="hidden" value={settlement.invoiceId} />
          <TextInput
            defaultValue={formatRupeesInput(recordable)}
            hint={translate(locale, "payment.cashAmountHint", { amount: formatIndianCurrency(locale, recordable) })}
            id="cashAmount"
            inputMode="decimal"
            label={translate(locale, "payment.cashAmount")}
            name="amountRupees"
            pattern="[0-9,]+(\.[0-9]{1,2})?"
            required
          />
          <TextInput
            hint={translate(locale, "payment.cashReceivedAtHint")}
            id="cashReceivedAt"
            label={translate(locale, "payment.cashReceivedAt")}
            max={toIndiaLocalDateTime(now)}
            name="receivedAt"
            type="datetime-local"
          />
          <Button type="submit">{cashLabel}</Button>
        </AuthoritativeActionForm>
      ) : null}
      <h3>{translate(locale, "payment.records")}</h3>
      <PaymentRecordList locale={locale} role="owner" settlement={settlement} />
      <a className="kt-button kt-button--quiet" href="/owner/payments">{translate(locale, "payment.history.open")}</a>
    </section>
  );
}

const onlineFeedbackKeys: Readonly<Record<OnlineFeedback, MessageKey>> = {
  returned: "payment.online.feedback.returned",
  dismissed: "payment.online.feedback.dismissed",
  confirmed: "payment.online.feedback.confirmed",
  cancelled: "payment.online.feedback.cancelled",
  "in-progress": "payment.online.feedback.inProgress",
  unavailable: "payment.online.feedback.unavailable",
  invalid: "payment.online.feedback.invalid",
  overpayment: "payment.online.feedback.overpayment",
  blocked: "payment.online.feedback.blocked",
  conflict: "payment.online.feedback.conflict",
  expired: "payment.online.feedback.expired",
  review: "payment.online.feedback.review",
  failed: "payment.online.feedback.failed",
  offline: "payment.online.feedback.offline",
};
const positiveOnlineFeedback: ReadonlySet<OnlineFeedback> = new Set(["confirmed", "cancelled", "returned"]);

export interface FarmerOnlinePaymentProps {
  /** Fresh stable key for a new online payment; an unknown-outcome retry reuses `retry.key` instead. */
  readonly key: string;
  readonly feedback?: OnlineFeedback;
  readonly retry?: OnlineRetry;
}

/** The Farmer's online payment controls: pay, continue, check status, cancel, and a same-key retry. */
function FarmerOnlinePayment({ locale, online, settlement }: Readonly<{
  locale: CatalogLocale; online: FarmerOnlinePaymentProps; settlement: BookingSettlementView;
}>) {
  const bookingId = settlement.bookingId;
  const family = attemptScope("online", bookingId);
  const action = `/api/farmer/bookings/${encodeURIComponent(bookingId)}/payments/online`;
  const pending = pendingOnlinePayment(settlement);
  const payable = onlinePayablePaise(settlement);
  const { feedback, retry } = online;
  const payLabel = translate(locale, "payment.online.submit", { amount: formatIndianCurrency(locale, payable) });
  const pendingFamily = pending === undefined ? undefined : attemptScope("online-pending", pending.id);
  return (
    <section aria-labelledby="farmer-online-payment" className="kt-owner-form">
      <h3 id="farmer-online-payment">{translate(locale, "payment.online.title")}</h3>
      {feedback ? (
        <div className={`kt-owner-feedback ${positiveOnlineFeedback.has(feedback) ? "kt-owner-feedback--success" : "kt-owner-feedback--danger"}`}
          id="payment-feedback" role={positiveOnlineFeedback.has(feedback) ? "status" : "alert"}>
          <p>{translate(locale, onlineFeedbackKeys[feedback])}</p>
        </div>
      ) : null}
      {settlement.onlineTestMode && (payable > 0 || pending !== undefined) ? <SandboxPaymentNotice locale={locale} /> : null}
      {pending !== undefined && pendingFamily !== undefined ? (
        <div role="group" aria-labelledby="online-pending">
          <h4 id="online-pending">{translate(locale, "payment.online.pendingTitle")}</h4>
          <p>{translate(locale, "payment.online.pendingHelp", { amount: formatIndianCurrency(locale, pending.amountPaise) })}</p>
          <a className="kt-button kt-button--primary" href={`/farmer/pay/${encodeURIComponent(pending.id)}?booking=${encodeURIComponent(bookingId)}`}>
            {translate(locale, "payment.online.continue")}
          </a>
          <AuthoritativeActionForm
            action={`/api/farmer/payments/${encodeURIComponent(pending.id)}/status-check`}
            actionId={`${pendingFamily}:status`}
            family={pendingFamily}
            messages={authoritativeActionMessages(locale, translate(locale, "payment.online.checkStatus"))}
            outcomeReported={feedback !== undefined}
          >
            <input name="bookingId" type="hidden" value={bookingId} />
            <Button type="submit" variant="secondary">{translate(locale, "payment.online.checkStatus")}</Button>
          </AuthoritativeActionForm>
          <p>{translate(locale, "payment.online.cancelHelp")}</p>
          <AuthoritativeActionForm
            action={`/api/farmer/payments/${encodeURIComponent(pending.id)}/cancel`}
            actionId={`${pendingFamily}:cancel`}
            family={pendingFamily}
            messages={authoritativeActionMessages(locale, translate(locale, "payment.online.cancel"))}
            outcomeReported={feedback !== undefined}
          >
            <input name="bookingId" type="hidden" value={bookingId} />
            <Button type="submit" variant="secondary">{translate(locale, "payment.online.cancel")}</Button>
          </AuthoritativeActionForm>
        </div>
      ) : null}
      {pending === undefined && lastOnlinePaymentNotCompleted(settlement) && payable > 0 ? <p>{translate(locale, "payment.online.notCompletedHelp")}</p> : null}
      {retry && settlement.invoiceId && pending === undefined ? (
        <div role="group" aria-labelledby="online-retry">
          <h4 id="online-retry">{translate(locale, "payment.online.retryTitle")}</h4>
          <p>{translate(locale, "payment.online.retryHelp")}</p>
          <AuthoritativeActionForm
            action={action}
            actionId={`${family}:retry`}
            family={family}
            idempotencyKey={retry.key}
            messages={authoritativeActionMessages(locale, translate(locale, "payment.online.retrySubmit", { amount: formatIndianCurrency(locale, retry.amountPaise) }))}
            outcomeReported={feedback !== undefined}
          >
            <input name="invoiceId" type="hidden" value={settlement.invoiceId} />
            <input name="amountPaise" type="hidden" value={String(retry.amountPaise)} />
            <Button type="submit">{translate(locale, "payment.online.retrySubmit", { amount: formatIndianCurrency(locale, retry.amountPaise) })}</Button>
          </AuthoritativeActionForm>
        </div>
      ) : null}
      {payable > 0 && !retry && settlement.invoiceId ? (
        <AuthoritativeActionForm
          action={action}
          actionId={`${family}:start`}
          family={family}
          idempotencyKey={online.key}
          messages={authoritativeActionMessages(locale, payLabel)}
          outcomeReported={feedback !== undefined}
        >
          <p>{translate(locale, "payment.online.help")}</p>
          <input name="invoiceId" type="hidden" value={settlement.invoiceId} />
          <input name="amountPaise" type="hidden" value={String(payable)} />
          <Button type="submit">{payLabel}</Button>
        </AuthoritativeActionForm>
      ) : null}
      {payable === 0 && pending === undefined && !settlement.onlineAvailable && cashRecordablePaise(settlement) > 0
        ? <p>{translate(locale, "payment.online.unavailable")}</p> : null}
    </section>
  );
}

/** Farmer settlement view: what is due, online payment, every recorded payment, and receipts once settled. */
export function FarmerPaymentPanel({ checkedAt, locale, online, settlement }: Readonly<{
  checkedAt?: Date;
  locale: CatalogLocale;
  settlement: BookingSettlementView;
  /** Online payment controls; omitted where the page cannot offer them. */
  online?: FarmerOnlinePaymentProps;
}>) {
  return (
    <Card className="kt-job__card kt-job__card--bill" id="payment-section" title={translate(locale, "payment.title")}>
      {checkedAt ? <DataFreshness checkedAt={checkedAt} kind="payment" locale={locale} pending={settlementIsPending(settlement)} /> : null}
      <SettlementSummary locale={locale} settlement={settlement} />
      {!settlement.settled && !settlement.settlementBlocked && settlement.status !== "AWAITING_FINAL_BILL" ? <p>{translate(locale, "payment.farmerHelp")}</p> : null}
      {online ? <FarmerOnlinePayment locale={locale} online={online} settlement={settlement} /> : null}
      <h3>{translate(locale, "payment.records")}</h3>
      <PaymentRecordList locale={locale} role="farmer" settlement={settlement} />
      <a className="kt-button kt-button--quiet" href="/farmer/payments">{translate(locale, "payment.history.open")}</a>
    </Card>
  );
}

/** Every payment on the viewer's own bookings, newest first, with receipts once a bill is fully paid. */
export function PaymentHistoryScreen({ cursor, history, locale, role }: Readonly<{
  history: PaymentHistoryView; locale: CatalogLocale; role: PaymentRole; cursor?: string;
}>) {
  return (
    <div className="kt-booking-detail">
      <p className="kt-route-surface__lead">{translate(locale, "payment.history.intro")}</p>
      {history.items.length === 0 ? <p>{translate(locale, cursor === undefined ? "payment.history.empty" : "payment.history.noMore")}</p> : (
        <ol className="kt-job-evidence">
          {history.items.map((item) => (
            <li className="kt-job-evidence__item" key={item.id}>
              <strong>{translate(locale, methodKeys[item.method])}: {formatIndianCurrency(locale, item.amountPaise)}</strong>
              {item.testMode ? <SandboxPaymentNotice locale={locale} /> : null}
              <dl className="kt-job-evidence__facts">
                <div><dt>{translate(locale, "payment.receipt.booking")}</dt><dd><a href={`/${role}/bookings/${encodeURIComponent(item.bookingId)}`}>{item.bookingReference}</a></dd></div>
                <div><dt>{translate(locale, "payment.status")}</dt><dd><StatusChip tone={recordStatusTone(item.status)}>{translate(locale, settlementStatusKeys[item.status])}</StatusChip></dd></div>
                {item.paidAt ? <div><dt>{translate(locale, "payment.paidAt")}</dt><dd><time dateTime={item.paidAt.toISOString()}>{formatDateTime(locale, item.paidAt)}</time></dd></div> : null}
                <div><dt>{translate(locale, "payment.recordedAt")}</dt><dd><time dateTime={item.recordedAt.toISOString()}>{formatDateTime(locale, item.recordedAt)}</time></dd></div>
                {item.confirmedBy ? <div><dt>{translate(locale, "payment.confirmedBy")}</dt><dd>{translate(locale, confirmerKeys[item.confirmedBy])}</dd></div> : null}
              </dl>
              {item.receiptAvailable ? (
                <a className="kt-button kt-button--secondary" href={receiptHref(role, item.bookingId, item.id)}>{translate(locale, "payment.viewReceipt")}</a>
              ) : null}
            </li>
          ))}
        </ol>
      )}
      {cursor !== undefined ? <a className="kt-button kt-button--quiet" href={`/${role}/payments`}>{translate(locale, "payment.history.first")}</a> : null}
      {history.nextCursor !== undefined ? (
        <a className="kt-button kt-button--secondary" href={`/${role}/payments?cursor=${encodeURIComponent(history.nextCursor)}`}>{translate(locale, "payment.history.more")}</a>
      ) : null}
    </div>
  );
}

/** An authorized receipt: booking, bill, method, amount, status, and when the payment was received. */
export function PaymentReceiptScreen({ locale, receipt, role }: Readonly<{ locale: CatalogLocale; receipt: PaymentReceiptView; role: PaymentRole }>) {
  return (
    <div className="kt-booking-detail">
      <a className="kt-button kt-button--quiet" href={`/${role}/bookings/${encodeURIComponent(receipt.bookingId)}#payment-section`}>← {translate(locale, "payment.receipt.back")}</a>
      <Card eyebrow={`${translate(locale, "payment.receipt.booking")} ${receipt.bookingReference}`} title={translate(locale, "payment.receiptTitle")}>
        {receipt.testMode ? <SandboxPaymentNotice locale={locale} /> : null}
        <dl className="kt-owner-booking-facts">
          <div><dt>{translate(locale, "payment.amount")}</dt><dd>{formatIndianCurrency(locale, receipt.amountPaise)}</dd></div>
          <div><dt>{translate(locale, "payment.method")}</dt><dd>{translate(locale, methodKeys[receipt.method])}</dd></div>
          <div><dt>{translate(locale, "payment.status")}</dt><dd><StatusChip tone={recordStatusTone(receipt.status)}>{translate(locale, settlementStatusKeys[receipt.status])}</StatusChip></dd></div>
          <div><dt>{translate(locale, "payment.paidAt")}</dt><dd><time dateTime={receipt.paidAt.toISOString()}>{formatDateTime(locale, receipt.paidAt)}</time></dd></div>
          <div><dt>{translate(locale, "payment.recordedAt")}</dt><dd><time dateTime={receipt.recordedAt.toISOString()}>{formatDateTime(locale, receipt.recordedAt)}</time></dd></div>
          <div><dt>{translate(locale, "payment.confirmedBy")}</dt><dd>{translate(locale, confirmerKeys[receipt.confirmedBy])}</dd></div>
          <div><dt>{translate(locale, "payment.receipt.billTotal")}</dt><dd>{formatIndianCurrency(locale, receipt.invoiceTotalPaise)}</dd></div>
          <div><dt>{translate(locale, "payment.receipt.billVersion")}</dt><dd>{receipt.invoiceVersion}</dd></div>
          <div><dt>{translate(locale, "payment.receipt.settlement")}</dt><dd><StatusChip tone={settlementStatusTone(receipt.settlementStatus)}>{translate(locale, settlementStatusKeys[receipt.settlementStatus])}</StatusChip></dd></div>
          <div><dt>{translate(locale, "payment.receipt.paymentId")}</dt><dd>{receipt.paymentId}</dd></div>
        </dl>
      </Card>
    </div>
  );
}
