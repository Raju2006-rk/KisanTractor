import type { HourlyRoundingPolicy, PricingMethod } from "@kisantractor/domain";
import { cookies } from "next/headers";

import { accessCookieName, runtimeConfig } from "./server-context";

export const workActions = ["START", "PAUSE", "RESUME", "COMPLETE"] as const;
export type JobWorkAction = (typeof workActions)[number];
export type JobWorkState = "NOT_STARTED" | "ACTIVE" | "PAUSED" | "COMPLETED";
export type JobInvoiceStatus = "ISSUED" | "DISPUTED" | "SETTLED" | "VOID";
export type JobBillableUnit = "HOUR" | "ACRE" | "TRIP";

export interface JobWorkEventView {
  readonly id: string;
  readonly eventType: JobWorkAction | "CORRECTION";
  readonly effectiveAt: Date;
  readonly receivedAt: Date;
  readonly deviceObservedAt?: Date;
  readonly correctionOfId?: string;
  readonly reason?: string;
}

export interface JobWorkMeasurementView {
  readonly id: string;
  readonly method: "PER_ACRE" | "PER_TRIP";
  readonly quantity: string;
  readonly unit: "ACRE" | "TRIP";
  readonly correctionOfId?: string;
  readonly reason?: string;
  readonly createdAt: Date;
}

export interface JobInvoiceView {
  readonly invoiceVersion: number;
  readonly supersedesEarlierVersion: boolean;
  readonly status: JobInvoiceStatus;
  readonly agreementVersion: number;
  readonly method: PricingMethod;
  readonly ratePaise: number;
  readonly billableQuantity: string;
  readonly billableUnit: JobBillableUnit;
  readonly subtotalPaise: number;
  readonly adjustmentsPaise: number;
  readonly totalPaise: number;
  readonly evidenceCount: number;
  readonly formula: string;
  readonly roundingPolicy?: HourlyRoundingPolicy;
  readonly activeMilliseconds?: number;
  readonly billableMilliseconds?: number;
  readonly createdAt: Date;
}

export interface JobSessionView {
  readonly bookingId: string;
  readonly bookingStatus: string;
  readonly bookingVersion: number;
  readonly pricingMethod: PricingMethod;
  readonly state: JobWorkState;
  readonly validNextActions: readonly JobWorkAction[];
  readonly events: readonly JobWorkEventView[];
  readonly measurements: readonly JobWorkMeasurementView[];
  readonly activeMilliseconds: number;
  readonly openStartedAt?: Date;
  readonly invoice?: JobInvoiceView;
}

export type JobSessionLoadResult =
  | Readonly<{ state: "READY"; session: JobSessionView }>
  | Readonly<{ state: "ERROR"; message: string }>;

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const safeText = (value: unknown, maximum = 500): string | undefined =>
  typeof value === "string" && value.trim().length > 0 && value.trim().length <= maximum ? value.trim() : undefined;
/** bigint money columns may arrive as decimal strings; only safe nonnegative integers are accepted. */
const safeInteger = (value: unknown): number | undefined => {
  const candidate = typeof value === "string" && /^\d{1,15}$/u.test(value) ? Number(value) : value;
  return typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0 ? candidate : undefined;
};
const safePositiveInteger = (value: unknown): number | undefined => {
  const result = safeInteger(value);
  return result !== undefined && result > 0 ? result : undefined;
};
const safeDate = (value: unknown): Date | undefined => {
  if (!(value instanceof Date) && typeof value !== "string") return undefined;
  const result = new Date(value);
  return Number.isNaN(result.getTime()) ? undefined : result;
};
const safeQuantity = (value: unknown): string | undefined => {
  const candidate = typeof value === "number" && Number.isFinite(value) ? String(value)
    : typeof value === "string" ? value.trim() : "";
  return /^(?:0|[1-9]\d{0,8})(?:\.\d{1,3})?$/u.test(candidate) ? candidate : undefined;
};
const oneOf = <T extends string>(value: unknown, allowed: readonly T[]): T | undefined =>
  typeof value === "string" && (allowed as readonly string[]).includes(value) ? value as T : undefined;

const pricingMethods = ["HOURLY", "PER_ACRE", "PER_TRIP"] as const;
const workStates = ["NOT_STARTED", "ACTIVE", "PAUSED", "COMPLETED"] as const;
const roundingPolicies = ["PROPORTIONAL_MINUTE", "THIRTY_MINUTE_BLOCK", "ONE_HOUR_BLOCK"] as const;

function normalizeEvent(value: unknown): JobWorkEventView | undefined {
  const source = record(value);
  const id = safeText(source?.id, 200);
  const eventType = oneOf(source?.eventType, [...workActions, "CORRECTION"] as const);
  const effectiveAt = safeDate(source?.effectiveAt);
  const receivedAt = safeDate(source?.receivedAt);
  if (!id || !eventType || !effectiveAt || !receivedAt) return undefined;
  const deviceObservedAt = source?.deviceObservedAt === undefined ? undefined : safeDate(source.deviceObservedAt);
  const correctionOfId = safeText(source?.correctionOfId, 200);
  const reason = safeText(source?.reason);
  if (eventType === "CORRECTION" && (!correctionOfId || !reason)) return undefined;
  return Object.freeze({
    id, eventType, effectiveAt, receivedAt,
    ...(deviceObservedAt ? { deviceObservedAt } : {}),
    ...(correctionOfId ? { correctionOfId } : {}),
    ...(reason ? { reason } : {}),
  });
}

