/**
 * Versioned catalog of every metric the platform emits. Dashboards and alerts
 * under `ops/observability` may reference only names defined here; a test
 * enforces that. Every label is either an enumerated value set or a bounded
 * code pattern, so no metric can carry user, phone, booking, or other
 * per-entity identifiers.
 */

export type MetricKind = "counter" | "histogram" | "gauge";

/** An enumerated label; values outside the set are recorded as `OTHER`. */
export interface EnumLabelSpec {
  readonly values: readonly string[];
}

/**
 * A code-shaped label (route templates, event types). Values that fail the
 * pattern, exceed the length, or look like an identifier become `OTHER`.
 */
export interface PatternLabelSpec {
  readonly pattern: RegExp;
  readonly maxLength: number;
}

export type LabelSpec = EnumLabelSpec | PatternLabelSpec;

/** The Requirement 18.2 indicator (or 18.1 signal) a metric serves. */
export type OperationalIndicator =
  | "HTTP_REQUESTS"
  | "DOMAIN_TRANSACTIONS"
  | "OTP_ABUSE_FAILURE"
  | "ZERO_RESULT_DISCOVERY"
  | "BOOKING_CONVERSION"
  | "ACCEPTANCE_CONFLICTS"
  | "INVALID_TRANSITIONS"
  | "INVOICE_DISPUTES"
  | "PAYMENT_VERIFICATION_FAILURES"
  | "OUTBOX_LAG"
  | "PROVIDER_CALLBACKS"
  | "NOTIFICATION_DELIVERY"
  | "IVR_ABANDONMENT"
  | "TRANSLATION_MISSES"
  | "WEB_VITALS"
  | "PRODUCT_ANALYTICS"
  | "LANDING_3D_FALLBACK";

export interface MetricDefinition {
  readonly kind: MetricKind;
  readonly unit: string;
  readonly description: string;
  readonly indicator: OperationalIndicator;
  /** Delivery phase whose code emits the metric. Later-phase metrics are contracts only. */
  readonly phase: 1 | 2 | 3 | 4;
  readonly labels: Readonly<Record<string, LabelSpec>>;
  readonly buckets?: readonly number[];
}

export const OTHER_LABEL_VALUE = "OTHER";
export const UNKNOWN_LABEL_VALUE = "UNKNOWN";

const CODE = { pattern: /^[A-Z][A-Z0-9_]{0,63}$/u, maxLength: 64 } as const;
const EVENT_TYPE = { pattern: /^[A-Z][A-Za-z]{2,63}$/u, maxLength: 64 } as const;
// Route templates such as `/owner/bookings/:bookingId/job`; never concrete paths.
const ROUTE_TEMPLATE = { pattern: /^(?=\/)(?:\/(?::?[a-z][A-Za-z_-]*|\*[a-z]*))*\/?$/u, maxLength: 120 } as const;

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;
const STATUS_CLASSES = ["1xx", "2xx", "3xx", "4xx", "5xx"] as const;
const LOCALES = ["en", "hi", "te", "kn", "ta", "mr", "bn"] as const;
const LATENCY_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 800, 1_000, 2_500, 5_000, 10_000] as const;
const LAG_BUCKETS_MS = [100, 500, 1_000, 5_000, 15_000, 30_000, 60_000, 300_000, 900_000, 3_600_000] as const;

export const bookingFunnelStages = [
  "REQUESTED",
  "ACCEPTED",
  "REJECTED",
  "CANCELLED",
  "EXPIRED",
  "WORK_STARTED",
  "WORK_COMPLETED",
  "FINAL_BILL_GENERATED",
  "PAYMENT_RECORDED",
  "COMPLETED",
] as const;
export type BookingFunnelStage = (typeof bookingFunnelStages)[number];

