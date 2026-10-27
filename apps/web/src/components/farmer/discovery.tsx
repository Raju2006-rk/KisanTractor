import {
  formatIndianCurrency,
  translate,
  type CatalogLocale,
} from "@kisantractor/i18n";

import type {
  DiscoveryLoadResult,
  FarmerPricingRule,
  FarmerSearchCriteria,
  FarmerTractorCardProjection,
} from "../../lib/farmer-discovery";
import { criteriaToSearchParameters } from "../../lib/farmer-discovery";
import { DataFreshness } from "../connectivity/data-freshness";
import { LocationCaptureFields, type MapsCapabilityPresentation } from "../location";
import { Card, EmptyState, SelectField, StatusChip, TextInput } from "../ui";

const pricingLabel = (locale: CatalogLocale, rule: FarmerPricingRule): string => {
  const key = {
    HOURLY: "currency.ratePerHour",
    PER_ACRE: "currency.ratePerAcre",
    PER_TRIP: "currency.ratePerTrip",
  } as const;
  return translate(locale, key[rule.method], {
    amount: formatIndianCurrency(locale, rule.ratePaise),
  });
};

export function FarmerHome({ locale }: Readonly<{ locale: CatalogLocale }>) {
  const actions = [
    { href: "/farmer/search#service-location", icon: "⌖", title: translate(locale, "form.serviceLocation"), text: translate(locale, "farmer.home.locationHelp") },
    { href: "/farmer/search#farming-work", icon: "⚒", title: translate(locale, "form.farmingWork"), text: translate(locale, "farmer.home.workHelp") },
    { href: "/farmer/search#schedule", icon: "□", title: `${translate(locale, "form.date")} & ${translate(locale, "form.time")}`, text: translate(locale, "farmer.home.scheduleHelp") },
    { href: "/farmer/search#pricing-method", icon: "₹", title: translate(locale, "form.pricingMethod"), text: translate(locale, "farmer.home.pricingHelp") },
    { href: "/farmer/search", icon: "⌕", title: translate(locale, "farmer.home.nearby"), text: translate(locale, "farmer.home.nearbyHelp") },
    { href: "/farmer/bookings", icon: "▣", title: translate(locale, "farmer.home.currentBookings"), text: translate(locale, "farmer.home.bookingsHelp") },
    { href: "/farmer/bookings?view=history", icon: "↶", title: translate(locale, "farmer.home.history"), text: translate(locale, "farmer.home.historyHelp") },
    { href: "/farmer/help", icon: "?", title: translate(locale, "menu.help"), text: translate(locale, "farmer.home.helpText") },
    { href: "/language", icon: "文", title: translate(locale, "control.chooseLanguage"), text: translate(locale, "farmer.home.languageHelp") },
  ] as const;

  return (
    <>
      <p className="kt-route-surface__lead">{translate(locale, "shell.farmerWelcome")}</p>
      <a className="kt-button kt-button--primary kt-farmer-home__primary" href="/farmer/search">
        {translate(locale, "control.search")}
      </a>
      <div className="kt-farmer-home" aria-label={translate(locale, "farmer.home.actions")}>
        {actions.map((action) => (
          <a className="kt-farmer-action" href={action.href} key={action.href}>
            <span aria-hidden="true" className="kt-farmer-action__icon">{action.icon}</span>
            <span><strong>{action.title}</strong><small>{action.text}</small></span>
          </a>
        ))}
      </div>
    </>
  );
}

