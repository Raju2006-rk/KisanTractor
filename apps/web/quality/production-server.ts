import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

export const webRoot = fileURLToPath(new URL("../", import.meta.url));
const buildIdFile = fileURLToPath(new URL("../.next/BUILD_ID", import.meta.url));
const nextBin = fileURLToPath(new URL("../node_modules/next/dist/bin/next", import.meta.url));

export interface ProductionServer {
  readonly origin: string;
  /** "external" when KT_LANDING_BASE_URL pointed at an already running server. */
  readonly source: "external" | "next-start";
  readonly buildId: string | null;
  stop(): Promise<void>;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address ? resolve(address.port) : reject(new Error("no port"))));
    });
  });
}

async function waitUntilReady(origin: string, timeoutMs: number, exited: () => string | null): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    const exit = exited();
    if (exit !== null) throw new Error(`next start exited early:\n${exit}`);
    try {
      const response = await fetch(`${origin}/`, { redirect: "manual" });
      if (response.status === 200) return;
      lastError = `status ${response.status}`;
    } catch (error) {
      lastError = String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`production server not ready after ${timeoutMs} ms (${lastError})`);
}

/**
 * Serves the existing production build with `next start`, or uses
 * `KT_LANDING_BASE_URL` when set. The child runs without APP_ENV so the
 * runtime infers the local profile: every provider capability is
 * UNCONFIGURED and no booking number exists, which is the launch state the
 * landing page must handle.
 */
export async function startProductionServer(timeoutMs = 90_000): Promise<ProductionServer> {
  const external = process.env.KT_LANDING_BASE_URL;
  if (external) {
    return { origin: external.replace(/\/$/, ""), source: "external", buildId: null, stop: async () => undefined };
  }
  if (!existsSync(buildIdFile)) {
    throw new Error("No production build in apps/web/.next. Run `corepack pnpm --filter @kisantractor/web build` first.");
  }
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const env: NodeJS.ProcessEnv = { ...process.env, NEXT_TELEMETRY_DISABLED: "1", PORT: String(port) };
  for (const key of ["APP_ENV", "NODE_ENV", "TELEPHONY_CAPABILITY_STATE", "TELEPHONY_BOOKING_NUMBER", "VITEST", "VITEST_POOL_ID", "VITEST_WORKER_ID", "TEST"]) delete env[key];
  const child = spawn(process.execPath, [nextBin, "start", "-p", String(port), "-H", "127.0.0.1"], { cwd: webRoot, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  let exit: string | null = null;
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.once("exit", (code) => { exit = `code ${code}\n${output}`; });
  try {
    await waitUntilReady(origin, timeoutMs, () => exit);
  } catch (error) {
    child.kill();
    throw error;
  }
  return {
    origin,
    source: "next-start",
    buildId: readFileSync(buildIdFile, "utf8").trim(),
    stop: () => new Promise<void>((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once("exit", () => resolve());
      child.kill();
    }),
  };
}
