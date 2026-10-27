import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { SeriesStore, evaluateAlert, parseDuration, parseExpression, type AlertState } from "./alert-evaluation.js";
import { OperationalIndicators } from "./indicators.js";
import { InMemoryMetrics } from "./metrics.js";
import { createTelemetry } from "./telemetry.js";

/**
 * Alert rules fire on their threshold conditions and stay quiet below them (Requirements 12.7,
 * 18.2). Each scenario drives the real `OperationalIndicators` emitters into the real metric
 * registry, scrapes it once a minute the way a collector would, and evaluates the rule from
 * `ops/observability/alerts` with its `for` duration.
 */
interface AlertRule {
  readonly id: string;
  readonly expr: string;
  readonly for: string;
  readonly phase: number;
  readonly enabled?: boolean;
}

const alertsDirectory = new URL("../../../ops/observability/alerts/", import.meta.url);
const rules: readonly AlertRule[] = readdirSync(alertsDirectory)
  .filter((name) => name.endsWith(".json"))
  .flatMap((name) => (JSON.parse(readFileSync(new URL(name, alertsDirectory), "utf8")) as { rules: AlertRule[] }).rules);
const enabledRules = rules.filter((rule) => rule.enabled !== false);

interface Scenario {
  readonly minutes: number;
  readonly each: (indicators: OperationalIndicators, minute: number) => void;
  /** False models a process that stopped exporting metrics (for example a crashed worker). */
  readonly exporting?: (minute: number) => boolean;
}

interface RuleScenarios {
  readonly firing: Scenario;
  readonly quiet: readonly Scenario[];
}

const times = (count: number, action: () => void): void => {
  for (let index = 0; index < count; index += 1) action();
};
const every = (period: number, minute: number): boolean => minute % period === 0;

const http = (i: OperationalIndicators, method: string, status: number, durationMs: number, count = 1) =>
  times(count, () => i.httpRequestCompleted(method, method === "GET" ? "/farmer/bookings" : "/farmer/bookings/:bookingId/dispute", status, durationMs));
const funnel = (i: OperationalIndicators, eventType: string) => i.outboxEventResolved(eventType, "PUBLISHED");
type Delivery = Parameters<OperationalIndicators["notificationDeliveryRecorded"]>[2];
const sms = (i: OperationalIndicators, outcome: Delivery, count: number, reason?: string, provider = "msg91") =>
  times(count, () => i.notificationDeliveryRecorded("SMS", provider, outcome, reason));
const push = (i: OperationalIndicators, outcome: Delivery, count: number, reason?: string) =>
  times(count, () => i.notificationDeliveryRecorded("PUSH", "fcm", outcome, reason));
const lcp = (i: OperationalIndicators, rating: "good" | "poor", count: number) =>
  times(count, () => i.webVitalReported({ vital: "LCP", value: rating === "good" ? 1_800 : 5_000, rating, routeGroup: "farmer" }));

