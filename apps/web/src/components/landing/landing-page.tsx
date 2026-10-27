import { e164PhoneNumberPattern } from "@kisantractor/config";
import {
  catalogLocales,
  localeMetadata,
  translate,
  type CatalogLocale,
  type MessageKey,
} from "@kisantractor/i18n";

import type { ReactNode } from "react";

import { StatusChip, type StatusTone } from "../ui";
import { heroSceneSlot } from "./landing-enhancement";
import { LandingSceneCapabilityGate } from "./landing-scene-capability-gate";

type CapabilityState = "UNCONFIGURED" | "SANDBOX" | "LIVE" | "DEGRADED";

/** Client-safe telephony fields read from the public capability projection. */
export type PhoneBookingCapability = Readonly<{
  state: CapabilityState;
  isLive: boolean;
}>;

/** A validated dedicated booking number, ready for a `tel:` link and for display. */
export interface BookingNumber {
  readonly e164: string;
  readonly display: string;
}

export interface PhoneBookingPresentation {
  readonly available: boolean;
  /** The state public copy describes. LIVE without a usable number reads as UNCONFIGURED. */
  readonly displayState: CapabilityState;
  readonly tone: StatusTone;
  readonly labelKey: MessageKey;
  readonly messageKey: MessageKey;
  /** Present only when phone booking is available. */
  readonly bookingNumber: BookingNumber | null;
}

/**
 * Accepts only an E.164 number from server configuration. Indian mobile-style
 * numbers are grouped for reading; anything else is shown exactly as configured.
 */
export function parseBookingNumber(value: string | null | undefined): BookingNumber | null {
  if (typeof value !== "string" || !e164PhoneNumberPattern.test(value)) return null;
  const indian = /^\+91(\d{5})(\d{5})$/.exec(value);
  return { e164: value, display: indian ? `+91 ${indian[1]} ${indian[2]}` : value };
}

/**
 * Maps the telephony capability to public copy. Phone booking reads as available
 * only for a LIVE projection that is flagged live and has a valid configured
 * number; that number is the only one any state can carry. Every other case
 * points people to online booking, and SANDBOX is labeled as a test.
 */
export function phoneBookingPresentation(
  capability: PhoneBookingCapability,
  configuredNumber?: string | null,
): PhoneBookingPresentation {
  const bookingNumber = capability.state === "LIVE" && capability.isLive ? parseBookingNumber(configuredNumber) : null;
  if (bookingNumber) {
    return { available: true, displayState: "LIVE", tone: "success", labelKey: "landing.phone.live.label", messageKey: "landing.phone.live.message", bookingNumber };
  }
  if (capability.state === "SANDBOX") {
    return { available: false, displayState: "SANDBOX", tone: "info", labelKey: "landing.phone.sandbox.label", messageKey: "landing.phone.sandbox.message", bookingNumber: null };
  }
  if (capability.state === "DEGRADED") {
    return { available: false, displayState: "DEGRADED", tone: "danger", labelKey: "landing.phone.degraded.label", messageKey: "landing.phone.degraded.message", bookingNumber: null };
  }
  return { available: false, displayState: "UNCONFIGURED", tone: "warning", labelKey: "landing.phone.unconfigured.label", messageKey: "landing.phone.unconfigured.message", bookingNumber: null };
}

/** Farmer booking starts at search; the Farmer route gate sends signed-out visitors to login. */
export const farmerBookingHref = "/farmer/search";
/** Owner registration runs through the OTP flow with the Owner registration purpose. */
export const ownerRegistrationHref = "/login?role=owner";

interface LandingImage {
  readonly base: string;
  readonly widths: readonly [number, number];
  readonly width: number;
  readonly height: number;
  readonly sizes: string;
}

/**
 * Photographic crops of the supplied design showcase, encoded as AVIF with a
 * WebP fallback. Intrinsic width/height reserve layout space to avoid CLS.
 */
export const landingImages = {
  hero: {
    base: "/images/landing/hero-farmer-tractor",
    widths: [320, 640],
    width: 640,
    height: 346,
    sizes: "(min-width: 56rem) 34rem, 100vw",
  },
  owner: {
    base: "/images/landing/farmer-mobile-phone",
    widths: [240, 480],
    width: 480,
    height: 500,
    sizes: "(min-width: 56rem) 28rem, 100vw",
  },
} as const satisfies Record<string, LandingImage>;

/** Under data saver only the smallest committed crop is offered; the image itself stays. */
function imageWidths(image: LandingImage, dataSaver: boolean): readonly number[] {
  return dataSaver ? [image.widths[0]] : image.widths;
}

function srcSet(image: LandingImage, format: "avif" | "webp", dataSaver: boolean) {
  return imageWidths(image, dataSaver).map((width) => `${image.base}-${width}.${format} ${width}w`).join(", ");
}