export const otpRequestOutcomes = ["ISSUED", "THROTTLED", "INVALID_PHONE", "DELIVERY_FAILED"] as const;
export const otpVerificationReasons = [
  "NONE",
  "INVALID_PHONE",
  "NOT_FOUND",
  "BINDING_MISMATCH",
  "EXPIRED",
  "CONSUMED",
  "ATTEMPTS_EXHAUSTED",
  "INVALID_CODE",
  "ACCOUNT_NOT_FOUND",
  "ACCOUNT_INACTIVE",
] as const;
export const acceptanceConflictReasons = [
  "OVERLAP",
  "CONCURRENT_RESERVATION",
  "VERSION_CONFLICT",
  "CONCURRENT_UPDATE",
] as const;
export const paymentVerificationReasons = [
  // Phase 1 cash confirmation rules (domain PaymentRuleCode and store conflict codes).
  "PAYMENT_INVALID_AMOUNT",
  "PAYMENT_CURRENCY_MISMATCH",
  "PAYMENT_INVOICE_REQUIRED",
  "PAYMENT_LIMIT_REACHED",
  "PAYMENT_REASON_REQUIRED",
  "PAYMENT_OVERPAYMENT",
  "PAYMENT_BOOKING_NOT_PAYABLE",
  "PAYMENT_INVOICE_NOT_PAYABLE",
  "PAYMENT_SETTLEMENT_BLOCKED",
  "PAYMENT_ACTOR_NOT_PERMITTED",
  "PAYMENT_LEDGER_INCONSISTENT",
  "PAYMENT_TRANSITION_NOT_ALLOWED",
  "PAYMENT_EVIDENCE_REQUIRED",
  "PAYMENT_CONFLICT",
  "IDEMPOTENCY_KEY_REUSED",
  // Phase 2 provider evidence checks, emitted by the payment webhook handler.
  "SIGNATURE_INVALID",
  "AMOUNT_MISMATCH",
  "CURRENCY_MISMATCH",
  "REFERENCE_MISMATCH",
  "REPLAYED_EVENT",
  // Phase 2 recovery, refund, and reconciliation checks (task 16.2).
  "RECONCILIATION_MISMATCH",
  "PAYMENT_REFUND_UNSUPPORTED",
  "PAYMENT_REFUND_EXCEEDS_PAYMENT",
  "PAYMENT_PARTIAL_REFUND_UNSUPPORTED",
  "PAYMENT_REFUND_NOT_ALLOWED",
] as const;
/** Subjects and outcomes of pending-intent recovery and refund reconciliation (task 16.2). */
export const paymentRecoverySubjects = ["INTENT", "REFUND"] as const;
export const paymentRecoveryOutcomes = [
  "CONFIRMED",
  "RELEASED",
  "STILL_PENDING",
  "SUBMITTED",
  "REFUNDED",
  "REFUND_FAILED",
  "MISMATCH",
  "PROVIDER_ERROR",
] as const;
/** Notification delivery labels (task 16.4). Providers are enumerated so no free text reaches a label. */
export const notificationChannels = ["IN_APP", "SMS", "PUSH", "IVR"] as const;
export const notificationProviders = ["in_app", "msg91", "fcm", "sandbox", "none", "other"] as const;
export const notificationDeliveryOutcomes = ["SENT", "SANDBOX_SENT", "DELIVERED", "NOT_SENT", "FAILED", "DEAD_LETTER"] as const;
export const outboxResolutions = ["PUBLISHED", "RETRY_SCHEDULED", "DEFERRED", "DEAD_LETTERED", "LEASE_LOST"] as const;
export const webVitalNames = ["LCP", "INP", "CLS", "FCP", "TTFB"] as const;
export type WebVitalName = (typeof webVitalNames)[number];
export const webVitalRatings = ["good", "needs-improvement", "poor"] as const;
export type WebVitalRating = (typeof webVitalRatings)[number];
export const productAnalyticsEvents = [
  "PAGE_VIEW",
  "BOOKING_STARTED",
  "BOOKING_SUBMITTED",
  "PAYMENT_HISTORY_VIEWED",
  "OWNER_EARNINGS_VIEWED",
  "OWNER_EARNINGS_FILTERED",
] as const;
export type ProductAnalyticsEvent = (typeof productAnalyticsEvents)[number];
export const webRouteGroups = ["landing", "auth", "farmer", "owner", "help", "capabilities", "language", "onboarding", "other"] as const;
export type WebRouteGroup = (typeof webRouteGroups)[number];
export const landing3dOutcomes = [
  "LOADED",
  "DISABLED",
  "REDUCED_MOTION",
  "DATA_SAVER",
  "LOW_CAPABILITY",
  "FAILED",
  "TIMED_OUT",
] as const;
export const ivrCallOutcomes = ["COMPLETED", "ABANDONED", "TRANSFERRED", "FAILED"] as const;
export const ivrPromptSteps = [
  "LANGUAGE",
  "VERIFICATION",
  "LOCATION",
  "SERVICE",
  "DATE_TIME",
  "QUANTITY",
  "CONFIRMATION",
  "BOOKING_STATUS",
  "NONE",
] as const;