const SCENARIOS: Readonly<Record<string, RuleScenarios>> = {
  ApiErrorRateHigh: {
    firing: { minutes: 30, each: (i) => { http(i, "GET", 200, 80, 27); http(i, "POST", 503, 80, 3); } },
    quiet: [
      { minutes: 30, each: (i, m) => { http(i, "GET", 200, 80, 30); if (every(10, m)) http(i, "POST", 500, 80); } },
      // A high error ratio on almost no traffic is below the volume floor.
      { minutes: 30, each: (i) => http(i, "POST", 500, 80, 2) },
    ],
  },
  ApiReadLatencyP95High: {
    firing: { minutes: 40, each: (i) => { http(i, "GET", 200, 80, 90); http(i, "GET", 200, 2_000, 10); } },
    quiet: [{ minutes: 40, each: (i) => { http(i, "GET", 200, 80, 100); http(i, "POST", 200, 3_000, 20); } }],
  },
  ApiWriteLatencyP95High: {
    firing: { minutes: 40, each: (i) => { http(i, "POST", 201, 120, 90); http(i, "POST", 201, 3_000, 10); } },
    quiet: [{ minutes: 40, each: (i) => { http(i, "POST", 201, 300, 100); http(i, "GET", 200, 4_000, 50); } }],
  },
  OtpThrottleSpike: {
    firing: { minutes: 30, each: (i) => { times(6, () => i.otpRequested("ISSUED")); times(4, () => i.otpRequested("THROTTLED")); } },
    quiet: [
      { minutes: 30, each: (i) => { times(9, () => i.otpRequested("ISSUED")); i.otpRequested("THROTTLED"); } },
      { minutes: 30, each: (i, m) => { if (every(2, m)) i.otpRequested("THROTTLED"); } },
    ],
  },
  OtpVerificationFailureRateHigh: {
    firing: { minutes: 40, each: (i) => { times(3, () => i.otpVerified()); times(7, () => i.otpVerificationRejected("INVALID_CODE")); } },
    quiet: [{ minutes: 40, each: (i) => { times(7, () => i.otpVerified()); times(3, () => i.otpVerificationRejected("INVALID_CODE")); } }],
  },
  OtpDeliveryFailing: {
    firing: { minutes: 30, each: (i) => { times(5, () => i.otpRequested("ISSUED")); i.otpRequested("DELIVERY_FAILED"); } },
    quiet: [{ minutes: 30, each: (i, m) => { times(5, () => i.otpRequested("ISSUED")); if (every(6, m)) i.otpRequested("DELIVERY_FAILED"); } }],
  },
  ZeroResultDiscoveryHigh: {
    firing: { minutes: 150, each: (i) => { times(2, () => i.discoverySearched(3, "HOURLY")); times(3, () => i.discoverySearched(0, "HOURLY")); } },
    quiet: [
      { minutes: 150, each: (i) => { times(4, () => i.discoverySearched(3, undefined)); i.discoverySearched(0, undefined); } },
      { minutes: 150, each: (i, m) => { if (every(5, m)) i.discoverySearched(0, "PER_ACRE"); } },
    ],
  },
  BookingAcceptanceConversionLow: {
    firing: { minutes: 480, each: (i, m) => { if (every(5, m)) funnel(i, "BookingRequested"); if (every(60, m)) funnel(i, "BookingAccepted"); } },
    quiet: [
      { minutes: 480, each: (i, m) => { if (every(5, m)) funnel(i, "BookingRequested"); if (every(10, m)) funnel(i, "BookingAccepted"); } },
      { minutes: 480, each: (i, m) => { if (every(30, m)) funnel(i, "BookingRequested"); } },
    ],
  },
  AcceptanceConflictsElevated: {
    firing: { minutes: 45, each: (i) => i.acceptanceConflict("OVERLAP") },
    quiet: [{ minutes: 45, each: (i, m) => { if (every(5, m)) i.acceptanceConflict("VERSION_CONFLICT"); } }],
  },
  InvalidTransitionsElevated: {
    firing: { minutes: 45, each: (i) => times(2, () => i.invalidTransition("BOOKING", "DISPUTE")) },
    // 15 per aggregate in 30 minutes: quiet, although the two together exceed the threshold.
    quiet: [{ minutes: 45, each: (i, m) => { if (every(2, m)) { i.invalidTransition("BOOKING", "CANCEL"); i.invalidTransition("WORK", "PAUSE"); } } }],
  },
  InvoiceDisputeRateHigh: {
    firing: { minutes: 26 * 60, each: (i, m) => { if (every(30, m)) funnel(i, "BookingFinalBillGenerated"); if (every(120, m)) funnel(i, "BookingDisputed"); } },
    quiet: [{ minutes: 26 * 60, each: (i, m) => { if (every(30, m)) funnel(i, "BookingFinalBillGenerated"); if (m > 0 && every(720, m)) funnel(i, "BookingDisputed"); } }],
  },
  PaymentIntegrityFailure: {
    // One inconsistency is enough to page.
    firing: { minutes: 30, each: (i, m) => { if (m === 25) i.paymentVerificationFailed("CASH", "PAYMENT_LEDGER_INCONSISTENT"); } },
    quiet: [{ minutes: 30, each: (i) => times(3, () => i.paymentVerificationFailed("CASH", "PAYMENT_OVERPAYMENT")) }],
  },
  PaymentVerificationFailuresElevated: {
    firing: { minutes: 90, each: (i) => i.paymentVerificationFailed("CASH", "PAYMENT_OVERPAYMENT") },
    quiet: [{ minutes: 90, each: (i, m) => { if (every(5, m)) i.paymentVerificationFailed("CASH", "PAYMENT_INVALID_AMOUNT"); } }],
  },
  PaymentRefundFailed: {
    // One failed refund needs support's attention.
    firing: { minutes: 30, each: (i, m) => { if (m === 25) i.paymentRecovery("REFUND", "REFUND_FAILED"); } },
    quiet: [{ minutes: 30, each: (i) => { i.paymentRecovery("REFUND", "REFUNDED"); i.paymentRecovery("INTENT", "RELEASED"); } }],
  },
  PaymentReconciliationErrors: {
    firing: { minutes: 60, each: (i) => i.paymentRecovery("INTENT", "PROVIDER_ERROR") },
    quiet: [{ minutes: 60, each: (i, m) => { i.paymentRecovery("INTENT", "STILL_PENDING"); if (every(10, m)) i.paymentRecovery("REFUND", "PROVIDER_ERROR"); } }],
  },
  OutboxLagHigh: {
    firing: { minutes: 25, each: (i, m) => i.outboxBacklogSampled({ dueEvents: 40, oldestDueAgeMs: 360_000 + m * 60_000, deadLetterEvents: 0 }) },
    quiet: [{ minutes: 25, each: (i) => i.outboxBacklogSampled({ dueEvents: 3, oldestDueAgeMs: 2_000, deadLetterEvents: 0 }) }],
  },
  OutboxWorkerSilent: {
    firing: { minutes: 40, each: (i) => i.outboxBacklogSampled({ dueEvents: 0, oldestDueAgeMs: 0, deadLetterEvents: 0 }), exporting: (m) => m < 10 },
    quiet: [{ minutes: 40, each: (i) => i.outboxBacklogSampled({ dueEvents: 0, oldestDueAgeMs: 0, deadLetterEvents: 0 }) }],
  },
  OutboxDeadLetters: {
    firing: { minutes: 40, each: (i, m) => i.outboxBacklogSampled({ dueEvents: 0, oldestDueAgeMs: 0, deadLetterEvents: m >= 5 ? 2 : 0 }) },
    // A dead letter requeued within ten minutes never reaches the 15-minute hold.
    quiet: [{ minutes: 40, each: (i, m) => i.outboxBacklogSampled({ dueEvents: 0, oldestDueAgeMs: 0, deadLetterEvents: m >= 20 && m < 30 ? 1 : 0 }) }],
  },
  OutboxPollFailing: {
    firing: { minutes: 30, each: (i) => i.outboxPollFailed() },
    quiet: [{ minutes: 30, each: (i, m) => { if (every(5, m)) i.outboxPollFailed(); } }],
  },
  NotificationDeliveryFailing: {
    firing: { minutes: 45, each: (i) => { sms(i, "SENT", 6); sms(i, "FAILED", 3, "PROVIDER_UNAVAILABLE"); } },
    quiet: [
      { minutes: 45, each: (i) => { sms(i, "SENT", 18); sms(i, "FAILED", 1, "PROVIDER_THROTTLED"); push(i, "SENT", 5); } },
      // A DEGRADED rollback contacts no provider; operators chose it, so it does not page.
      { minutes: 45, each: (i) => { sms(i, "SENT", 2); sms(i, "FAILED", 8, "CAPABILITY_DEGRADED"); } },
      // Failures on almost no traffic stay below the volume floor.
      { minutes: 45, each: (i, m) => { if (every(30, m)) sms(i, "FAILED", 1, "PROVIDER_TIMEOUT"); } },
      // In-app delivery and unconfigured channels are not provider failures.
      { minutes: 45, each: (i) => { i.notificationDeliveryRecorded("IN_APP", "in_app", "DELIVERED", undefined); sms(i, "NOT_SENT", 4, "CHANNEL_UNCONFIGURED", "none"); } },
    ],
  },
  SmsTemplateNotRegistered: {
    // One unregistered template means every message of that kind is silently missing.
    firing: { minutes: 30, each: (i, m) => { sms(i, "SENT", 3); if (m === 25) sms(i, "NOT_SENT", 1, "SMS_TEMPLATE_NOT_REGISTERED"); } },
    quiet: [{ minutes: 30, each: (i) => { sms(i, "SENT", 3); sms(i, "NOT_SENT", 1, "RECIPIENT_UNREACHABLE"); } }],
  },
  TranslationMissesElevated: {
    firing: { minutes: 150, each: (i) => times(2, () => i.translationMissed("te", "MISSING_LOCALE_ENTRY", "WEB")) },
    quiet: [{
      minutes: 150,
      each: (i, m) => {
        times(2, () => i.translationMissed("en", "UNSUPPORTED_LOCALE", "API"));
        if (every(2, m)) { i.translationMissed("te", "MISSING_LOCALE_ENTRY", "WEB"); i.translationMissed("hi", "MISSING_LOCALE_ENTRY", "WEB"); }
      },
    }],
  },
  WebVitalsPoor: {
    firing: { minutes: 200, each: (i) => { lcp(i, "good", 2); lcp(i, "poor", 1); } },
    quiet: [{ minutes: 200, each: (i) => { lcp(i, "good", 9); lcp(i, "poor", 1); } }],
  },
};

