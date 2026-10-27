import {
  OTHER_LABEL_VALUE,
  noopMetrics,
  type BookingFunnelStage,
  type MetricsRecorder,
  type ProductAnalyticsEvent,
  type WebRouteGroup,
  type WebVitalName,
  type WebVitalRating,
  acceptanceConflictReasons,
  bookingFunnelStages,
  ivrCallOutcomes,
  ivrPromptSteps,
  landing3dOutcomes,
  notificationChannels,
  notificationDeliveryOutcomes,
  notificationProviders,
  otpRequestOutcomes,
  outboxResolutions,
  otpVerificationReasons,
  productAnalyticsEvents,
  paymentRecoveryOutcomes,
  paymentRecoverySubjects,
  paymentVerificationReasons,
} from "./metrics.js";

export type OtpRequestOutcome = (typeof otpRequestOutcomes)[number];
export type OtpVerificationReason = (typeof otpVerificationReasons)[number];
export type AcceptanceConflictReason = (typeof acceptanceConflictReasons)[number];
export type PaymentVerificationReason = (typeof paymentVerificationReasons)[number];
export type PaymentRecoverySubject = (typeof paymentRecoverySubjects)[number];
export type PaymentRecoveryOutcome = (typeof paymentRecoveryOutcomes)[number];
export type InvalidTransitionAggregate = "BOOKING" | "WORK" | "PAYMENT";
export type OutboxResolution = (typeof outboxResolutions)[number];
export type NotificationDeliveryChannel = (typeof notificationChannels)[number];
export type NotificationDeliveryProvider = (typeof notificationProviders)[number];
export type NotificationDeliveryOutcome = (typeof notificationDeliveryOutcomes)[number];

/** Delivery reasons a low-threshold alert reads with `increase()`, so they get zero baselines. */
export const NOTIFICATION_MISCONFIGURATION_REASONS = Object.freeze(["SMS_TEMPLATE_NOT_REGISTERED"] as const);
export type TranslationSurface = "API" | "WORKER" | "WEB";
export type ProviderCallbackCapability = "OTP" | "ONLINE_PAYMENT" | "MESSAGING" | "TELEPHONY";
export type ProviderCallbackOutcome = "ACCEPTED" | "DUPLICATE" | "REJECTED_SIGNATURE" | "REJECTED_PAYLOAD" | "FAILED";
export type IvrCallOutcome = (typeof ivrCallOutcomes)[number];
export type IvrPromptStep = (typeof ivrPromptSteps)[number];
export type Landing3dOutcome = (typeof landing3dOutcomes)[number];

/**
 * Committed booking lifecycle events (outbox `eventType`) mapped to funnel
 * stages. Counting these once per outbox event means idempotent replays and
 * rolled-back transactions never inflate conversion.
 */
export const bookingFunnelStageByEventType: Readonly<Record<string, BookingFunnelStage>> = Object.freeze({
  BookingRequested: "REQUESTED",
  BookingAccepted: "ACCEPTED",
  BookingRejected: "REJECTED",
  BookingCancelled: "CANCELLED",
  BookingExpired: "EXPIRED",
  BookingInProgress: "WORK_STARTED",
  BookingWorkCompleted: "WORK_COMPLETED",
  BookingFinalBillGenerated: "FINAL_BILL_GENERATED",
  BookingPaymentRecorded: "PAYMENT_RECORDED",
  BookingCompleted: "COMPLETED",
} satisfies Readonly<Record<string, (typeof bookingFunnelStages)[number]>>);

export const INVOICE_DISPUTE_EVENT_TYPE = "BookingDisputed";

/** Reasons the critical `PaymentIntegrityFailure` alert pages on (ops/observability/alerts). */
export const PAYMENT_INTEGRITY_REASONS = Object.freeze([
  "PAYMENT_LEDGER_INCONSISTENT",
  "SIGNATURE_INVALID",
  "AMOUNT_MISMATCH",
  "CURRENCY_MISMATCH",
  "REFERENCE_MISMATCH",
  "RECONCILIATION_MISMATCH",
] as const satisfies readonly PaymentVerificationReason[]);

/** Recovery outcomes the payment-recovery alerts read with `increase()`, so they get zero baselines. */
const PAYMENT_RECOVERY_ALERT_SERIES = Object.freeze([
  ["REFUND", "REFUND_FAILED"],
  ["INTENT", "PROVIDER_ERROR"],
  ["REFUND", "PROVIDER_ERROR"],
] as const satisfies ReadonlyArray<readonly [PaymentRecoverySubject, PaymentRecoveryOutcome]>);