export const METRIC_DEFINITIONS = {
  kt_http_server_requests_total: {
    kind: "counter", unit: "1", phase: 1, indicator: "HTTP_REQUESTS",
    description: "Completed API requests by method, route template, and status class.",
    labels: { method: { values: HTTP_METHODS }, route: ROUTE_TEMPLATE, status_class: { values: STATUS_CLASSES } },
  },
  kt_http_server_request_duration_ms: {
    kind: "histogram", unit: "ms", phase: 1, indicator: "HTTP_REQUESTS",
    description: "API request latency by method, route template, and status class (Requirement 18.4 targets).",
    labels: { method: { values: HTTP_METHODS }, route: ROUTE_TEMPLATE, status_class: { values: STATUS_CLASSES } },
    buckets: LATENCY_BUCKETS_MS,
  },
  kt_domain_transactions_total: {
    kind: "counter", unit: "1", phase: 1, indicator: "DOMAIN_TRANSACTIONS",
    description: "Database transactions by isolation level and outcome.",
    labels: {
      isolation: { values: ["READ_COMMITTED", "REPEATABLE_READ", "SERIALIZABLE"] },
      outcome: { values: ["COMMITTED", "ROLLED_BACK"] },
    },
  },
  kt_domain_transaction_duration_ms: {
    kind: "histogram", unit: "ms", phase: 1, indicator: "DOMAIN_TRANSACTIONS",
    description: "Database transaction duration by isolation level and outcome.",
    labels: {
      isolation: { values: ["READ_COMMITTED", "REPEATABLE_READ", "SERIALIZABLE"] },
      outcome: { values: ["COMMITTED", "ROLLED_BACK"] },
    },
    buckets: LATENCY_BUCKETS_MS,
  },
  kt_otp_requests_total: {
    kind: "counter", unit: "1", phase: 1, indicator: "OTP_ABUSE_FAILURE",
    description: "OTP challenge requests by outcome; THROTTLED counts phone/requester rate-limit hits.",
    labels: { outcome: { values: otpRequestOutcomes } },
  },
  kt_otp_verifications_total: {
    kind: "counter", unit: "1", phase: 1, indicator: "OTP_ABUSE_FAILURE",
    description: "OTP verification attempts by outcome and rejection reason.",
    labels: { outcome: { values: ["SUCCEEDED", "REJECTED"] }, reason: { values: otpVerificationReasons } },
  },
  kt_discovery_searches_total: {
    kind: "counter", unit: "1", phase: 1, indicator: "ZERO_RESULT_DISCOVERY",
    description: "First-page Farmer discovery searches by result outcome and requested pricing method.",
    labels: {
      outcome: { values: ["RESULTS", "ZERO_RESULTS"] },
      pricing_method: { values: ["HOURLY", "PER_ACRE", "PER_TRIP", "ANY"] },
    },
  },
  kt_booking_funnel_events_total: {
    kind: "counter", unit: "1", phase: 1, indicator: "BOOKING_CONVERSION",
    description: "Committed booking lifecycle events by funnel stage, counted once per outbox event.",
    labels: { stage: { values: bookingFunnelStages } },
  },
  kt_booking_acceptance_conflicts_total: {
    kind: "counter", unit: "1", phase: 1, indicator: "ACCEPTANCE_CONFLICTS",
    description: "Owner acceptances refused because the Tractor interval or booking version changed.",
    labels: { reason: { values: acceptanceConflictReasons } },
  },
  kt_invalid_transitions_total: {
    kind: "counter", unit: "1", phase: 1, indicator: "INVALID_TRANSITIONS",
    description: "Commands refused because the aggregate's current state does not allow the action.",
    labels: { aggregate: { values: ["BOOKING", "WORK", "PAYMENT"] }, action: CODE },
  },
  kt_invoice_disputes_total: {
    kind: "counter", unit: "1", phase: 1, indicator: "INVOICE_DISPUTES",
    description: "Committed bill disputes (BookingDisputed events), counted once per outbox event.",
    labels: {},
  },
  kt_payment_verification_failures_total: {
    kind: "counter", unit: "1", phase: 1, indicator: "PAYMENT_VERIFICATION_FAILURES",
    description: "Payment records refused by verification rules, by method and reason code.",
    labels: { method: { values: ["CASH", "ONLINE"] }, reason: { values: paymentVerificationReasons } },
  },
  kt_outbox_dispatch_lag_ms: {
    kind: "histogram", unit: "ms", phase: 1, indicator: "OUTBOX_LAG",
    description: "Delay between an outbox event becoming available and a worker claiming it.",
    labels: { event_type: EVENT_TYPE },
    buckets: LAG_BUCKETS_MS,
  },
  kt_outbox_events_resolved_total: {
    kind: "counter", unit: "1", phase: 1, indicator: "OUTBOX_LAG",
    description: "Outbox attempts by event type and resolution.",
    labels: {
      event_type: EVENT_TYPE,
      resolution: { values: outboxResolutions },
    },
  },
  kt_outbox_backlog_events: {
    kind: "gauge", unit: "1", phase: 1, indicator: "OUTBOX_LAG",
    description: "Outbox events that are due and not yet published, sampled by the worker.",
    labels: {},
  },
  kt_outbox_oldest_pending_age_ms: {
    kind: "gauge", unit: "ms", phase: 1, indicator: "OUTBOX_LAG",
    description: "Age of the oldest due, unpublished outbox event, sampled by the worker.",
    labels: {},
  },
  kt_outbox_dead_letter_events: {
    kind: "gauge", unit: "1", phase: 1, indicator: "OUTBOX_LAG",
    description: "Outbox events currently dead-lettered and awaiting operator action.",
    labels: {},
  },
  kt_outbox_poll_failures_total: {
    kind: "counter", unit: "1", phase: 1, indicator: "OUTBOX_LAG",
    description: "Outbox polling cycles that failed before resolving any event.",
    labels: {},
  },
  kt_translation_misses_total: {
    kind: "counter", unit: "1", phase: 1, indicator: "TRANSLATION_MISSES",
    description: "Translation fallbacks by resolved locale, reason, and surface.",
    labels: {
      locale: { values: LOCALES },
      reason: { values: ["UNSUPPORTED_LOCALE", "MISSING_LOCALE_ENTRY", "MISSING_ENGLISH_ENTRY"] },
      surface: { values: ["API", "WORKER", "WEB"] },
    },
  },
  kt_web_vitals_reports_total: {
    kind: "counter", unit: "1", phase: 1, indicator: "WEB_VITALS",
    description: "Browser web-vital reports by metric, rating, and coarse route group.",
    labels: { vital: { values: webVitalNames }, rating: { values: webVitalRatings }, route_group: { values: webRouteGroups } },
  },
  kt_web_vital_duration_ms: {
    kind: "histogram", unit: "ms", phase: 1, indicator: "WEB_VITALS",
    description: "Timing web vitals (LCP, INP, FCP, TTFB) by coarse route group.",
    labels: { vital: { values: ["LCP", "INP", "FCP", "TTFB"] }, route_group: { values: webRouteGroups } },
    buckets: [100, 200, 500, 800, 1_000, 1_800, 2_500, 3_000, 4_000, 6_000, 10_000],
  },
  kt_web_vital_cls: {
    kind: "histogram", unit: "1", phase: 1, indicator: "WEB_VITALS",
    description: "Cumulative layout shift by coarse route group.",
    labels: { route_group: { values: webRouteGroups } },
    buckets: [0.01, 0.05, 0.1, 0.15, 0.25, 0.5, 1],
  },
  kt_payment_recovery_total: {
    kind: "counter", unit: "1", phase: 2, indicator: "PAYMENT_VERIFICATION_FAILURES",
    description: "Pending online intents and refunds checked against the provider, by subject and outcome.",
    labels: { subject: { values: paymentRecoverySubjects }, outcome: { values: paymentRecoveryOutcomes } },
  },
  kt_notification_deliveries_total: {
    kind: "counter", unit: "1", phase: 2, indicator: "NOTIFICATION_DELIVERY",
    description: "Notification delivery attempts by channel, provider, recorded delivery state, and PII-free reason code.",
    labels: {
      channel: { values: notificationChannels },
      provider: { values: notificationProviders },
      outcome: { values: notificationDeliveryOutcomes },
      reason: CODE,
    },
  },
  kt_provider_callbacks_total: {
    kind: "counter", unit: "1", phase: 2, indicator: "PROVIDER_CALLBACKS",
    description: "Contract for Phase 2/3 provider callbacks by capability and verification outcome.",
    labels: {
      capability: { values: ["OTP", "ONLINE_PAYMENT", "MESSAGING", "TELEPHONY"] },
      outcome: { values: ["ACCEPTED", "DUPLICATE", "REJECTED_SIGNATURE", "REJECTED_PAYLOAD", "FAILED"] },
    },
  },
  kt_ivr_calls_total: {
    kind: "counter", unit: "1", phase: 3, indicator: "IVR_ABANDONMENT",
    description: "Contract for Phase 3 IVR calls by outcome and the prompt step where the call ended.",
    labels: { outcome: { values: ivrCallOutcomes }, last_step: { values: ivrPromptSteps } },
  },
  kt_product_analytics_events_total: {
    kind: "counter", unit: "1", phase: 4, indicator: "PRODUCT_ANALYTICS",
    description: "Privacy-reviewed product events by fixed event, coarse surface, and supported locale; no per-user labels.",
    labels: { event: { values: productAnalyticsEvents }, surface: { values: webRouteGroups }, locale: { values: LOCALES } },
  },
  kt_landing_3d_outcomes_total: {
    kind: "counter", unit: "1", phase: 4, indicator: "LANDING_3D_FALLBACK",
    description: "Contract for Phase 4 landing-page 3D load outcomes; anything but LOADED is a fallback.",
    labels: { outcome: { values: landing3dOutcomes } },
  },
} as const satisfies Readonly<Record<string, MetricDefinition>>;

