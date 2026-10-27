import type { AuditActorChannel } from "@kisantractor/database";

/** Phrase the account holder must send to confirm deletion; guards against accidental requests. */
export const ACCOUNT_DELETION_CONFIRMATION = "DELETE_MY_ACCOUNT";

/** Display values written in place of erased personal data. */
export const ERASED_PROFILE_NAME = "Deleted user";
export const REDACTED_RECIPIENT_NAME = "Redacted recipient";

export interface AccountErasureRequest {
  readonly userId: string;
  readonly actorChannel: AuditActorChannel;
  readonly correlationId: string;
  /** Booking statuses that no longer need either party; deletion is refused while any other exists. */
  readonly closedBookingStatuses: readonly string[];
}

/** What was removed or anonymized. Counts only; never personal data. */
export interface AccountErasureSummary {
  readonly sessionsRevoked: number;
  readonly rolesRevoked: number;
  readonly profileAnonymized: boolean;
  readonly locationsDeleted: number;
  readonly locationsCoarsened: number;
  readonly privateFilesDeleted: number;
  readonly tractorPhotosDeleted: number;
  readonly tractorsWithdrawn: number;
  readonly recipientSnapshotsRedacted: number;
  readonly otpChallengesDeleted: number;
  readonly idempotencyRecordsDeleted: number;
  readonly ivrSessionsRedacted: number;
  readonly pushDevicesDeleted: number;
  /** Dispute statements by this person whose free text was erased; the entries and codes remain. */
  readonly disputeStatementsRedacted: number;
  /** Support access grants this operator held that were revoked. */
  readonly supportGrantsRevoked: number;
}

/** Financial and audit records kept under the retention policy, referencing the pseudonymous user id. */
export interface AccountRetentionSummary {
  readonly bookings: number;
  readonly invoices: number;
  readonly payments: number;
  readonly auditEvents: number;
  /** Dispute cases on this person's bookings, kept with their timelines (codes and ids). */
  readonly disputeCases: number;
}

export type AccountErasureResult =
  | {
      readonly status: "ERASED";
      readonly userId: string;
      readonly erasedAt: Date;
      readonly erased: AccountErasureSummary;
      readonly retained: AccountRetentionSummary;
    }
  | { readonly status: "REFUSED"; readonly reason: "OPEN_BOOKINGS"; readonly openBookings: number }
  | { readonly status: "REFUSED"; readonly reason: "ACCOUNT_NOT_ACTIVE" };

export interface AccountErasureStore {
  eraseAccount(request: AccountErasureRequest): Promise<AccountErasureResult>;
}
