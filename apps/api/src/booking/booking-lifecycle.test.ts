import { describe, expect, it } from "vitest";

import { BOOKING_TRANSITION_TABLE, bookingTransitionEventType, bookingTransitionRule } from "./booking-lifecycle.js";
import type { BookingStatus } from "./booking.contracts.js";

/** Validates: Requirements 8.8, 8.9, 8.10 */
describe("complete booking lifecycle", () => {
  it("covers every required successful and exceptional outcome", () => {
    const outcomes = new Set(BOOKING_TRANSITION_TABLE.map((rule) => rule.to));
    const required: BookingStatus[] = ["PENDING_OWNER_RESPONSE", "ACCEPTED", "SCHEDULED", "IN_PROGRESS", "WORK_COMPLETED",
      "FINAL_BILL_GENERATED", "PAYMENT_RECORDED", "COMPLETED", "REJECTED", "CANCELLED",
      "EXPIRED", "DISPUTED", "REFUND_PENDING", "REFUNDED"];
    expect(required.every((status) => outcomes.has(status))).toBe(true);
  });

  it("enforces actor permissions and terminal-state safety", () => {
    expect(bookingTransitionRule("PENDING_OWNER_RESPONSE", "ACCEPT", "OWNER")?.to).toBe("ACCEPTED");
    expect(bookingTransitionRule("PENDING_OWNER_RESPONSE", "ACCEPT", "FARMER")).toBeUndefined();
    expect(bookingTransitionRule("FINAL_BILL_GENERATED", "DISPUTE", "FARMER")?.reasonRequired).toBe(true);
    expect(bookingTransitionRule("DISPUTED", "REQUEST_REFUND", "SUPPORT")?.to).toBe("REFUND_PENDING");
    expect(bookingTransitionRule("REFUND_PENDING", "REFUND", "SYSTEM")?.to).toBe("REFUNDED");
    expect(BOOKING_TRANSITION_TABLE.some((rule) => rule.from === "REFUNDED")).toBe(false);
    expect(BOOKING_TRANSITION_TABLE.some((rule) => rule.from === "REJECTED")).toBe(false);
  });

  it("allows only SYSTEM to auto-complete a zero-total bill while leaving PAYMENT_RECORDED -> COMPLETED intact", () => {
    // The new FINAL_BILL_GENERATED -> COMPLETED path is SYSTEM-only; the zero-total guard lives at the call site.
    expect(bookingTransitionRule("FINAL_BILL_GENERATED", "COMPLETE", "SYSTEM")?.to).toBe("COMPLETED");
    for (const role of ["FARMER", "OWNER", "SUPPORT"] as const) {
      expect(bookingTransitionRule("FINAL_BILL_GENERATED", "COMPLETE", role)).toBeUndefined();
    }
    // The existing settlement-driven completion is unchanged and still SYSTEM-only.
    expect(bookingTransitionRule("PAYMENT_RECORDED", "COMPLETE", "SYSTEM")?.to).toBe("COMPLETED");
    expect(bookingTransitionRule("PAYMENT_RECORDED", "COMPLETE", "OWNER")).toBeUndefined();
    // Auto-completion does not introduce a dispute path from COMPLETED.
    expect(bookingTransitionRule("COMPLETED", "DISPUTE", "FARMER")).toBeUndefined();
  });
  it("lets only support resolve a disputed booking, each outcome along one explicit edge", () => {
    expect(bookingTransitionRule("DISPUTED", "RESOLVE_DISPUTE", "SUPPORT")).toMatchObject({ to: "FINAL_BILL_GENERATED", reasonRequired: true });
    expect(bookingTransitionRule("DISPUTED", "COMPLETE", "SUPPORT")).toMatchObject({ to: "COMPLETED", reasonRequired: true });
    expect(bookingTransitionRule("DISPUTED", "CANCEL", "SUPPORT")).toMatchObject({ to: "CANCELLED", reasonRequired: true });
    for (const role of ["FARMER", "OWNER", "SYSTEM"] as const) {
      for (const action of ["RESOLVE_DISPUTE", "COMPLETE", "CANCEL"] as const) {
        expect(bookingTransitionRule("DISPUTED", action, role), `${role} ${action}`).toBeUndefined();
      }
    }
    // A dispute can never be resolved from any other status.
    expect(BOOKING_TRANSITION_TABLE.filter((rule) => rule.action === "RESOLVE_DISPUTE").map((rule) => rule.from)).toEqual(["DISPUTED"]);
  });

  it("creates stable configured-notification event names", () => {
    expect(bookingTransitionEventType("REFUND_PENDING")).toBe("BookingRefundPending");
    expect(bookingTransitionEventType("EXPIRED")).toBe("BookingExpired");
  });
});
