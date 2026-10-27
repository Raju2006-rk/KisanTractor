import type {
  BookingLifecycleAction,
  BookingLifecycleActorRole,
  BookingStatus,
} from "./booking.contracts.js";
export interface BookingTransitionRule {
  readonly action: BookingLifecycleAction;
  readonly from: BookingStatus;
  readonly to: BookingStatus;
  readonly roles: readonly BookingLifecycleActorRole[];
  readonly reasonRequired?: boolean;
}
export const BOOKING_TRANSITION_TABLE: readonly BookingTransitionRule[] = Object.freeze([
  { action: "SUBMIT", from: "CREATED", to: "PENDING_OWNER_RESPONSE", roles: ["FARMER"] },
  { action: "ACCEPT", from: "PENDING_OWNER_RESPONSE", to: "ACCEPTED", roles: ["OWNER"] },
  { action: "REJECT", from: "PENDING_OWNER_RESPONSE", to: "REJECTED", roles: ["OWNER"], reasonRequired: true },
  { action: "CANCEL", from: "PENDING_OWNER_RESPONSE", to: "CANCELLED", roles: ["FARMER"], reasonRequired: true },
  { action: "EXPIRE", from: "PENDING_OWNER_RESPONSE", to: "EXPIRED", roles: ["SYSTEM"], reasonRequired: true },
  { action: "SCHEDULE", from: "ACCEPTED", to: "SCHEDULED", roles: ["OWNER", "SYSTEM"] },
  { action: "CANCEL", from: "ACCEPTED", to: "CANCELLED", roles: ["FARMER", "OWNER"], reasonRequired: true },
  { action: "START_WORK", from: "ACCEPTED", to: "IN_PROGRESS", roles: ["OWNER"] },
  { action: "CANCEL", from: "SCHEDULED", to: "CANCELLED", roles: ["FARMER", "OWNER"], reasonRequired: true },
  { action: "START_WORK", from: "SCHEDULED", to: "IN_PROGRESS", roles: ["OWNER"] },
  { action: "COMPLETE_WORK", from: "IN_PROGRESS", to: "WORK_COMPLETED", roles: ["OWNER"] },
  { action: "GENERATE_FINAL_BILL", from: "WORK_COMPLETED", to: "FINAL_BILL_GENERATED", roles: ["SYSTEM"] },
  { action: "DISPUTE", from: "FINAL_BILL_GENERATED", to: "DISPUTED", roles: ["FARMER"], reasonRequired: true },
  { action: "RECORD_PAYMENT", from: "FINAL_BILL_GENERATED", to: "PAYMENT_RECORDED", roles: ["SYSTEM"] },
  // Zero-total auto-completion: a SYSTEM-only short-circuit that completes a booking whose issued
  // final bill is 0 paise, since no payment can ever be recorded against it. The zero-total guard is
  // enforced at the call site (see PostgresJobStore); the table only grants the capability to SYSTEM.
  { action: "COMPLETE", from: "FINAL_BILL_GENERATED", to: "COMPLETED", roles: ["SYSTEM"] },
  { action: "DISPUTE", from: "PAYMENT_RECORDED", to: "DISPUTED", roles: ["FARMER"], reasonRequired: true },
  { action: "COMPLETE", from: "PAYMENT_RECORDED", to: "COMPLETED", roles: ["SYSTEM"] },
  { action: "REQUEST_REFUND", from: "DISPUTED", to: "REFUND_PENDING", roles: ["SUPPORT", "SYSTEM"], reasonRequired: true },
  // Support dispute resolutions (task 16.5). Only a support principal with an explicit, unexpired
  // grant for the case reaches these edges (see SupportCaseService); the reason is the outcome code.
  // Upheld or adjusted bill, not yet fully paid: settlement reopens on the current invoice version.
  { action: "RESOLVE_DISPUTE", from: "DISPUTED", to: "FINAL_BILL_GENERATED", roles: ["SUPPORT"], reasonRequired: true },
  // Upheld or adjusted bill already fully paid by confirmed payments: the booking completes.
  { action: "COMPLETE", from: "DISPUTED", to: "COMPLETED", roles: ["SUPPORT"], reasonRequired: true },
  // Cancelled bill with no confirmed or pending payment; a paid bill is refunded instead.
  { action: "CANCEL", from: "DISPUTED", to: "CANCELLED", roles: ["SUPPORT"], reasonRequired: true },
  { action: "REFUND", from: "REFUND_PENDING", to: "REFUNDED", roles: ["SYSTEM"] },
]);
export function bookingTransitionRule(
  status: BookingStatus,
  action: BookingLifecycleAction,
  role: BookingLifecycleActorRole,
): BookingTransitionRule | undefined {
  return BOOKING_TRANSITION_TABLE.find((rule) =>
    rule.from === status && rule.action === action && rule.roles.includes(role));
}
export function bookingTransitionEventType(status: BookingStatus): string {
  return `Booking${status.toLowerCase().split("_").map((part) => part[0]!.toUpperCase() + part.slice(1)).join("")}`;
}
