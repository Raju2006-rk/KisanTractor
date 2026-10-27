import { existsSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";

import { landingAssetBudgets } from "./profiles";

/** Formats that constitute the separately deployed landing model/texture payload. */
const MODEL_PAYLOAD_EXTENSIONS = new Set([".avif", ".basis", ".bin", ".glb", ".gltf", ".ktx2", ".webp"]);

export interface ModelPayloadMeasurement {
  readonly assets: readonly Readonly<{ path: string; bytes: number }>[];
  readonly totalBytes: number;
  readonly budgetBytes: number;
}

/**
 * Measures deployable compressed model and texture files. GLB/KTX2/Basis and
 * modern image textures are already compressed, so committed byte size is the
 * transfer budget rather than a misleading second gzip pass.
 */
export function measureLandingModelPayload(assetRoot: string): ModelPayloadMeasurement {
  const assets: { path: string; bytes: number }[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && MODEL_PAYLOAD_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        assets.push({ path: relative(assetRoot, path).replaceAll("\\", "/"), bytes: statSync(path).size });
      }
    }
  };
  if (existsSync(assetRoot)) visit(assetRoot);
  assets.sort((left, right) => left.path.localeCompare(right.path));
  return Object.freeze({
    assets: Object.freeze(assets.map((asset) => Object.freeze(asset))),
    totalBytes: assets.reduce((sum, asset) => sum + asset.bytes, 0),
    budgetBytes: landingAssetBudgets.optional3dCompressedBytes,
  });
}

export function assertLandingModelBudget(measurement: ModelPayloadMeasurement): void {
  if (measurement.totalBytes <= measurement.budgetBytes) return;
  const detail = measurement.assets.map((asset) => `${asset.path}=${asset.bytes}B`).join(", ");
  throw new Error(`Landing 3D payload ${measurement.totalBytes}B exceeds ${measurement.budgetBytes}B budget (${detail})`);
}