function LandingPicture({ image, alt, className, dataSaver, priority = false }: {
  readonly image: LandingImage;
  readonly alt: string;
  readonly className: string;
  readonly dataSaver: boolean;
  readonly priority?: boolean;
}) {
  const fallbackWidth = dataSaver ? image.widths[0] : image.widths[1];
  return (
    <picture className={className}>
      <source sizes={image.sizes} srcSet={srcSet(image, "avif", dataSaver)} type="image/avif" />
      <source sizes={image.sizes} srcSet={srcSet(image, "webp", dataSaver)} type="image/webp" />
      <img
        alt={alt}
        decoding="async"
        fetchPriority={priority ? "high" : "auto"}
        height={image.height}
        loading={priority ? "eager" : "lazy"}
        sizes={image.sizes}
        src={`${image.base}-${fallbackWidth}.webp`}
        srcSet={srcSet(image, "webp", dataSaver)}
        width={image.width}
      />
    </picture>
  );
}

/**
 * Phone-booking status, explanation, and the one action that applies: a call
 * link to the configured number when available, otherwise online booking.
 */
export function PhoneBookingDetails({ locale, presentation, children }: {
  readonly locale: CatalogLocale;
  readonly presentation: PhoneBookingPresentation;
  /** Extra actions placed after the primary one. */
  readonly children?: ReactNode;
}) {
  const t = (key: MessageKey) => translate(locale, key);
  const number = presentation.bookingNumber;
  return (
    <>
      <StatusChip tone={presentation.tone}>{t(presentation.labelKey)}</StatusChip>
      <p>{t(presentation.messageKey)}</p>
      <div className="kt-landing-actions">
        {number ? (
          <a className="kt-button kt-button--primary" href={`tel:${number.e164}`}>
            {t("landing.phone.callAction")} <span dir="ltr">{number.display}</span>
          </a>
        ) : (
          <a className="kt-button kt-button--primary" href={farmerBookingHref}>
            {t("landing.cta.bookTractor")}
          </a>
        )}
        {children}
      </div>
    </>
  );
}

/** Display order for the language section: regional languages first, English last. */
export const landingLanguageOrder = [
  ...catalogLocales.filter((language) => language !== "en"),
  "en",
] as const satisfies readonly CatalogLocale[];

const steps = ["step1", "step2", "step3", "step4"] as const;
const services = [
  ["ploughing", "≡"],
  ["rotavator", "◎"],
  ["sowing", "⁘"],
  ["harvesting", "✂"],
  ["transport", "▭"],
  ["levelling", "▬"],
] as const;
const ownerBenefits = ["benefit1", "benefit2", "benefit3", "benefit4"] as const;
const pricingMethods = [
  ["form.hourly", "landing.pricing.hourly.body"],
  ["form.perAcre", "landing.pricing.perAcre.body"],
  ["form.perTrip", "landing.pricing.perTrip.body"],
] as const;

function RoleActions({ locale, inverse = false }: { readonly locale: CatalogLocale; readonly inverse?: boolean }) {
  return (
    <div className={`kt-landing-actions${inverse ? " kt-landing-actions--inverse" : ""}`}>
      <a className="kt-button kt-button--primary" href={farmerBookingHref}>
        {translate(locale, "landing.cta.bookTractor")}
      </a>
      <a className="kt-button kt-button--secondary" href={ownerRegistrationHref}>
        {translate(locale, "landing.cta.registerOwner")}
      </a>
    </div>
  );
}

export interface LandingPageProps {
  readonly locale: CatalogLocale;
  readonly telephony: PhoneBookingCapability;
  /** The dedicated number from validated server configuration; never a literal. */
  readonly bookingNumber?: string | null | undefined;
  /** The visitor asked for reduced data (`Save-Data: on`). */
  readonly dataSaver?: boolean;
}

/**
 * The complete Phase 1 landing page as server-rendered HTML with plain links.
 * It needs no script, canvas, or 3D; optional enhancements may only add to the
 * hero scene slot.
 */
