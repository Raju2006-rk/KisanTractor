import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const vitest = fileURLToPath(new URL("../../../node_modules/vitest/vitest.mjs", import.meta.url));
const result = spawnSync(process.execPath, [vitest, "run", "apps/web/quality/landing-budget.test.ts"], {
  cwd: repositoryRoot,
  stdio: "inherit",
  env: process.env,
});
process.exit(result.status ?? 1);
