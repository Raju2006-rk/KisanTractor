import { cookies } from "next/headers";

import { accessCookieName, runtimeConfig } from "./server-context";

/**
 * Invoice settlement states. Beyond the eight payment states, `PAID_MIXED` marks a bill settled
 * with both cash and online money, and `NOTHING_DUE` marks a zero-total bill.
 */
export const settlementStatuses = [
  "PENDING", "AWAITING_FINAL_BILL", "PAYMENT_DUE", "PAID_ONLINE", "PAID_CASH",
  "PAYMENT_FAILED", "REFUND_PENDING", "REFUNDED", "PAID_MIXED", "NOTHING_DUE",
] as const;
export type SettlementStatusView = (typeof settlementStatuses)[number];

export const paymentRecordStatuses = ["PENDING", "PAID_ONLINE", "PAID_CASH", "PAYMENT_FAILED", "REFUND_PENDING", "REFUNDED"] as const;
export type PaymentRecordStatusView = (typeof paymentRecordStatuses)[number];
export type PaymentMethodView = "CASH" | "ONLINE";
export type PaymentConfirmerView = "OWNER" | "FARMER" | "OTHER" | "PAYMENT_PROVIDER";
export type PaymentRole = "owner" | "farmer";

/** Payment statuses whose money counts toward the bill; these payments get receipts once it is settled. */
export const appliedPaymentStatuses: ReadonlySet<PaymentRecordStatusView> = new Set(["PAID_CASH", "PAID_ONLINE", "REFUND_PENDING"]);

export interface PaymentRecordView {
  readonly id: string;
  readonly method: PaymentMethodView;
  readonly status: PaymentRecordStatusView;
  readonly amountPaise: number;
  readonly recordedAt: Date;
  readonly paidAt?: Date;
  readonly confirmedBy?: PaymentConfirmerView;
  /** Present only for online money that moved through a provider sandbox. */
  readonly testMode?: true;
}

export interface BookingSettlementView {
  readonly bookingId: string;
  readonly bookingReference: string;
  readonly bookingStatus: string;
  readonly invoiceId?: string;
  readonly invoiceVersion?: number;
  readonly status: SettlementStatusView;
  readonly totalPaise: number;
  readonly appliedPaise: number;
  readonly pendingPaise: number;
  readonly outstandingPaise: number;
  readonly settled: boolean;
  readonly settlementBlocked: boolean;
  readonly payments: readonly PaymentRecordView[];
  /**
   * True when online payments in this environment run against a provider sandbox, so every
   * online record must be labelled as test money (Requirement 14.3). Absent means not a test.
   */
  readonly onlineTestMode: boolean;
  /** True only when the server reports online payment as SANDBOX or LIVE right now. */
  readonly onlineAvailable: boolean;
}

