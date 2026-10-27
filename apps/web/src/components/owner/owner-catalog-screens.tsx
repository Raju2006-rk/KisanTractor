import type {
  OwnerLocationProjection,
  OwnerPricingRuleProjection,
  OwnerProfileProjection,
  OwnerServiceOfferingProjection,
  OwnerTractorProjection,
  PricingMethod,
} from "@kisantractor/domain";
import {
  catalogLocales,
  formatIndianCurrency,
  localeMetadata,
  translate,
  type CatalogLocale,
  type MessageKey,
} from "@kisantractor/i18n";

import { LocationCaptureFields, type MapsCapabilityPresentation } from "../location";
import { Button, Card, CheckboxField, FormActions, SelectField, StatusChip, TextInput } from "../ui";

const unavailableMaps: MapsCapabilityPresentation = Object.freeze({
  state: "UNCONFIGURED",
  isOperational: false,
  isTest: false,
  canRetry: false,
  message: "Maps and geocoding are not configured.",
});

const locationFields = (
  locale: CatalogLocale,
  location: OwnerLocationProjection | undefined,
  mapsCapability: MapsCapabilityPresentation,
) => (
  <LocationCaptureFields
    collectionPurpose="TRACTOR_OPERATING_LOCATION"
    locale={locale}
    {...(location === undefined ? {} : { location })}
    mapsCapability={mapsCapability}
  />
);

export function OwnerProfileScreen({
  locale,
  profile,
  mapsCapability = unavailableMaps,
}: {
  readonly locale: CatalogLocale;
  readonly profile?: OwnerProfileProjection;
  readonly mapsCapability?: MapsCapabilityPresentation;
}) {
  return (
    <div className="kt-owner-workflow">
      <p className="kt-route-surface__lead">{translate(locale, "owner.profile.intro")}</p>
      <StatusChip tone="success">{translate(locale, "owner.mobileVerified")}</StatusChip>
      <form action="/api/owner/profile" className="kt-owner-form" method="post">
        {profile ? <input name="expectedVersion" type="hidden" value={profile.version} /> : null}
        <TextInput defaultValue={profile?.fullName} id="fullName" label={translate(locale, "form.fullName")} maxLength={150} name="fullName" required />
        <SelectField
          defaultValue={profile?.preferredLocale ?? locale}
          id="preferredLocale"
          label={translate(locale, "form.preferredLanguage")}
          name="preferredLocale"
          options={catalogLocales.map((option) => ({
            value: option,
            label: localeMetadata[option].nativeName,
          }))}
        />
        <CheckboxField
          defaultChecked={profile?.contactSharingConsent}
          hint={translate(locale, "owner.registrationPrivate")}
          id="contactSharingConsent"
          label={translate(locale, "form.contactSharingConsent")}
          name="contactSharingConsent"
          value="true"
        />
        {locationFields(locale, profile?.operatingLocation, mapsCapability)}
        <FormActions><Button type="submit">{translate(locale, "control.save")}</Button></FormActions>
      </form>
    </div>
  );
}