type Definitions = typeof METRIC_DEFINITIONS;
export type MetricName = keyof Definitions;
type NamesOfKind<Kind extends MetricKind> = {
  [Name in MetricName]: Definitions[Name]["kind"] extends Kind ? Name : never;
}[MetricName];
export type CounterName = NamesOfKind<"counter">;
export type HistogramName = NamesOfKind<"histogram">;
export type GaugeName = NamesOfKind<"gauge">;
export type MetricLabels<Name extends MetricName> = {
  readonly [Label in keyof Definitions[Name]["labels"]]?: string;
};

export const metricNames = Object.freeze(Object.keys(METRIC_DEFINITIONS) as MetricName[]);

export function isMetricName(name: string): name is MetricName {
  return Object.hasOwn(METRIC_DEFINITIONS, name);
}

export function metricDefinition(name: MetricName): MetricDefinition {
  return METRIC_DEFINITIONS[name];
}

const IDENTIFIER_LIKE = /\d{3,}|[0-9a-f]{8}-[0-9a-f]{4}/iu;

const normalizeLabelValue = (spec: LabelSpec, value: string | undefined): string => {
  if (value === undefined) return UNKNOWN_LABEL_VALUE;
  if ("values" in spec) return spec.values.includes(value) ? value : OTHER_LABEL_VALUE;
  return value.length <= spec.maxLength && spec.pattern.test(value) && !IDENTIFIER_LIKE.test(value)
    ? value
    : OTHER_LABEL_VALUE;
};

