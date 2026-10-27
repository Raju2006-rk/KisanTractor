import {
  providerCapabilities,
  type CapabilityState,
  type ProviderCapability,
} from "@kisantractor/providers";
import { z } from "zod";

/**
 * Production readiness gate (Requirements 12.7, 18.7). Evaluates the version-controlled manifest
 * `ops/release/readiness.json` against the capability states a production deploy is about to run
 * with. A release is ready only when every blocking gate PASSED and every capability configured
 * LIVE has a live adapter and has passed all six readiness checks. The result lists stable codes,
 * never configuration values.
 */
export const readinessCheckKinds = [
  "SECURITY",
  "CONTRACT",
  "SANDBOX",
  "FAILURE_MODE",
  "OPERATIONAL",
  "ROLLBACK",
] as const;
export type ReadinessCheckKind = (typeof readinessCheckKinds)[number];

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, "must be an ISO date (YYYY-MM-DD)");
const repositoryPath = z.string().min(1).refine((path) => !path.startsWith("/") && !path.includes(".."), {
  message: "must be a repository-relative path",
});

const passedEvidence = <T extends { status: string; evidence: string; verifiedOn?: string | undefined }>(
  value: T,
  context: z.RefinementCtx,
): void => {
  if (value.status !== "PASSED") return;
  if (value.evidence.trim().length < 20) {
    context.addIssue({ code: "custom", path: ["evidence"], message: "a PASSED item needs its evidence described" });
  }
  if (value.verifiedOn === undefined) {
    context.addIssue({ code: "custom", path: ["verifiedOn"], message: "a PASSED item needs the date it was verified" });
  }
};

const gateSchema = z.object({
  id: z.string().regex(/^[A-Z][A-Z0-9_]+$/u),
  requirements: z.array(z.string().regex(/^\d+\.\d+$/u)).min(1),
  kind: z.enum(["AUTOMATED", "OPERATIONAL"]),
  blocking: z.boolean(),
  status: z.enum(["PENDING", "PASSED"]),
  verifiedOn: isoDate.optional(),
  evidence: z.string(),
  evidencePaths: z.array(repositoryPath).min(1),
  owner: z.string().min(1),
  note: z.string().optional(),
}).superRefine(passedEvidence);

const checkSchema = z.object({
  status: z.enum(["PENDING", "PASSED"]),
  evidence: z.string(),
  verifiedOn: isoDate.optional(),
}).superRefine(passedEvidence);

const capabilitySchema = z.object({
  requiredForLaunch: z.boolean(),
  liveAdapterAvailable: z.boolean(),
  note: z.string().optional(),
  checks: z.object(Object.fromEntries(readinessCheckKinds.map((kind) => [kind, checkSchema])) as Record<ReadinessCheckKind, typeof checkSchema>),
});

export const readinessManifestSchema = z.object({
  schemaVersion: z.literal("kisantractor.release.readiness/v1"),
  release: z.string().min(1),
  statusNote: z.string().optional(),
  gates: z.array(gateSchema).min(1),
  capabilities: z.object(Object.fromEntries(providerCapabilities.map((capability) => [capability, capabilitySchema])) as Record<ProviderCapability, typeof capabilitySchema>),
}).superRefine((manifest, context) => {
  const ids = manifest.gates.map(({ id }) => id);
  for (const duplicate of ids.filter((id, index) => ids.indexOf(id) !== index)) {
    context.addIssue({ code: "custom", path: ["gates"], message: `duplicate gate ${duplicate}` });
  }
});

export type ReadinessManifest = z.output<typeof readinessManifestSchema>;

export function parseReadinessManifest(input: unknown): ReadinessManifest {
  const result = readinessManifestSchema.safeParse(input);
  if (!result.success) {
    throw new Error(`Invalid readiness manifest:\n${result.error.issues
      .map((issue) => `- ${issue.path.join(".") || "manifest"}: ${issue.message}`).join("\n")}`);
  }
  return result.data;
}

export interface ReadinessTarget {
  readonly capabilityStates: Readonly<Record<ProviderCapability, CapabilityState>>;
  /** False when the states came from raw variables rather than a validated production config. */
  readonly environmentValidated: boolean;
}

export interface ReadinessReport {
  readonly ready: boolean;
  readonly release: string;
  readonly blockers: readonly string[];
  readonly warnings: readonly string[];
  readonly passedGates: readonly string[];
}

export function evaluateProductionReadiness(
  manifest: ReadinessManifest,
  target: ReadinessTarget,
  pathExists: (repositoryRelativePath: string) => boolean,
): ReadinessReport {
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (!target.environmentValidated) blockers.push("PRODUCTION_ENVIRONMENT_NOT_VALIDATED");

  for (const gate of manifest.gates) {
    for (const path of gate.evidencePaths) if (!pathExists(path)) blockers.push(`EVIDENCE_MISSING:${gate.id}:${path}`);
    if (gate.status !== "PASSED") (gate.blocking ? blockers : warnings).push(`GATE_PENDING:${gate.id}`);
  }

  for (const capability of providerCapabilities) {
    const readiness = manifest.capabilities[capability];
    const state = target.capabilityStates[capability];
    if (state === "LIVE") {
      if (!readiness.liveAdapterAvailable) blockers.push(`CAPABILITY_NO_LIVE_ADAPTER:${capability}`);
      for (const kind of readinessCheckKinds) {
        if (readiness.checks[kind].status !== "PASSED") blockers.push(`CAPABILITY_CHECK_PENDING:${capability}:${kind}`);
      }
    } else if (state === "SANDBOX") {
      // Production never registers sandbox providers; the capability would silently run DEGRADED.
      blockers.push(`SANDBOX_IN_PRODUCTION:${capability}`);
    } else if (state === "DEGRADED") {
      warnings.push(`CAPABILITY_DEGRADED:${capability}`);
    }
    if (readiness.requiredForLaunch && state !== "LIVE") blockers.push(`REQUIRED_CAPABILITY_NOT_LIVE:${capability}`);
  }

  return Object.freeze({
    ready: blockers.length === 0,
    release: manifest.release,
    blockers: Object.freeze(blockers),
    warnings: Object.freeze(warnings),
    passedGates: Object.freeze(manifest.gates.filter(({ status }) => status === "PASSED").map(({ id }) => id)),
  });
}