export function OwnerTractorListScreen({
  locale,
  tractors,
}: {
  readonly locale: CatalogLocale;
  readonly tractors: readonly OwnerTractorProjection[];
}) {
  return (
    <div className="kt-owner-workflow">
      <p className="kt-route-surface__lead">{translate(locale, "owner.tractors.intro")}</p>
      <a className="kt-button kt-button--primary kt-owner-workflow__action" href="/owner/tractors/new">
        {translate(locale, "control.addTractor")}
      </a>
      {tractors.length === 0 ? <p>{translate(locale, "owner.tractors.empty")}</p> : (
        <div className="kt-role-grid">
          {tractors.map((tractor) => (
            <Card
              actions={<a className="kt-button kt-button--secondary" href={`/owner/tractors/${tractor.id}`}>{translate(locale, "control.viewDetails")}</a>}
              eyebrow={tractor.registrationNumber}
              key={tractor.id}
              title={`${tractor.brand} ${tractor.model}`}
            >
              <div className="kt-owner-tractor-summary">
                <StatusChip tone={tractor.eligibilityStatus === "ELIGIBLE" ? "success" : "warning"}>
                  {translate(locale, tractor.eligibilityStatus === "ELIGIBLE" ? "status.tractor.eligible" : "status.tractor.ineligible")}
                </StatusChip>
                <p>{tractor.manufacturingYear}{tractor.horsepower ? ` · ${tractor.horsepower} HP` : ""}</p>
                <p>{tractor.operatingLocation.village}, {tractor.operatingLocation.district}</p>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

export function OwnerTractorFormScreen({
  locale,
  tractor,
  mapsCapability = unavailableMaps,
}: {
  readonly locale: CatalogLocale;
  readonly tractor?: OwnerTractorProjection;
  readonly mapsCapability?: MapsCapabilityPresentation;
}) {
  const action = tractor ? `/api/owner/tractors/${tractor.id}` : "/api/owner/tractors";
  return (
    <form action={action} className="kt-owner-form" method="post">
      {tractor ? <input name="expectedVersion" type="hidden" value={tractor.version} /> : null}
      <div className="kt-owner-form__grid">
        <TextInput defaultValue={tractor?.brand} id="brand" label={translate(locale, "form.brand")} maxLength={100} name="brand" required />
        <TextInput defaultValue={tractor?.model} id="model" label={translate(locale, "form.model")} maxLength={100} name="model" required />
        <TextInput
          autoCapitalize="characters"
          defaultValue={tractor?.registrationNumber}
          hint={translate(locale, "owner.registrationPrivate")}
          id="registrationNumber"
          label={translate(locale, "form.registrationNumber")}
          maxLength={16}
          name="registrationNumber"
          required
        />
        <TextInput defaultValue={tractor?.manufacturingYear} id="manufacturingYear" inputMode="numeric" label={translate(locale, "form.manufacturingYear")} max={new Date().getUTCFullYear() + 1} min="1900" name="manufacturingYear" required type="number" />
        <TextInput defaultValue={tractor?.horsepower} id="horsepower" inputMode="decimal" label={translate(locale, "form.horsepower")} max="1000" min="0.01" name="horsepower" step="0.01" type="number" />
      </div>
      {locationFields(locale, tractor?.operatingLocation, mapsCapability)}
      <section aria-labelledby="tractor-photos-title" className="kt-owner-form__section">
        <h2 id="tractor-photos-title">{translate(locale, "owner.tractor.photos")}</h2>
        {tractor?.photos.length ? (
          <ul className="kt-owner-photo-list">
            {tractor.photos.map((photo) => <li key={photo.id}>{photo.altText} · {photo.mimeType}</li>)}
          </ul>
        ) : null}
        <p id="tractor-photos-hint">{translate(locale, "owner.tractor.photosHint")}</p>
        <div className="kt-owner-photo-inputs">
          <label className="kt-file-field" htmlFor="tractorPhotoCamera">
            <span>{translate(locale, "owner.tractor.takePhoto")}</span>
            <input
              accept="image/jpeg,image/png,image/webp"
              aria-describedby="tractor-photos-hint"
              capture="environment"
              id="tractorPhotoCamera"
              name="tractorPhotoCamera"
              type="file"
            />
          </label>
          <label className="kt-file-field" htmlFor="tractorPhotoFiles">
            <span>{translate(locale, "owner.tractor.choosePhotos")}</span>
            <input
              accept="image/jpeg,image/png,image/webp"
              aria-describedby="tractor-photos-hint"
              id="tractorPhotoFiles"
              multiple
              name="tractorPhotoFiles"
              type="file"
            />
          </label>
        </div>
      </section>
      <FormActions><Button type="submit">{translate(locale, "control.save")}</Button></FormActions>
    </form>
  );
}

const pricingMethodKeys: Readonly<Record<PricingMethod, MessageKey>> = {
  HOURLY: "form.hourly",
  PER_ACRE: "form.perAcre",
  PER_TRIP: "form.perTrip",
};

const roundingOptions = [
  { value: "PROPORTIONAL_MINUTE", key: "rounding.proportionalMinute" },
  { value: "THIRTY_MINUTE_BLOCK", key: "rounding.thirtyMinuteBlock" },
  { value: "ONE_HOUR_BLOCK", key: "rounding.oneHourBlock" },
] as const satisfies readonly { value: string; key: MessageKey }[];

export interface OwnerPricingConfigurationView {
  readonly tractor: OwnerTractorProjection;
  readonly offering: OwnerServiceOfferingProjection;
  readonly rules: readonly OwnerPricingRuleProjection[];
}

export function OwnerPricingScreen({
  configurations,
  locale,
}: {
  readonly configurations: readonly OwnerPricingConfigurationView[];
  readonly locale: CatalogLocale;
}) {
  const methods = Object.keys(pricingMethodKeys) as PricingMethod[];
  return (
    <div className="kt-owner-workflow">
      <p className="kt-route-surface__lead">{translate(locale, "owner.pricing.intro")}</p>
      {configurations.length === 0 ? <p>{translate(locale, "owner.pricing.empty")}</p> : (
        <div className="kt-pricing-offerings">
          {configurations.map(({ tractor, offering, rules }) => (
            <Card
              eyebrow={`${tractor.brand} ${tractor.model} · ${offering.equipmentName ?? translate(locale, "owner.pricing.noEquipment")}`}
              key={offering.id}
              title={offering.serviceName}
            >
              {!offering.enabled ? (
                <StatusChip tone="warning">{translate(locale, "owner.pricing.offeringDisabled")}</StatusChip>
              ) : null}
              <div className="kt-pricing-rules">
                {methods.map((method) => {
                  const rule = rules.find((candidate) => candidate.method === method);
                  const idPrefix = `${offering.id}-${method.toLowerCase()}`;
                  return (
                    <form
                      action={`/api/owner/service-offerings/${encodeURIComponent(offering.id)}/pricing-rules`}
                      className="kt-pricing-rule"
                      key={method}
                      method="post"
                    >
                      <h3>{translate(locale, pricingMethodKeys[method])}</h3>
                      <input name="method" type="hidden" value={method} />
                      {rule ? <input name="expectedVersion" type="hidden" value={rule.version} /> : null}
                      <TextInput
                        defaultValue={rule?.ratePaise}
                        hint={translate(locale, "owner.pricing.rateHint")}
                        id={`${idPrefix}-rate`}
                        inputMode="numeric"
                        label={translate(locale, "owner.pricing.ratePaise")}
                        min="1"
                        name="ratePaise"
                        required
                        step="1"
                        type="number"
                      />
                      {method === "HOURLY" ? (
                        <SelectField
                          defaultValue={rule?.roundingPolicy ?? "PROPORTIONAL_MINUTE"}
                          id={`${idPrefix}-rounding`}
                          label={translate(locale, "owner.pricing.roundingPolicy")}
                          name="roundingPolicy"
                          options={roundingOptions.map((option) => ({
                            value: option.value,
                            label: translate(locale, option.key),
                          }))}
                          required
                        />
                      ) : null}
                      <CheckboxField
                        defaultChecked={rule?.enabled ?? true}
                        id={`${idPrefix}-enabled`}
                        label={translate(locale, "owner.pricing.enabled")}
                        name="enabled"
                        value="true"
                      />
                      {rule ? (
                        <p className="kt-pricing-rule__current">
                          {formatIndianCurrency(locale, rule.ratePaise)} · {rule.enabled ? translate(locale, "owner.pricing.enabled") : translate(locale, "owner.pricing.offeringDisabled")}
                        </p>
                      ) : null}
                      <FormActions><Button type="submit">{translate(locale, "control.save")}</Button></FormActions>
                    </form>
                  );
                })}
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
