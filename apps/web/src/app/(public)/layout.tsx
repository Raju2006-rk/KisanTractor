import type { ReactNode } from "react";

import { PublicFooter } from "../../components/landing";
import { AppShell } from "../../components/shell";
import { loadLocale } from "../../lib/server-context";

export default async function PublicLayout({ children }: Readonly<{ children: ReactNode }>) {
  const locale = await loadLocale();
  return (
    <AppShell footer={<PublicFooter locale={locale} />} locale={locale} role="PUBLIC">
      {children}
    </AppShell>
  );
}
