import type { AuthPrincipal } from "@kisantractor/domain";
import { HttpException } from "@nestjs/common";
import { describe, expect, it } from "vitest";

import { BOOKING_TRANSITION_TABLE } from "../booking/booking-lifecycle.js";
import {
  ACCOUNT_DELETION_CONFIRMATION,
  type AccountErasureRequest,
  type AccountErasureResult,
  type AccountErasureStore,
} from "./account-deletion.contracts.js";
import {
  AccountDeletionConfirmationError,
  AccountDeletionService,
  AccountHasOpenBookingsError,
  AccountNotActiveError,
  CLOSED_BOOKING_STATUSES,
} from "./account-deletion.service.js";
import { AccountController, type AccountSessionAuthenticator } from "./account.controller.js";

const principal: AuthPrincipal = { userId: "a1000000-0000-4000-8000-000000000001", sessionId: "s-1", roles: ["FARMER"] };

const erased: AccountErasureResult = {
  status: "ERASED",
  userId: principal.userId,
  erasedAt: new Date("2026-03-01T10:00:00.000Z"),
  erased: {
    sessionsRevoked: 2, rolesRevoked: 1, profileAnonymized: true, locationsDeleted: 1, locationsCoarsened: 0,
    privateFilesDeleted: 0, tractorPhotosDeleted: 0, tractorsWithdrawn: 0, recipientSnapshotsRedacted: 1,
    otpChallengesDeleted: 3, idempotencyRecordsDeleted: 1, ivrSessionsRedacted: 0, pushDevicesDeleted: 0,
  },
  retained: { bookings: 4, invoices: 3, payments: 3, auditEvents: 9 },
};

class RecordingStore implements AccountErasureStore {
  readonly requests: AccountErasureRequest[] = [];
  constructor(private readonly result: AccountErasureResult) {}
  async eraseAccount(request: AccountErasureRequest): Promise<AccountErasureResult> {
    this.requests.push(request);
    return this.result;
  }
}

const command = (confirmation: unknown) => ({
  principal, confirmation, actorChannel: "WEB" as const, correlationId: "corr-account-1",
});

/** Validates: Requirements 12.5 */
describe("AccountDeletionService", () => {
  it("treats only terminal booking statuses as closed", () => {
    expect([...CLOSED_BOOKING_STATUSES]).toEqual(["CANCELLED", "COMPLETED", "EXPIRED", "REFUNDED", "REJECTED"]);
    const open = new Set(BOOKING_TRANSITION_TABLE.map(({ from }) => from));
    for (const status of CLOSED_BOOKING_STATUSES) expect(open.has(status), status).toBe(false);
    // Disputed and unpaid bookings still need both parties.
    for (const status of ["DISPUTED", "REFUND_PENDING", "FINAL_BILL_GENERATED", "PAYMENT_RECORDED", "SCHEDULED"]) {
      expect(CLOSED_BOOKING_STATUSES).not.toContain(status);
    }
  });

  it("requires the exact confirmation phrase and never reaches the store without it", async () => {
    const store = new RecordingStore(erased);
    const service = new AccountDeletionService(store);
    for (const confirmation of [undefined, "", "delete_my_account", " DELETE_MY_ACCOUNT", true, { value: ACCOUNT_DELETION_CONFIRMATION }]) {
      await expect(service.deleteOwnAccount(command(confirmation))).rejects.toBeInstanceOf(AccountDeletionConfirmationError);
    }
    expect(store.requests).toEqual([]);
  });

  it("erases only the authenticated principal's own account with the closed-status policy", async () => {
    const store = new RecordingStore(erased);
    const result = await new AccountDeletionService(store).deleteOwnAccount(command(ACCOUNT_DELETION_CONFIRMATION));
    expect(result).toBe(erased);
    expect(store.requests).toEqual([{
      userId: principal.userId, actorChannel: "WEB", correlationId: "corr-account-1", closedBookingStatuses: CLOSED_BOOKING_STATUSES,
    }]);
  });

  it("maps store refusals to typed errors", async () => {
    await expect(new AccountDeletionService(new RecordingStore({ status: "REFUSED", reason: "OPEN_BOOKINGS", openBookings: 2 }))
      .deleteOwnAccount(command(ACCOUNT_DELETION_CONFIRMATION))).rejects.toMatchObject({ openBookings: 2, code: "ACCOUNT_HAS_OPEN_BOOKINGS" });
    await expect(new AccountDeletionService(new RecordingStore({ status: "REFUSED", reason: "ACCOUNT_NOT_ACTIVE" }))
      .deleteOwnAccount(command(ACCOUNT_DELETION_CONFIRMATION))).rejects.toBeInstanceOf(AccountNotActiveError);
  });
});