export interface PaymentReceiptView {
  readonly bookingId: string;
  readonly bookingReference: string;
  readonly invoiceVersion: number;
  readonly invoiceTotalPaise: number;
  readonly paymentId: string;
  readonly method: PaymentMethodView;
  readonly status: PaymentRecordStatusView;
  readonly settlementStatus: SettlementStatusView;
  readonly amountPaise: number;
  readonly paidAt: Date;
  readonly recordedAt: Date;
  readonly confirmedBy: PaymentConfirmerView;
  /** Present only for online money that moved through a provider sandbox. */
  readonly testMode?: true;
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const safeText = (value: unknown, maximum = 200): string | undefined =>
  typeof value === "string" && value.trim().length > 0 && value.trim().length <= maximum ? value.trim() : undefined;
const safePaise = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const safeDate = (value: unknown): Date | undefined => {
  if (!(value instanceof Date) && typeof value !== "string") return undefined;
  const result = new Date(value);
  return Number.isNaN(result.getTime()) ? undefined : result;
};
const oneOf = <T extends string>(value: unknown, allowed: readonly T[]): T | undefined =>
  typeof value === "string" && (allowed as readonly string[]).includes(value) ? value as T : undefined;
const confirmers = ["OWNER", "FARMER", "OTHER", "PAYMENT_PROVIDER"] as const;
const methods = ["CASH", "ONLINE"] as const;

/** Allowlists one party-safe payment record; provider references and recorder identifiers are never copied. */
export function normalizePaymentRecord(value: unknown): PaymentRecordView | undefined {
  const source = record(value);
  const id = safeText(source?.id);
  const method = oneOf(source?.method, methods);
  const status = oneOf(source?.status, paymentRecordStatuses);
  const amountPaise = safePaise(source?.amountPaise);
  const recordedAt = safeDate(source?.recordedAt);
  if (!id || !method || !status || amountPaise === undefined || amountPaise === 0 || !recordedAt) return undefined;
  // Cash never carries an online status, and online money never carries the paid-cash status.
  if (method === "CASH" && (status === "PAID_ONLINE" || status === "PENDING" || status === "PAYMENT_FAILED")) return undefined;
  if (method === "ONLINE" && status === "PAID_CASH") return undefined;
  const paidAt = source?.paidAt === undefined ? undefined : safeDate(source.paidAt);
  const confirmedBy = oneOf(source?.confirmedBy, confirmers);
  return Object.freeze({
    id, method, status, amountPaise, recordedAt,
    ...(paidAt ? { paidAt } : {}),
    ...(confirmedBy ? { confirmedBy } : {}),
    // Only online money can be sandbox money; a cash record is never labelled as a test.
    ...(method === "ONLINE" && source?.testMode === true ? { testMode: true as const } : {}),
  });
}

/** Allowlists the authoritative settlement view and rejects totals that do not add up. */
export function normalizeBookingSettlement(value: unknown): BookingSettlementView | undefined {
  const source = record(value);
  const settlement = record(source?.settlement);
  const bookingId = safeText(source?.bookingId);
  const bookingReference = safeText(source?.bookingReference);
  const bookingStatus = safeText(source?.bookingStatus, 50);
  const status = oneOf(settlement?.status, settlementStatuses);
  const totalPaise = safePaise(settlement?.totalPaise);
  const appliedPaise = safePaise(settlement?.appliedPaise);
  const pendingPaise = safePaise(settlement?.pendingPaise);
  const outstandingPaise = safePaise(settlement?.outstandingPaise);
  if (!bookingId || !bookingReference || !bookingStatus || !status || totalPaise === undefined ||
      appliedPaise === undefined || pendingPaise === undefined || outstandingPaise === undefined ||
      typeof settlement?.settled !== "boolean" || !Array.isArray(source?.payments) ||
      appliedPaise + outstandingPaise !== totalPaise || settlement.settled !== (status !== "AWAITING_FINAL_BILL" && outstandingPaise === 0)) {
    return undefined;
  }
  const payments = source.payments.map(normalizePaymentRecord);
  if (payments.some((payment) => payment === undefined)) return undefined;
  const invoiceId = safeText(source.invoiceId);
  const invoiceVersion = typeof source.invoiceVersion === "number" && Number.isSafeInteger(source.invoiceVersion) && source.invoiceVersion > 0
    ? source.invoiceVersion : undefined;
  return Object.freeze({
    bookingId,
    bookingReference,
    bookingStatus,
    ...(invoiceId ? { invoiceId } : {}),
    ...(invoiceVersion ? { invoiceVersion } : {}),
    status,
    totalPaise,
    appliedPaise,
    pendingPaise,
    outstandingPaise,
    settled: settlement.settled,
    settlementBlocked: settlement.settlementBlocked === true,
    payments: Object.freeze(payments as PaymentRecordView[]),
    onlineTestMode: record(source.onlinePayment)?.testMode === true,
    onlineAvailable: record(source.onlinePayment)?.available === true,
  });
}

export function normalizePaymentReceipt(value: unknown): PaymentReceiptView | undefined {
  const source = record(value);
  const bookingId = safeText(source?.bookingId);
  const bookingReference = safeText(source?.bookingReference);
  const invoiceVersion = typeof source?.invoiceVersion === "number" && Number.isSafeInteger(source.invoiceVersion) && source.invoiceVersion > 0
    ? source.invoiceVersion : undefined;
  const invoiceTotalPaise = safePaise(source?.invoiceTotalPaise);
  const paymentId = safeText(source?.paymentId);
  const method = oneOf(source?.method, methods);
  const status = oneOf(source?.status, paymentRecordStatuses);
  const settlementStatus = oneOf(source?.settlementStatus, settlementStatuses);
  const amountPaise = safePaise(source?.amountPaise);
  const paidAt = safeDate(source?.paidAt);
  const recordedAt = safeDate(source?.recordedAt);
  const confirmedBy = oneOf(source?.confirmedBy, confirmers);
  if (!bookingId || !bookingReference || !invoiceVersion || invoiceTotalPaise === undefined || !paymentId || !method ||
      !status || !appliedPaymentStatuses.has(status) || !settlementStatus || amountPaise === undefined ||
      amountPaise === 0 || amountPaise > invoiceTotalPaise || !paidAt || !recordedAt || !confirmedBy) return undefined;
  return Object.freeze({
    bookingId, bookingReference, invoiceVersion, invoiceTotalPaise, paymentId, method, status,
    settlementStatus, amountPaise, paidAt, recordedAt, confirmedBy,
    // Only online money can be sandbox money; a cash receipt is never labelled as a test.
    ...(method === "ONLINE" && source?.testMode === true ? { testMode: true as const } : {}),
  });
}

/** Booking statuses that can have a final bill, and therefore a settlement to show. */
export const billedBookingStatuses: ReadonlySet<string> = new Set([
  "FINAL_BILL_GENERATED", "PAYMENT_RECORDED", "COMPLETED", "DISPUTED", "REFUND_PENDING", "REFUNDED",
]);

/** Booking statuses in which the assigned Owner may record cash against the current bill. */
const cashRecordableBookingStatuses: ReadonlySet<string> = new Set(["FINAL_BILL_GENERATED", "PAYMENT_RECORDED"]);

/** The paise the Owner can still record as cash, or 0 when no cash can be recorded right now. */
export function cashRecordablePaise(settlement: BookingSettlementView): number {
  if (!cashRecordableBookingStatuses.has(settlement.bookingStatus) || settlement.invoiceId === undefined ||
      settlement.settlementBlocked || settlement.status === "REFUND_PENDING") return 0;
  return Math.max(0, settlement.outstandingPaise - settlement.pendingPaise);
}

/** The provider's smallest chargeable amount (₹1). */
export const MINIMUM_ONLINE_PAYMENT_PAISE = 100;

/**
 * The paise the Farmer can pay online now, or 0: online payment must be SANDBOX or LIVE, the bill
 * current and undisputed, no online payment already awaiting confirmation, and at least ₹1 left.
 */
export function onlinePayablePaise(settlement: BookingSettlementView): number {
  if (!settlement.onlineAvailable || pendingOnlinePayment(settlement) !== undefined) return 0;
  const payable = cashRecordablePaise(settlement);
  return payable >= MINIMUM_ONLINE_PAYMENT_PAISE ? payable : 0;
}

/** The most recent online payment still waiting for the provider's confirmation, if any. */
export function pendingOnlinePayment(settlement: BookingSettlementView): PaymentRecordView | undefined {
  return [...settlement.payments].reverse().find((payment) => payment.method === "ONLINE" && payment.status === "PENDING");
}

/** True when the latest online attempt ended without payment, so the Farmer may start again. */
export function lastOnlinePaymentNotCompleted(settlement: BookingSettlementView): boolean {
  const online = settlement.payments.filter((payment) => payment.method === "ONLINE");
  return online.at(-1)?.status === "PAYMENT_FAILED";
}

export const onlineFeedbacks = [
  "returned", "dismissed", "confirmed", "cancelled", "in-progress", "unavailable", "invalid", "overpayment", "blocked",
  "conflict", "expired", "review", "failed", "offline",
] as const;
export type OnlineFeedback = (typeof onlineFeedbacks)[number];

export interface OnlineRetry {
  readonly key: string;
  readonly amountPaise: number;
}

export interface OnlineRetryState {
  readonly feedback?: OnlineFeedback;
  /** Present only after an unknown outcome of starting a payment; the retry resends the same key. */
  readonly retry?: OnlineRetry;
}

/** Reads post-redirect online-payment feedback and, after an unknown outcome, the exact request to retry. */
export function readOnlineRetryState(query: Readonly<Record<string, string | readonly string[] | undefined>>): OnlineRetryState {
  const feedback = oneOf(first(query.online), onlineFeedbacks);
  const key = first(query.onlineKey);
  const amount = first(query.onlineAmount);
  const amountPaise = amount !== undefined && /^\d{3,15}$/u.test(amount) ? Number(amount) : undefined;
  const validRetry = (feedback === "failed" || feedback === "offline") && key !== undefined && idempotencyKeyPattern.test(key) &&
    amountPaise !== undefined && Number.isSafeInteger(amountPaise) && amountPaise >= MINIMUM_ONLINE_PAYMENT_PAISE;
  return Object.freeze({
    ...(feedback ? { feedback } : {}),
    ...(validRetry ? { retry: Object.freeze({ key, amountPaise: amountPaise! }) } : {}),
  });
}

/** Client-safe values for the provider checkout of one pending online payment. */
export interface OnlineCheckoutView {
  readonly paymentId: string;
  readonly bookingId: string;
  readonly bookingReference: string;
  readonly amountPaise: number;
  readonly publicKey: string;
  readonly providerReference: string;
  readonly testMode: boolean;
  readonly expiresAt: Date;
}

const publicKeyPattern = /^rzp_(?:test|live)_[A-Za-z0-9]{8,32}$/u;
const orderPattern = /^order_[A-Za-z0-9]{6,40}$/u;

/** Allowlists the checkout response; anything unexpected is refused rather than rendered. */
export function normalizeOnlineCheckout(value: unknown): OnlineCheckoutView | undefined {
  const source = record(value);
  const payment = record(source?.payment);
  const checkout = record(source?.checkout);
  const paymentId = safeText(payment?.id);
  const bookingId = safeText(source?.bookingId);
  const bookingReference = safeText(source?.bookingReference);
  const amountPaise = safePaise(checkout?.amountPaise);
  const publicKey = typeof checkout?.publicKey === "string" && publicKeyPattern.test(checkout.publicKey) ? checkout.publicKey : undefined;
  const providerReference = typeof checkout?.providerReference === "string" && orderPattern.test(checkout.providerReference)
    ? checkout.providerReference : undefined;
  const expiresAt = safeDate(source?.checkoutExpiresAt);
  if (!paymentId || !bookingId || !bookingReference || amountPaise === undefined || amountPaise < MINIMUM_ONLINE_PAYMENT_PAISE ||
      !publicKey || !providerReference || !expiresAt || payment?.status !== "PENDING" || checkout?.currency !== "INR") return undefined;
  // A test key is always sandbox money, whatever the response claims.
  const testMode = checkout.testMode === true || publicKey.startsWith("rzp_test_");
  return Object.freeze({ paymentId, bookingId, bookingReference, amountPaise, publicKey, providerReference, testMode, expiresAt });
}

export interface PaymentHistoryItemView extends PaymentRecordView {
  readonly bookingId: string;
  readonly bookingReference: string;
  readonly invoiceVersion: number;
  readonly receiptAvailable: boolean;
}

export interface PaymentHistoryView {
  readonly items: readonly PaymentHistoryItemView[];
  readonly nextCursor?: string;
}

export type PaymentHistoryLoadResult =
  | Readonly<{ state: "READY"; history: PaymentHistoryView }>
  | Readonly<{ state: "ERROR"; message: string }>;

const cursorPattern = /^[A-Za-z0-9_-]{1,400}$/u;

/** Allowlists one history page; a page with any malformed item is refused as a whole. */
export function normalizePaymentHistory(value: unknown): PaymentHistoryView | undefined {
  const source = record(value);
  if (!Array.isArray(source?.items)) return undefined;
  const items = source.items.map((item): PaymentHistoryItemView | undefined => {
    const base = normalizePaymentRecord(item);
    const entry = record(item);
    const bookingId = safeText(entry?.bookingId);
    const bookingReference = safeText(entry?.bookingReference);
    const invoiceVersion = typeof entry?.invoiceVersion === "number" && Number.isSafeInteger(entry.invoiceVersion) && entry.invoiceVersion > 0
      ? entry.invoiceVersion : undefined;
    if (!base || !bookingId || !bookingReference || !invoiceVersion || typeof entry?.receiptAvailable !== "boolean") return undefined;
    // A receipt exists only for money that counts toward a fully paid bill.
    const receiptAvailable = entry.receiptAvailable && appliedPaymentStatuses.has(base.status);
    return Object.freeze({ ...base, bookingId, bookingReference, invoiceVersion, receiptAvailable });
  });
  if (items.some((item) => item === undefined)) return undefined;
  const nextCursor = typeof source.nextCursor === "string" && cursorPattern.test(source.nextCursor) ? source.nextCursor : undefined;
  return Object.freeze({ items: Object.freeze(items as PaymentHistoryItemView[]), ...(nextCursor ? { nextCursor } : {}) });
}

/** Reads one page of the viewer's own payment history; nothing is cached. */
export async function loadPaymentHistory(role: PaymentRole, cursor: string | undefined): Promise<PaymentHistoryLoadResult> {
  const unavailable = { state: "ERROR", message: "Payment history is unavailable right now. Refresh and retry safely." } as const;
  const query = cursor !== undefined && cursorPattern.test(cursor) ? `?cursor=${encodeURIComponent(cursor)}` : "";
  try {
    const response = await authorizedGet(`/${role}/payments${query}`);
    if (response === undefined) return { state: "ERROR", message: "Your session has expired. Log in and try again." };
    if (!response.ok) return unavailable;
    const history = normalizePaymentHistory(await response.json());
    return history === undefined
      ? { state: "ERROR", message: "Payment history returned an invalid response. No private data was displayed." }
      : { state: "READY", history };
  } catch {
    return unavailable;
  }
}

export type SettlementLoadResult =
  | Readonly<{ state: "READY"; settlement: BookingSettlementView }>
  | Readonly<{ state: "ERROR"; message: string }>;
export type ReceiptLoadResult =
  | Readonly<{ state: "READY"; receipt: PaymentReceiptView }>
  | Readonly<{ state: "NOT_FOUND" }>
  | Readonly<{ state: "UNAVAILABLE" }>
  | Readonly<{ state: "ERROR"; message: string }>;

const authorizedGet = async (path: string): Promise<Response | undefined> => {
  const credential = (await cookies()).get(accessCookieName)?.value;
  if (!credential) return undefined;
  return fetch(`${runtimeConfig().publicApiOrigin}${path}`, {
    headers: { authorization: `Bearer ${credential}`, accept: "application/json" },
    cache: "no-store",
  });
};

/** Reads the authoritative settlement for one booking; nothing is cached. */
export async function loadBookingSettlement(role: PaymentRole, bookingId: string): Promise<SettlementLoadResult> {
  const unavailable = { state: "ERROR", message: "Payment details are unavailable right now. Refresh and retry safely." } as const;
  if (!bookingId.trim()) return unavailable;
  try {
    const response = await authorizedGet(`/${role}/bookings/${encodeURIComponent(bookingId)}/payments`);
    if (response === undefined) return { state: "ERROR", message: "Your session has expired. Log in and try again." };
    if (!response.ok) return unavailable;
    const settlement = normalizeBookingSettlement(await response.json());
    if (!settlement || settlement.bookingId !== bookingId) {
      return { state: "ERROR", message: "Payment details returned an invalid response. No private data was displayed." };
    }
    return { state: "READY", settlement };
  } catch {
    return unavailable;
  }
}

export async function loadPaymentReceipt(role: PaymentRole, paymentId: string): Promise<ReceiptLoadResult> {
  const unavailable = { state: "ERROR", message: "The receipt is unavailable right now. Refresh and retry safely." } as const;
  if (!paymentId.trim()) return { state: "NOT_FOUND" };
  try {
    const response = await authorizedGet(`/${role}/payments/${encodeURIComponent(paymentId)}/receipt`);
    if (response === undefined) return { state: "ERROR", message: "Your session has expired. Log in and try again." };
    if (response.status === 404) return { state: "NOT_FOUND" };
    if (response.status === 409) return { state: "UNAVAILABLE" };
    if (!response.ok) return unavailable;
    const receipt = normalizePaymentReceipt(await response.json());
    if (!receipt || receipt.paymentId !== paymentId) {
      return { state: "ERROR", message: "The receipt returned an invalid response. No private data was displayed." };
    }
    return { state: "READY", receipt };
  } catch {
    return unavailable;
  }
}

const rupeesPattern = /^(\d{1,11})(?:\.(\d{1,2}))?$/u;

/** Converts a typed rupee amount (for example "1,200.50") to exact integer paise without floating point. */
export function parseRupeesToPaise(value: string): number | undefined {
  const match = rupeesPattern.exec(value.replaceAll(",", "").trim());
  if (match === null || match[1] === undefined) return undefined;
  const paise = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return Number.isSafeInteger(paise) && paise > 0 ? paise : undefined;
}

/** Formats paise for a rupee text input, keeping paise only when present ("1200" or "1200.50"). */
export function formatRupeesInput(paise: number): string {
  const rupees = Math.floor(paise / 100);
  const remainder = paise % 100;
  return remainder === 0 ? String(rupees) : `${rupees}.${String(remainder).padStart(2, "0")}`;
}

/** India Standard Time has a fixed +05:30 offset and no daylight saving. */
const IST_OFFSET_MS = 330 * 60 * 1_000;
const localDateTimePattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/u;

/**
 * Reads a `datetime-local` value as India time. Plain HTML forms carry no time zone, and the
 * Platform serves India, so the Owner's entry is interpreted as IST rather than the server's zone.
 */
export function parseIndiaLocalDateTime(value: string): Date | undefined {
  const match = localDateTimePattern.exec(value.trim());
  if (match === null) return undefined;
  const [year, month, day, hour, minute] = match.slice(1).map(Number) as [number, number, number, number, number];
  const utc = Date.UTC(year, month - 1, day, hour, minute);
  const check = new Date(utc);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day ||
      check.getUTCHours() !== hour || check.getUTCMinutes() !== minute) return undefined;
  return new Date(utc - IST_OFFSET_MS);
}

