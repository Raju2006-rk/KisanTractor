import { readFileSync } from "node:fs";

/** A style rule with its enclosing `@media` condition, if any. */
export interface CssRule {
  readonly media: string | null;
  readonly selectors: readonly string[];
  readonly body: string;
}

/** Splits a stylesheet into style rules; nested `@media` blocks are flattened. */
export function parseCssRules(source: string): CssRule[] {
  const rules: CssRule[] = [];
  const walk = (text: string, media: string | null) => {
    let position = 0;
    while (position < text.length) {
      const open = text.indexOf("{", position);
      if (open < 0) return;
      const prelude = text.slice(position, open).split(/[;}]/).at(-1)!.trim();
      let depth = 1;
      let close = open + 1;
      for (; close < text.length && depth > 0; close += 1) {
        if (text[close] === "{") depth += 1;
        if (text[close] === "}") depth -= 1;
      }
      const body = text.slice(open + 1, close - 1);
      if (prelude.startsWith("@media")) walk(body, prelude);
      else if (!prelude.startsWith("@")) {
        rules.push({ media, selectors: prelude.split(",").map((part) => part.replace(/\s+/g, " ").trim()), body });
      }
      position = close;
    }
  };
  walk(source.replace(/\/\*[\s\S]*?\*\//g, ""), null);
  return rules;
}

export function declarationValue(body: string, property: string): string | undefined {
  const escaped = property.replace(/[-]/g, "\\-");
  return new RegExp(`(?:^|[;{\\s])${escaped}\\s*:\\s*([^;]+)`).exec(body)?.[1]?.trim();
}

export class Stylesheet {
  readonly source: string;
  readonly rules: readonly CssRule[];
  readonly tokens: ReadonlyMap<string, string>;

  constructor(source: string) {
    this.source = source;
    this.rules = parseCssRules(source);
    const tokens = new Map<string, string>();
    for (const rule of this.rules) {
      if (rule.media !== null || !rule.selectors.includes(":root")) continue;
      for (const match of rule.body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+)/gi)) tokens.set(match[1]!, match[2]!.trim());
    }
    this.tokens = tokens;
  }

  static fromFile(url: URL): Stylesheet {
    return new Stylesheet(readFileSync(url, "utf8"));
  }

  /** Replaces `var(--token)` references with token values until none remain. */
  resolve(value: string): string {
    let current = value;
    for (let depth = 0; depth < 10 && current.includes("var("); depth += 1) {
      current = current.replace(/var\((--[a-z0-9-]+)\)/gi, (_match, name: string) => {
        const token = this.tokens.get(name);
        if (token === undefined) throw new Error(`unknown token ${name}`);
        return token;
      });
    }
    return current;
  }

  /** The last unconditional declaration of `property` on a rule listing exactly `selector`. */
  value(selector: string, property: string): string {
    const normalized = selector.replace(/\s+/g, " ").trim();
    let found: string | undefined;
    for (const rule of this.rules) {
      if (rule.media !== null || !rule.selectors.includes(normalized)) continue;
      found = declarationValue(rule.body, property) ?? found;
    }
    if (found === undefined) throw new Error(`no ${property} declared for ${selector}`);
    return this.resolve(found);
  }

  /** Every hex color in the resolved value (all stops of a gradient). */
  colors(selector: string, property: string): string[] {
    const colors = this.value(selector, property).match(/#[0-9a-f]{6}\b|#[0-9a-f]{3}\b/gi);
    if (!colors) throw new Error(`no hex color in ${selector} ${property}`);
    return colors;
  }
}

/** Converts a CSS length in px or rem (16 px root) to CSS pixels. */
export function cssLengthToPx(value: string): number {
  const match = /^(-?\d*\.?\d+)(px|rem)$/.exec(value.trim());
  if (!match) throw new Error(`unsupported length: ${value}`);
  return Number(match[1]) * (match[2] === "rem" ? 16 : 1);
}
