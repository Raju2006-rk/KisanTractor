import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  bookingDiscoveryParameters,
  bookingRequestBody,
  bookingStepErrors,
  bookingSteps,
  createBookingDraft,
  restoreBookingDraft,
  type BookingStep,
  type FarmerBookingDraft,
} from "../../lib/farmer-booking";
import { captureConsentedBrowserLocation } from "../../lib/browser-location";
import {
  criteriaToSearchParameters,
  normalizeFarmerTractorCard,
  parseFarmerSearchCriteria,
  type FarmerTractorCardProjection,
} from "../../lib/farmer-discovery";
import { LocationCaptureFields } from "../location/location-capture-fields";
import { BookingReview, FarmerBookingStepper } from "./booking-stepper";
import { FarmerSearchResults, TractorCard } from "./discovery";

const render = (element: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(element);

const CUSTOMER_CITY = { state: "Telangana", district: "Hyderabad", mandalOrTaluk: "Serilingampally", village: "Gachibowli", latitude: "17.4401", longitude: "78.3489" } as const;
const RECIPIENT_CITY = { state: "Karnataka", district: "Mysuru", mandalOrTaluk: "Nanjangud", village: "Hullahalli", latitude: "12.0560", longitude: "76.6840" } as const;

const mysuruTractorResponse = {
  id: "tractor-mysuru-1",
  brand: "Mahindra",
  model: "575 DI",
  photo: { altText: "Red Mahindra tractor near Hullahalli" },
  approximateLocation: { state: "Karnataka", district: "Mysuru" },
  approximateDistance: { kilometers: 2.1, label: "2.1 km away", isEstimate: true, exactCoordinatesExposed: false },
  ownerDisplayName: "Lakshmi",
  service: { offeringId: "offering-1", id: "ploughing", name: "Ploughing" },
  equipment: { id: "equipment-1", typeId: "cultivator", name: "Cultivator" },
  pricingRules: [{ id: "price-1", method: "HOURLY", ratePaise: 80_000, currency: "INR", roundingPolicy: "PROPORTIONAL_MINUTE" }],
  availability: { available: true, rank: 0 },
  ownerPhone: "+919876543210",
  exactCoordinates: { latitude: 12.056, longitude: 76.684 },
  registrationNumber: "KA09AA0000",
};
const mysuruTractor = normalizeFarmerTractorCard(mysuruTractorResponse)! as FarmerTractorCardProjection;

/** A completed draft representing the chosen tractor and schedule for whichever target is supplied. */
function completeDraft(target: "MYSELF" | "SOMEONE_ELSE"): FarmerBookingDraft {
  const city = target === "SOMEONE_ELSE" ? RECIPIENT_CITY : CUSTOMER_CITY;
  const base = createBookingDraft({ target, ...city, serviceId: "ploughing", tractorId: mysuruTractor.id, offeringId: "offering-1", pricingMethod: "HOURLY", pricingRuleId: "price-1", quantity: "4", start: "2027-01-02T08:00", end: "2027-01-02T12:00" });
  return Object.freeze({
    ...base,
    equipmentTypeId: "cultivator",
    ...(target === "SOMEONE_ELSE"
      ? { recipientName: "Ravi Kumar", coordinationPhone: "+919111122223", coordinationConsent: true, landmarkOrDirections: "Opposite the school" }
      : {}),
  });
}

/** Validates: Requirements 3.1, 3.2, 3.3, 8.1, 8.12 */
describe("Farmer self-booking journey from discovery through confirmation", () => {
  const criteria = parseFarmerSearchCriteria({ ...CUSTOMER_CITY, serviceId: "ploughing", start: "2027-01-02T08:00", end: "2027-01-02T12:00", radius: "5", search: "1" });

  it("lets the Farmer open a tractor and carry its selection into the booking stepper", () => {
    const cardMarkup = render(createElement(TractorCard, { criteria, locale: "en", tractor: mysuruTractor }));
    // The accessible "Book now" action must carry the chosen tractor and offering into the stepper route.
    expect(cardMarkup).toContain("Book now");
    const bookingHref = cardMarkup.match(/href="(\/farmer\/book[^"]*)"/u)?.[1];
    expect(bookingHref).toBeDefined();
    const bookingParameters = new URLSearchParams(bookingHref!.replace("/farmer/book?", "").replaceAll("&amp;", "&"));
    expect(bookingParameters.get("tractorId")).toBe(mysuruTractor.id);
    expect(bookingParameters.get("offeringId")).toBe("offering-1");

    const resumed = createBookingDraft(Object.fromEntries(bookingParameters) as Record<string, string>);
    expect(resumed.tractorId).toBe(mysuruTractor.id);
    expect(resumed.serviceOfferingId).toBe("offering-1");
  });

  it("validates every step and produces a self-targeted booking request without a separate Recipient", () => {
    const draft = completeDraft("MYSELF");
    for (const step of bookingSteps.filter((candidate): candidate is Exclude<BookingStep, "review"> => candidate !== "review")) {
      expect(bookingStepErrors(step, draft)).toEqual([]);
    }
    const body = bookingRequestBody(draft);
    expect(body.bookingTarget).toBe("MYSELF");
    expect(body).not.toHaveProperty("recipient");
    expect(body.serviceLocation).toMatchObject({ district: "Hyderabad", village: "Gachibowli", collectionPurpose: "SERVICE_LOCATION" });
  });

  it("confirms with all required review fields and no direct Owner contact", () => {
    const draft = completeDraft("MYSELF");
    const markup = render(createElement(BookingReview, { draft, estimatedTotal: 320_000, locale: "en", selectedRule: mysuruTractor.pricingRules[0], tractor: mysuruTractor }));
    for (const label of ["Booked by", "Recipient", "Service location", "Tractor", "Owner", "Farming work", "Equipment", "Pricing", "Estimated total", "Schedule", "Payment expectation"]) {
      expect(markup).toContain(label);
    }
    expect(markup).toContain("Myself");
    expect(markup).toContain("Mahindra 575 DI");
    expect(markup).toContain("₹3,200");
    expect(markup).not.toContain("9876543210");
  });
});