export interface OutboxBacklogStats {
  readonly dueEvents: number;
  readonly oldestDueAgeMs: number;
  readonly deadLetterEvents: number;
}

export interface WebVitalReport {
  readonly vital: WebVitalName;
  readonly value: number;
  readonly rating: WebVitalRating;
  readonly routeGroup: WebRouteGroup;
}

const isoClass = (statusCode: number): string =>
  statusCode >= 100 && statusCode < 600 ? `${Math.floor(statusCode / 100)}xx` : "5xx";

/**
 * Typed recorders for the Requirement 18.1/18.2 operational indicators. Each
 * method maps a domain-level fact onto catalog metrics with bounded labels;
 * callers never pass identifiers, phone numbers, or free text.
 */
export class OperationalIndicators {
  constructor(private readonly metrics: MetricsRecorder = noopMetrics) {}

  /**
   * Publishes zero-valued series for the counters that low-threshold alerts read with
   * `increase()`. A counter series that first appears at 1 has no earlier sample, so `increase()`
   * cannot see that first event; without a zero baseline the first payment-ledger inconsistency
   * after a deploy would never page anyone (see `alert-rules.test.ts`). Every label here is
   * enumerated, so the baseline adds a fixed, small number of series.
   */
  initializeAlertBaselines(): void {
    for (const method of ["CASH", "ONLINE"] as const) {
      for (const reason of PAYMENT_INTEGRITY_REASONS) {
        this.metrics.increment("kt_payment_verification_failures_total", { method, reason }, 0);
      }
    }
    for (const outcome of otpRequestOutcomes) this.metrics.increment("kt_otp_requests_total", { outcome }, 0);
    for (const reason of acceptanceConflictReasons) this.metrics.increment("kt_booking_acceptance_conflicts_total", { reason }, 0);
    for (const stage of bookingFunnelStages) this.metrics.increment("kt_booking_funnel_events_total", { stage }, 0);
    for (const event of productAnalyticsEvents) {
      this.metrics.increment("kt_product_analytics_events_total", { event, surface: "other", locale: "en" }, 0);
    }
    for (const outcome of landing3dOutcomes) this.metrics.increment("kt_landing_3d_outcomes_total", { outcome }, 0);
    this.metrics.increment("kt_invoice_disputes_total", {}, 0);
    this.metrics.increment("kt_outbox_poll_failures_total", {}, 0);
    for (const [subject, outcome] of PAYMENT_RECOVERY_ALERT_SERIES) {
      this.metrics.increment("kt_payment_recovery_total", { subject, outcome }, 0);
    }
    for (const reason of NOTIFICATION_MISCONFIGURATION_REASONS) {
      this.metrics.increment("kt_notification_deliveries_total", { channel: "SMS", provider: "msg91", outcome: "NOT_SENT", reason }, 0);
    }
  }

  /**
   * One recorded notification delivery attempt. `reason` is the PII-free error or not-sent code
   * (`NONE` when there is none); recipients, numbers, tokens, and bodies are never labels.
   */
  notificationDeliveryRecorded(
    channel: NotificationDeliveryChannel,
    provider: string,
    outcome: NotificationDeliveryOutcome,
    reason: string | undefined,
  ): void {
    this.metrics.increment("kt_notification_deliveries_total", { channel, provider, outcome, reason: reason ?? "NONE" });
  }

  httpRequestCompleted(method: string, route: string | undefined, statusCode: number, durationMs: number): void {
    // Unmatched requests (404s, scanners) share one series instead of exposing their paths.
    const labels = { method: method.toUpperCase(), route: route ?? OTHER_LABEL_VALUE, status_class: isoClass(statusCode) };
    this.metrics.increment("kt_http_server_requests_total", labels);
    this.metrics.observe("kt_http_server_request_duration_ms", durationMs, labels);
  }

  domainTransactionCompleted(isolation: string, outcome: "COMMITTED" | "ROLLED_BACK", durationMs: number): void {
    const labels = { isolation: isolation.replaceAll(" ", "_"), outcome };
    this.metrics.increment("kt_domain_transactions_total", labels);
    this.metrics.observe("kt_domain_transaction_duration_ms", durationMs, labels);
  }

  otpRequested(outcome: OtpRequestOutcome): void {
    this.metrics.increment("kt_otp_requests_total", { outcome });
  }

  otpVerified(): void {
    this.metrics.increment("kt_otp_verifications_total", { outcome: "SUCCEEDED", reason: "NONE" });
  }

  otpVerificationRejected(reason: OtpVerificationReason): void {
    this.metrics.increment("kt_otp_verifications_total", { outcome: "REJECTED", reason });
  }

