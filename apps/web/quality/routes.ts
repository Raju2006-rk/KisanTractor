import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const webAppDirectory = fileURLToPath(new URL("../src/app/", import.meta.url));

const isGroup = (segment: string) => /^\(.+\)$/.test(segment);
const isDynamic = (segment: string) => /^\[[^.\]]+\]$/.test(segment);
const isCatchAll = (segment: string) => /^\[\.\.\.[^\]]+\]$/.test(segment);
const isOptionalCatchAll = (segment: string) => /^\[\[\.\.\.[^\]]+\]\]$/.test(segment);
const hasPage = (directory: string) => existsSync(join(directory, "page.tsx")) || existsSync(join(directory, "page.ts"));

function directories(directory: string): string[] {
  return readdirSync(directory).filter((entry) => statSync(join(directory, entry)).isDirectory());
}

/**
 * True when an App Router page under `src/app` serves `pathname`, following
 * route groups, dynamic segments, and (optional) catch-all segments the same
 * way Next.js matches them. Route handlers are not pages and do not count.
 */
export function pageRouteExists(pathname: string, root: string = webAppDirectory): boolean {
  const segments = pathname.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment));
  const match = (directory: string, remaining: readonly string[]): boolean => {
    const children = directories(directory);
    if (remaining.length === 0) {
      if (hasPage(directory)) return true;
      return children.some((child) =>
        (isGroup(child) && match(join(directory, child), remaining))
        || (isOptionalCatchAll(child) && hasPage(join(directory, child))));
    }
    const [head, ...rest] = remaining;
    return children.some((child) => {
      const next = join(directory, child);
      if (isGroup(child)) return match(next, remaining);
      if (child === head || isDynamic(child)) return match(next, rest);
      if (isCatchAll(child) || isOptionalCatchAll(child)) return hasPage(next);
      return false;
    });
  };
  return match(root, segments);
}