function SearchForm({
  criteria,
  locale,
  mapsCapability,
}: Readonly<{
  criteria: FarmerSearchCriteria;
  locale: CatalogLocale;
  mapsCapability: MapsCapabilityPresentation;
}>) {
  const latitude = criteria.latitude === "" ? undefined : Number(criteria.latitude);
  const longitude = criteria.longitude === "" ? undefined : Number(criteria.longitude);
  const accuracyMeters = criteria.accuracyMeters === "" ? undefined : Number(criteria.accuracyMeters);
  const location = {
    state: criteria.state,
    district: criteria.district,
    mandalOrTaluk: criteria.mandalOrTaluk,
    village: criteria.village,
    source: criteria.source,
    capturedAt: criteria.capturedAt === "" ? new Date() : new Date(criteria.capturedAt),
    ...(criteria.postalCode === "" ? {} : { postalCode: criteria.postalCode }),
    ...(criteria.landmark === "" ? {} : { landmark: criteria.landmark }),
    ...(latitude === undefined || !Number.isFinite(latitude) ? {} : { latitude }),
    ...(longitude === undefined || !Number.isFinite(longitude) ? {} : { longitude }),
    ...(accuracyMeters === undefined || !Number.isFinite(accuracyMeters) ? {} : { accuracyMeters }),
    ...(criteria.consentedAt === "" ? {} : { consentedAt: new Date(criteria.consentedAt) }),
  } as const;
  return (
    <form action="/farmer/search" className="kt-farmer-search-form" method="get">
      <input name="search" type="hidden" value="1" />
      <div id="service-location">
        <LocationCaptureFields
          collectionPurpose="SERVICE_LOCATION"
          locale={locale}
          location={location}
          mapsCapability={mapsCapability}
          showCoordinateEntry
        />
      </div>
      <fieldset id="farming-work">
        <legend>{translate(locale, "form.farmingWork")}</legend>
        <div className="kt-farmer-search-form__grid">
          <TextInput defaultValue={criteria.serviceId} id="serviceId" label={translate(locale, "farmer.search.serviceId")} name="serviceId" required />
          <TextInput defaultValue={criteria.equipmentTypeId} id="equipmentTypeId" label={translate(locale, "farmer.search.equipmentOptional")} name="equipmentTypeId" />
          <SelectField
            defaultValue={criteria.pricingMethod}
            id="pricingMethod"
            label={translate(locale, "form.pricingMethod")}
            name="pricingMethod"
            options={[
              { value: "", label: translate(locale, "farmer.search.anyPricing") },
              { value: "HOURLY", label: translate(locale, "form.hourly") },
              { value: "PER_ACRE", label: translate(locale, "form.perAcre") },
              { value: "PER_TRIP", label: translate(locale, "form.perTrip") },
            ]}
          />
        </div>
      </fieldset>
      <fieldset id="schedule">
        <legend>{translate(locale, "farmer.search.schedule")}</legend>
        <div className="kt-farmer-search-form__grid">
          <TextInput defaultValue={criteria.start} id="start" label={translate(locale, "farmer.search.start")} name="start" required type="datetime-local" />
          <TextInput defaultValue={criteria.end} id="end" label={translate(locale, "farmer.search.end")} name="end" required type="datetime-local" />
          <TextInput defaultValue={criteria.radiusKilometers} id="radius" label={translate(locale, "farmer.search.radius")} max={100} min={1} name="radius" required type="number" />
        </div>
      </fieldset>
      <button className="kt-button kt-button--primary" type="submit">{translate(locale, "control.search")}</button>
    </form>
  );
}

export function TractorCard({
  criteria,
  locale,
  tractor,
}: Readonly<{
  criteria: FarmerSearchCriteria;
  locale: CatalogLocale;
  tractor: FarmerTractorCardProjection;
}>) {
  const query = criteriaToSearchParameters(criteria);
  const detailHref = `/farmer/tractors/${encodeURIComponent(tractor.id)}?${query.toString()}`;
  const bookingParameters = criteriaToSearchParameters(criteria);
  bookingParameters.set("tractorId", tractor.id);
  bookingParameters.set("offeringId", tractor.service.offeringId);
  const matchingRule = criteria.pricingMethod
    ? tractor.pricingRules.find((rule) => rule.method === criteria.pricingMethod)
    : tractor.pricingRules[0];
  if (matchingRule) {
    bookingParameters.set("pricingRuleId", matchingRule.id);
    bookingParameters.set("pricingMethod", matchingRule.method);
  }
  const bookingHref = `/farmer/book?${bookingParameters.toString()}`;
  return (
    <Card
      className="kt-tractor-card"
      eyebrow={`${tractor.approximateDistance.label} · ${translate(locale, "farmer.search.estimatedDistance")}`}
      media={<div aria-label={tractor.photoAltText ?? `${tractor.brand} ${tractor.model}`} className="kt-tractor-card__photo" role="img"><span aria-hidden="true">▱</span></div>}
      title={`${tractor.brand} ${tractor.model}`}
      actions={<><a className="kt-button kt-button--secondary" href={detailHref}>{translate(locale, "control.viewDetails")}</a><a className="kt-button kt-button--primary" href={bookingHref}>{translate(locale, "control.bookNow")}</a></>}
    >
      <div className="kt-tractor-card__status"><StatusChip tone="success">{translate(locale, "farmer.search.available")}</StatusChip></div>
      <dl className="kt-tractor-card__facts">
        <div><dt>{translate(locale, "form.serviceLocation")}</dt><dd>{tractor.approximateLocation.district}, {tractor.approximateLocation.state}</dd></div>
        {tractor.ownerDisplayName ? <div><dt>{translate(locale, "farmer.search.owner")}</dt><dd>{tractor.ownerDisplayName}</dd></div> : null}
        <div><dt>{translate(locale, "form.farmingWork")}</dt><dd>{tractor.service.name}</dd></div>
        {tractor.equipment ? <div><dt>{translate(locale, "form.equipment")}</dt><dd>{tractor.equipment.name}</dd></div> : null}
        <div><dt>{translate(locale, "form.pricingMethod")}</dt><dd><ul>{tractor.pricingRules.map((rule) => <li key={rule.id}>{pricingLabel(locale, rule)}</li>)}</ul></dd></div>
      </dl>
    </Card>
  );
}

