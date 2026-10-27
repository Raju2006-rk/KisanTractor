import type {
  OwnerPricingRuleProjection,
  OwnerProfileProjection,
  OwnerServiceOfferingProjection,
  OwnerTractorProjection,
} from "@kisantractor/domain";
import { cookies } from "next/headers";

import { accessCookieName, runtimeConfig } from "./server-context";

async function ownerRequest(path: string): Promise<Response> {
  const cookieStore = await cookies();
  const accessCredential = cookieStore.get(accessCookieName)?.value;
  if (!accessCredential) return new Response(null, { status: 401 });
  return fetch(`${runtimeConfig().publicApiOrigin}/owner/${path}`, {
    headers: { authorization: `Bearer ${accessCredential}`, accept: "application/json" },
    cache: "no-store",
  });
}

export async function loadOwnerProfile(): Promise<OwnerProfileProjection | undefined> {
  try {
    const response = await ownerRequest("profile");
    if (!response.ok) return undefined;
    return await response.json() as OwnerProfileProjection;
  } catch {
    return undefined;
  }
}

export async function loadOwnerTractors(): Promise<readonly OwnerTractorProjection[]> {
  try {
    const response = await ownerRequest("tractors");
    if (!response.ok) return [];
    return await response.json() as readonly OwnerTractorProjection[];
  } catch {
    return [];
  }
}

export async function loadOwnerTractor(tractorId: string): Promise<OwnerTractorProjection | undefined> {
  try {
    const response = await ownerRequest(`tractors/${encodeURIComponent(tractorId)}`);
    if (!response.ok) return undefined;
    return await response.json() as OwnerTractorProjection;
  } catch {
    return undefined;
  }
}

export interface OwnerPricingConfiguration {
  readonly tractor: OwnerTractorProjection;
  readonly offering: OwnerServiceOfferingProjection;
  readonly rules: readonly OwnerPricingRuleProjection[];
}

export async function loadOwnerServiceOfferings(
  tractorId: string,
): Promise<readonly OwnerServiceOfferingProjection[]> {
  try {
    const response = await ownerRequest(`tractors/${encodeURIComponent(tractorId)}/service-offerings`);
    if (!response.ok) return [];
    return await response.json() as readonly OwnerServiceOfferingProjection[];
  } catch {
    return [];
  }
}

export async function loadOwnerPricingRules(
  serviceOfferingId: string,
): Promise<readonly OwnerPricingRuleProjection[]> {
  try {
    const response = await ownerRequest(`service-offerings/${encodeURIComponent(serviceOfferingId)}/pricing-rules`);
    if (!response.ok) return [];
    return await response.json() as readonly OwnerPricingRuleProjection[];
  } catch {
    return [];
  }
}

export async function loadOwnerPricingConfigurations(): Promise<readonly OwnerPricingConfiguration[]> {
  const tractors = await loadOwnerTractors();
  const offeringsByTractor = await Promise.all(tractors.map(async (tractor) => ({
    tractor,
    offerings: await loadOwnerServiceOfferings(tractor.id),
  })));
  const configurations = await Promise.all(offeringsByTractor.flatMap(({ tractor, offerings }) =>
    offerings.map(async (offering) => ({
      tractor,
      offering,
      rules: await loadOwnerPricingRules(offering.id),
    })),
  ));
  return Object.freeze(configurations);
}