  /** Counts first-page searches only, so paging through results does not skew the zero-result rate. */
  discoverySearched(resultCount: number, pricingMethod: string | undefined): void {
    this.metrics.increment("kt_discovery_searches_total", {
      outcome: resultCount > 0 ? "RESULTS" : "ZERO_RESULTS",
      pricing_method: pricingMethod ?? "ANY",
    });
  }

  acceptanceConflict(reason: AcceptanceConflictReason): void {
    this.metrics.increment("kt_booking_acceptance_conflicts_total", { reason });
  }

  invalidTransition(aggregate: InvalidTransitionAggregate, action: string): void {
    this.metrics.increment("kt_invalid_transitions_total", { aggregate, action });
  }

  paymentVerificationFailed(method: "CASH" | "ONLINE", reason: string): void {
    this.metrics.increment("kt_payment_verification_failures_total", { method, reason });
  }

  /** One pending intent or refund checked against the provider, or a refund outcome from a webhook. */
  paymentRecovery(subject: PaymentRecoverySubject, outcome: PaymentRecoveryOutcome): void {
    this.metrics.increment("kt_payment_recovery_total", { subject, outcome });
  }

  outboxEventClaimed(eventType: string, lagMs: number): void {
    this.metrics.observe("kt_outbox_dispatch_lag_ms", Math.max(0, lagMs), { event_type: eventType });
  }

  /**
   * Records one outbox attempt's resolution. Terminal resolutions (published or
   * dead-lettered) happen once per committed event and drive the booking funnel
   * and invoice-dispute counters.
   */
  outboxEventResolved(eventType: string, resolution: OutboxResolution): void {
    this.metrics.increment("kt_outbox_events_resolved_total", { event_type: eventType, resolution });
    if (resolution !== "PUBLISHED" && resolution !== "DEAD_LETTERED") return;
    const stage = bookingFunnelStageByEventType[eventType];
    if (stage !== undefined) this.metrics.increment("kt_booking_funnel_events_total", { stage });
    if (eventType === INVOICE_DISPUTE_EVENT_TYPE) this.metrics.increment("kt_invoice_disputes_total");
  }

  outboxBacklogSampled(stats: OutboxBacklogStats): void {
    this.metrics.setGauge("kt_outbox_backlog_events", stats.dueEvents);
    this.metrics.setGauge("kt_outbox_oldest_pending_age_ms", Math.max(0, stats.oldestDueAgeMs));
    this.metrics.setGauge("kt_outbox_dead_letter_events", stats.deadLetterEvents);
  }

  outboxPollFailed(): void {
    this.metrics.increment("kt_outbox_poll_failures_total");
  }

  translationMissed(resolvedLocale: string, reason: string, surface: TranslationSurface): void {
    this.metrics.increment("kt_translation_misses_total", { locale: resolvedLocale, reason, surface });
  }

  productAnalyticsEvent(event: ProductAnalyticsEvent, surface: WebRouteGroup, locale: string): void {
    this.metrics.increment("kt_product_analytics_events_total", { event, surface, locale });
  }

  webVitalReported(report: WebVitalReport): void {
    this.metrics.increment("kt_web_vitals_reports_total", {
      vital: report.vital, rating: report.rating, route_group: report.routeGroup,
    });
    if (report.vital === "CLS") {
      this.metrics.observe("kt_web_vital_cls", report.value, { route_group: report.routeGroup });
    } else {
      this.metrics.observe("kt_web_vital_duration_ms", report.value, { vital: report.vital, route_group: report.routeGroup });
    }
  }

  /** Phase 2/3 contract: provider webhook or telephony callback verification outcome. */
  providerCallbackHandled(capability: ProviderCallbackCapability, outcome: ProviderCallbackOutcome): void {
    this.metrics.increment("kt_provider_callbacks_total", { capability, outcome });
  }

  /** Phase 3 contract: emitted only by the IVR channel once a telephony provider is live. */
  ivrCallEnded(outcome: IvrCallOutcome, lastStep: IvrPromptStep): void {
    this.metrics.increment("kt_ivr_calls_total", { outcome, last_step: lastStep });
  }

  /** One terminal landing outcome per page view; every non-LOADED outcome is a fallback. */
  landing3dOutcome(outcome: Landing3dOutcome): void {
    this.metrics.increment("kt_landing_3d_outcomes_total", { outcome });
  }
}

/** Indicators that discard every measurement; the default for services built without telemetry. */
export const noopIndicators = new OperationalIndicators(noopMetrics);
