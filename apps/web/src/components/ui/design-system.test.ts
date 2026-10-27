import { readFileSync } from "node:fs";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { Dialog } from "./dialog";
import { Navigation } from "./navigation";
import { Button, Card, CheckboxField, SelectField, StatusChip, Switch, TextArea, TextInput } from "./primitives";
import { EmptyState, ErrorState } from "./states";
import { Stepper } from "./stepper";

const render = (component: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(component);

describe("accessible design-system primitives", () => {
  it("keeps button icons decorative while retaining visible text", () => {
    const markup = render(createElement(Button, {
      children: "Search tractors",
      icon: "⌕",
      variant: "primary",
    }));

    expect(markup).toContain("Search tractors");
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain("kt-button--primary");
  });

  it("renders cards with semantic headings, content, and actions", () => {
    const markup = render(createElement(Card, {
      title: "Mahindra 575 DI",
      eyebrow: "2.5 km estimated",
      actions: createElement(Button, null, "Book now"),
      children: createElement("p", null, "₹500 per hour"),
    }));

    expect(markup).toContain("<article");
    expect(markup).toContain("<h2");
    expect(markup).toContain("Book now");
  });

  it("links field labels, hints, and simple validation errors", () => {
    const input = render(createElement(TextInput, {
      id: "village",
      label: "Village",
      hint: "Enter the service village",
      error: "Village is required",
    }));
    const select = render(createElement(SelectField, {
      id: "work",
      label: "Farming work",
      options: [{ label: "Ploughing", value: "ploughing" }],
    }));
    const textarea = render(createElement(TextArea, { id: "directions", label: "Directions" }));

    expect(input).toContain('for="village"');
    expect(input).toContain('aria-describedby="village-hint village-error"');
    expect(input).toContain('aria-invalid="true"');
    expect(input).toContain('role="alert"');
    expect(select).toContain('<option value="ploughing">Ploughing</option>');
    expect(textarea).toContain('<textarea');
  });

  it("communicates every status with a symbol and visible label", () => {
    for (const tone of ["success", "warning", "danger", "neutral", "info"] as const) {
      const markup = render(createElement(StatusChip, {
        children: `${tone} status`,
        tone,
      }));
      expect(markup).toContain(`${tone} status`);
      expect(markup).toContain('aria-hidden="true"');
      expect(markup).toContain(`kt-status--${tone}`);
    }
  });

  it("renders named navigation with visible icon labels and current page state", () => {
    const markup = render(createElement(Navigation, {
      label: "Farmer navigation",
      variant: "bottom",
      items: [
        { href: "/farmer", icon: "⌂", label: "Home", current: true },
        { href: "/farmer/search", icon: "⌕", label: "Search Tractors" },
        { href: "/farmer/bookings", icon: "▣", label: "Bookings" },
        { href: "/help", icon: "?", label: "Help" },
        { href: "/account", icon: "○", label: "Account" },
      ],
    }));

    expect(markup).toContain('aria-label="Farmer navigation"');
    expect(markup).toContain('aria-current="page"');
    for (const label of ["Home", "Search Tractors", "Bookings", "Help", "Account"]) {
      expect(markup).toContain(label);
    }
  });

  it("announces the current step and exposes text for each step state", () => {
    const markup = render(createElement(Stepper, {
      label: "Booking progress",
      steps: [
        { id: "location", label: "Location", state: "complete", statusLabel: "Completed" },
        { id: "schedule", label: "Schedule", state: "current", statusLabel: "Current step" },
        { id: "review", label: "Review", state: "upcoming", statusLabel: "Not started" },
      ],
    }));

    expect(markup).toContain('aria-current="step"');
    expect(markup).toContain("Completed");
    expect(markup).toContain("Current step");
    expect(markup).toContain("Not started");
  });

  it("gives dialogs an accessible name, description, and labeled close control", () => {
    const markup = render(createElement(Dialog, {
      open: true,
      title: "Confirm booking",
      description: "Review before submitting.",
      closeLabel: "Close dialog",
      onClose: vi.fn(),
      children: createElement("p", null, "Booking details"),
    }));

    expect(markup).toContain("<dialog");
    expect(markup).toContain("aria-labelledby=");
    expect(markup).toContain("aria-describedby=");
    expect(markup).toContain('aria-label="Close dialog"');
  });

  it("provides meaningful empty and alert error states with recovery", () => {
    const emptyMarkup = render(createElement(EmptyState, {
      title: "No tractors found",
      message: "Try a wider search area.",
      action: createElement(Button, null, "Expand area"),
    }));
    const errorMarkup = render(createElement(ErrorState, {
      title: "Could not load bookings",
      message: "Check your connection and try again.",
      reference: "KT-123",
      retryLabel: "Try again",
      onRetry: vi.fn(),
    }));

    expect(emptyMarkup).toContain("No tractors found");
    expect(emptyMarkup).toContain("Expand area");
    expect(errorMarkup).toContain('role="alert"');
    expect(errorMarkup).toContain("Try again");
    expect(errorMarkup).toContain("KT-123");
  });
});

describe("visual token accessibility safeguards", () => {
  const css = readFileSync(new URL("../../app/globals.css", import.meta.url), "utf8");

  it("defines the green and cream visual identity and script-aware font fallbacks", () => {
    expect(css).toContain("--kt-color-primary: #006b3a");
    expect(css).toContain("--kt-color-surface: #fffdf7");
    for (const family of ["Noto Sans Telugu", "Noto Sans Devanagari", "Noto Sans Kannada", "Noto Sans Tamil"]) {
      expect(css).toContain(family);
    }
  });

  it("enforces minimum targets, visible focus, responsive flow, and reduced motion", () => {
    expect(css).toContain("--kt-target-min: 2.75rem");
    expect(css).toMatch(/:focus-visible\s*\{[^}]*outline:/s);
    expect(css).toContain("overflow-wrap: anywhere");
    expect(css).toContain("@media (max-width: 30rem)");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain("transition-duration: 0.01ms !important");
  });
});


describe("keyboard-operable choice controls", () => {
  it("uses a native checkbox with a visible label and linked hint", () => {
    const markup = render(createElement(CheckboxField, {
      id: "consent",
      label: "Use my location",
      hint: "Only for finding nearby tractors",
    }));

    expect(markup).toContain('type="checkbox"');
    expect(markup).toContain('for="consent"');
    expect(markup).toContain('aria-describedby="consent-hint"');
  });

  it("uses native button keyboard behavior and announces switch state", () => {
    const markup = render(createElement(Switch, {
      checked: true,
      label: "Tractor availability",
      checkedLabel: "Online",
      uncheckedLabel: "Offline",
      onCheckedChange: vi.fn(),
    }));

    expect(markup).toContain('role="switch"');
    expect(markup).toContain('aria-checked="true"');
    expect(markup).toContain("Tractor availability");
    expect(markup).toContain("Online");
  });
});