/** Formats an instant as a `datetime-local` value in India time. */
export function toIndiaLocalDateTime(instant: Date): string {
  return new Date(instant.getTime() + IST_OFFSET_MS).toISOString().slice(0, 16);
}

export type CashFeedback = "recorded" | "invalid" | "overpayment" | "blocked" | "conflict" | "failed" | "offline";

export interface CashRetry {
  readonly key: string;
  readonly amountRupees: string;
  readonly receivedAt?: string;
}

export interface CashRetryState {
  readonly feedback?: CashFeedback;
  /** Present only after an unknown outcome; the retry must resend the same key and values. */
  readonly retry?: CashRetry;
}

const first = (value: string | readonly string[] | undefined): string | undefined =>
  typeof value === "string" ? value : value?.[0];
const idempotencyKeyPattern = /^[A-Za-z0-9_-]{8,100}$/u;

export function isValidCashIdempotencyKey(value: string): boolean {
  return idempotencyKeyPattern.test(value);
}

/** Reads post-redirect cash feedback and, after an unknown outcome, the exact request to retry. */
export function readCashRetryState(query: Readonly<Record<string, string | readonly string[] | undefined>>): CashRetryState {
  const feedback: CashFeedback | undefined = first(query.cash) === "recorded" ? "recorded"
    : oneOf(first(query.cashError), ["invalid", "overpayment", "blocked", "conflict", "failed", "offline"] as const);
  const key = first(query.cashKey);
  const amountRupees = first(query.cashAmount);
  const receivedAt = first(query.cashReceivedAt);
  const validRetry = (feedback === "failed" || feedback === "offline") && key !== undefined && idempotencyKeyPattern.test(key) &&
    amountRupees !== undefined && parseRupeesToPaise(amountRupees) !== undefined &&
    (receivedAt === undefined || parseIndiaLocalDateTime(receivedAt) !== undefined);
  return Object.freeze({
    ...(feedback ? { feedback } : {}),
    ...(validRetry ? { retry: Object.freeze({ key, amountRupees, ...(receivedAt ? { receivedAt } : {}) }) } : {}),
  });
}