function normalizeMeasurement(value: unknown): JobWorkMeasurementView | undefined {
  const source = record(value);
  const id = safeText(source?.id, 200);
  const method = oneOf(source?.method, ["PER_ACRE", "PER_TRIP"] as const);
  const quantity = safeQuantity(source?.quantity);
  const unit = oneOf(source?.unit, ["ACRE", "TRIP"] as const);
  const createdAt = safeDate(source?.createdAt);
  if (!id || !method || quantity === undefined || !unit || !createdAt) return undefined;
  if ((method === "PER_ACRE") !== (unit === "ACRE")) return undefined;
  const correctionOfId = safeText(source?.correctionOfId, 200);
  const reason = safeText(source?.reason);
  if (correctionOfId && !reason) return undefined;
  return Object.freeze({
    id, method, quantity, unit, createdAt,
    ...(correctionOfId ? { correctionOfId } : {}),
    ...(reason ? { reason } : {}),
  });
}

/** Allowlists the invoice fields needed to reproduce and explain the bill; provider data is never copied. */
export function normalizeJobInvoice(value: unknown): JobInvoiceView | undefined {
  const source = record(value);
  if (!source) return undefined;
  const invoiceVersion = safePositiveInteger(source.invoiceVersion);
  const status = oneOf(source.status, ["ISSUED", "DISPUTED", "SETTLED", "VOID"] as const);
  const agreementVersion = safePositiveInteger(source.agreementVersion);
  const method = oneOf(source.method, pricingMethods);
  const ratePaise = safeInteger(source.ratePaise);
  const billableQuantity = safeQuantity(source.billableQuantity);
  const billableUnit = oneOf(source.billableUnit, ["HOUR", "ACRE", "TRIP"] as const);
  const subtotalPaise = safeInteger(source.subtotalPaise);
  const adjustmentsPaise = typeof source.adjustmentsPaise === "number" && Number.isSafeInteger(source.adjustmentsPaise)
    ? source.adjustmentsPaise : safeInteger(source.adjustmentsPaise);
  const totalPaise = safeInteger(source.totalPaise);
  const formula = safeText(source.formula, 1_000);
  const createdAt = safeDate(source.createdAt);
  const expectedUnit = method === "HOURLY" ? "HOUR" : method === "PER_ACRE" ? "ACRE" : "TRIP";
  if (!invoiceVersion || !status || !agreementVersion || !method || ratePaise === undefined ||
      billableQuantity === undefined || billableUnit !== expectedUnit || subtotalPaise === undefined ||
      adjustmentsPaise === undefined || totalPaise === undefined || !formula || !createdAt ||
      subtotalPaise + adjustmentsPaise !== totalPaise) return undefined;

  const trace = record(source.roundingTrace);
  const roundingPolicy = oneOf(trace?.roundingPolicy, roundingPolicies);
  if (method === "HOURLY" && !roundingPolicy) return undefined;
  const activeMilliseconds = method === "HOURLY" ? safeInteger(trace?.activeMilliseconds) : undefined;
  const billableMilliseconds = method === "HOURLY" ? safeInteger(trace?.billableMilliseconds) : undefined;
  const evidence = Array.isArray(source.evidenceReferences) ? source.evidenceReferences : [];
  return Object.freeze({
    invoiceVersion,
    supersedesEarlierVersion: safeText(source.supersedesInvoiceId, 200) !== undefined || invoiceVersion > 1,
    status,
    agreementVersion,
    method,
    ratePaise,
    billableQuantity,
    billableUnit,
    subtotalPaise,
    adjustmentsPaise,
    totalPaise,
    evidenceCount: evidence.filter((item) => typeof item === "string").length,
    formula,
    ...(method === "HOURLY" && roundingPolicy ? { roundingPolicy } : {}),
    ...(activeMilliseconds === undefined ? {} : { activeMilliseconds }),
    ...(billableMilliseconds === undefined ? {} : { billableMilliseconds }),
    createdAt,
  });
}

