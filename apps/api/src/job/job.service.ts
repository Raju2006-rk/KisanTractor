import { createHash } from "node:crypto";

import type { AuthPrincipal, PricingMethod, WorkAction, WorkState } from "@kisantractor/domain";
import { noopIndicators, type OperationalIndicators } from "@kisantractor/observability";

import type {
  CompleteJobCommand,
  CorrectWorkEventCommand,
  CorrectWorkMeasurementCommand,
  JobActionCommand,
  JobRequestContext,
  JobStore,
  JobViewerRole,
  WorkSessionProjection,
} from "./job.contracts.js";

export class JobAuthorizationError extends Error {
  readonly code = "JOB_FORBIDDEN";
  constructor(message = "The assigned Owner is required to control this job") {
    super(message);
    this.name = "JobAuthorizationError";
  }
}

export class JobValidationError extends Error {
  readonly code = "JOB_VALIDATION_FAILED";
  constructor(readonly field: string, message: string) {
    super(message);
    this.name = "JobValidationError";
  }
}

export class JobConflictError extends Error {
  readonly code = "JOB_CONFLICT";
  constructor(message: string) {
    super(message);
    this.name = "JobConflictError";
  }
}

export class InvalidJobSequenceError extends Error {
  readonly code = "WORK_EVENT_OUT_OF_SEQUENCE";
  constructor(
    message: string,
    readonly currentState: WorkState,
    readonly validNextActions: readonly WorkAction[],
  ) {
    super(message);
    this.name = "InvalidJobSequenceError";
  }
}

const normalizedText = (value: string, field: string, maximum: number): string => {
  const normalized = value.normalize("NFC").trim().replace(/\s+/gu, " ");
  if (normalized.length === 0 || normalized.length > maximum) {
    throw new JobValidationError(field, `${field} must contain 1 to ${maximum} characters`);
  }
  return normalized;
};

export const normalizeWorkQuantity = (value: number | string, field: string): string => {
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new JobValidationError(field, `${field} must be a finite nonnegative decimal`);
  }
  const input = typeof value === "number" ? String(value) : value.trim();
  const match = /^(0|[1-9]\d{0,8})(?:\.(\d{1,3}))?$/u.exec(input);
  if (match === null || match[1] === undefined) {
    throw new JobValidationError(field, `${field} must be nonnegative with at most three decimal places`);
  }
  const fraction = (match[2] ?? "").replace(/0+$/u, "");
  return fraction.length === 0 ? match[1] : `${match[1]}.${fraction}`;
};

export const validateCompletionQuantity = (method: PricingMethod, quantity: string | undefined): void => {
  if (method === "HOURLY") {
    if (quantity !== undefined) {
      throw new JobValidationError("completedQuantity", "Hourly work completion derives quantity from active intervals");
    }
    return;
  }
  if (quantity === undefined) {
    throw new JobValidationError("completedQuantity", `${method === "PER_ACRE" ? "Completed acres" : "Completed trips"} are required`);
  }
  if (method === "PER_TRIP" && !/^\d+$/u.test(quantity)) {
    throw new JobValidationError("completedQuantity", "Completed trips must be a nonnegative integer");
  }
};

/**
 * The Farmer sees what work was recorded and when, never the Owner's account identifiers
 * (Requirement 12.2). The Owner's own view keeps them for its records.
 */
export const farmerWorkSession = (session: WorkSessionProjection): WorkSessionProjection => Object.freeze({
  ...session,
  events: Object.freeze(session.events.map(({ actorId: _actorId, ...event }) => Object.freeze(event))),
  measurements: Object.freeze(session.measurements.map(
    ({ submittedByUserId: _submittedByUserId, ...measurement }) => Object.freeze(measurement),
  )),
});

const digest = (value: Readonly<Record<string, unknown>>): string => createHash("sha256")
  .update(JSON.stringify(value))
  .digest("hex");

export class JobService {
  constructor(
    private readonly store: JobStore,
    private readonly now = () => new Date(),
    private readonly indicators: OperationalIndicators = noopIndicators,
  ) {}

  /** Returns the authoritative work record and current invoice to the assigned Owner or booking Farmer. */
  async getWorkSession(
    principal: AuthPrincipal,
    bookingId: string,
    viewerRole: JobViewerRole,
    context: JobRequestContext,
  ): Promise<WorkSessionProjection> {
    if (!principal.roles.includes(viewerRole)) {
      throw new JobAuthorizationError("The job is unavailable for this account");
    }
    const normalizedBookingId = normalizedText(bookingId, "bookingId", 200);
    this.#validateContext(context);
    const session = await this.store.loadWorkSession({
      bookingId: normalizedBookingId,
      viewerId: principal.userId,
      viewerRole,
    }, context);
    return viewerRole === "FARMER" ? farmerWorkSession(session) : session;
  }

  async startJob(principal: AuthPrincipal, command: JobActionCommand, context: JobRequestContext): Promise<WorkSessionProjection> {
    return this.#recordAction(principal, command, context, "START");
  }

