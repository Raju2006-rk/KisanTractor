"use client";

import { usePathname } from "next/navigation";

import { Navigation, type NavigationItem } from "../ui";

export interface RoleNavigationProps {
  readonly items: readonly Omit<NavigationItem, "current">[];
  readonly label: string;
}

export function RoleNavigation({ items, label }: RoleNavigationProps) {
  const pathname = usePathname();
  const resolvedItems = items.map((item) => ({
    ...item,
    current:
      pathname === item.href ||
      (item.href.split("/").length > 2 && pathname.startsWith(`${item.href}/`)),
  }));

  return <Navigation items={resolvedItems} label={label} variant="bottom" />;
}