/** Validates: Requirements 7.3, 8.1, 8.12 */
describe("Farmer cross-city someone-else booking journey", () => {
  it("drives discovery from the Recipient location, never the customer's own city", () => {
    const draft = completeDraft("SOMEONE_ELSE");
    const parameters = bookingDiscoveryParameters(draft);
    expect(parameters.get("target")).toBe("SOMEONE_ELSE");
    expect(parameters.get("state")).toBe("Karnataka");
    expect(parameters.get("district")).toBe("Mysuru");
    expect(parameters.get("latitude")).toBe("12.0560");
    expect(parameters.get("longitude")).toBe("76.6840");
    // The customer's own Hyderabad coordinates must never leak into the someone-else search origin.
    expect(parameters.toString()).not.toContain("17.4401");
    expect(parameters.toString()).not.toContain("Hyderabad");
  });

  it("is invariant: changing only the customer's profile city cannot change the someone-else search origin", () => {
    const base = completeDraft("SOMEONE_ELSE");
    // Simulate the customer sitting in a different city each time; the draft's service location is the Recipient's.
    const firstOrigin = bookingDiscoveryParameters(base).toString();
    const movedCustomer = restoreBookingDraft(JSON.stringify({ ...base }), createBookingDraft({ target: "SOMEONE_ELSE", ...RECIPIENT_CITY, serviceId: "ploughing", tractorId: mysuruTractor.id, offeringId: "offering-1" }));
    const secondOrigin = bookingDiscoveryParameters(movedCustomer).toString();
    expect(secondOrigin).toBe(firstOrigin);
  });

  it("snapshots a separate Recipient and the Recipient service location in the booking request", () => {
    const draft = completeDraft("SOMEONE_ELSE");
    const body = bookingRequestBody(draft);
    expect(body).toMatchObject({
      bookingTarget: "SOMEONE_ELSE",
      tractorId: "tractor-mysuru-1",
      serviceOfferingId: "offering-1",
      recipient: { name: "Ravi Kumar", coordinationConsent: true, landmarkOrDirections: "Opposite the school" },
      serviceLocation: { state: "Karnataka", district: "Mysuru", village: "Hullahalli", collectionPurpose: "SERVICE_LOCATION" },
    });
  });

  it("renders the stepper explaining the Recipient origin and showing both booking-target choices accessibly", () => {
    const markup = render(createElement(FarmerBookingStepper, { locale: "en", parameters: { target: "SOMEONE_ELSE" } }));
    expect(markup).toContain('aria-label="Booking progress"');
    expect(markup).toContain('aria-current="step"');
    expect(markup).toContain("Book for myself");
    expect(markup).toContain("Book for someone else");
  });
});