/** Allowlists the authoritative work-session projection; actor identifiers are not exposed to screens. */
export function normalizeJobSession(value: unknown): JobSessionView | undefined {
  const source = record(value);
  if (!source) return undefined;
  const bookingId = safeText(source.bookingId, 200);
  const bookingStatus = safeText(source.bookingStatus, 50);
  const bookingVersion = safePositiveInteger(source.bookingVersion);
  const pricingMethod = oneOf(source.pricingMethod, pricingMethods);
  const state = oneOf(source.state, workStates);
  const activeMilliseconds = safeInteger(source.activeMilliseconds);
  if (!bookingId || !bookingStatus || !bookingVersion || !pricingMethod || !state || activeMilliseconds === undefined ||
      !Array.isArray(source.validNextActions) || !Array.isArray(source.events)) return undefined;

  const validNextActions = source.validNextActions
    .map((action) => oneOf(action, workActions))
    .filter((action): action is JobWorkAction => action !== undefined);
  const events = source.events.map(normalizeEvent).filter((item): item is JobWorkEventView => item !== undefined);
  const measurements = (Array.isArray(source.measurements) ? source.measurements : [])
    .map(normalizeMeasurement).filter((item): item is JobWorkMeasurementView => item !== undefined);
  const openStartedAt = source.openStartedAt === undefined ? undefined : safeDate(source.openStartedAt);
  const invoice = source.invoice === undefined ? undefined : normalizeJobInvoice(source.invoice);
  if (source.invoice !== undefined && invoice === undefined) return undefined;

  return Object.freeze({
    bookingId,
    bookingStatus,
    bookingVersion,
    pricingMethod,
    state,
    validNextActions: Object.freeze(validNextActions),
    events: Object.freeze(events),
    measurements: Object.freeze(measurements),
    activeMilliseconds,
    ...(openStartedAt ? { openStartedAt } : {}),
    ...(invoice ? { invoice } : {}),
  });
}

/** Booking statuses whose job record is relevant to each role. */
export const ownerJobStatuses: ReadonlySet<string> = new Set([
  "ACCEPTED", "SCHEDULED", "IN_PROGRESS", "WORK_COMPLETED", "FINAL_BILL_GENERATED",
  "PAYMENT_RECORDED", "COMPLETED", "DISPUTED", "REFUND_PENDING", "REFUNDED",
]);
export const farmerJobStatuses: ReadonlySet<string> = new Set([
  "IN_PROGRESS", "WORK_COMPLETED", "FINAL_BILL_GENERATED", "PAYMENT_RECORDED",
  "COMPLETED", "DISPUTED", "REFUND_PENDING", "REFUNDED",
]);

export async function loadJobSession(role: "owner" | "farmer", bookingId: string): Promise<JobSessionLoadResult> {
  const unavailable = { state: "ERROR", message: "Job details are unavailable right now. Refresh and retry safely." } as const;
  if (!bookingId.trim()) return unavailable;
  try {
    const credential = (await cookies()).get(accessCookieName)?.value;
    if (!credential) return { state: "ERROR", message: "Your session has expired. Log in and try again." };
    const response = await fetch(`${runtimeConfig().publicApiOrigin}/${role}/bookings/${encodeURIComponent(bookingId)}/job`, {
      headers: { authorization: `Bearer ${credential}`, accept: "application/json" },
      cache: "no-store",
    });
    if (!response.ok) return unavailable;
    const session = normalizeJobSession(await response.json());
    if (!session || session.bookingId !== bookingId) {
      return { state: "ERROR", message: "Job details returned an invalid response. No private data was displayed." };
    }
    return { state: "READY", session };
  } catch {
    return unavailable;
  }
}

export type JobFeedback = "saved" | "sequence" | "conflict" | "invalid" | "failed" | "offline";

export interface JobRetryState {
  readonly feedback?: JobFeedback;
  readonly retryAction?: JobWorkAction;
  readonly retryKey?: string;
}

const first = (value: string | readonly string[] | undefined): string | undefined =>
  typeof value === "string" ? value : value?.[0];
const idempotencyKeyPattern = /^[A-Za-z0-9_-]{8,100}$/u;

/** Reads post-redirect job feedback and the idempotency key that must be reused for an explicit retry. */
export function readJobRetryState(query: Readonly<Record<string, string | readonly string[] | undefined>>): JobRetryState {
  const feedback = query.job === "saved" ? "saved" : oneOf(first(query.jobError), ["sequence", "conflict", "invalid", "failed", "offline"] as const);
  const retryAction = oneOf(first(query.retryAction), workActions);
  const retryKey = first(query.retryKey);
  // Only an unknown outcome needs the same key; definite rejections committed nothing.
  const validRetry = retryAction !== undefined && retryKey !== undefined && idempotencyKeyPattern.test(retryKey) &&
    (feedback === "failed" || feedback === "offline");
  return Object.freeze({
    ...(feedback ? { feedback } : {}),
    ...(validRetry ? { retryAction, retryKey } : {}),
  });
}

/** Issues one stable key per action form, reusing the failed attempt's key so a retry cannot double-record. */
export function jobActionKeys(retry: JobRetryState, createKey: () => string): Readonly<Record<JobWorkAction, string>> {
  return Object.freeze(Object.fromEntries(workActions.map((action) => [
    action,
    retry.retryAction === action && retry.retryKey ? retry.retryKey : createKey(),
  ])) as Record<JobWorkAction, string>);
}

export function isValidIdempotencyKey(value: string): boolean {
  return idempotencyKeyPattern.test(value);
}
