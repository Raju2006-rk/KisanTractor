"use client";

import { formatDateTime, formatIndianCurrency, translate, type CatalogLocale } from "@kisantractor/i18n";
import { useEffect, useMemo, useState, type FormEvent } from "react";

import {
  isDeviceOnline,
  isValidAttemptKey,
  loadAttempt,
  resumeNotice,
  runAuthoritativeAction,
  safeDraftStoragePrefix,
  type StorageLike,
} from "../../lib/authoritative-action";
import {
  bookingDiscoveryParameters,
  bookingDraftOmittedPhone,
  bookingRequestBody,
  bookingStepErrors,
  bookingSteps,
  createBookingDraft,
  restoreBookingDraft,
  serializeSafeBookingDraft,
  type BookingStep,
  type FarmerBookingDraft,
} from "../../lib/farmer-booking";
import type { FarmerPricingRule, FarmerTractorCardProjection, SearchParameters } from "../../lib/farmer-discovery";
import { DataFreshness } from "../connectivity/data-freshness";
import { Button, CheckboxField, FormActions, SelectField, Stepper, TextArea, TextInput } from "../ui";

const draftKey = `${safeDraftStoragePrefix}farmer-booking`;
/** Storage keys written before safe drafts; removed on load, and their key is reused once. */
const legacyDraftKey = "kisantractor:farmer-booking-draft:v1";
const legacyIdempotencyKey = "kisantractor:farmer-booking-idempotency:v1";
const createBookingActionId = "farmer:booking:create";
const confirmLabel = "Confirm booking";

type ConnectivityNotice = Readonly<{ message: string; showBookingsLink: boolean }>;

const tabStorage = (): StorageLike | undefined => {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
};
const stepLabels: Readonly<Record<BookingStep, string>> = {
  target: "Booking target",
  location: "Service location",
  work: "Work and equipment",
  schedule: "Schedule",
  pricing: "Pricing",
  review: "Review",
};

interface FarmerBookingStepperProps {
  readonly locale: CatalogLocale;
  readonly parameters: SearchParameters;
  readonly tractor?: FarmerTractorCardProjection | undefined;
  /** When the server evaluated the selected tractor's availability and prices (ISO 8601). */
  readonly checkedAt?: string | undefined;
}

const ruleLabel = (locale: CatalogLocale, rule: FarmerPricingRule): string => {
  const unitKey = { HOURLY: "currency.ratePerHour", PER_ACRE: "currency.ratePerAcre", PER_TRIP: "currency.ratePerTrip" } as const;
  return translate(locale, unitKey[rule.method], { amount: formatIndianCurrency(locale, rule.ratePaise) });
};

const roundingLabel = (locale: CatalogLocale, rule?: FarmerPricingRule): string => {
  if (!rule?.roundingPolicy) return "Not applicable";
  const key = {
    PROPORTIONAL_MINUTE: "rounding.proportionalMinute",
    THIRTY_MINUTE_BLOCK: "rounding.thirtyMinuteBlock",
    ONE_HOUR_BLOCK: "rounding.oneHourBlock",
  } as const;
  return translate(locale, key[rule.roundingPolicy]);
};