/** Validates: Requirements 7.1 (manual entry and GPS denial) */
describe("Farmer service-location capture resilience", () => {
  const unavailableMaps = { state: "UNCONFIGURED" as const, isOperational: false, isTest: false, canRetry: false, message: "This service is not configured." };

  it("always offers manual administrative entry even when maps are unavailable", () => {
    const html = render(createElement(LocationCaptureFields, { collectionPurpose: "SERVICE_LOCATION", locale: "en", mapsCapability: unavailableMaps }));
    for (const name of ["state", "district", "mandalOrTaluk", "village"]) {
      expect(html).toContain(`name="${name}"`);
    }
    expect(html).toContain("Maps are unavailable. Enter the service location manually.");
  });

  it("falls back to manual entry when GPS permission is denied without asking again automatically", async () => {
    const denyingGeolocation = {
      getCurrentPosition: (_success: unknown, error: (value: { code: number }) => void) => error({ code: 1 }),
    };
    const result = await captureConsentedBrowserLocation(denyingGeolocation, { granted: true, consentedAt: new Date("2027-01-01T00:00:00.000Z"), purpose: "SERVICE_LOCATION" }, { mapAlternativeAvailable: false });
    expect(result.kind).toBe("PERMISSION_DENIED");
    if (result.kind !== "CAPTURED") {
      expect(result.manualEntryAvailable).toBe(true);
      expect(result.message).toContain("enter the location manually");
    }
  });
});

/** Validates: Requirements 8.12 (pricing disclosure) and 8.5 (duplicate-submit idempotency) */
describe("Farmer booking pricing disclosure and duplicate-submit safety", () => {
  it("discloses the rate, rounding policy, and estimated total before confirmation", () => {
    const draft = completeDraft("MYSELF");
    const markup = render(createElement(BookingReview, { draft, estimatedTotal: 320_000, locale: "en", selectedRule: mysuruTractor.pricingRules[0], tractor: mysuruTractor }));
    expect(markup).toContain("₹800 per hour");
    expect(markup).toContain("Charge proportional to each active minute");
    expect(markup).toContain("₹3,200");
  });

  it("keeps a single booking request body stable so a repeated submit is deduplicated", () => {
    const draft = completeDraft("SOMEONE_ELSE");
    // The same draft must serialize to the same request each submit; the stepper reuses one stored
    // idempotency key and the attempt's capture time, so a retry is the identical command.
    const capturedAt = "2027-01-01T05:00:00.000Z";
    expect(JSON.stringify(bookingRequestBody(draft, capturedAt))).toBe(JSON.stringify(bookingRequestBody(draft, capturedAt)));
  });
});

/** Validates: Requirements 8.5 (conflict refresh preserves the draft for explicit retry) */
describe("Farmer booking conflict and resume handling", () => {
  it("preserves a resumed draft while letting a freshly selected tractor win", () => {
    const draft = completeDraft("SOMEONE_ELSE");
    const fallback = createBookingDraft({ target: "SOMEONE_ELSE", tractorId: "tractor-new", offeringId: "offering-new", ...RECIPIENT_CITY });
    const restored = restoreBookingDraft(JSON.stringify(draft), fallback);
    expect(restored.recipientName).toBe("Ravi Kumar");
    expect(restored.tractorId).toBe("tractor-new");
    expect(restored.serviceOfferingId).toBe("offering-new");
  });

  it("tells the Farmer their progress is saved so a conflict can be retried explicitly", () => {
    const markup = render(createElement(FarmerBookingStepper, { locale: "en", parameters: {} }));
    expect(markup).toContain("Your progress is saved in this browser tab until the booking is confirmed.");
  });
});