  async pauseJob(principal: AuthPrincipal, command: JobActionCommand, context: JobRequestContext): Promise<WorkSessionProjection> {
    return this.#recordAction(principal, command, context, "PAUSE");
  }

  async resumeJob(principal: AuthPrincipal, command: JobActionCommand, context: JobRequestContext): Promise<WorkSessionProjection> {
    return this.#recordAction(principal, command, context, "RESUME");
  }

  async completeJob(principal: AuthPrincipal, command: CompleteJobCommand, context: JobRequestContext): Promise<WorkSessionProjection> {
    return this.#recordAction(principal, command, context, "COMPLETE");
  }

  correctWorkEvent(
    principal: AuthPrincipal,
    command: CorrectWorkEventCommand,
    context: JobRequestContext,
  ): Promise<WorkSessionProjection> {
    this.#authorizeOwner(principal);
    const bookingId = normalizedText(command.bookingId, "bookingId", 200);
    const eventId = normalizedText(command.eventId, "eventId", 200);
    const reason = normalizedText(command.reason, "reason", 500);
    const idempotencyKey = normalizedText(command.idempotencyKey, "idempotencyKey", 200);
    this.#validateContext(context);
    if (Number.isNaN(command.correctedEffectiveAt.getTime())) {
      throw new JobValidationError("correctedEffectiveAt", "correctedEffectiveAt must be a valid instant");
    }
    const receivedAt = this.#serverNow();
    return this.store.correctWorkEvent({
      bookingId,
      eventId,
      correctedEffectiveAt: new Date(command.correctedEffectiveAt),
      reason,
      actorId: principal.userId,
      idempotencyKey,
      receivedAt,
      requestDigest: digest({ bookingId, eventId, correctedEffectiveAt: command.correctedEffectiveAt.toISOString(), reason }),
    }, context);
  }

  correctWorkMeasurement(
    principal: AuthPrincipal,
    command: CorrectWorkMeasurementCommand,
    context: JobRequestContext,
  ): Promise<WorkSessionProjection> {
    this.#authorizeOwner(principal);
    const bookingId = normalizedText(command.bookingId, "bookingId", 200);
    const measurementId = normalizedText(command.measurementId, "measurementId", 200);
    const reason = normalizedText(command.reason, "reason", 500);
    const idempotencyKey = normalizedText(command.idempotencyKey, "idempotencyKey", 200);
    const correctedQuantity = normalizeWorkQuantity(command.correctedQuantity, "correctedQuantity");
    this.#validateContext(context);
    const receivedAt = this.#serverNow();
    return this.store.correctWorkMeasurement({
      bookingId,
      measurementId,
      correctedQuantity,
      reason,
      actorId: principal.userId,
      idempotencyKey,
      receivedAt,
      requestDigest: digest({ bookingId, measurementId, correctedQuantity, reason }),
    }, context);
  }

  #recordAction(
    principal: AuthPrincipal,
    command: CompleteJobCommand,
    context: JobRequestContext,
    action: WorkAction,
  ): Promise<WorkSessionProjection> {
    this.#authorizeOwner(principal);
    const bookingId = normalizedText(command.bookingId, "bookingId", 200);
    const idempotencyKey = normalizedText(command.idempotencyKey, "idempotencyKey", 200);
    this.#validateContext(context);
    if (command.deviceObservedAt !== undefined && Number.isNaN(command.deviceObservedAt.getTime())) {
      throw new JobValidationError("deviceObservedAt", "deviceObservedAt must be a valid instant");
    }
    if (action !== "COMPLETE" && command.completedQuantity !== undefined) {
      throw new JobValidationError("completedQuantity", "Only job completion may include a completed quantity");
    }
    const completedQuantity = command.completedQuantity === undefined
      ? undefined
      : normalizeWorkQuantity(command.completedQuantity, "completedQuantity");
    const receivedAt = this.#serverNow();
    const deviceObservedAt = command.deviceObservedAt === undefined ? undefined : new Date(command.deviceObservedAt);
    const recorded = this.store.recordAction({
      bookingId,
      action,
      actorId: principal.userId,
      idempotencyKey,
      receivedAt,
      ...(deviceObservedAt === undefined ? {} : { deviceObservedAt }),
      ...(completedQuantity === undefined ? {} : { completedQuantity }),
      requestDigest: digest({
        bookingId,
        action,
        deviceObservedAt: deviceObservedAt?.toISOString(),
        completedQuantity,
      }),
    }, context);
    return recorded.catch((error: unknown) => {
      // Out-of-order job events are an operational indicator (Requirement 18.2).
      if (error instanceof InvalidJobSequenceError) this.indicators.invalidTransition("WORK", action);
      throw error;
    });
  }

  #authorizeOwner(principal: AuthPrincipal): void {
    if (!principal.roles.includes("OWNER")) throw new JobAuthorizationError();
  }

  #validateContext(context: JobRequestContext): void {
    normalizedText(context.correlationId, "correlationId", 200);
  }

  #serverNow(): Date {
    const receivedAt = this.now();
    if (Number.isNaN(receivedAt.getTime())) throw new Error("Server clock returned an invalid instant");
    return new Date(receivedAt);
  }
}
