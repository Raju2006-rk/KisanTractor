import { catalogLocales, translate } from "@kisantractor/i18n";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { AppShell } from "../shell/app-shell";
import { AuthoritativeActionForm } from "./authoritative-action-form";
import { DataFreshness } from "./data-freshness";
import { freshnessText } from "./freshness-indicator";
import { authoritativeActionMessages, freshnessMessages } from "./messages";

vi.mock("next/navigation", () => ({ usePathname: () => "/farmer" }));

const checkedAt = new Date("2027-01-01T05:00:00.000Z");

/** Validates: Requirements 17.3 */
describe("freshness indicator", () => {
  it("names when availability, quotes, bills, and payments were checked in every locale", () => {
    for (const locale of catalogLocales) {
      for (const kind of ["availability", "quote", "invoice", "payment"] as const) {
        const messages = freshnessMessages(locale, kind, checkedAt);
        for (const text of [messages.fresh, messages.stale, messages.offline, messages.refresh]) {
          expect(text.trim().length).toBeGreaterThan(0);
          expect(text).not.toMatch(/\{time\}|freshness\./u);
        }
        expect(messages.stale).not.toBe(messages.fresh);
      }
      expect(freshnessMessages(locale, "payment", checkedAt).pending).toBeDefined();
    }
    expect(translate("hi", "freshness.refresh")).toBe("रीफ़्रेश करें");
  });

  it("chooses the copy for each state and falls back to the fresh copy for pending", () => {
    const messages = freshnessMessages("en", "availability", checkedAt);
    expect(freshnessText("STALE", messages)).toContain("may have changed");
    expect(freshnessText("OFFLINE", messages)).toContain("You are offline");
    expect(freshnessText("PENDING", messages)).toBe(messages.fresh);
  });

  it("renders as a polite status with server time, and shows refresh for pending payments", () => {
    const markup = renderToStaticMarkup(createElement(DataFreshness, { checkedAt, kind: "availability", locale: "en" }));
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('data-freshness="FRESH"');
    expect(markup).toContain("Availability checked at");
    expect(markup).toContain("reserved only when the Owner accepts");
    expect(markup).not.toContain("<button");

    const pending = renderToStaticMarkup(createElement(DataFreshness, { checkedAt, kind: "payment", locale: "ta", pending: true }));
    expect(pending).toContain('data-freshness="PENDING"');
    expect(pending).toContain("காத்திருக்கிறது");
    expect(pending).toContain(">புதுப்பிக்கவும்<");
  });
});

/** Validates: Requirements 17.4 */
describe("authoritative action form", () => {
  it("renders a native post form carrying the stable idempotency key with no pending notice", () => {
    const markup = renderToStaticMarkup(createElement(AuthoritativeActionForm, {
      action: "/api/owner/bookings/b-1/job/start",
      actionId: "job:b-1:start",
      children: createElement("button", { type: "submit" }, "Start work"),
      family: "job:b-1",
      idempotencyKey: "start-key-0001",
      messages: authoritativeActionMessages("en", "Start work"),
    }));
    expect(markup).toContain('action="/api/owner/bookings/b-1/job/start"');
    expect(markup).toContain('method="post"');
    expect(markup).toMatch(/name="idempotencyKey"[^>]*value="start-key-0001"/u);
    expect(markup).not.toContain('role="alert"');
  });

  it("explains offline and unknown outcomes in every locale without promising a background send", () => {
    for (const locale of catalogLocales) {
      const messages = authoritativeActionMessages(locale, "X-ACTION");
      expect(messages.offlineBlocked).toContain("X-ACTION");
      expect(messages.unknownOutcome).toContain("X-ACTION");
      expect(messages.draftRestored.trim().length).toBeGreaterThan(0);
    }
    const english = authoritativeActionMessages("en", "Record cash");
    expect(english.offlineBlocked).toContain("nothing was sent and nothing is waiting to be sent");
    expect(english.unknownOutcome).toContain("Nothing was resent automatically");
    expect(english.unknownOutcome).toContain("cannot be recorded twice");
  });
});

/** Validates: Requirements 17.3, 17.4 */
describe("connectivity banner", () => {
  it("is an empty polite live region in every role shell until connectivity changes", () => {
    for (const role of ["PUBLIC", "FARMER", "OWNER"] as const) {
      const markup = renderToStaticMarkup(createElement(AppShell, { locale: "kn", role, children: "content" }));
      expect(markup).toMatch(/<div aria-live="polite" class="kt-connectivity kt-connectivity--online" role="status"><\/div>/u);
    }
    expect(translate("en", "connectivity.online")).toContain("Nothing was sent automatically");
  });
});