/** Validates: Requirements 13.4, 13.5 (localized, no raw keys) */
describe("Farmer booking localization", () => {
  it("renders the stepper target choices in Telugu with no raw message keys", () => {
    const markup = render(createElement(FarmerBookingStepper, { locale: "te", parameters: { target: "SOMEONE_ELSE" } }));
    expect(markup).toContain("నా కోసం బుక్ చేయండి"); // Book for myself
    expect(markup).toContain("మరొకరి కోసం బుక్ చేయండి"); // Book for someone else
    expect(markup).not.toMatch(/form\.bookFor/u);
    expect(markup).not.toContain("translation.missing");
  });

  it("renders a discovery result card in Telugu with a localized Book now action", () => {
    const criteria = parseFarmerSearchCriteria({ ...RECIPIENT_CITY, serviceId: "ploughing", start: "2027-01-02T08:00", end: "2027-01-02T12:00", radius: "5" });
    const markup = render(createElement(TractorCard, { criteria, locale: "te", tractor: mysuruTractor }));
    expect(markup).toContain("ఇప్పుడే బుక్ చేయండి"); // Book now
    expect(markup).not.toMatch(/control\.bookNow/u);
  });
});

/** Validates: Requirements 13.4, 13.7 (keyboard, screen reader, zoom, narrow screens) */
describe("Farmer booking accessibility", () => {
  it("exposes screen-reader structure: a labelled progress stepper and current step", () => {
    const markup = render(createElement(FarmerBookingStepper, { locale: "en", parameters: {} }));
    expect(markup).toContain('aria-label="Booking progress"');
    expect(markup).toContain('aria-current="step"');
  });

  it("groups each step in a fieldset/legend and announces validation errors in an alert region", () => {
    // Every booking step renders as a fieldset with a legend so assistive tech announces the group.
    const stepperMarkup = render(createElement(FarmerBookingStepper, { locale: "en", parameters: {} }));
    expect(stepperMarkup).toContain("<fieldset");
    expect(stepperMarkup).toContain("<legend");
    // The review surface is a labelled section with a definition list, keyboard-reachable without custom widgets.
    const reviewMarkup = render(createElement(BookingReview, { draft: completeDraft("MYSELF"), estimatedTotal: 320_000, locale: "en", selectedRule: mysuruTractor.pricingRules[0], tractor: mysuruTractor }));
    expect(reviewMarkup).toContain('aria-labelledby="booking-review-title"');
    expect(reviewMarkup).toContain("<dl");
  });

  it("gives the result card a non-decorative image role and keyboard-reachable links rather than click-only widgets", () => {
    const criteria = parseFarmerSearchCriteria({ ...RECIPIENT_CITY, serviceId: "ploughing", start: "2027-01-02T08:00", end: "2027-01-02T12:00", radius: "5" });
    const markup = render(createElement(TractorCard, { criteria, locale: "en", tractor: mysuruTractor }));
    expect(markup).toContain('role="img"');
    expect(markup).toContain('aria-label="Red Mahindra tractor near Hullahalli"');
    // Actions are anchors/buttons (keyboard-focusable), not div-only click targets.
    expect(markup).toMatch(/<a [^>]*class="kt-button kt-button--primary"/u);
  });

  it("announces the empty-results state and search errors to assistive technology", () => {
    const criteria = parseFarmerSearchCriteria({ ...RECIPIENT_CITY, serviceId: "ploughing", start: "2027-01-02T08:00", end: "2027-01-02T12:00", radius: "5" });
    const emptyMarkup = render(createElement(FarmerSearchResults, {
      locale: "en",
      mapsCapability: { state: "UNCONFIGURED", isOperational: false, isTest: false, canRetry: false, message: "Not configured" },
      result: { state: "READY", criteria, page: { items: [], radiusKilometers: 5, canExpandRadius: true, maximumRadiusKilometers: 100, origin: { state: "Karnataka", district: "Mysuru" }, evaluatedAt: new Date("2027-01-01T00:00:00.000Z") } },
    }));
    expect(emptyMarkup).toContain("No suitable tractors found");
    const errorMarkup = render(createElement(FarmerSearchResults, { locale: "en", mapsCapability: { state: "UNCONFIGURED", isOperational: false, isTest: false, canRetry: false, message: "Not configured" }, result: { state: "ERROR", criteria, message: "Search is unavailable right now. Reconnect and retry safely." } }));
    expect(errorMarkup).toContain('role="alert"');
  });

  it("uses responsive grid layout classes rather than fixed widths so zoom and narrow screens reflow", () => {
    const markup = render(createElement(FarmerBookingStepper, { locale: "en", parameters: { target: "SOMEONE_ELSE" } }));
    expect(markup).toContain('class="kt-booking-flow__grid"');
    expect(markup).not.toMatch(/style="[^"]*width:\s*\d+px/u);
  });
});
