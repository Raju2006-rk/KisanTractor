"use client";

import type { TractorAvailabilityProjection } from "@kisantractor/domain";
import { formatDateTime, formatIndianCurrency, translate, type CatalogLocale } from "@kisantractor/i18n";
import { useState } from "react";

import type { OwnerDashboardAvailability, OwnerDashboardSummary } from "../../lib/owner-dashboard-model";
import { Card, StatusChip, Switch } from "../ui";

interface DashboardLink {
  readonly href: string;
  readonly icon: string;
  readonly label: string;
  readonly description: string;
}

const displayedValue = (value: number | undefined, unavailable: string): string =>
  value === undefined ? unavailable : new Intl.NumberFormat("en-IN").format(value);

export function OwnerDashboard({
  availabilities: initialAvailabilities,
  locale,
  summary,
}: {
  readonly availabilities: readonly OwnerDashboardAvailability[];
  readonly locale: CatalogLocale;
  readonly summary: OwnerDashboardSummary;
}) {
  const [availabilities, setAvailabilities] = useState(initialAvailabilities);
  const [pendingTractorId, setPendingTractorId] = useState<string>();
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string }>();

  const changeAvailability = async (tractor: OwnerDashboardAvailability, checked: boolean) => {
    if (!checked && (summary.pendingRequests ?? 0) > 0 && !window.confirm(translate(locale, "owner.dashboard.offlineConfirmation"))) {
      return;
    }

    setPendingTractorId(tractor.tractorId);
    setMessage(undefined);
    try {
      const response = await fetch(`/api/owner/tractors/${encodeURIComponent(tractor.tractorId)}/availability`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: checked ? "ONLINE" : "OFFLINE", expectedVersion: tractor.version }),
      });
      if (!response.ok) throw new Error("Availability update rejected");
      const updated = await response.json() as TractorAvailabilityProjection;
      const effectiveAt = new Date(updated.effectiveAt);
      if (updated.tractorId !== tractor.tractorId || Number.isNaN(effectiveAt.getTime())) {
        throw new Error("Invalid availability response");
      }
      setAvailabilities((current) => current.map((item) => item.tractorId === tractor.tractorId
        ? Object.freeze({ ...item, ...updated, effectiveAt })
        : item));
      setMessage({ tone: "success", text: translate(locale, checked ? "owner.dashboard.onlineSuccess" : "owner.dashboard.offlineSuccess") });
    } catch {
      setMessage({ tone: "danger", text: translate(locale, "owner.dashboard.availabilityError") });
    } finally {
      setPendingTractorId(undefined);
    }
  };

  const unavailable = translate(locale, "owner.dashboard.dataUnavailable");
  const summaryCards = [
    { label: translate(locale, "owner.dashboard.totalTractors"), value: displayedValue(summary.totalTractors, unavailable), href: "/owner/tractors" },
    { label: translate(locale, "menu.equipment"), value: displayedValue(summary.equipmentCount, unavailable), href: "/owner/equipment" },
    { label: translate(locale, "owner.dashboard.requests"), value: displayedValue(summary.pendingRequests, unavailable), href: "/owner/bookings" },
    { label: translate(locale, "owner.dashboard.acceptedJobs"), value: displayedValue(summary.acceptedJobs, unavailable), href: "/owner/bookings" },
    { label: translate(locale, "owner.dashboard.activeJobs"), value: displayedValue(summary.activeJobs, unavailable), href: "/owner/bookings" },
    { label: translate(locale, "owner.dashboard.completedJobs"), value: displayedValue(summary.completedJobs, unavailable), href: "/owner/bookings" },
    {
      label: translate(locale, "owner.dashboard.recordedEarnings"),
      value: summary.recordedEarningsPaise === undefined ? unavailable : formatIndianCurrency(locale, summary.recordedEarningsPaise),
      href: "/owner/earnings",
    },
  ] as const;

  const shortcuts: readonly DashboardLink[] = [
    { href: "/owner/tractors", icon: "▱", label: translate(locale, "menu.myTractors"), description: translate(locale, "owner.dashboard.tractorsHelp") },
    { href: "/owner/equipment", icon: "⚙", label: translate(locale, "menu.equipment"), description: translate(locale, "owner.dashboard.equipmentHelp") },
    { href: "/owner/documents", icon: "▤", label: translate(locale, "menu.documents"), description: translate(locale, "owner.dashboard.documentsHelp") },
    { href: "/owner/pricing", icon: "₹", label: translate(locale, "menu.pricingAndServices"), description: translate(locale, "owner.dashboard.pricingHelp") },
  ];

  const allOffline = availabilities.length > 0 && availabilities.every((tractor) => tractor.operationalStatus === "OFFLINE");

  return (
    <div className="kt-owner-dashboard">
      <section aria-labelledby="owner-availability-title" className="kt-owner-dashboard__availability">
        <div>
          <p className="kt-owner-dashboard__eyebrow">{translate(locale, "owner.dashboard.firstControl")}</p>
          <h2 id="owner-availability-title">{translate(locale, "owner.dashboard.availabilityTitle")}</h2>
          <p>{translate(locale, "owner.dashboard.availabilityHelp")}</p>
        </div>
        {availabilities.length === 0 ? (
          <Card title={translate(locale, "owner.dashboard.noTractorsTitle")}>
            <p>{translate(locale, "owner.dashboard.noTractorsHelp")}</p>
            <a className="kt-button kt-button--primary" href="/owner/tractors/new">{translate(locale, "control.addTractor")}</a>
          </Card>
        ) : (
          <div className="kt-owner-availability-list">
            {availabilities.map((tractor) => {
              const isOnline = tractor.operationalStatus === "ONLINE";
              const isPending = pendingTractorId === tractor.tractorId;
              return (
                <article className="kt-owner-availability" key={tractor.tractorId}>
                  <div className="kt-owner-availability__identity">
                    <strong>{tractor.tractorName}</strong>
                    <span>{tractor.registrationNumber}</span>
                  </div>
                  <Switch
                    aria-label={`${tractor.tractorName} ${translate(locale, "owner.dashboard.availabilityTitle")}`}
                    checked={isOnline}
                    checkedLabel={translate(locale, "status.tractor.online")}
                    disabled={isPending}
                    label={translate(locale, "owner.dashboard.availabilityLabel")}
                    onCheckedChange={(checked) => void changeAvailability(tractor, checked)}
                    uncheckedLabel={translate(locale, "status.tractor.offline")}
                  />
                  <div className="kt-owner-availability__status">
                    <StatusChip tone={tractor.acceptingNewDemand ? "success" : "warning"}>
                      {translate(locale, tractor.acceptingNewDemand ? "owner.dashboard.acceptingRequests" : "owner.dashboard.notAcceptingRequests")}
                    </StatusChip>
                    <small>{translate(locale, "owner.dashboard.updatedAt", { date: formatDateTime(locale, tractor.effectiveAt) })}</small>
                  </div>
                </article>
              );
            })}
          </div>
        )}
        {message ? <p aria-live="polite" className={`kt-owner-dashboard__message kt-owner-dashboard__message--${message.tone}`} role={message.tone === "danger" ? "alert" : "status"}>{message.text}</p> : null}
      </section>

      <section aria-labelledby="owner-summary-title">
        <h2 id="owner-summary-title">{translate(locale, "owner.dashboard.summaryTitle")}</h2>
        <div className="kt-owner-summary-grid">
          {summaryCards.map((card) => (
            <a className="kt-owner-summary-card" href={card.href} key={card.label}>
              <span>{card.label}</span>
              <strong>{card.value}</strong>
              <small>{translate(locale, "control.viewDetails")}</small>
            </a>
          ))}
        </div>
      </section>

      <section aria-labelledby="owner-work-title" className="kt-owner-dashboard__work">
        <div>
          <h2 id="owner-work-title">{translate(locale, "owner.dashboard.workTitle")}</h2>
          <p>{translate(locale, "owner.dashboard.existingBookingsRemain")}</p>
          {allOffline ? <StatusChip tone="info">{translate(locale, "owner.dashboard.allOffline")}</StatusChip> : null}
        </div>
        <div className="kt-owner-dashboard__primary-links">
          <a className="kt-button kt-button--primary" href="/owner/bookings">{translate(locale, "menu.bookingRequests")}</a>
          <a className="kt-button kt-button--secondary" href="/owner/bookings?view=active">{translate(locale, "owner.dashboard.viewActiveJobs")}</a>
        </div>
      </section>

      <section aria-labelledby="owner-shortcuts-title">
        <h2 id="owner-shortcuts-title">{translate(locale, "owner.dashboard.shortcutsTitle")}</h2>
        <div className="kt-owner-shortcuts">
          {shortcuts.map((shortcut) => (
            <a className="kt-owner-shortcut" href={shortcut.href} key={shortcut.href}>
              <span aria-hidden="true" className="kt-owner-shortcut__icon">{shortcut.icon}</span>
              <span><strong>{shortcut.label}</strong><small>{shortcut.description}</small></span>
            </a>
          ))}
        </div>
      </section>

      <section aria-labelledby="owner-finance-title" className="kt-owner-dashboard__finance">
        <div><h2 id="owner-finance-title">{translate(locale, "owner.dashboard.financeTitle")}</h2><p>{translate(locale, "owner.dashboard.financeHelp")}</p></div>
        <div className="kt-owner-dashboard__primary-links">
          <a className="kt-button kt-button--secondary" href="/owner/earnings">{translate(locale, "menu.earnings")}</a>
          <a className="kt-button kt-button--secondary" href="/owner/payments">{translate(locale, "menu.payments")}</a>
        </div>
      </section>

      <section aria-label={translate(locale, "owner.dashboard.accountLinks")} className="kt-owner-dashboard__secondary-links">
        <a className="kt-text-link" href="/owner/profile">{translate(locale, "menu.profileAndSettings")}</a>
        <a className="kt-text-link" href="/owner/help">{translate(locale, "menu.help")}</a>
      </section>
    </div>
  );
}
