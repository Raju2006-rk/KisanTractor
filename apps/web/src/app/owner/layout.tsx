import type { ReactNode } from "react";

import { AppShell } from "../../components/shell";
import { loadAuthorizedRoute } from "../../lib/server-context";

export default async function OwnerLayout({ children }: Readonly<{ children: ReactNode }>) {
  const { locale } = await loadAuthorizedRoute("OWNER", "/owner");
  return <AppShell locale={locale} role="OWNER">{children}</AppShell>;
}
