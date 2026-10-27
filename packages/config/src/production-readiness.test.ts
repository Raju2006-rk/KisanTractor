import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { providerCapabilities, type CapabilityState, type ProviderCapability } from "@kisantractor/providers";
import { describe, expect, it } from "vitest";

import {
  evaluateProductionReadiness,
  parseReadinessManifest,
  readinessCheckKinds,
  type ReadinessManifest,
  type ReadinessTarget,
} from "./production-readiness.js";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const rawManifest = JSON.parse(readFileSync(join(repositoryRoot, "ops", "release", "readiness.json"), "utf8")) as Record<string, unknown>;
const shipped = parseReadinessManifest(rawManifest);
const exists = (path: string): boolean => existsSync(join(repositoryRoot, path));

const states = (overrides: Partial<Record<ProviderCapability, CapabilityState>> = {}): ReadinessTarget => ({
  environmentValidated: true,
  capabilityStates: { ...Object.fromEntries(providerCapabilities.map((capability) => [capability, "UNCONFIGURED"])), ...overrides } as ReadinessTarget["capabilityStates"],
});

/** The shipped manifest with every gate passed and OTP ready for LIVE, as a release would look. */
const readyManifest = (): ReadinessManifest => {
  const manifest = structuredClone(shipped) as ReadinessManifest & { gates: Array<Record<string, unknown>> };
  for (const gate of manifest.gates) Object.assign(gate, { status: "PASSED", verifiedOn: "2026-11-01", evidence: "Recorded in the release log with links." });
  const otp = manifest.capabilities.OTP as { liveAdapterAvailable: boolean; checks: Record<string, unknown> };
  otp.liveAdapterAvailable = true;
  for (const kind of readinessCheckKinds) otp.checks[kind] = { status: "PASSED", evidence: "Provider sandbox and failure drills recorded.", verifiedOn: "2026-11-01" };
  return parseReadinessManifest(manifest);
};

/** Validates: Requirements 12.7, 18.7 */
describe("production readiness manifest", () => {
  it("lists every provider capability with all six readiness checks", () => {
    expect(Object.keys(shipped.capabilities).sort()).toEqual([...providerCapabilities].sort());
    for (const capability of providerCapabilities) {
      expect(Object.keys(shipped.capabilities[capability].checks).sort()).toEqual([...readinessCheckKinds].sort());
    }
  });

  it("points every gate at evidence that exists in the repository", () => {
    for (const gate of shipped.gates) {
      for (const path of gate.evidencePaths) expect(exists(path), `${gate.id}: ${path}`).toBe(true);
    }
  });

  it("covers the Requirement 12.5, 12.7, 18.5, and 18.7 release obligations", () => {
    const covered = new Set(shipped.gates.flatMap(({ requirements }) => requirements));
    for (const requirement of ["12.5", "12.7", "18.5", "18.7"]) expect(covered.has(requirement), requirement).toBe(true);
    for (const id of ["PRODUCTION_BACKUPS_CONFIGURED", "STAGING_RESTORE_DRILL", "MONITORING_DEPLOYED", "INCIDENT_RESPONSE_READY"]) {
      expect(shipped.gates.find((gate) => gate.id === id), id).toMatchObject({ kind: "OPERATIONAL", blocking: true });
    }
  });

  it("never marks an operational gate passed without dated evidence", () => {
    const passedWithoutEvidence = structuredClone(rawManifest) as { gates: Array<Record<string, unknown>> };
    Object.assign(passedWithoutEvidence.gates.find((gate) => gate.id === "INCIDENT_RESPONSE_READY")!, { status: "PASSED" });
    expect(() => parseReadinessManifest(passedWithoutEvidence)).toThrow(/evidence|verifiedOn/u);
    expect(() => parseReadinessManifest({ ...rawManifest, schemaVersion: "v0" })).toThrow(/schemaVersion/u);
  });

  it("reports the shipped Phase 1 manifest as not ready for production, with the reasons", () => {
    const report = evaluateProductionReadiness(shipped, states(), exists);
    expect(report.ready).toBe(false);
    for (const gate of shipped.gates.filter(({ status, blocking }) => status === "PENDING" && blocking)) {
      expect(report.blockers).toContain(`GATE_PENDING:${gate.id}`);
    }
    expect(report.blockers).toContain("REQUIRED_CAPABILITY_NOT_LIVE:OTP");
    expect(report.blockers.some((blocker) => blocker.startsWith("EVIDENCE_MISSING"))).toBe(false);
  });

  it("records the Razorpay and MSG91/FCM live adapters honestly: available, with no readiness check passed yet", () => {
    const withLiveAdapters = ["ONLINE_PAYMENT", "MESSAGING"] as const;
    for (const capability of withLiveAdapters) {
      expect(shipped.capabilities[capability].liveAdapterAvailable, capability).toBe(true);
      for (const kind of readinessCheckKinds) {
        expect(shipped.capabilities[capability].checks[kind], `${capability} ${kind}`).toMatchObject({ status: "PENDING" });
      }
    }
    for (const capability of providerCapabilities.filter((candidate) => !(withLiveAdapters as readonly string[]).includes(candidate))) {
      expect(shipped.capabilities[capability].liveAdapterAvailable, capability).toBe(false);
    }
  });
});

