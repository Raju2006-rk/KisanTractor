import type { ReactNode } from "react";

export interface NavigationItem {
  href: string;
  label: string;
  icon: ReactNode;
  current?: boolean;
}

export interface NavigationProps {
  items: readonly NavigationItem[];
  label: string;
  variant?: "primary" | "bottom";
}

export function Navigation({ items, label, variant = "primary" }: NavigationProps) {
  return (
    <nav aria-label={label} className={`kt-navigation kt-navigation--${variant}`}>
      <ul>
        {items.map((item) => (
          <li key={`${item.href}-${item.label}`}>
            <a aria-current={item.current ? "page" : undefined} href={item.href}>
              <span aria-hidden="true" className="kt-navigation__icon">{item.icon}</span>
              <span>{item.label}</span>
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