function simulate(scenario: Scenario, baselines = true): SeriesStore {
  const telemetry = baselines ? createTelemetry({ service: "api", sink: () => undefined }) : undefined;
  const metrics = telemetry?.metrics ?? new InMemoryMetrics();
  const indicators = telemetry?.indicators ?? new OperationalIndicators(metrics);
  const store = new SeriesStore();
  for (let minute = 0; minute <= scenario.minutes; minute += 1) {
    scenario.each(indicators, minute);
    if (scenario.exporting?.(minute) ?? true) store.scrape(minute * 60_000, metrics.snapshot());
  }
  return store;
}

/** States over the last `for` + 20 minutes of the scenario, evaluated once a minute. */
function states(rule: AlertRule, scenario: Scenario, baselines = true): AlertState[] {
  const end = scenario.minutes * 60_000;
  const start = Math.max(0, end - parseDuration(rule.for) - 20 * 60_000);
  return evaluateAlert(simulate(scenario, baselines), rule, start, end).map(({ state }) => state);
}

const rule = (id: string): AlertRule => {
  const found = rules.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`No alert rule ${id}`);
  return found;
};

/** Validates: Requirements 12.7, 18.2 */
describe("operational alert rules", () => {
  it("are all expressible in the evaluated PromQL subset, including disabled later-phase rules", () => {
    for (const { id, expr, for: hold } of rules) {
      expect(() => parseExpression(expr), id).not.toThrow();
      expect(() => parseDuration(hold), id).not.toThrow();
    }
  });

  it("have a firing and a quiet scenario for every enabled rule, and none for disabled ones", () => {
    expect(Object.keys(SCENARIOS).sort()).toEqual(enabledRules.map(({ id }) => id).sort());
    for (const disabled of rules.filter((candidate) => candidate.enabled === false)) expect(disabled.phase).toBeGreaterThanOrEqual(3);
  });

  for (const enabled of enabledRules) {
    it(`${enabled.id} fires on its threshold condition and stays quiet below it`, () => {
      const scenarios = SCENARIOS[enabled.id]!;
      expect(states(enabled, scenarios.firing).at(-1), `${enabled.id} firing scenario`).toBe("FIRING");
      for (const [index, quiet] of scenarios.quiet.entries()) {
        expect(states(enabled, quiet), `${enabled.id} quiet scenario ${index}`).not.toContain("FIRING");
      }
    });
  }

  it("fires only after the condition has held for the rule's `for` duration", () => {
    const apiErrors = rule("ApiErrorRateHigh");
    const scenario: Scenario = { minutes: 40, each: (i, m) => { http(i, "GET", 200, 80, 27); if (m >= 20) http(i, "POST", 503, 80, 3); } };
    const timeline = evaluateAlert(simulate(scenario), apiErrors, 0, scenario.minutes * 60_000);
    const pending = timeline.find(({ state }) => state !== "INACTIVE")!.timeMs;
    const firing = timeline.find(({ state }) => state === "FIRING")!.timeMs;
    expect(pending).toBeGreaterThanOrEqual(20 * 60_000);
    expect(firing - pending).toBe(parseDuration(apiErrors.for));
  });

  it("needs zero baselines to see the first payment-integrity failure after a deploy", () => {
    const integrity = rule("PaymentIntegrityFailure");
    const scenario = SCENARIOS.PaymentIntegrityFailure!.firing;
    // Without a zero sample, the counter's first value is 1 and increase() has nothing to compare it with.
    expect(states(integrity, scenario, false)).not.toContain("FIRING");
    expect(states(integrity, scenario, true)).toContain("FIRING");
  });
});