export function BookingReview({
  draft, estimatedTotal, locale, selectedRule, tractor,
}: Readonly<{
  draft: FarmerBookingDraft;
  estimatedTotal?: number | undefined;
  locale: CatalogLocale;
  selectedRule?: FarmerPricingRule | undefined;
  tractor?: FarmerTractorCardProjection | undefined;
}>) {
  return <section aria-labelledby="booking-review-title" className="kt-booking-flow__panel">
    <h2 id="booking-review-title">Review and confirm</h2>
    <dl className="kt-booking-review">
      <div><dt>Booked by</dt><dd>You (authenticated Farmer)</dd></div>
      <div><dt>Recipient</dt><dd>{draft.bookingTarget === "SOMEONE_ELSE" ? draft.recipientName : "Myself"}</dd></div>
      <div><dt>{translate(locale, "form.serviceLocation")}</dt><dd>{[draft.village, draft.mandalOrTaluk, draft.district, draft.state, draft.landmark].filter(Boolean).join(", ")}</dd></div>
      <div><dt>{translate(locale, "form.tractor")}</dt><dd>{tractor ? `${tractor.brand} ${tractor.model}` : draft.tractorId}</dd></div>
      <div><dt>Owner</dt><dd>{tractor?.ownerDisplayName ?? "Shown after policy permits"}</dd></div>
      <div><dt>{translate(locale, "form.farmingWork")}</dt><dd>{tractor?.service.name ?? draft.serviceId}</dd></div>
      <div><dt>{translate(locale, "form.equipment")}</dt><dd>{tractor?.equipment?.name ?? (draft.equipmentTypeId || "None")}</dd></div>
      <div><dt>Pricing</dt><dd>{selectedRule ? `${ruleLabel(locale, selectedRule)}; ${roundingLabel(locale, selectedRule)}` : draft.pricingMethod}</dd></div>
      <div><dt>{translate(locale, "currency.estimatedTotal")}</dt><dd>{estimatedTotal === undefined ? "Not available" : formatIndianCurrency(locale, estimatedTotal)}</dd></div>
      <div><dt>Schedule</dt><dd>{formatDateTime(locale, draft.start)} – {formatDateTime(locale, draft.end)}</dd></div>
      <div><dt>Payment expectation</dt><dd>Final payment is due after recorded work and the final bill.</dd></div>
    </dl>
  </section>;
}