/**
 * Normalizes labels to the metric's declared, bounded label set. Undeclared
 * labels are dropped and out-of-set values become `OTHER`, which keeps every
 * metric's series count fixed regardless of input.
 */
export function normalizeMetricLabels(
  name: MetricName,
  labels: Readonly<Record<string, string | undefined>> = {},
): Readonly<Record<string, string>> {
  const definition = metricDefinition(name);
  const normalized: Record<string, string> = {};
  for (const [label, spec] of Object.entries(definition.labels)) {
    normalized[label] = normalizeLabelValue(spec, labels[label]);
  }
  return Object.freeze(normalized);
}

/** Upper bound of distinct series for a metric, or undefined when a label is pattern-bounded. */
export function enumeratedSeriesBound(name: MetricName): number | undefined {
  let bound = 1;
  for (const spec of Object.values(metricDefinition(name).labels)) {
    if (!("values" in spec)) return undefined;
    bound *= spec.values.length + 2; // + OTHER and UNKNOWN
  }
  return bound;
}

export interface MetricsRecorder {
  increment<Name extends CounterName>(name: Name, labels?: MetricLabels<Name>, value?: number): void;
  observe<Name extends HistogramName>(name: Name, value: number, labels?: MetricLabels<Name>): void;
  setGauge<Name extends GaugeName>(name: Name, value: number, labels?: MetricLabels<Name>): void;
}

