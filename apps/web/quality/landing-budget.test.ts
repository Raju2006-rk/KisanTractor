import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { assertLandingModelBudget, measureLandingModelPayload } from "./model-budget";
import { landingAssetBudgets } from "./profiles";

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** Validates: Requirement 16.7 */
describe("compressed landing model budget", () => {
  it("enforces the 1.5 MB aggregate model and texture payload against committed assets", () => {
    const assetRoot = fileURLToPath(new URL("../public/models/landing/", import.meta.url));
    const measurement = measureLandingModelPayload(assetRoot);
    console.info(`[landing] compressed 3D payload ${measurement.totalBytes} B in ${measurement.assets.length} files (budget ${measurement.budgetBytes} B)`);
    expect(measurement.budgetBytes).toBe(1_500_000);
    expect(() => assertLandingModelBudget(measurement)).not.toThrow();
  });

  it("sums nested supported assets, ignores unrelated files, and rejects one byte over budget", () => {
    const root = mkdtempSync(join(tmpdir(), "kt-model-budget-"));
    temporaryDirectories.push(root);
    mkdirSync(join(root, "textures"));
    writeFileSync(join(root, "tractor.glb"), Buffer.alloc(900_000));
    writeFileSync(join(root, "textures", "paint.ktx2"), Buffer.alloc(600_001));
    writeFileSync(join(root, "README.md"), Buffer.alloc(100));

    const measurement = measureLandingModelPayload(root);
    expect(measurement.assets.map((asset) => asset.path)).toEqual(["textures/paint.ktx2", "tractor.glb"]);
    expect(measurement.totalBytes).toBe(landingAssetBudgets.optional3dCompressedBytes + 1);
    expect(() => assertLandingModelBudget(measurement)).toThrow(/exceeds 1500000B budget/u);
  });
});