export function LandingPage({ locale, telephony, bookingNumber = null, dataSaver = false }: LandingPageProps) {
  const t = (key: MessageKey) => translate(locale, key);
  const phone = phoneBookingPresentation(telephony, bookingNumber);

  return (
    <div className="kt-landing">
      <section aria-labelledby="landing-hero-title" className="kt-landing-hero" id="hero">
        <div className="kt-landing-hero__copy">
          <p className="kt-landing__eyebrow">{t("landing.hero.eyebrow")}</p>
          <h1 id="landing-hero-title">{t("landing.hero.title")}</h1>
          <p className="kt-landing__lead">{t("landing.hero.lead")}</p>
          <RoleActions inverse locale={locale} />
        </div>
        {/* Static poster. A Phase 4 scene may enhance this slot but never replaces the copy or links. */}
        <div
          className="kt-landing-hero__media"
          data-enhancement-slot={heroSceneSlot}
          data-static-only={dataSaver ? "true" : undefined}
        >
          <LandingPicture
            alt={t("landing.hero.imageAlt")}
            className="kt-landing-hero__image"
            dataSaver={dataSaver}
            image={landingImages.hero}
            priority
          />
          <LandingSceneCapabilityGate serverDataSaver={dataSaver} />
        </div>
      </section>

      <section aria-labelledby="landing-how-title" className="kt-landing-section" id="how-it-works">
        <h2 id="landing-how-title">{t("landing.howItWorks.title")}</h2>
        <ol className="kt-landing-steps">
          {steps.map((step, index) => (
            <li className="kt-landing-step" key={step}>
              <span aria-hidden="true" className="kt-landing-step__number">{index + 1}</span>
              <h3>{t(`landing.howItWorks.${step}.title`)}</h3>
              <p>{t(`landing.howItWorks.${step}.body`)}</p>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="landing-services-title" className="kt-landing-section" id="services">
        <h2 id="landing-services-title">{t("landing.services.title")}</h2>
        <p className="kt-landing__lead">{t("landing.services.lead")}</p>
        <ul className="kt-landing-grid">
          {services.map(([service, icon]) => (
            <li className="kt-landing-tile" key={service}>
              <span aria-hidden="true" className="kt-landing-tile__icon">{icon}</span>
              <h3>{t(`landing.services.${service}.title`)}</h3>
              <p>{t(`landing.services.${service}.body`)}</p>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="landing-owner-title" className="kt-landing-section kt-landing-owner" id="owner-benefits">
        <div className="kt-landing-owner__copy">
          <h2 id="landing-owner-title">{t("landing.owner.title")}</h2>
          <p className="kt-landing__lead">{t("landing.owner.lead")}</p>
          <ul className="kt-landing-benefits">
            {ownerBenefits.map((benefit) => (
              <li key={benefit}>
                <span aria-hidden="true" className="kt-landing-benefits__mark">✓</span>
                <div>
                  <h3>{t(`landing.owner.${benefit}.title`)}</h3>
                  <p>{t(`landing.owner.${benefit}.body`)}</p>
                </div>
              </li>
            ))}
          </ul>
          <a className="kt-button kt-button--primary kt-landing-owner__action" href={ownerRegistrationHref}>
            {t("landing.cta.registerOwner")}
          </a>
        </div>
        <LandingPicture
          alt={t("landing.owner.imageAlt")}
          className="kt-landing-owner__image"
          dataSaver={dataSaver}
          image={landingImages.owner}
        />
      </section>

      <section aria-labelledby="landing-pricing-title" className="kt-landing-section" id="pricing">
        <h2 id="landing-pricing-title">{t("landing.pricing.title")}</h2>
        <p className="kt-landing__lead">{t("landing.pricing.lead")}</p>
        <ul className="kt-landing-grid kt-landing-grid--three">
          {pricingMethods.map(([labelKey, bodyKey]) => (
            <li className="kt-landing-tile kt-landing-tile--price" key={labelKey}>
              <span aria-hidden="true" className="kt-landing-tile__icon">₹</span>
              <h3>{t(labelKey)}</h3>
              <p>{t(bodyKey)}</p>
            </li>
          ))}
        </ul>
        <p className="kt-landing__note">{t("landing.pricing.note")}</p>
      </section>

      <section
        aria-labelledby="landing-phone-title"
        className={`kt-landing-section kt-landing-phone kt-landing-phone--${phone.available ? "available" : "unavailable"}`}
        data-capability-state={phone.displayState}
        id="phone-booking"
      >
        <h2 id="landing-phone-title">{t("landing.phone.title")}</h2>
        <PhoneBookingDetails locale={locale} presentation={phone}>
          <a className="kt-button kt-button--secondary" href="/help">{t("landing.phone.helpLink")}</a>
        </PhoneBookingDetails>
      </section>

      <section aria-labelledby="landing-languages-title" className="kt-landing-section" id="languages">
        <h2 id="landing-languages-title">{t("landing.languages.title")}</h2>
        <p className="kt-landing__lead">{t("landing.languages.lead")}</p>
        <ul className="kt-landing-languages">
          {landingLanguageOrder.map((language) => (
            <li aria-current={language === locale ? "true" : undefined} key={language} lang={language}>
              {localeMetadata[language].nativeName}
            </li>
          ))}
        </ul>
        <a className="kt-button kt-button--secondary kt-landing-languages__action" href="/language">
          {t("control.chooseLanguage")}
        </a>
      </section>

      <section aria-labelledby="landing-final-title" className="kt-landing-final" id="get-started">
        <h2 id="landing-final-title">{t("landing.finalCta.title")}</h2>
        <p>{t("landing.finalCta.lead")}</p>
        <RoleActions inverse locale={locale} />
      </section>
    </div>
  );
}
