import { cookies } from "next/headers";

import { accessCookieName, runtimeConfig } from "./server-context";

/** Viewer of a dispute case: the booking's parties, or a support operator with a grant. */
export type DisputeViewer = "farmer" | "owner" | "support";

export const disputeOutcomes = ["UPHOLD", "ADJUST", "REFUND", "CANCEL"] as const;
export type DisputeOutcome = (typeof disputeOutcomes)[number];
export const partyStatementCodes = [
  "HOURS_INCORRECT", "QUANTITY_INCORRECT", "RATE_NOT_AGREED", "WORK_INCOMPLETE", "PAYMENT_ALREADY_MADE", "WORK_RECORD_CORRECT", "OTHER",
] as const;
export const supportReasonCodes = [
  "EVIDENCE_SUPPORTS_BILL", "EVIDENCE_CORRECTED", "SERVICE_NOT_DELIVERED", "DUPLICATE_PAYMENT", "PARTIES_AGREED", "OTHER",
] as const;
const entryTypes = ["OPENED", "PARTY_STATEMENT", "EVIDENCE_REFERENCE", "SUPPORT_NOTE", "RESOLVED"] as const;
const authorRoles = ["FARMER", "OWNER", "SUPPORT", "SYSTEM"] as const;
const evidenceKinds = ["INVOICE", "WORK_EVENT", "WORK_MEASUREMENT", "PAYMENT"] as const;
const statementCodes = new Set<string>(["BILL_DISPUTED", ...partyStatementCodes, ...supportReasonCodes]);

export interface DisputeEntryView {
  readonly id: string;
  readonly entryType: (typeof entryTypes)[number];
  readonly authorRole: (typeof authorRoles)[number];
  /** A known code, or OTHER for anything this client does not recognise. */
  readonly statementCode: string;
  readonly statementText?: string;
  readonly statementRedacted: boolean;
  readonly evidenceKind?: (typeof evidenceKinds)[number];
  readonly occurredAt: Date;
}

export interface DisputeCaseView {
  readonly id: string;
  readonly bookingId: string;
  readonly bookingReference: string;
  readonly bookingStatus: string;
  readonly bookingVersion: number;
  readonly status: "OPEN" | "RESOLVED";
  readonly version: number;
  readonly openedAt: Date;
  readonly disputedInvoiceVersion: number;
  readonly currentInvoiceVersion: number;
  readonly currentInvoiceTotalPaise: number;
  readonly appliedPaise: number;
  readonly resolution?: { readonly outcome: DisputeOutcome; readonly rulesVersion: number; readonly resolvedAt: Date };
  readonly entries: readonly DisputeEntryView[];
  readonly refundablePayments: readonly { readonly id: string; readonly amountPaise: number }[];
  readonly grantExpiresAt?: Date;
}