export function FarmerSearchResults({
  locale,
  mapsCapability,
  result,
}: Readonly<{
  locale: CatalogLocale;
  mapsCapability: MapsCapabilityPresentation;
  result: DiscoveryLoadResult;
}>) {
  const page = result.state === "READY" ? result.page : undefined;
  const expanded = page ? Math.min(page.maximumRadiusKilometers, Math.max(page.radiusKilometers + 5, page.radiusKilometers * 2)) : result.criteria.radiusKilometers;
  const expandCriteria = { ...result.criteria, radiusKilometers: expanded };
  const expandParameters = criteriaToSearchParameters(expandCriteria);
  expandParameters.set("search", "1");
  return (
    <div className="kt-farmer-search">
      <SearchForm criteria={result.criteria} locale={locale} mapsCapability={mapsCapability} />
      {result.state === "INVALID" || result.state === "ERROR" ? <p className="kt-farmer-search__error" role="alert">{result.message}</p> : null}
      {page ? (
        <section aria-labelledby="search-results-title" className="kt-farmer-results">
          <div className="kt-farmer-results__header">
            <div><h2 id="search-results-title">{translate(locale, "farmer.search.results")}</h2><p>{translate(locale, "farmer.search.origin", { district: page.origin.district, radius: page.radiusKilometers })}</p></div>
            <div className="kt-farmer-results__freshness">
              <DataFreshness checkedAt={page.evaluatedAt} kind="availability" locale={locale} />
            </div>
          </div>
          {page.items.length ? <div className="kt-tractor-grid">{page.items.map((tractor) => <TractorCard criteria={result.criteria} key={tractor.id} locale={locale} tractor={tractor} />)}</div> : (
            <EmptyState
              action={page.canExpandRadius ? <a className="kt-button kt-button--primary" href={`/farmer/search?${expandParameters.toString()}`}>{translate(locale, "farmer.search.expandRadius", { radius: expanded })}</a> : <a className="kt-button kt-button--secondary" href="#service-location">{translate(locale, "farmer.search.changeFilters")}</a>}
              icon="⌕"
              message={translate(locale, "farmer.search.emptyMessage", { radius: page.radiusKilometers })}
              title={translate(locale, "farmer.search.emptyTitle")}
            />
          )}
        </section>
      ) : null}
    </div>
  );
}

export function FarmerTractorDetails({
  checkedAt,
  criteria,
  locale,
  tractor,
}: Readonly<{ checkedAt?: Date; criteria: FarmerSearchCriteria; locale: CatalogLocale; tractor: FarmerTractorCardProjection }>) {
  return (
    <div className="kt-tractor-details">
      <a className="kt-text-link" href={`/farmer/search?${criteriaToSearchParameters(criteria).toString()}&search=1`}>← {translate(locale, "farmer.search.backToResults")}</a>
      {checkedAt ? <DataFreshness checkedAt={checkedAt} kind="availability" locale={locale} /> : null}
      <TractorCard criteria={criteria} locale={locale} tractor={tractor} />
      <p className="kt-tractor-details__privacy">{translate(locale, "farmer.search.privacyNote")}</p>
    </div>
  );
}
