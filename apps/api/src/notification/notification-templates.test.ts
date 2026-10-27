import { createLocalization, defaultCatalogs } from "@kisantractor/i18n";
import { describe, expect, it } from "vitest";

import { defaultNotificationRules } from "./notification-rules.js";
import {
  contactTemplateKeys,
  NotificationTemplateError,
  NotificationTemplateRenderer,
  notificationTemplateKeys,
  notificationTemplates,
  type NotificationTemplateVariables,
} from "./notification-templates.js";

const renderer = new NotificationTemplateRenderer();

/** Validates: Requirements 13.3, 17.6 */
describe("localized notification template contracts", () => {
  it("defines an English catalog entry for every template used by a notification rule", () => {
    const used = new Set(Object.values(defaultNotificationRules).flatMap((rules) => rules.map((rule) => rule.templateKey)));
    for (const key of used) expect(notificationTemplateKeys).toContain(key);
    for (const key of notificationTemplateKeys) {
      expect(defaultCatalogs.en[key]?.trim().length ?? 0).toBeGreaterThan(0);
      const variables: NotificationTemplateVariables = contactTemplateKeys.has(key)
        ? { reference: "KT-ABCDEF123456", ownerPhone: "+919876543210" }
        : { reference: "KT-ABCDEF123456" };
      const rendered = renderer.render(key, "en", variables);
      expect(rendered.body).toContain("KT-ABCDEF123456");
      expect(rendered.body).not.toMatch(/\{\w+\}/u);
      expect(rendered.templateVersion).toBe(notificationTemplates[key].version);
      expect(rendered.variables).toEqual(variables);
    }
  });

  it("declares a version and only the booking reference, except for the SMS-only Owner contact template", () => {
    expect([...contactTemplateKeys]).toEqual(["notification.booking.ownerContact"]);
    for (const key of notificationTemplateKeys) {
      expect(Number.isSafeInteger(notificationTemplates[key].version) && notificationTemplates[key].version > 0, key).toBe(true);
      expect(notificationTemplates[key].variables, key).toEqual(contactTemplateKeys.has(key) ? ["reference", "ownerPhone"] : ["reference"]);
    }
    // Every Owner-contact rule is SMS-only, Farmer-only, and gated by the sharing policy.
    for (const rule of Object.values(defaultNotificationRules).flat().filter((candidate) => contactTemplateKeys.has(candidate.templateKey))) {
      expect(rule).toMatchObject({ audience: ["CUSTOMER"], channels: ["SMS"], requires: "OWNER_CONTACT" });
    }
    // A phone is refused in any other template and must be E.164 in the contact template.
    expect(() => renderer.render("notification.booking.ownerContact", "en", { reference: "KT-1", ownerPhone: "98765 43210" }))
      .toThrow(/VARIABLE_INVALID/u);
  });

  it("covers online receipts and refunds from the payment outbox events", () => {
    expect(defaultNotificationRules.OnlinePaymentConfirmed?.map((rule) => [rule.templateKey, rule.audience, rule.relatedEntity])).toEqual([
      ["notification.payment.onlineConfirmed", ["CUSTOMER"], "Payment"],
      ["notification.payment.onlineReceived", ["OWNER"], "Payment"],
    ]);
    for (const [eventType, templateKey] of [
      ["OnlinePaymentFailed", "notification.payment.onlineFailed"],
      ["OnlinePaymentReleased", "notification.payment.onlineReleased"],
      ["PaymentRefundRequested", "notification.refund.requested"],
      ["PaymentRefundProcessed", "notification.refund.processed"],
      ["PaymentRefundFailed", "notification.refund.failed"],
    ] as const) {
      expect(defaultNotificationRules[eventType], eventType).toEqual([{ templateKey, audience: ["CUSTOMER"], relatedEntity: "Payment" }]);
    }
  });

  it("notifies the Owner of a dispute and both parties of its resolution", () => {
    expect(defaultNotificationRules.BookingDisputed).toEqual([{ templateKey: "notification.dispute.opened", audience: ["OWNER"] }]);
    expect(defaultNotificationRules.DisputeResolved).toEqual([{ templateKey: "notification.dispute.resolved", audience: ["CUSTOMER", "OWNER"] }]);
    for (const locale of ["hi", "te", "kn", "ta"] as const) {
      expect(renderer.render("notification.dispute.resolved", locale, { reference: "KT-7" }).locale).toBe(locale);
    }
  });

  it("falls back to English and records English as the template locale", () => {
    const { "notification.booking.accepted": _removed, ...tamilWithoutTemplate } = defaultCatalogs.ta;
    const fallback = new NotificationTemplateRenderer(createLocalization({ catalogs: { ta: tamilWithoutTemplate } }));
    expect(fallback.templateLocale("notification.booking.accepted", "ta")).toBe("en");
    expect(fallback.templateLocale("notification.booking.accepted", "gu-IN")).toBe("en");
    expect(fallback.render("notification.booking.accepted", "ta", { reference: "KT-1" })).toEqual({
      templateKey: "notification.booking.accepted",
      templateVersion: 1,
      locale: "en",
      body: "KisanTractor: Your booking KT-1 was accepted by the Owner.",
      variables: { reference: "KT-1" },
    });
  });

  it("uses a regional template when the catalog provides one", () => {
    const localized = new NotificationTemplateRenderer(createLocalization({
      catalogs: { hi: { ...defaultCatalogs.hi, "notification.bill.ready": "KisanTractor: बुकिंग {reference} का अंतिम बिल तैयार है।" } },
    }));
    expect(localized.render("notification.bill.ready", "hi-IN", { reference: "KT-9" })).toEqual({
      templateKey: "notification.bill.ready",
      templateVersion: 1,
      locale: "hi",
      body: "KisanTractor: बुकिंग KT-9 का अंतिम बिल तैयार है।",
      variables: { reference: "KT-9" },
    });
  });

  it("refuses undeclared, missing, or PII-shaped variables", () => {
    const render = (variables: Record<string, string>) => () =>
      renderer.render("notification.booking.accepted", "en", variables as unknown as NotificationTemplateVariables);
    expect(render({})).toThrow(NotificationTemplateError);
    expect(render({ reference: "KT-1", phone: "+919876543210" })).toThrow(/VARIABLES_MISMATCH/u);
    expect(render({ reference: "9876543210" })).toThrow(/VARIABLE_INVALID/u);
    expect(render({ reference: "ravi@example.com" })).toThrow(/VARIABLE_INVALID/u);
    expect(render({ reference: "Ravi Kumar" })).toThrow(/VARIABLE_INVALID/u);
  });

  it("refuses to start when an English template entry is missing", () => {
    const { "notification.booking.expired": _removed, ...withoutExpired } = defaultCatalogs.en;
    expect(() => new NotificationTemplateRenderer(createLocalization({ catalogs: { en: withoutExpired } })))
      .toThrow(/MISSING_ENGLISH_ENTRY/u);
  });
});
