import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { capabilityStates, providerCapabilities, type CapabilityState, type ProviderCapability } from "@kisantractor/providers";

import { validateEnvironment } from "./environment.js";
import { evaluateProductionReadiness, parseReadinessManifest, type ReadinessTarget } from "./production-readiness.js";

/**
 * `corepack pnpm release:check`: evaluates ops/release/readiness.json for a production release.
 *
 * With APP_ENV=production and the production variables present, the deploy's validated
 * configuration supplies the capability states. Without it, the check reads only the
 * `*_CAPABILITY_STATE` variables (default UNCONFIGURED) and reports
 * PRODUCTION_ENVIRONMENT_NOT_VALIDATED as a blocker. Exit code 0 means ready, 1 means not ready.
 */
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const stateVariable: Readonly<Record<ProviderCapability, string>> = {
  OTP: "OTP_CAPABILITY_STATE",
  MAPS_GEOCODING: "MAPS_CAPABILITY_STATE",
  ONLINE_PAYMENT: "PAYMENT_CAPABILITY_STATE",
  MESSAGING: "MESSAGING_CAPABILITY_STATE",
  OBJECT_STORAGE: "STORAGE_CAPABILITY_STATE",
  TELEPHONY: "TELEPHONY_CAPABILITY_STATE",
};

function target(): ReadinessTarget {
  if (process.env.APP_ENV === "production") {
    const config = validateEnvironment(process.env);
    return {
      environmentValidated: true,
      capabilityStates: Object.fromEntries(providerCapabilities.map((capability) =>
        [capability, config[stateVariable[capability] as "OTP_CAPABILITY_STATE"] as CapabilityState])) as ReadinessTarget["capabilityStates"],
    };
  }
  return {
    environmentValidated: false,
    capabilityStates: Object.fromEntries(providerCapabilities.map((capability) => {
      const value = process.env[stateVariable[capability]] ?? "UNCONFIGURED";
      if (!(capabilityStates as readonly string[]).includes(value)) throw new Error(`${stateVariable[capability]} must be one of ${capabilityStates.join(", ")}`);
      return [capability, value as CapabilityState];
    })) as ReadinessTarget["capabilityStates"],
  };
}

try {
  const manifest = parseReadinessManifest(JSON.parse(readFileSync(join(repositoryRoot, "ops", "release", "readiness.json"), "utf8")));
  const report = evaluateProductionReadiness(manifest, target(), (path) => existsSync(join(repositoryRoot, path)));
  console.log(JSON.stringify(report, null, 2));
  if (!report.ready) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : "Readiness check failed.");
  process.exitCode = 1;
}