export interface SupportCaseSummaryView {
  readonly id: string;
  readonly bookingReference: string;
  readonly bookingStatus: string;
  readonly status: "OPEN" | "RESOLVED";
  readonly openedAt: Date;
  readonly grantScope: "READ" | "RESOLVE";
  readonly grantExpiresAt: Date;
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const text = (value: unknown, max = 200): string | undefined =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max ? value : undefined;
const whole = (value: unknown): number | undefined => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const instant = (value: unknown): Date | undefined => {
  if (typeof value !== "string") return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
};
const oneOf = <Value extends string>(value: unknown, allowed: readonly Value[]): Value | undefined =>
  typeof value === "string" && (allowed as readonly string[]).includes(value) ? value as Value : undefined;
const referencePattern = /^[A-Za-z0-9][A-Za-z0-9-]{0,39}$/u;
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function normalizeEntry(value: unknown): DisputeEntryView | undefined {
  const source = record(value);
  const id = text(source?.id);
  const entryType = oneOf(source?.entryType, entryTypes);
  const authorRole = oneOf(source?.authorRole, authorRoles);
  const occurredAt = instant(source?.occurredAt);
  if (!id || !entryType || !authorRole || !occurredAt) return undefined;
  const code = typeof source?.statementCode === "string" && statementCodes.has(source.statementCode) ? source.statementCode : "OTHER";
  const evidence = record(source?.evidence);
  const evidenceKind = oneOf(evidence?.kind, evidenceKinds);
  const statementText = text(source?.statementText, 500);
  return Object.freeze({
    id, entryType, authorRole, statementCode: code, statementRedacted: source?.statementRedacted === true, occurredAt,
    ...(statementText ? { statementText } : {}),
    ...(evidenceKind ? { evidenceKind } : {}),
  });
}

/** Allowlists a dispute case; a case with any malformed field or entry is refused as a whole. */
export function normalizeDisputeCase(value: unknown): DisputeCaseView | undefined {
  const source = record(value);
  const id = text(source?.id);
  const bookingId = text(source?.bookingId);
  const bookingReference = text(source?.bookingReference, 40);
  const bookingStatus = text(source?.bookingStatus, 40);
  const status = oneOf(source?.status, ["OPEN", "RESOLVED"] as const);
  const openedAt = instant(source?.openedAt);
  const numbers = ["bookingVersion", "version", "disputedInvoiceVersion", "currentInvoiceVersion", "currentInvoiceTotalPaise", "appliedPaise"]
    .map((field) => whole(source?.[field]));
  if (!id || !bookingId || !bookingReference || !referencePattern.test(bookingReference) || !bookingStatus || !status || !openedAt
      || numbers.some((number) => number === undefined) || !Array.isArray(source?.entries)) return undefined;
  const entries = source.entries.map(normalizeEntry);
  if (entries.some((entry) => entry === undefined)) return undefined;
  const resolutionSource = record(source.resolution);
  const outcome = oneOf(resolutionSource?.outcome, disputeOutcomes);
  const resolvedAt = instant(resolutionSource?.resolvedAt);
  const rulesVersion = whole(resolutionSource?.rulesVersion);
  if (status === "RESOLVED" && (!outcome || !resolvedAt || !rulesVersion)) return undefined;
  const refundable = Array.isArray(source.refundablePayments) ? source.refundablePayments.map(record) : [];
  const refundablePayments = refundable.flatMap((payment) => {
    const paymentId = text(payment?.id);
    const amountPaise = whole(payment?.amountPaise);
    return paymentId && idPattern.test(paymentId) && amountPaise !== undefined ? [Object.freeze({ id: paymentId, amountPaise })] : [];
  });
  const grantExpiresAt = instant(source.grantExpiresAt);
  const [bookingVersion, version, disputedInvoiceVersion, currentInvoiceVersion, currentInvoiceTotalPaise, appliedPaise] = numbers as number[];
  return Object.freeze({
    id, bookingId, bookingReference, bookingStatus, bookingVersion: bookingVersion!, status, version: version!, openedAt,
    disputedInvoiceVersion: disputedInvoiceVersion!, currentInvoiceVersion: currentInvoiceVersion!,
    currentInvoiceTotalPaise: currentInvoiceTotalPaise!, appliedPaise: appliedPaise!,
    entries: Object.freeze(entries as DisputeEntryView[]),
    refundablePayments: Object.freeze(refundablePayments),
    ...(status === "RESOLVED" ? { resolution: Object.freeze({ outcome: outcome!, rulesVersion: rulesVersion!, resolvedAt: resolvedAt! }) } : {}),
    ...(grantExpiresAt ? { grantExpiresAt } : {}),
  });
}

export function normalizeSupportCaseList(value: unknown): readonly SupportCaseSummaryView[] | undefined {
  const items = record(value)?.items;
  if (!Array.isArray(items)) return undefined;
  const cases = items.map((item) => {
    const source = record(item);
    const id = text(source?.id);
    const bookingReference = text(source?.bookingReference, 40);
    const bookingStatus = text(source?.bookingStatus, 40);
    const status = oneOf(source?.status, ["OPEN", "RESOLVED"] as const);
    const grantScope = oneOf(source?.grantScope, ["READ", "RESOLVE"] as const);
    const openedAt = instant(source?.openedAt);
    const grantExpiresAt = instant(source?.grantExpiresAt);
    return id && idPattern.test(id) && bookingReference && bookingStatus && status && grantScope && openedAt && grantExpiresAt
      ? Object.freeze({ id, bookingReference, bookingStatus, status, grantScope, openedAt, grantExpiresAt })
      : undefined;
  });
  return cases.some((entry) => entry === undefined) ? undefined : Object.freeze(cases as SupportCaseSummaryView[]);
}

export type DisputeCaseLoadResult =
  | { readonly state: "READY"; readonly dispute: DisputeCaseView }
  | { readonly state: "NONE" }
  | { readonly state: "ERROR" };

export type SupportCasesLoadResult =
  | { readonly state: "READY"; readonly cases: readonly SupportCaseSummaryView[] }
  | { readonly state: "ERROR" };

const authorizedGet = async (path: string): Promise<Response | undefined> => {
  const credential = (await cookies()).get(accessCookieName)?.value;
  if (!credential) return undefined;
  return fetch(`${runtimeConfig().publicApiOrigin}${path}`, {
    headers: { authorization: `Bearer ${credential}`, accept: "application/json", "x-client-channel": "WEB" },
    cache: "no-store",
  });
};

/** The latest dispute case of a party's booking, or NONE when the booking was never disputed. */
export async function loadDisputeCase(viewer: Exclude<DisputeViewer, "support">, bookingId: string): Promise<DisputeCaseLoadResult> {
  if (!idPattern.test(bookingId)) return { state: "NONE" };
  try {
    const response = await authorizedGet(`/${viewer}/bookings/${encodeURIComponent(bookingId)}/dispute-case`);
    if (response?.status === 404) return { state: "NONE" };
    if (!response?.ok) return { state: "ERROR" };
    const dispute = normalizeDisputeCase(await response.json());
    return dispute ? { state: "READY", dispute } : { state: "ERROR" };
  } catch {
    return { state: "ERROR" };
  }
}

export async function loadSupportCases(): Promise<SupportCasesLoadResult> {
  try {
    const response = await authorizedGet("/support/cases");
    if (!response?.ok) return { state: "ERROR" };
    const cases = normalizeSupportCaseList(await response.json());
    return cases ? { state: "READY", cases } : { state: "ERROR" };
  } catch {
    return { state: "ERROR" };
  }
}

export async function loadSupportCase(caseId: string): Promise<DisputeCaseLoadResult> {
  if (!idPattern.test(caseId)) return { state: "NONE" };
  try {
    const response = await authorizedGet(`/support/cases/${encodeURIComponent(caseId)}`);
    if (response?.status === 404) return { state: "NONE" };
    if (!response?.ok) return { state: "ERROR" };
    const dispute = normalizeDisputeCase(await response.json());
    return dispute ? { state: "READY", dispute } : { state: "ERROR" };
  } catch {
    return { state: "ERROR" };
  }
}

export const disputeFeedbacks = ["added", "conflict", "invalid", "closed", "failed"] as const;
export type DisputeFeedback = (typeof disputeFeedbacks)[number];
export const supportFeedbacks = ["resolved", "noted", "conflict", "invalid", "denied", "failed"] as const;
export type SupportFeedback = (typeof supportFeedbacks)[number];

/** Maps an API answer to the feedback shown after the redirect; nothing is queued on failure. */
export function feedbackForStatus(status: number, code: string | undefined, success: "added" | "resolved" | "noted"): string {
  if (status >= 200 && status < 300) return success;
  if (status === 404) return success === "added" ? "failed" : "denied";
  if (status === 409) return code === "CASE_CLOSED" || code === "CASE_NOT_OPEN" ? (success === "added" ? "closed" : "invalid")
    : code === "VERSION_CONFLICT" || code === "IDEMPOTENCY_KEY_REUSED" ? "conflict" : "invalid";
  if (status === 422) return "invalid";
  return "failed";
}
