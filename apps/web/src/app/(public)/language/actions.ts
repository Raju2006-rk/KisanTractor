"use server";

import { isCatalogLocale } from "@kisantractor/i18n";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { localeCookieName } from "../../../lib/server-context";

export async function selectLanguage(formData: FormData): Promise<never> {
  const selected = formData.get("locale");
  const requestedReturnTo = formData.get("returnTo");
  if (typeof selected !== "string" || !isCatalogLocale(selected)) {
    redirect("/language?error=invalid-locale");
  }

  const returnTo =
    typeof requestedReturnTo === "string" &&
    requestedReturnTo.startsWith("/") &&
    !requestedReturnTo.startsWith("//")
      ? requestedReturnTo
      : "/";

  const cookieStore = await cookies();
  cookieStore.set(localeCookieName, selected, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
  redirect(returnTo);
}
