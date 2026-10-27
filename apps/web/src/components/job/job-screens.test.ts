import { translate } from "@kisantractor/i18n";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  jobActionKeys,
  normalizeJobInvoice,
  normalizeJobSession,
  readJobRetryState,
} from "../../lib/job-tracking";
import { FarmerJobPanel, OwnerJobPanel } from "./job-screens";

const hourlyInvoice = {
  id: "invoice-1", bookingId: "booking-1", invoiceVersion: 1, status: "ISSUED",
  agreementId: "agreement-1", agreementVersion: 2, method: "HOURLY", ratePaise: 80_000, currency: "INR",
  billableQuantity: "1.5", billableUnit: "HOUR", subtotalPaise: 120_000, adjustmentsPaise: 0, totalPaise: 120_000,
  evidenceReferences: ["work_event:e1", "work_event:e2", "work_event:e3", "work_event:e4"],
  formula: "total_paise = round_half_up(80000 paise/hour × 5400000 billable ms ÷ 3600000 ms/hour)",
  roundingTrace: {
    method: "HOURLY", roundingPolicy: "PROPORTIONAL_MINUTE", activeMilliseconds: 5_400_000,
    billableMilliseconds: 5_400_000, rawSubtotalNumerator: "432000000000", rawSubtotalDenominator: "3600000",
    minorUnitRounding: "HALF_UP_ONCE_AT_FINAL_PAISE", roundedSubtotalPaise: 120_000, billableQuantityDisplayRounded: false,
  },
  providerPayload: { secret: "never-render" },
  createdAt: "2026-03-01T10:00:00.000Z",
};

const apiSession = (overrides: Record<string, unknown> = {}) => ({
  bookingId: "booking-1",
  bookingStatus: "IN_PROGRESS",
  bookingVersion: 4,
  pricingMethod: "HOURLY",
  state: "ACTIVE",
  validNextActions: ["PAUSE", "COMPLETE"],
  events: [
    { id: "e1", bookingId: "booking-1", eventType: "START", effectiveAt: "2026-03-01T08:00:00.000Z", receivedAt: "2026-03-01T08:00:00.000Z",
      deviceObservedAt: "2026-03-01T07:59:30.000Z", actorId: "owner-user-secret", actorChannel: "WEB" },
  ],
  measurements: [],
  activeIntervals: [],
  activeMilliseconds: 1_800_000,
  activeMinutes: 30,
  openStartedAt: "2026-03-01T08:00:00.000Z",
  ...overrides,
});

const keys = { START: "start-key-0001", PAUSE: "pause-key-0001", RESUME: "resume-key-001", COMPLETE: "complete-key-1" } as const;

/** Validates: Requirements 9.1, 9.7, 10.6, 12.2 */
describe("job session projection", () => {
  it("allowlists work evidence and invoice fields and drops actor identifiers and provider data", () => {
    const session = normalizeJobSession(apiSession({ invoice: hourlyInvoice, bookingStatus: "FINAL_BILL_GENERATED" }))!;
    expect(session.events[0]).toMatchObject({ eventType: "START", deviceObservedAt: new Date("2026-03-01T07:59:30.000Z") });
    expect(session.invoice).toMatchObject({ totalPaise: 120_000, evidenceCount: 4, roundingPolicy: "PROPORTIONAL_MINUTE" });
    const serialized = JSON.stringify(session);
    expect(serialized).not.toContain("owner-user-secret");
    expect(serialized).not.toContain("never-render");
    expect(serialized).not.toContain("work_event:e1");
  });

  it("rejects invoices that cannot reproduce their total or misstate their unit", () => {
    expect(normalizeJobInvoice({ ...hourlyInvoice, totalPaise: 120_001 })).toBeUndefined();
    expect(normalizeJobInvoice({ ...hourlyInvoice, billableUnit: "ACRE" })).toBeUndefined();
    expect(normalizeJobSession(apiSession({ invoice: { ...hourlyInvoice, totalPaise: -1 } }))).toBeUndefined();
  });
});

/** Validates: Requirements 3.5, 17.4 */
describe("job action retry keys", () => {
  it("reuses the failed attempt's key only for an unknown outcome", () => {
    let counter = 0;
    const create = () => `fresh-key-${++counter}`;
    const offline = readJobRetryState({ jobError: "offline", retryAction: "PAUSE", retryKey: "pause-key-0001" });
    expect(jobActionKeys(offline, create)).toMatchObject({ START: "fresh-key-1", PAUSE: "pause-key-0001", COMPLETE: "fresh-key-3" });

    const sequence = readJobRetryState({ jobError: "sequence", retryAction: "PAUSE", retryKey: "pause-key-0001" });
    expect(sequence).toEqual({ feedback: "sequence" });
    expect(readJobRetryState({ jobError: "failed", retryAction: "PAUSE", retryKey: "<script>" })).toEqual({ feedback: "failed" });
  });
});

