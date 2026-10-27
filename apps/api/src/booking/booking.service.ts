import { createHash } from "node:crypto";

import {
  normalizeIndianPhone,
  normalizeLocation,
  type AuthPrincipal,
} from "@kisantractor/domain";

import { noopIndicators, type OperationalIndicators } from "@kisantractor/observability";

import { BookingCrypto } from "./booking-crypto.js";
import type {
  AgreementChangeCommand,
  BookingLifecycleAction,
  BookingLifecycleCommand,
  BookingLifecycleActorRole,
  BookingProjection,
  BookingRequestContext,
  BookingSecrets,
  BookingStore,
  CreateBookingCommand,
  RecipientInput,
} from "./booking.contracts.js";

export class BookingAuthorizationError extends Error {
  readonly code = "BOOKING_FORBIDDEN";
  constructor(message = "The actor is not permitted to perform this booking operation") {
    super(message);
    this.name = "BookingAuthorizationError";
  }
}

export class BookingValidationError extends Error {
  readonly code = "BOOKING_VALIDATION_FAILED";
  constructor(readonly field: string, message: string) { super(message); this.name = "BookingValidationError"; }
}

/** Why a booking command conflicted; drives operational indicators, not user messages. */
export type BookingConflictReason =
  | "VERSION_CONFLICT"
  | "INVALID_TRANSITION"
  | "OVERLAP"
  | "CONCURRENT_RESERVATION"
  | "CONCURRENT_UPDATE"
  | "OTHER";

export class BookingConflictError extends Error {
  readonly code = "BOOKING_CONFLICT";
  constructor(message: string, readonly reason: BookingConflictReason = "OTHER") {
    super(message);
    this.name = "BookingConflictError";
  }
}

const text = (value: string, field: string, maximum: number): string => {
  const result = value.normalize("NFC").trim().replace(/\s+/gu, " ");
  if (result.length === 0 || result.length > maximum) {
    throw new BookingValidationError(field, `${field} must contain 1 to ${maximum} characters`);
  }
  return result;
};

const normalizeRecipient = (input: RecipientInput, crypto: BookingCrypto) => {
  const coordinationConsent = input.coordinationConsent ?? false;
  if (input.coordinationPhone !== undefined && !coordinationConsent) {
    throw new BookingValidationError("recipient.coordinationConsent", "Consent is required to store a coordination phone");
  }
  const phone = input.coordinationPhone === undefined
    ? undefined
    : normalizeIndianPhone(input.coordinationPhone);
  const directions = input.landmarkOrDirections === undefined
    ? undefined
    : text(input.landmarkOrDirections, "recipient.landmarkOrDirections", 250);
  return Object.freeze({
    name: text(input.name, "recipient.name", 150),
    coordinationConsent,
    ...(phone === undefined ? {} : {
      coordinationPhoneCiphertext: crypto.encryptCoordinationPhone(phone),
      coordinationPhoneLookupHash: crypto.coordinationPhoneLookupHash(phone),
    }),
    ...(directions === undefined ? {} : { landmarkOrDirections: directions }),
  });
};

const digestCommand = (customerId: string, command: CreateBookingCommand): string => createHash("sha256")
  .update(JSON.stringify({
    customerId,
    ...command,
    requestedInterval: {
      start: command.requestedInterval.start.toISOString(),
      end: command.requestedInterval.end.toISOString(),
    },
    serviceLocation: {
      ...command.serviceLocation,
      capturedAt: command.serviceLocation.capturedAt.toISOString(),
      consentedAt: command.serviceLocation.consentedAt?.toISOString(),
    },
  }))
  .digest("hex");

export class BookingService {
  readonly #crypto: BookingCrypto;
  constructor(
    private readonly store: BookingStore,
    secrets: BookingSecrets,
    private readonly now = () => new Date(),
    private readonly indicators: OperationalIndicators = noopIndicators,
  ) {
    this.#crypto = new BookingCrypto(secrets);
  }

