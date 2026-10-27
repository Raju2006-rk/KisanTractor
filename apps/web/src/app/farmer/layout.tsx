import type { ReactNode } from "react";

import { AppShell } from "../../components/shell";
import { loadAuthorizedRoute } from "../../lib/server-context";

export default async function FarmerLayout({ children }: Readonly<{ children: ReactNode }>) {
  const { locale } = await loadAuthorizedRoute("FARMER", "/farmer");
  return <AppShell locale={locale} role="FARMER">{children}</AppShell>;
}