/** Validates: Requirements 14.5, 18.7 */
describe("production readiness evaluation", () => {
  it("is ready when every blocking gate passed and only ready capabilities are LIVE", () => {
    expect(evaluateProductionReadiness(readyManifest(), states({ OTP: "LIVE" }), exists)).toMatchObject({ ready: true, blockers: [] });
  });

  it("blocks a LIVE capability without a live adapter or with any readiness check pending", () => {
    const manifest = readyManifest();
    const report = evaluateProductionReadiness(manifest, states({ OTP: "LIVE", TELEPHONY: "LIVE" }), exists);
    expect(report.ready).toBe(false);
    expect(report.blockers).toEqual([
      "CAPABILITY_NO_LIVE_ADAPTER:TELEPHONY",
      ...readinessCheckKinds.map((kind) => `CAPABILITY_CHECK_PENDING:TELEPHONY:${kind}`),
    ]);
    // Razorpay can run LIVE, but online payment stays blocked until its six checks pass.
    expect(evaluateProductionReadiness(manifest, states({ OTP: "LIVE", ONLINE_PAYMENT: "LIVE" }), exists).blockers)
      .toEqual(readinessCheckKinds.map((kind) => `CAPABILITY_CHECK_PENDING:ONLINE_PAYMENT:${kind}`));
    // Likewise MSG91/FCM messaging.
    expect(evaluateProductionReadiness(manifest, states({ OTP: "LIVE", MESSAGING: "LIVE" }), exists).blockers)
      .toEqual(readinessCheckKinds.map((kind) => `CAPABILITY_CHECK_PENDING:MESSAGING:${kind}`));
    for (const kind of readinessCheckKinds) {
      const missingOne = structuredClone(manifest) as ReadinessManifest;
      (missingOne.capabilities.OTP.checks as Record<string, unknown>)[kind] = { status: "PENDING", evidence: "" };
      expect(evaluateProductionReadiness(parseReadinessManifest(missingOne), states({ OTP: "LIVE" }), exists).blockers, kind)
        .toEqual([`CAPABILITY_CHECK_PENDING:OTP:${kind}`]);
    }
  });

  it("refuses SANDBOX in production, warns on DEGRADED, and requires a validated environment", () => {
    const manifest = readyManifest();
    expect(evaluateProductionReadiness(manifest, states({ OTP: "LIVE", MESSAGING: "SANDBOX" }), exists).blockers)
      .toEqual(["SANDBOX_IN_PRODUCTION:MESSAGING"]);
    expect(evaluateProductionReadiness(manifest, states({ OTP: "LIVE", MAPS_GEOCODING: "DEGRADED" }), exists))
      .toMatchObject({ ready: true, warnings: ["CAPABILITY_DEGRADED:MAPS_GEOCODING"] });
    expect(evaluateProductionReadiness(manifest, { ...states({ OTP: "LIVE" }), environmentValidated: false }, exists).blockers)
      .toEqual(["PRODUCTION_ENVIRONMENT_NOT_VALIDATED"]);
  });

  it("blocks on missing evidence files and pending blocking gates, and only warns on non-blocking ones", () => {
    const manifest = readyManifest() as ReadinessManifest & { gates: Array<Record<string, unknown>> };
    Object.assign(manifest.gates.find((gate) => gate.id === "INITIAL_LOAD_PROFILE")!, { status: "PENDING" });
    Object.assign(manifest.gates.find((gate) => gate.id === "STAGING_RESTORE_DRILL")!, { status: "PENDING" });
    const report = evaluateProductionReadiness(parseReadinessManifest(manifest), states({ OTP: "LIVE" }), (path) =>
      path !== "ops/runbooks/incident-response.md" && exists(path));
    expect(report.blockers).toEqual(["GATE_PENDING:STAGING_RESTORE_DRILL", "EVIDENCE_MISSING:INCIDENT_RESPONSE_READY:ops/runbooks/incident-response.md"]);
    expect(report.warnings).toEqual(["GATE_PENDING:INITIAL_LOAD_PROFILE"]);
  });
});