export interface CounterSample {
  readonly kind: "counter" | "gauge";
  readonly name: MetricName;
  readonly labels: Readonly<Record<string, string>>;
  readonly value: number;
}

export interface HistogramSample {
  readonly kind: "histogram";
  readonly name: MetricName;
  readonly labels: Readonly<Record<string, string>>;
  readonly count: number;
  readonly sum: number;
  /** Cumulative counts per upper bound, ending with `+Inf`. */
  readonly buckets: readonly Readonly<{ le: number | "+Inf"; count: number }>[];
}

export type MetricSample = CounterSample | HistogramSample;

interface HistogramState {
  count: number;
  sum: number;
  readonly bucketCounts: number[];
}

const seriesKey = (name: string, labels: Readonly<Record<string, string>>): string =>
  `${name}{${Object.entries(labels).map(([key, value]) => `${key}=${value}`).join(",")}}`;

const requireKind = (name: MetricName, kind: MetricKind): MetricDefinition => {
  const definition = metricDefinition(name);
  if (definition === undefined) throw new TypeError(`Metric ${String(name)} is not defined`);
  if (definition.kind !== kind) throw new TypeError(`Metric ${name} is a ${definition.kind}, not a ${kind}`);
  return definition;
};

/**
 * Process-local metric registry. It needs no telemetry backend; an exporter
 * (see `startMetricSnapshotExport`) or a test reads `snapshot()`. Memory is
 * bounded because every label set is normalized to the declared catalog.
 */
export class InMemoryMetrics implements MetricsRecorder {
  readonly #scalars = new Map<string, { name: MetricName; kind: "counter" | "gauge"; labels: Readonly<Record<string, string>>; value: number }>();
  readonly #histograms = new Map<string, { name: MetricName; labels: Readonly<Record<string, string>>; state: HistogramState }>();

