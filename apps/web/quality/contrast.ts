/** WCAG 2.x relative luminance and contrast ratio for sRGB colors. */

export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/** Parses `#rgb` or `#rrggbb`. */
export function parseHexColor(value: string): Rgb {
  const hex = value.trim().replace(/^#/, "");
  const full = hex.length === 3 ? [...hex].map((digit) => digit + digit).join("") : hex;
  if (!/^[0-9a-f]{6}$/i.test(full)) throw new Error(`not a hex color: ${value}`);
  return {
    r: Number.parseInt(full.slice(0, 2), 16),
    g: Number.parseInt(full.slice(2, 4), 16),
    b: Number.parseInt(full.slice(4, 6), 16),
  };
}

function channel(value: number): number {
  const srgb = value / 255;
  return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance({ r, g, b }: Rgb): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** Contrast ratio between two opaque colors, from 1 to 21. */
export function contrastRatio(first: Rgb | string, second: Rgb | string): number {
  const a = relativeLuminance(typeof first === "string" ? parseHexColor(first) : first);
  const b = relativeLuminance(typeof second === "string" ? parseHexColor(second) : second);
  const [light, dark] = a >= b ? [a, b] : [b, a];
  return (light + 0.05) / (dark + 0.05);
}
