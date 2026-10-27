import type { NotificationChannel } from "@kisantractor/domain";

import type { NotificationTemplateKey } from "./notification-templates.js";

export type NotificationAudience = "CUSTOMER" | "OWNER";

/** The entity a notification is recorded against; its id comes from the outbox payload. */
export type NotificationRelatedEntity = "Booking" | "Payment";

export interface NotificationRule {
  readonly templateKey: NotificationTemplateKey;
  readonly audience: readonly NotificationAudience[];
  /** Defaults to Booking (`payload.bookingId`); Payment uses `payload.paymentId`. */
  readonly relatedEntity?: NotificationRelatedEntity;
  /** Restricts the rule to these channels; defaults to every configured channel. */
  readonly channels?: readonly NotificationChannel[];
  /**
   * OWNER_CONTACT: generated only while contact sharing is enabled, the Owner consented, and the
   * booking state allows sharing; checked again before every send.
   */
  readonly requires?: "OWNER_CONTACT";
}

const payment = (templateKey: NotificationTemplateKey, audience: readonly NotificationAudience[]): readonly NotificationRule[] =>
  [{ templateKey, audience, relatedEntity: "Payment" }];

/**
 * Which committed domain events generate notifications, and for whom. Every
 * listed event carries `bookingId` in its outbox payload; payment events also
 * carry `paymentId`.
 */
export const defaultNotificationRules: Readonly<Record<string, readonly NotificationRule[]>> = Object.freeze({
  BookingRequested: [{ templateKey: "notification.booking.requested", audience: ["OWNER"] }],
  BookingAccepted: [
    { templateKey: "notification.booking.accepted", audience: ["CUSTOMER"] },
    // The Owner's number goes by SMS only, to the booking's Farmer, under the sharing policy.
    { templateKey: "notification.booking.ownerContact", audience: ["CUSTOMER"], channels: ["SMS"], requires: "OWNER_CONTACT" },
  ],
  BookingRejected: [{ templateKey: "notification.booking.rejected", audience: ["CUSTOMER"] }],
  BookingCancelled: [{ templateKey: "notification.booking.cancelled", audience: ["CUSTOMER", "OWNER"] }],
  BookingExpired: [{ templateKey: "notification.booking.expired", audience: ["CUSTOMER", "OWNER"] }],
  FinalBillGenerated: [{ templateKey: "notification.bill.ready", audience: ["CUSTOMER"] }],
  FinalBillReissued: [{ templateKey: "notification.bill.ready", audience: ["CUSTOMER"] }],
  CashPaymentRecorded: [{ templateKey: "notification.payment.cashRecorded", audience: ["CUSTOMER"] }],
  // Online receipts and refunds (task 16.2 events). Only a verified provider event or a provider
  // status read produces these, never a browser redirect.
  OnlinePaymentConfirmed: [
    { templateKey: "notification.payment.onlineConfirmed", audience: ["CUSTOMER"], relatedEntity: "Payment" },
    { templateKey: "notification.payment.onlineReceived", audience: ["OWNER"], relatedEntity: "Payment" },
  ],
  OnlinePaymentFailed: payment("notification.payment.onlineFailed", ["CUSTOMER"]),
  OnlinePaymentReleased: payment("notification.payment.onlineReleased", ["CUSTOMER"]),
  PaymentRefundRequested: payment("notification.refund.requested", ["CUSTOMER"]),
  PaymentRefundProcessed: payment("notification.refund.processed", ["CUSTOMER"]),
  PaymentRefundFailed: payment("notification.refund.failed", ["CUSTOMER"]),
  // Disputes and support resolutions (task 16.5). The Farmer raised the dispute, so only the Owner
  // is told it opened; both parties learn the outcome. Status events emitted by a resolution
  // (for example BookingCancelled) still notify through their own rules.
  BookingDisputed: [{ templateKey: "notification.dispute.opened", audience: ["OWNER"] }],
  DisputeResolved: [{ templateKey: "notification.dispute.resolved", audience: ["CUSTOMER", "OWNER"] }],
} satisfies Readonly<Record<string, readonly NotificationRule[]>>);