  async createBooking(
    principal: AuthPrincipal,
    command: CreateBookingCommand,
    idempotencyKeyValue: string,
    context: BookingRequestContext,
  ): Promise<BookingProjection> {
    if (!principal.roles.includes("FARMER")) {
      throw new BookingAuthorizationError("A Farmer role is required to create a booking");
    }
    const idempotencyKey = text(idempotencyKeyValue, "idempotencyKey", 200);
    text(context.correlationId, "correlationId", 200);
    const start = new Date(command.requestedInterval.start);
    const end = new Date(command.requestedInterval.end);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start >= end) {
      throw new BookingValidationError("requestedInterval", "Booking start must be before booking end");
    }
    if (command.bookingTarget === "MYSELF" && command.recipient !== undefined) {
      throw new BookingValidationError("recipient", "A self booking cannot include a Recipient");
    }
    if (command.bookingTarget === "SOMEONE_ELSE" && command.recipient === undefined) {
      throw new BookingValidationError("recipient", "Recipient details are required for someone else");
    }
    if (command.bookingTarget !== "MYSELF" && command.bookingTarget !== "SOMEONE_ELSE") {
      throw new BookingValidationError("bookingTarget", "Select who will receive the service");
    }
    const location = normalizeLocation(command.serviceLocation, "SERVICE_LOCATION");
    const disclosedAt = this.now();
    return this.store.createBooking({
      customerId: principal.userId,
      command: {
        ...command,
        requestedInterval: { start, end },
        serviceLocation: location,
      },
      ...(command.recipient === undefined ? {} : { recipient: normalizeRecipient(command.recipient, this.#crypto) }),
      idempotencyKey,
      requestDigest: digestCommand(principal.userId, command),
      disclosedAt,
    }, context);
  }

  async acceptBooking(
    principal: AuthPrincipal,
    command: BookingLifecycleCommand,
    context: BookingRequestContext,
  ): Promise<BookingProjection> {
    return this.#transition(principal, command, context, "OWNER", "ACCEPT", false);
  }

  async rejectBooking(
    principal: AuthPrincipal,
    command: BookingLifecycleCommand,
    context: BookingRequestContext,
  ): Promise<BookingProjection> {
    return this.#transition(principal, command, context, "OWNER", "REJECT", true);
  }

  async cancelBooking(
    principal: AuthPrincipal,
    command: BookingLifecycleCommand,
    context: BookingRequestContext,
    actorRole: BookingLifecycleActorRole,
  ): Promise<BookingProjection> {
    return this.#transition(principal, command, context, actorRole, "CANCEL", true);
  }

  async transitionLifecycle(
    principal: AuthPrincipal,
    command: BookingLifecycleCommand,
    context: BookingRequestContext,
    action: Exclude<BookingLifecycleAction, "ACCEPT" | "REJECT" | "CANCEL" | "EXPIRE">,
  ): Promise<BookingProjection> {
    const actorRole: BookingLifecycleActorRole = principal.roles.includes("OWNER") ? "OWNER"
      : principal.roles.includes("FARMER") ? "FARMER"
      : principal.roles.includes("FUTURE_OPERATOR") ? "SUPPORT"
      : (() => { throw new BookingAuthorizationError(); })();
    return this.#transition(principal, command, context, actorRole, action,
      action === "DISPUTE" || action === "REQUEST_REFUND");
  }

  async changeAgreement(
    principal: AuthPrincipal,
    command: AgreementChangeCommand,
    context: BookingRequestContext,
  ): Promise<BookingProjection> {
    if (!principal.roles.includes("OWNER")) throw new BookingAuthorizationError("An Owner role is required to change an agreement");
    text(command.bookingId, "bookingId", 200);
    text(command.reason, "reason", 500);
    text(context.correlationId, "correlationId", 200);
    if (!Number.isSafeInteger(command.expectedVersion) || command.expectedVersion < 1) {
      throw new BookingValidationError("expectedVersion", "expectedVersion must be a positive safe integer");
    }
    if (Number.isNaN(command.customerApprovedAt.getTime()) || Number.isNaN(command.ownerApprovedAt.getTime())) {
      throw new BookingValidationError("approval", "Both agreement approvals require valid timestamps");
    }
    return this.store.changeAgreement({ ...command, reason: text(command.reason, "reason", 500), actorId: principal.userId }, context);
  }

  async expirePendingBookings(
    pendingBefore: Date,
    context: BookingRequestContext,
    limit = 100,
  ): Promise<number> {
    if (Number.isNaN(pendingBefore.getTime())) throw new BookingValidationError("pendingBefore", "pendingBefore must be valid");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new BookingValidationError("limit", "limit must be between 1 and 1000");
    }
    return this.store.expirePendingBookings({ pendingBefore, occurredAt: this.now(), limit }, context);
  }

  async #transition(
    principal: AuthPrincipal,
    command: BookingLifecycleCommand,
    context: BookingRequestContext,
    actorRole: BookingLifecycleActorRole,
    action: BookingLifecycleAction,
    reasonRequired: boolean,
  ): Promise<BookingProjection> {
    const hasRole = actorRole === "SUPPORT"
      ? principal.roles.includes("FUTURE_OPERATOR")
      : actorRole !== "SYSTEM" && principal.roles.includes(actorRole);
    if (!hasRole) throw new BookingAuthorizationError();
    text(command.bookingId, "bookingId", 200);
    text(context.correlationId, "correlationId", 200);
    if (!Number.isSafeInteger(command.expectedVersion) || command.expectedVersion < 1) {
      throw new BookingValidationError("expectedVersion", "expectedVersion must be a positive safe integer");
    }
    const reason = command.reason === undefined ? undefined : text(command.reason, "reason", 500);
    if (reasonRequired && reason === undefined) {
      throw new BookingValidationError("reason", "A reason is required for rejection or cancellation");
    }
    try {
      return await this.store.transitionBooking({
        bookingId: command.bookingId,
        expectedVersion: command.expectedVersion,
        actorId: principal.userId,
        actorRole,
        action,
        occurredAt: this.now(),
        ...(reason === undefined ? {} : { reason }),
      }, context);
    } catch (error) {
      this.#recordConflict(error, action);
      throw error;
    }
  }

  /** Counts refused transitions and acceptance conflicts; never changes the outcome. */
  #recordConflict(error: unknown, action: BookingLifecycleAction): void {
    if (!(error instanceof BookingConflictError)) return;
    if (error.reason === "INVALID_TRANSITION") {
      this.indicators.invalidTransition("BOOKING", action);
    } else if (action === "ACCEPT" && error.reason !== "OTHER") {
      this.indicators.acceptanceConflict(error.reason);
    }
  }
}
