/**
 * Progressive-enhancement policy for the landing hero.
 *
 * The server always renders the complete landing page and poster first. This
 * module only decides whether an optional scene may be added; it never owns or
 * removes copy, navigation, controls, or calls to action.
 */

/** Marks the hero element an optional scene may enhance. The poster inside stays the fallback. */
export const heroSceneSlot = "hero-scene";

/** Device memory, in GB, below which the optional scene is never loaded. */
export const minimumSceneDeviceMemoryGb = 4;

/** Conservative texture capability required before spending bandwidth on the model. */
export const minimumSceneTextureSize = 4096;

export const landingSceneEvents = {
  eligible: "kisantractor:landing-scene-eligible",
  loaded: "kisantractor:landing-scene-loaded",
  loadFailed: "kisantractor:landing-scene-load-failed",
} as const;

export type GpuConfidence = "HIGH" | "UNKNOWN" | "LOW";

export type LandingSceneFallbackReason =
  | "SCRIPTING_DISABLED"
  | "REDUCED_MOTION"
  | "DATA_SAVER"
  | "LOW_DEVICE_MEMORY"
  | "LOW_GPU_CONFIDENCE"
  | "LOAD_FAILED";

export interface LandingEnhancementSignals {
  /** False when the scene cannot run, including a disabled-script/static render. */
  readonly scriptsAvailable: boolean;
  /** `prefers-reduced-motion: reduce`. */
  readonly prefersReducedMotion: boolean;
  /** `Save-Data: on`, `navigator.connection.saveData`, or `prefers-reduced-data: reduce`. */
  readonly dataSaver: boolean;
  /** `navigator.deviceMemory` when the browser reports it. */
  readonly deviceMemoryGb?: number | undefined;
  /** Browser graphics confidence; LOW always selects the poster. */
  readonly gpuConfidence?: GpuConfidence | undefined;
  /** True after the separately loaded scene reports an error or timeout. */
  readonly sceneLoadFailed?: boolean | undefined;
}

export type LandingSceneDecision =
  | { readonly enhance: true; readonly reason: null }
  | { readonly enhance: false; readonly reason: LandingSceneFallbackReason };

/** Returns one stable fallback reason, ordered from user preference to runtime failure. */
export function assessLandingSceneCapability(signals: LandingEnhancementSignals): LandingSceneDecision {
  if (!signals.scriptsAvailable) return { enhance: false, reason: "SCRIPTING_DISABLED" };
  if (signals.prefersReducedMotion) return { enhance: false, reason: "REDUCED_MOTION" };
  if (signals.dataSaver) return { enhance: false, reason: "DATA_SAVER" };

  const memory = signals.deviceMemoryGb;
  if (memory !== undefined && (!Number.isFinite(memory) || memory < minimumSceneDeviceMemoryGb)) {
    return { enhance: false, reason: "LOW_DEVICE_MEMORY" };
  }
  if (signals.gpuConfidence === "LOW") return { enhance: false, reason: "LOW_GPU_CONFIDENCE" };
  if (signals.sceneLoadFailed) return { enhance: false, reason: "LOAD_FAILED" };
  return { enhance: true, reason: null };
}

/** True only when nothing asks for the complete static experience. */
export function shouldEnhanceLandingScene(signals: LandingEnhancementSignals): boolean {
  return assessLandingSceneCapability(signals).enhance;
}

export interface SceneStateElement {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

/**
 * Records enhancement state without changing any descendants. In particular,
 * fallback handling cannot remove or disable the server-rendered poster or CTAs.
 */
export function applyLandingSceneDecision(element: SceneStateElement, decision: LandingSceneDecision): void {
  element.setAttribute("data-scene-state", decision.enhance ? "eligible" : "fallback");
  if (decision.reason === null) element.removeAttribute("data-scene-fallback-reason");
  else element.setAttribute("data-scene-fallback-reason", decision.reason);
}

export interface WebGlContextLike {
  readonly MAX_TEXTURE_SIZE: number;
  getParameter(parameter: number): unknown;
  isContextLost?(): boolean;
}

export interface GraphicsCanvasLike {
  getContext(contextId: "webgl2" | "webgl"): WebGlContextLike | null;
}

/**
 * Makes a small, local graphics probe. Failure is contained and means the
 * optional scene is skipped; UNKNOWN is reserved for browsers that cannot be
 * probed and does not override their other capability signals.
 */
export function detectGpuConfidence(canvas: GraphicsCanvasLike | null | undefined): GpuConfidence {
  if (!canvas) return "UNKNOWN";
  try {
    const context = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    if (!context || context.isContextLost?.()) return "LOW";
    const textureSize = context.getParameter(context.MAX_TEXTURE_SIZE);
    return typeof textureSize === "number" && Number.isFinite(textureSize) && textureSize >= minimumSceneTextureSize
      ? "HIGH"
      : "LOW";
  } catch {
    return "LOW";
  }
}

/** Reads the `Save-Data` client hint; only the literal token `on` requests reduced data. */
export function prefersDataSaver(saveDataHeader: string | null | undefined): boolean {
  return saveDataHeader?.trim().toLowerCase() === "on";
}
