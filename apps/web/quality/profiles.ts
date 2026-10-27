/**
 * Representative device profiles and budgets for the public landing page.
 *
 * This module is the single definition used by the source-level checks
 * (`src/components/landing/landing-quality.test.ts`), the production-build
 * checks, and the browser lab suite (`landing.production.test.ts`). The
 * README in this directory explains each value; change them here only.
 */

/** Network shaping applied through the DevTools protocol (per-request latency, not RTT). */
export interface NetworkProfile {
  readonly id: string;
  /** Added latency per request, in milliseconds. */
  readonly latencyMs: number;
  readonly downloadKbps: number;
  readonly uploadKbps: number;
}

/**
 * Lighthouse's "slow 4G" mobile preset as applied by DevTools throttling:
 * 150 ms RTT and 1.6 Mbps down / 750 Kbps up, scaled by Lighthouse's
 * devtools factors (latency × 3.75, throughput × 0.9).
 */
export const slow4g: NetworkProfile = Object.freeze({
  id: "slow-4g",
  latencyMs: 562.5,
  downloadKbps: 1474.56,
  uploadKbps: 675,
});

export type ProfileKind = "mobile" | "tablet" | "laptop" | "desktop";

export interface DeviceProfile {
  readonly id: string;
  readonly kind: ProfileKind;
  readonly description: string;
  /** CSS-pixel viewport. For zoomed profiles this is the effective viewport after zoom. */
  readonly width: number;
  readonly height: number;
  readonly deviceScaleFactor: number;
  readonly mobile: boolean;
  readonly touch: boolean;
  /** DevTools CPU slowdown multiplier; 1 means unthrottled. */
  readonly cpuSlowdown: number;
  readonly network: NetworkProfile | null;
  /** Browser zoom represented by this profile (2 = 200%). */
  readonly zoom: number;
}

/**
 * Profiles the landing page must serve (Requirements 13.5, 16.6, 17.1).
 *
 * `low-end-mobile` is the representative mobile profile for web-vital budgets:
 * a 360×640 CSS-pixel Android phone with a 4× slower CPU on slow 4G.
 * `desktop-zoom-200` is a 1280×800 laptop window at 200% zoom, which gives a
 * 640×400 CSS-pixel viewport at device scale factor 2.
 */
export const deviceProfiles = Object.freeze({
  lowEndMobile: {
    id: "low-end-mobile",
    kind: "mobile",
    description: "Entry-level Android phone, 360×640 CSS px at 2×, 4× CPU slowdown, slow 4G",
    width: 360,
    height: 640,
    deviceScaleFactor: 2,
    mobile: true,
    touch: true,
    cpuSlowdown: 4,
    network: slow4g,
    zoom: 1,
  },
  narrowMobile: {
    id: "narrow-mobile",
    kind: "mobile",
    description: "Smallest supported phone width, 320×568 CSS px at 2×, 4× CPU slowdown, slow 4G",
    width: 320,
    height: 568,
    deviceScaleFactor: 2,
    mobile: true,
    touch: true,
    cpuSlowdown: 4,
    network: slow4g,
    zoom: 1,
  },
  tablet: {
    id: "tablet",
    kind: "tablet",
    description: "Portrait tablet, 768×1024 CSS px at 2×",
    width: 768,
    height: 1024,
    deviceScaleFactor: 2,
    mobile: true,
    touch: true,
    cpuSlowdown: 1,
    network: null,
    zoom: 1,
  },
  laptop: {
    id: "laptop",
    kind: "laptop",
    description: "Common laptop window, 1366×768 CSS px at 1×",
    width: 1366,
    height: 768,
    deviceScaleFactor: 1,
    mobile: false,
    touch: false,
    cpuSlowdown: 1,
    network: null,
    zoom: 1,
  },
  desktop: {
    id: "desktop",
    kind: "desktop",
    description: "Full-HD desktop, 1920×1080 CSS px at 1×",
    width: 1920,
    height: 1080,
    deviceScaleFactor: 1,
    mobile: false,
    touch: false,
    cpuSlowdown: 1,
    network: null,
    zoom: 1,
  },
  desktopZoom200: {
    id: "desktop-zoom-200",
    kind: "laptop",
    description: "1280×800 laptop window at 200% zoom: 640×400 CSS px at 2×",
    width: 640,
    height: 400,
    deviceScaleFactor: 2,
    mobile: false,
    touch: false,
    cpuSlowdown: 1,
    network: null,
    zoom: 2,
  },
} as const satisfies Record<string, DeviceProfile>);

export const allDeviceProfiles: readonly DeviceProfile[] = Object.values(deviceProfiles);

/** The profile Requirement 16.6 budgets are measured on. */
export const representativeMobileProfile: DeviceProfile = deviceProfiles.lowEndMobile;

/**
 * Landing web-vital budgets (Requirement 16.6, design "Performance budgets").
 * Lab runs cannot observe field INP directly, so observed interaction duration
 * is the INP gate. TBT is retained as a diagnostic, not a release gate.
 */
export const webVitalBudgets = Object.freeze({
  lcpMs: 2500,
  cls: 0.1,
  inpMs: 200,
  tbtMs: 200,
});

/** Cold-load lab runs per profile; the budget applies to their nearest-rank 75th percentile. */
export const defaultLabRuns = 3;

/**
 * Transfer budgets checked from source and from the production build.
 * Sizes are bytes; JavaScript and CSS are measured gzip-compressed.
 */
export const landingAssetBudgets = Object.freeze({
  /** Largest committed crop of any single landing image, in any format. */
  maxImageBytes: 40_000,
  /** Worst case a browser downloads for all landing images (largest crop of each). */
  totalImageBytes: 75_000,
  /** All JavaScript the landing route loads on startup, including the framework runtime. */
  initialJsGzipBytes: 180_000,
  /** All render-blocking CSS for the landing route. */
  cssGzipBytes: 16_000,
  /** The server-rendered landing HTML document. */
  htmlGzipBytes: 30_000,
  /** Aggregate deployed bytes for the initial compressed 3D model and textures. */
  optional3dCompressedBytes: 1_500_000,
});

/** Accessibility thresholds (Requirement 13.4). */
export const accessibilityThresholds = Object.freeze({
  /** Minimum pointer target in CSS pixels. */
  minTargetPx: 44,
  /** WCAG 2.2 AA 1.4.3 normal text. */
  textContrast: 4.5,
  /** WCAG 2.2 AA 1.4.3 large text (≥24 px, or ≥18.66 px bold). */
  largeTextContrast: 3,
  /** WCAG 2.2 AA 1.4.11 non-text contrast, used for focus indicators. */
  nonTextContrast: 3,
  /** Smallest rendered text size allowed on the landing page. */
  minFontPx: 14,
  /** Minimum focus outline thickness in CSS pixels. */
  minFocusOutlinePx: 2,
});

/** Nearest-rank percentile of a nonempty sample. */
export function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) throw new Error("percentile of an empty sample");
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(fraction * sorted.length));
  return sorted[rank - 1]!;
}
