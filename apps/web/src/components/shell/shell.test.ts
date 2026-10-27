import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppShell } from "./app-shell";
import { CapabilityUnavailable } from "./surfaces";

vi.mock("next/navigation", () => ({ usePathname: () => "/farmer" }));

const render = (component: Parameters<typeof renderToStaticMarkup>[0]) =>
  renderToStaticMarkup(component);

/** Validates: Requirements 3.1, 5.1, 13.2, 17.1 */
describe("responsive role shells", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders all five Farmer destinations with accessible navigation", () => {
    const markup = render(createElement(AppShell, { locale: "en", role: "FARMER", children: "Farmer content" }));
    expect(markup).toContain('aria-label="Farmer navigation"');
    for (const destination of ["Home", "Search tractors", "Bookings", "Help", "Account"]) {
      expect(markup).toContain(destination);
    }
    expect(markup).toContain('href="#main-content"');
    expect(markup).toContain('id="main-content"');
  });

  it("renders Owner destinations without exposing Farmer search", () => {
    const markup = render(createElement(AppShell, { locale: "en", role: "OWNER", children: "Owner content" }));
    for (const destination of ["Dashboard", "My tractors", "Bookings", "Earnings", "Account"]) {
      expect(markup).toContain(destination);
    }
    expect(markup).not.toContain("Search tractors");
  });

  it("localizes shell navigation and keeps icon labels visible", () => {
    const markup = render(createElement(AppShell, { locale: "hi", role: "FARMER", children: "सामग्री" }));
    expect(markup).toContain('aria-label="किसान नेविगेशन"');
    expect(markup).toContain("ट्रैक्टर खोजें");
    expect(markup).toContain("भाषा चुनें");
    expect(markup).toContain('aria-hidden="true"');
  });
});

/** Validates: Requirement 14.2 */
describe("capability honesty surface", () => {
  it("explains an unconfigured provider and offers no live action", () => {
    const markup = render(createElement(CapabilityUnavailable, {
      capabilityName: "OTP",
      locale: "en",
      presentation: {
        state: "UNCONFIGURED",
        canRetry: false,
      },
    }));
    expect(markup).toContain("Service unavailable");
    expect(markup).toContain("no external action was performed");
    expect(markup).not.toContain("<button");
  });
});