class FixedAuthenticator implements AccountSessionAuthenticator {
  async authenticateAccessCredential(credential: string): Promise<AuthPrincipal> {
    if (credential !== "access-token") throw new HttpException({ code: "UNAUTHENTICATED" }, 401);
    return principal;
  }
}

const request = (authorization?: string) => ({ headers: authorization === undefined ? {} : { authorization } });

const httpStatus = async (promise: Promise<unknown>): Promise<{ status: number; body: unknown }> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HttpException) return { status: error.getStatus(), body: error.getResponse() };
    throw error;
  }
  throw new Error("expected an HTTP error");
};

/** Validates: Requirements 12.5 */
describe("AccountController", () => {
  it("returns counts only, never personal data", async () => {
    const controller = new AccountController(new FixedAuthenticator(), new AccountDeletionService(new RecordingStore(erased)));
    const response = await controller.deleteAccount(request("Bearer access-token"), { confirmation: ACCOUNT_DELETION_CONFIRMATION });
    expect(response).toEqual({
      status: "ERASED", erasedAt: "2026-03-01T10:00:00.000Z", erased: erased.status === "ERASED" ? erased.erased : undefined,
      retained: { bookings: 4, invoices: 3, payments: 3, auditEvents: 9 },
    });
  });

  it("maps authentication, confirmation, open-booking, and inactive-account failures to stable codes", async () => {
    const store = new RecordingStore({ status: "REFUSED", reason: "OPEN_BOOKINGS", openBookings: 1 });
    const controller = new AccountController(new FixedAuthenticator(), new AccountDeletionService(store));
    expect(await httpStatus(controller.deleteAccount(request(), { confirmation: ACCOUNT_DELETION_CONFIRMATION })))
      .toMatchObject({ status: 401, body: { code: "UNAUTHENTICATED" } });
    expect(await httpStatus(controller.deleteAccount(request("Bearer forged"), { confirmation: ACCOUNT_DELETION_CONFIRMATION })))
      .toMatchObject({ status: 401 });
    expect(await httpStatus(controller.deleteAccount(request("Bearer access-token"), {})))
      .toMatchObject({ status: 422, body: { code: "ACCOUNT_DELETION_CONFIRMATION_REQUIRED", field: "confirmation" } });
    expect(store.requests).toHaveLength(0);
    expect(await httpStatus(controller.deleteAccount(request("Bearer access-token"), { confirmation: ACCOUNT_DELETION_CONFIRMATION })))
      .toMatchObject({ status: 409, body: { code: "ACCOUNT_HAS_OPEN_BOOKINGS", openBookings: 1 } });
    const inactive = new AccountController(new FixedAuthenticator(),
      new AccountDeletionService(new RecordingStore({ status: "REFUSED", reason: "ACCOUNT_NOT_ACTIVE" })));
    expect(await httpStatus(inactive.deleteAccount(request("Bearer access-token"), { confirmation: ACCOUNT_DELETION_CONFIRMATION })))
      .toMatchObject({ status: 401, body: { code: "UNAUTHENTICATED" } });
    expect(new AccountHasOpenBookingsError(1).message).not.toMatch(/\d{10}/u);
  });
});
