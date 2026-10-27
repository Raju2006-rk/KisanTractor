import { translate, type CatalogLocale } from "@kisantractor/i18n";
import type { ReactNode } from "react";

import { ConnectivityStatus } from "../connectivity/connectivity-status";
import { RoleNavigation } from "./role-navigation";

export type ShellRole = "PUBLIC" | "FARMER" | "OWNER";

interface AppShellProps {
  readonly children: ReactNode;
  /** Optional site footer rendered after main content as the contentinfo landmark. */
  readonly footer?: ReactNode;
  readonly locale: CatalogLocale;
  readonly role: ShellRole;
}

const icons = {
  home: "⌂",
  search: "⌕",
  bookings: "▣",
  help: "?",
  account: "○",
  dashboard: "▦",
  tractors: "▱",
  earnings: "₹",
} as const;

function navigationFor(role: Exclude<ShellRole, "PUBLIC">, locale: CatalogLocale) {
  if (role === "FARMER") {
    return {
      label: translate(locale, "shell.farmerNavigation"),
      items: [
        { href: "/farmer", icon: icons.home, label: translate(locale, "menu.home") },
        { href: "/farmer/search", icon: icons.search, label: translate(locale, "menu.searchTractors") },
        { href: "/farmer/bookings", icon: icons.bookings, label: translate(locale, "menu.bookings") },
        { href: "/farmer/help", icon: icons.help, label: translate(locale, "menu.help") },
        { href: "/farmer/account", icon: icons.account, label: translate(locale, "menu.account") },
      ],
    } as const;
  }

  return {
    label: translate(locale, "shell.ownerNavigation"),
    items: [
      { href: "/owner", icon: icons.dashboard, label: translate(locale, "menu.dashboard") },
      { href: "/owner/tractors", icon: icons.tractors, label: translate(locale, "menu.myTractors") },
      { href: "/owner/bookings", icon: icons.bookings, label: translate(locale, "menu.bookings") },
      { href: "/owner/earnings", icon: icons.earnings, label: translate(locale, "menu.earnings") },
      { href: "/owner/account", icon: icons.account, label: translate(locale, "menu.account") },
    ],
  } as const;
}

export function AppShell({ children, footer, locale, role }: AppShellProps) {
  const navigation = role === "PUBLIC" ? undefined : navigationFor(role, locale);

  return (
    <div className={`kt-app-shell kt-app-shell--${role.toLowerCase()}`}>
      <a className="kt-skip-link" href="#main-content">
        {translate(locale, "shell.skipToContent")}
      </a>
      <header className="kt-app-header">
        <a className="kt-brand" href={role === "PUBLIC" ? "/" : `/${role.toLowerCase()}`}>
          <span aria-hidden="true">●</span>
          {translate(locale, "app.name")}
        </a>
        <div className="kt-app-header__actions">
          {role !== "PUBLIC" ? <a href={`/${role.toLowerCase()}/help`}>{translate(locale, "menu.help")}</a> : <a href="/help">{translate(locale, "menu.help")}</a>}
          <a href="/language">{translate(locale, "control.chooseLanguage")}</a>
        </div>
      </header>
      <ConnectivityStatus
        offlineMessage={translate(locale, "connectivity.offline")}
        reconnectedMessage={translate(locale, "connectivity.online")}
      />
      <main className="kt-shell-main" id="main-content" tabIndex={-1}>{children}</main>
      {footer ?? null}
      {navigation ? <RoleNavigation items={navigation.items} label={navigation.label} /> : null}
    </div>
  );
}