  increment<Name extends CounterName>(name: Name, labels?: MetricLabels<Name>, value = 1): void {
    requireKind(name, "counter");
    if (!Number.isFinite(value) || value < 0) throw new RangeError("Counter increments must be finite and non-negative");
    const normalized = normalizeMetricLabels(name, labels as Readonly<Record<string, string | undefined>>);
    const key = seriesKey(name, normalized);
    const current = this.#scalars.get(key);
    if (current === undefined) this.#scalars.set(key, { name, kind: "counter", labels: normalized, value });
    else current.value += value;
  }

  setGauge<Name extends GaugeName>(name: Name, value: number, labels?: MetricLabels<Name>): void {
    requireKind(name, "gauge");
    if (!Number.isFinite(value)) throw new RangeError("Gauge values must be finite");
    const normalized = normalizeMetricLabels(name, labels as Readonly<Record<string, string | undefined>>);
    this.#scalars.set(seriesKey(name, normalized), { name, kind: "gauge", labels: normalized, value });
  }

  observe<Name extends HistogramName>(name: Name, value: number, labels?: MetricLabels<Name>): void {
    const definition = requireKind(name, "histogram");
    if (!Number.isFinite(value) || value < 0) return;
    const normalized = normalizeMetricLabels(name, labels as Readonly<Record<string, string | undefined>>);
    const key = seriesKey(name, normalized);
    const bounds = definition.buckets ?? [];
    const existing = this.#histograms.get(key);
    const series = existing ?? { name, labels: normalized, state: { count: 0, sum: 0, bucketCounts: bounds.map(() => 0) } };
    if (existing === undefined) this.#histograms.set(key, series);
    const { state } = series;
    state.count += 1;
    state.sum += value;
    bounds.forEach((bound, index) => {
      if (value <= bound) state.bucketCounts[index] = (state.bucketCounts[index] ?? 0) + 1;
    });
  }

  /** Current value of one counter or gauge series; zero when never recorded. */
  value<Name extends CounterName | GaugeName>(name: Name, labels?: MetricLabels<Name>): number {
    const normalized = normalizeMetricLabels(name, labels as Readonly<Record<string, string | undefined>>);
    return this.#scalars.get(seriesKey(name, normalized))?.value ?? 0;
  }

  /** Sum of a counter across every label combination. */
  total(name: CounterName): number {
    let sum = 0;
    for (const series of this.#scalars.values()) if (series.name === name) sum += series.value;
    return sum;
  }

  histogram<Name extends HistogramName>(name: Name, labels?: MetricLabels<Name>): Readonly<{ count: number; sum: number }> {
    const normalized = normalizeMetricLabels(name, labels as Readonly<Record<string, string | undefined>>);
    const state = this.#histograms.get(seriesKey(name, normalized))?.state;
    return Object.freeze({ count: state?.count ?? 0, sum: state?.sum ?? 0 });
  }

  snapshot(): readonly MetricSample[] {
    const scalars: MetricSample[] = [...this.#scalars.values()].map((series) => Object.freeze({
      kind: series.kind, name: series.name, labels: series.labels, value: series.value,
    }));
    const histograms: MetricSample[] = [...this.#histograms.values()].map((series) => {
      const bounds = metricDefinition(series.name).buckets ?? [];
      return Object.freeze({
        kind: "histogram" as const,
        name: series.name,
        labels: series.labels,
        count: series.state.count,
        sum: series.state.sum,
        buckets: Object.freeze([
          ...bounds.map((le, index) => Object.freeze({ le, count: series.state.bucketCounts[index] ?? 0 })),
          Object.freeze({ le: "+Inf" as const, count: series.state.count }),
        ]),
      });
    });
    return Object.freeze([...scalars, ...histograms]);
  }

  reset(): void {
    this.#scalars.clear();
    this.#histograms.clear();
  }
}

/** Discards every measurement; used when telemetry is disabled. */
export const noopMetrics: MetricsRecorder = Object.freeze({
  increment: () => undefined,
  observe: () => undefined,
  setGauge: () => undefined,
});