export function FarmerBookingStepper({ checkedAt, locale, parameters, tractor }: FarmerBookingStepperProps) {
  const initialDraft = useMemo(() => createBookingDraft(parameters), [parameters]);
  const [draft, setDraft] = useState<FarmerBookingDraft>(initialDraft);
  const [stepIndex, setStepIndex] = useState(0);
  const [errors, setErrors] = useState<readonly string[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState("");
  const [submission, setSubmission] = useState<"IDLE" | "SUBMITTING" | "ERROR">("IDLE");
  const [notice, setNotice] = useState<ConnectivityNotice>();
  const [phoneOmitted, setPhoneOmitted] = useState(false);
  const [pageReceivedAt, setPageReceivedAt] = useState(0);

  useEffect(() => {
    const storage = tabStorage();
    const read = (key: string) => {
      try {
        return storage?.getItem(key) ?? null;
      } catch {
        return null;
      }
    };
    const remove = (key: string) => {
      try {
        storage?.removeItem(key);
      } catch {
        // Best effort.
      }
    };
    setPageReceivedAt(Date.now());
    // Legacy drafts may hold the Recipient phone; read the safe fields once and delete them.
    const stored = read(draftKey) ?? read(legacyDraftKey);
    const legacyKey = read(legacyIdempotencyKey);
    remove(legacyDraftKey);
    remove(legacyIdempotencyKey);
    setDraft(restoreBookingDraft(stored, initialDraft));
    setPhoneOmitted(bookingDraftOmittedPhone(stored));

    // A pending attempt keeps its key until the server gives a definite answer.
    const attempt = loadAttempt(storage, createBookingActionId, Date.now());
    setIdempotencyKey(attempt?.idempotencyKey ?? legacyKey ?? crypto.randomUUID());
    const pending = resumeNotice(attempt, false);
    if (pending === "UNKNOWN") {
      setNotice({ message: translate(locale, "booking.unknownResumed", { action: confirmLabel }), showBookingsLink: true });
    } else if (pending === "NOT_SENT") {
      setNotice({ message: translate(locale, "booking.offline", { action: confirmLabel }), showBookingsLink: false });
    }
    setHydrated(true);
  }, [initialDraft, locale]);
  useEffect(() => {
    if (!hydrated) return;
    try {
      tabStorage()?.setItem(draftKey, serializeSafeBookingDraft(draft));
    } catch {
      // Storage may be full or disabled; the draft stays in memory for this page.
    }
  }, [draft, hydrated]);

  const step = bookingSteps[stepIndex]!;
  const selectedRule = tractor?.pricingRules.find((rule) => rule.id === draft.pricingRuleId)
    ?? tractor?.pricingRules.find((rule) => rule.method === draft.pricingMethod)
    ?? tractor?.pricingRules[0];
  const estimatedTotal = selectedRule && Number(draft.expectedQuantity) > 0
    ? Math.round(selectedRule.ratePaise * Number(draft.expectedQuantity))
    : undefined;

  const update = <K extends keyof FarmerBookingDraft>(key: K, value: FarmerBookingDraft[K]) => {
    setDraft((current) => Object.freeze({ ...current, [key]: value }));
    setErrors([]);
  };
  const continueToNext = () => {
    const nextErrors = bookingStepErrors(step, draft);
    if (nextErrors.length) return setErrors(nextErrors);
    setErrors([]);
    setStepIndex((current) => Math.min(current + 1, bookingSteps.length - 1));
  };
  const searchFromServiceLocation = () => {
    const nextErrors = bookingStepErrors("location", draft);
    if (nextErrors.length) return setErrors(nextErrors);
    try {
      tabStorage()?.setItem(draftKey, serializeSafeBookingDraft(draft));
    } catch {
      // Best effort; the search still uses the URL parameters.
    }
    window.location.assign(`/farmer/search?${bookingDiscoveryParameters(draft).toString()}`);
  };
  /**
   * Confirms the booking only when the Farmer presses the button. Offline presses send nothing,
   * and nothing is queued or replayed later; an unknown outcome keeps the same idempotency key
   * and capture time so the explicit retry is the same request.
   */
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (submission === "SUBMITTING") return;
    const allErrors = bookingSteps.flatMap((candidate) => bookingStepErrors(candidate, draft));
    if (allErrors.length) return setErrors(allErrors);
    setErrors([]);
    setNotice(undefined);
    setSubmission("SUBMITTING");
    const storage = tabStorage();
    const result = await runAuthoritativeAction({
      storage,
      actionId: createBookingActionId,
      renderedKey: isValidAttemptKey(idempotencyKey) ? idempotencyKey : crypto.randomUUID(),
      online: isDeviceOnline(window),
      fields: {},
      stableValues: { capturedAt: new Date().toISOString() },
      now: Date.now(),
      send: (attempt) => fetch("/api/farmer/bookings", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": attempt.idempotencyKey ?? "" },
        body: JSON.stringify(bookingRequestBody(draft, attempt.stableValues.capturedAt)),
        cache: "no-store",
      }),
    });

    if (result.outcome === "SUCCEEDED") {
      const body = await result.response?.json().catch(() => undefined) as { id?: unknown } | undefined;
      try {
        storage?.removeItem(draftKey);
      } catch {
        // Best effort.
      }
      window.location.assign(typeof body?.id === "string" ? `/farmer/bookings/${encodeURIComponent(body.id)}` : "/farmer/bookings");
      return;
    }
    setSubmission("ERROR");
    if (result.outcome === "NOT_SENT" || result.outcome === "UNKNOWN") {
      setIdempotencyKey(result.attempt.idempotencyKey ?? idempotencyKey);
      setNotice({
        message: translate(locale, result.outcome === "NOT_SENT" ? "booking.offline" : "booking.unknown", { action: confirmLabel }),
        showBookingsLink: false,
      });
      return;
    }
    // A definite refusal recorded nothing under this key, so the next confirmation gets a new one.
    setIdempotencyKey(crypto.randomUUID());
    const status = result.response?.status ?? 0;
    if (status === 401) {
      setNotice({ message: translate(locale, "booking.sessionExpired"), showBookingsLink: false });
    } else if (status === 409) {
      setNotice(result.resumedUnknown
        ? { message: translate(locale, "booking.conflictAfterUnknown"), showBookingsLink: true }
        : { message: translate(locale, "booking.conflict"), showBookingsLink: false });
    } else {
      setNotice({ message: translate(locale, "booking.rejected"), showBookingsLink: false });
    }
  };

  return (
    <form className="kt-booking-flow" onSubmit={submit}>
      <p className="kt-route-surface__lead">Your progress is saved in this browser tab until the booking is confirmed.</p>
      <Stepper
        label="Booking progress"
        steps={bookingSteps.map((candidate, index) => ({
          id: candidate,
          label: stepLabels[candidate],
          state: index < stepIndex ? "complete" : index === stepIndex ? "current" : "upcoming",
          statusLabel: index < stepIndex ? "Completed" : index === stepIndex ? "Current step" : "Not started",
        }))}
      />
      {errors.length ? <div className="kt-booking-flow__errors" role="alert"><strong>Check this step</strong><ul>{errors.map((error) => <li key={error}>{error}</li>)}</ul></div> : null}
      {notice ? (
        <div className="kt-action-notice kt-action-notice--warning" role="alert">
          <p>{notice.message}</p>
          {notice.showBookingsLink ? <a className="kt-button kt-button--secondary" href="/farmer/bookings">{translate(locale, "booking.checkBookings")}</a> : null}
        </div>
      ) : null}

      {step === "target" ? <fieldset className="kt-booking-flow__panel">
        <legend>Who is this booking for?</legend>
        <label className="kt-booking-choice"><input checked={draft.bookingTarget === "MYSELF"} name="bookingTarget" onChange={() => update("bookingTarget", "MYSELF")} type="radio" /> <span><strong>{translate(locale, "form.bookForMyself")}</strong><small>You are both the authenticated customer and service recipient.</small></span></label>
        <label className="kt-booking-choice"><input checked={draft.bookingTarget === "SOMEONE_ELSE"} name="bookingTarget" onChange={() => update("bookingTarget", "SOMEONE_ELSE")} type="radio" /> <span><strong>{translate(locale, "form.bookForSomeoneElse")}</strong><small>You remain the booking customer; the other person is stored separately as the Recipient.</small></span></label>
        {draft.bookingTarget === "SOMEONE_ELSE" ? <div className="kt-booking-flow__grid">
          <TextInput id="recipientName" label={translate(locale, "form.recipientName")} onChange={(event) => update("recipientName", event.target.value)} required value={draft.recipientName} />
          <TextInput
            hint={phoneOmitted && !draft.coordinationPhone ? translate(locale, "booking.phoneNotSaved") : undefined}
            id="coordinationPhone"
            inputMode="tel"
            label={translate(locale, "form.coordinationPhone")}
            onChange={(event) => update("coordinationPhone", event.target.value)}
            value={draft.coordinationPhone}
          />
          {draft.coordinationPhone ? <CheckboxField checked={draft.coordinationConsent} id="coordinationConsent" label="The Recipient agrees that this phone may be used to coordinate this service" onChange={(event) => update("coordinationConsent", event.target.checked)} /> : null}
          <TextArea id="recipientDirections" label="Recipient landmark or directions (optional)" onChange={(event) => update("landmarkOrDirections", event.target.value)} value={draft.landmarkOrDirections} />
        </div> : null}
      </fieldset> : null}

      {step === "location" ? <fieldset className="kt-booking-flow__panel">
        <legend>{draft.bookingTarget === "SOMEONE_ELSE" ? "Recipient service location" : translate(locale, "form.serviceLocation")}</legend>
        <p>{draft.bookingTarget === "SOMEONE_ELSE" ? "Tractor search and service delivery use this Recipient location, never your profile or current location." : translate(locale, "location.manualHelp")}</p>
        <div className="kt-booking-flow__grid">
          <TextInput id="bookingState" label={translate(locale, "form.state")} onChange={(event) => update("state", event.target.value)} required value={draft.state} />
          <TextInput id="bookingDistrict" label={translate(locale, "form.district")} onChange={(event) => update("district", event.target.value)} required value={draft.district} />
          <TextInput id="bookingMandal" label={translate(locale, "form.mandalOrTaluk")} onChange={(event) => update("mandalOrTaluk", event.target.value)} required value={draft.mandalOrTaluk} />
          <TextInput id="bookingVillage" label={translate(locale, "form.village")} onChange={(event) => update("village", event.target.value)} required value={draft.village} />
          <TextInput id="bookingLandmark" label={translate(locale, "form.landmark")} onChange={(event) => update("landmark", event.target.value)} value={draft.landmark} />
          <TextInput id="bookingLatitude" inputMode="decimal" label={translate(locale, "form.latitude")} max={90} min={-90} onChange={(event) => update("latitude", event.target.value)} required step="any" type="number" value={draft.latitude} />
          <TextInput id="bookingLongitude" inputMode="decimal" label={translate(locale, "form.longitude")} max={180} min={-180} onChange={(event) => update("longitude", event.target.value)} required step="any" type="number" value={draft.longitude} />
        </div>
        <Button onClick={searchFromServiceLocation} type="button" variant="secondary">{draft.bookingTarget === "SOMEONE_ELSE" ? "Find tractors near Recipient" : "Find tractors near this farm"}</Button>
      </fieldset> : null}

      {step === "work" ? <fieldset className="kt-booking-flow__panel">
        <legend>Work and Equipment</legend>
        <div className="kt-booking-flow__grid">
          <TextInput id="bookingService" label={translate(locale, "form.farmingWork")} onChange={(event) => update("serviceId", event.target.value)} required value={draft.serviceId} />
          <TextInput id="bookingEquipment" label={translate(locale, "form.equipment")} onChange={(event) => update("equipmentTypeId", event.target.value)} value={draft.equipmentTypeId} />
        </div>
        {tractor ? <div className="kt-booking-selection"><strong>Selected tractor</strong><span>{tractor.brand} {tractor.model}</span>{tractor.equipment ? <span>{tractor.equipment.name}</span> : null}</div> : <p>No tractor selected. Return to location and search near the service location.</p>}
      </fieldset> : null}

      {step === "schedule" ? <fieldset className="kt-booking-flow__panel">
        <legend>Requested schedule</legend>
        <div className="kt-booking-flow__grid">
          <TextInput id="bookingStart" label={translate(locale, "farmer.search.start")} onChange={(event) => update("start", event.target.value)} required type="datetime-local" value={draft.start} />
          <TextInput id="bookingEnd" label={translate(locale, "farmer.search.end")} onChange={(event) => update("end", event.target.value)} required type="datetime-local" value={draft.end} />
        </div>
      </fieldset> : null}

      {step === "pricing" ? <fieldset className="kt-booking-flow__panel">
        <legend>Pricing and estimated quantity</legend>
        <SelectField id="pricingRule" label={translate(locale, "form.pricingMethod")} onChange={(event) => {
          const rule = tractor?.pricingRules.find((candidate) => candidate.id === event.target.value);
          update("pricingRuleId", event.target.value);
          if (rule) update("pricingMethod", rule.method);
        }} options={[{ value: "", label: translate(locale, "form.selectOption") }, ...(tractor?.pricingRules.map((rule) => ({ value: rule.id, label: ruleLabel(locale, rule) })) ?? [])]} required value={draft.pricingRuleId} />
        <TextInput id="bookingQuantity" inputMode="decimal" label={translate(locale, "form.quantity")} min="0.01" onChange={(event) => update("expectedQuantity", event.target.value)} required step="0.01" type="number" value={draft.expectedQuantity} />
        {selectedRule ? <div className="kt-booking-selection"><span>{ruleLabel(locale, selectedRule)}</span><span>{roundingLabel(locale, selectedRule)}</span>{estimatedTotal !== undefined ? <strong>{translate(locale, "currency.estimatedTotal")}: {formatIndianCurrency(locale, estimatedTotal)}</strong> : null}</div> : null}
      </fieldset> : null}

      {step === "review" ? <BookingReview draft={draft} estimatedTotal={estimatedTotal} locale={locale} selectedRule={selectedRule} tractor={tractor} /> : null}
      {step === "review" && tractor && checkedAt ? (
        <DataFreshness checkedAt={checkedAt} kind="quote" locale={locale} {...(pageReceivedAt > 0 ? { receivedAt: pageReceivedAt } : {})} />
      ) : null}

      <FormActions>
        {stepIndex > 0 ? <Button onClick={() => { setErrors([]); setStepIndex((current) => current - 1); }} type="button" variant="secondary">{translate(locale, "control.back")}</Button> : null}
        {step !== "review" ? <Button onClick={continueToNext} type="button">{translate(locale, "control.continue")}</Button> : <Button disabled={submission === "SUBMITTING"} type="submit">{submission === "SUBMITTING" ? "Confirming…" : confirmLabel}</Button>}
      </FormActions>
    </form>
  );
}