/** Validates: Requirements 9.1, 9.5, 10.6, 13.2, 13.4, 13.7 */
describe("Owner job controls, completion, and invoice preview", () => {
  it("renders only valid next actions with stable keys and an accessible completion quantity", () => {
    const session = normalizeJobSession(apiSession({ pricingMethod: "PER_ACRE" }))!;
    const markup = renderToStaticMarkup(createElement(OwnerJobPanel, { actionKeys: keys, bookingId: "booking-1", locale: "en", session }));

    expect(markup).toContain('action="/api/owner/bookings/booking-1/job/pause"');
    expect(markup).toContain('value="pause-key-0001"');
    expect(markup).toContain('action="/api/owner/bookings/booking-1/job/complete"');
    expect(markup).toContain('value="complete-key-1"');
    expect(markup).not.toContain("/job/start");
    expect(markup).not.toContain("/job/resume");
    expect(markup).toMatch(/<label[^>]*for="completedAcres"/u);
    expect(markup).toMatch(/name="completedQuantity"[^>]*required|required[^>]*name="completedQuantity"/u);
    expect(markup).toContain("Valid next actions:</strong> Pause work, Complete work");
    expect(markup).toContain("The final bill is not ready yet.");
  });

  it("previews the reproducible bill and announces an out-of-sequence rejection", () => {
    const session = normalizeJobSession(apiSession({
      bookingStatus: "FINAL_BILL_GENERATED", state: "COMPLETED", validNextActions: [], invoice: hourlyInvoice, openStartedAt: undefined,
    }))!;
    const markup = renderToStaticMarkup(createElement(OwnerJobPanel, {
      actionKeys: keys, bookingId: "booking-1", feedback: "sequence", locale: "en", session,
    }));

    expect(markup).toContain('role="alert"');
    expect(markup).toContain("That action does not match the job");
    expect(markup).toContain("₹800 per hour × 1.5 hours = ₹1,200");
    expect(markup).toContain("Charge proportional to each active minute");
    expect(markup).toContain("90 minutes");
    expect(markup).toContain("Work records used: 4");
    expect(markup).not.toContain("<form");
  });
});

/** Validates: Requirements 17.3, 17.4 */
describe("job screens under unreliable connectivity", () => {
  it("labels the bill with when it was checked and keeps every job control a same-key native form", () => {
    const billed = normalizeJobSession(apiSession({
      bookingStatus: "FINAL_BILL_GENERATED", state: "COMPLETED", validNextActions: [], invoice: hourlyInvoice, openStartedAt: undefined,
    }))!;
    const checkedAt = new Date("2026-03-01T10:05:00.000Z");
    for (const markup of [
      renderToStaticMarkup(createElement(OwnerJobPanel, { actionKeys: keys, bookingId: "booking-1", checkedAt, locale: "en", session: billed })),
      renderToStaticMarkup(createElement(FarmerJobPanel, { bookingId: "booking-1", checkedAt, locale: "en", session: billed })),
    ]) {
      expect(markup).toContain('data-freshness="FRESH"');
      expect(markup).toContain("Bill checked at");
    }

    const active = normalizeJobSession(apiSession())!;
    const controls = renderToStaticMarkup(createElement(OwnerJobPanel, { actionKeys: keys, bookingId: "booking-1", locale: "en", session: active }));
    expect(controls.match(/method="post"/gu)?.length).toBe(2);
    expect(controls).toMatch(/<form[^>]*action="[^"]*\/job\/pause"[^>]*method="post"><input[^>]*name="idempotencyKey"[^>]*value="pause-key-0001"/u);
  });
});

/** Validates: Requirements 9.7, 10.6, 10.8, 13.2, 13.7 */
describe("Farmer active job, final bill, review, and dispute", () => {
  it("shows the bill with its evidence and a reasoned dispute form tied to the booking version", () => {
    const session = normalizeJobSession(apiSession({
      bookingStatus: "FINAL_BILL_GENERATED", bookingVersion: 7, state: "COMPLETED", validNextActions: [], openStartedAt: undefined,
      events: [
        ...apiSession().events as unknown[],
        { id: "e2", eventType: "COMPLETE", effectiveAt: "2026-03-01T09:30:00.000Z", receivedAt: "2026-03-01T09:30:00.000Z" },
        { id: "e3", eventType: "CORRECTION", effectiveAt: "2026-03-01T09:20:00.000Z", receivedAt: "2026-03-01T11:00:00.000Z",
          correctionOfId: "e2", reason: "Owner pressed complete late" },
      ],
      invoice: { ...hourlyInvoice, invoiceVersion: 2, supersedesInvoiceId: "invoice-0" },
    }))!;
    const markup = renderToStaticMarkup(createElement(FarmerJobPanel, { bookingId: "booking-1", locale: "en", session }));

    expect(markup).toContain("Time corrected");
    expect(markup).toContain("Owner pressed complete late");
    expect(markup).toContain("This bill replaces an earlier version");
    expect(markup).toContain('action="/api/farmer/bookings/booking-1/dispute"');
    expect(markup).toMatch(/<input[^>]*type="hidden"[^>]*name="expectedVersion"[^>]*value="7"/u);
    expect(markup).toMatch(/<label[^>]*for="disputeReason"/u);
    expect(markup).toContain("Dispute this bill");
  });

  it("locks the review once disputed and explains that settlement is blocked", () => {
    const session = normalizeJobSession(apiSession({
      bookingStatus: "DISPUTED", state: "COMPLETED", validNextActions: [], openStartedAt: undefined,
      invoice: { ...hourlyInvoice, status: "DISPUTED" },
    }))!;
    const markup = renderToStaticMarkup(createElement(FarmerJobPanel, { bookingId: "booking-1", feedback: "disputed", locale: "hi", session }));

    expect(markup).not.toContain("/dispute\"");
    expect(markup).toContain(translate("hi", "bill.disputedHelp"));
    expect(markup).toContain('role="status"');
    expect(markup).not.toMatch(/\b(job|bill)\.[a-z]+\.[A-Za-z]+\b/u);
  });
});
