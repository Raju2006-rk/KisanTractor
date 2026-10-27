import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";

/**
 * Thin wrappers around `pg_dump` and `pg_restore` for logical backups and restore drills.
 *
 * Credentials never appear on a command line: they travel in the child's PG* environment
 * variables (and, in container mode, `docker exec -e NAME` copies them from that environment).
 * Error messages carry the tool's exit code and a bounded stderr excerpt, which names objects but
 * never row data.
 */
export interface PgToolsOptions {
  /**
   * Run the tools inside this Docker container, connecting over the container's local socket.
   * Use it when the client tools are not installed on the host (for example the local PostGIS
   * container from apps/api/src/e2e/README.md).
   */
  readonly container?: string;
  /** Directory containing pg_dump/pg_restore when they are not on PATH. */
  readonly binDirectory?: string;
}

interface ConnectionParts {
  readonly host: string;
  readonly port: string;
  readonly user: string;
  readonly password: string;
  readonly database: string;
}

export class PgToolError extends Error {
  readonly code = "PG_TOOL_FAILED";

  constructor(readonly tool: string, readonly exitCode: number | null, readonly stderrExcerpt: string) {
    super(`${tool} exited with ${exitCode ?? "a signal"}: ${stderrExcerpt}`);
    this.name = "PgToolError";
  }
}

export function connectionParts(databaseUrl: string): ConnectionParts {
  const url = new URL(databaseUrl);
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") throw new TypeError("Database URL must use PostgreSQL");
  const database = decodeURIComponent(url.pathname.slice(1));
  if (database.length === 0) throw new TypeError("Database URL must name a database");
  return {
    host: url.hostname,
    port: url.port || "5432",
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
  };
}

/** Removes anything that looks like a connection URL or password from tool output. */
const redactStderr = (stderr: string): string =>
  stderr.replace(/postgres(?:ql)?:\/\/\S+/giu, "[connection-url]").replace(/password\S*/giu, "[password]").slice(-2_000).trim();

export interface Invocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
}

export function pgToolInvocation(tool: "pg_dump" | "pg_restore", toolArgs: readonly string[], parts: ConnectionParts, options: PgToolsOptions): Invocation {
  const pgEnv = { PGUSER: parts.user, PGPASSWORD: parts.password, PGDATABASE: parts.database };
  if (options.container !== undefined) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(options.container)) throw new TypeError("Invalid container name");
    return {
      command: "docker",
      args: ["exec", "-i", "-e", "PGUSER", "-e", "PGPASSWORD", "-e", "PGDATABASE", options.container, tool, ...toolArgs],
      env: { ...process.env, ...pgEnv },
    };
  }
  return {
    command: options.binDirectory === undefined ? tool : join(options.binDirectory, tool),
    args: [...toolArgs],
    env: { ...process.env, ...pgEnv, PGHOST: parts.host, PGPORT: parts.port },
  };
}

async function run(
  tool: "pg_dump" | "pg_restore",
  call: Invocation,
  io: { readonly stdinFile?: string; readonly stdoutFile?: string },
): Promise<void> {
  const child = spawn(call.command, call.args, {
    env: call.env,
    stdio: [io.stdinFile === undefined ? "ignore" : "pipe", io.stdoutFile === undefined ? "ignore" : "pipe", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-8_000);
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code));
  });
  const transfers: Promise<void>[] = [];
  if (io.stdoutFile !== undefined && child.stdout !== null) transfers.push(pipeline(child.stdout, createWriteStream(io.stdoutFile)));
  if (io.stdinFile !== undefined && child.stdin !== null) transfers.push(pipeline(createReadStream(io.stdinFile), child.stdin));
  const [exitCode] = await Promise.all([exited, ...transfers]);
  if (exitCode !== 0) throw new PgToolError(tool, exitCode, redactStderr(stderr));
}

export interface DumpResult {
  readonly bytes: number;
  readonly durationMs: number;
}

/**
 * Writes a custom-format logical backup of the whole database (schema, data, extensions, and the
 * migration ledger) to `outputFile`. The file holds personal data: keep it encrypted and delete it
 * when the drill ends.
 */
export async function dumpDatabase(databaseUrl: string, outputFile: string, options: PgToolsOptions = {}): Promise<DumpResult> {
  const parts = connectionParts(databaseUrl);
  const started = performance.now();
  await run("pg_dump", pgToolInvocation("pg_dump", ["--format=custom", "--no-owner", "--no-privileges", "--compress=6"], parts, options),
    { stdoutFile: outputFile });
  return { bytes: (await stat(outputFile)).size, durationMs: Math.round(performance.now() - started) };
}

/** Restores a custom-format backup into an empty database in one transaction, stopping at the first error. */
export async function restoreDatabase(databaseUrl: string, inputFile: string, options: PgToolsOptions = {}): Promise<{ durationMs: number }> {
  const parts = connectionParts(databaseUrl);
  const started = performance.now();
  await run("pg_restore", pgToolInvocation("pg_restore", [
    "--no-owner", "--no-privileges", "--exit-on-error", "--single-transaction", `--dbname=${parts.database}`,
  ], parts, options), { stdinFile: inputFile });
  return { durationMs: Math.round(performance.now() - started) };
}
