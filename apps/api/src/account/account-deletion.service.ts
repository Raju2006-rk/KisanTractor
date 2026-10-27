import type { AuditActorChannel } from "@kisantractor/database";
import type { AuthPrincipal } from "@kisantractor/domain";

import { BOOKING_TRANSITION_TABLE } from "../booking/booking-lifecycle.js";
import type { BookingStatus } from "../booking/booking.contracts.js";
import {
  ACCOUNT_DELETION_CONFIRMATION,
  type AccountErasureResult,
  type AccountErasureStore,
} from "./account-deletion.contracts.js";

/**
 * Booking statuses with no outgoing transition. A booking in any other status still needs both
 * parties (work, billing, payment, dispute, refund), so deletion waits until it closes.
 */
export const CLOSED_BOOKING_STATUSES: readonly BookingStatus[] = Object.freeze((() => {
  const statuses = new Set<BookingStatus>();
  for (const rule of BOOKING_TRANSITION_TABLE) {
    statuses.add(rule.from);
    statuses.add(rule.to);
  }
  const open = new Set(BOOKING_TRANSITION_TABLE.map((rule) => rule.from));
  return [...statuses].filter((status) => !open.has(status)).sort();
})());

export class AccountDeletionConfirmationError extends Error {
  readonly code = "ACCOUNT_DELETION_CONFIRMATION_REQUIRED";

  constructor() {
    super(`Send confirmation "${ACCOUNT_DELETION_CONFIRMATION}" to delete this account.`);
    this.name = "AccountDeletionConfirmationError";
  }
}

export class AccountHasOpenBookingsError extends Error {
  readonly code = "ACCOUNT_HAS_OPEN_BOOKINGS";

  constructor(readonly openBookings: number) {
    super("Bookings that are still in progress, unpaid, or disputed must close before the account can be deleted.");
    this.name = "AccountHasOpenBookingsError";
  }
}

export class AccountNotActiveError extends Error {
  readonly code = "ACCOUNT_NOT_ACTIVE";

  constructor() {
    super("The account is not active.");
    this.name = "AccountNotActiveError";
  }
}

export interface AccountDeletionCommand {
  readonly principal: AuthPrincipal;
  readonly confirmation: unknown;
  readonly actorChannel: AuditActorChannel;
  readonly correlationId: string;
}

export type AccountDeletionOutcome = Extract<AccountErasureResult, { status: "ERASED" }>;

/**
 * Account deletion (Requirement 12.5): erases or anonymizes the account holder's personal data and
 * keeps bookings, agreements, status history, work records, invoices, payments, notifications, and
 * audit events, which keep referencing the now-pseudonymous user id. See ops/runbooks/account-deletion.md.
 */
export class AccountDeletionService {
  constructor(private readonly store: AccountErasureStore) {}

  async deleteOwnAccount(command: AccountDeletionCommand): Promise<AccountDeletionOutcome> {
    if (command.confirmation !== ACCOUNT_DELETION_CONFIRMATION) throw new AccountDeletionConfirmationError();
    const result = await this.store.eraseAccount({
      userId: command.principal.userId,
      actorChannel: command.actorChannel,
      correlationId: command.correlationId,
      closedBookingStatuses: CLOSED_BOOKING_STATUSES,
    });
    if (result.status === "ERASED") return result;
    if (result.reason === "OPEN_BOOKINGS") throw new AccountHasOpenBookingsError(result.openBookings);
    throw new AccountNotActiveError();
  }
}
