/**
 * Runs the production-build landing suite (`landing.production.test.ts`).
 * Build first: `corepack pnpm --filter @kisantractor/web build`.
 * Extra arguments are passed to Vitest.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const vitest = fileURLToPath(new URL("../../../node_modules/vitest/vitest.mjs", import.meta.url));

const result = spawnSync(
  process.execPath,
  [vitest, "run", "apps/web/quality/landing.production.test.ts", ...process.argv.slice(2)],
  { cwd: repositoryRoot, stdio: "inherit", env: { ...process.env, KT_LANDING_PRODUCTION_TESTS: "1" } },
);
process.exit(result.status ?? 1);
