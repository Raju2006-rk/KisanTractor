import "reflect-metadata";

import type { AddressInfo } from "node:net";

import { validateEnvironment } from "@kisantractor/config";
import { createTelemetry, type LogSink } from "@kisantractor/observability";
import { NestFactory } from "@nestjs/core";
import { Pool } from "pg";

import { AppModule } from "../app.module.js";
import { loadRuntimeSecrets } from "../runtime-config.js";
import { PgPoolAdapter } from "../sql-pool.js";
import { installApiTelemetry } from "../telemetry.js";

/**
 * The API under load, in its own process so the load generator does not share its event loop.
 * It composes AppModule exactly as `main.ts` does (request telemetry included) with the test
 * profile: OTP on the labelled local sandbox, every other provider UNCONFIGURED. Secrets arrive
 * as hex in the environment from the parent and never touch disk.
 *
 * The pg pool uses the production default (`createSqlPool`) unless LOAD_API_POOL_MAX is set,
 * which exists only to compare pool sizes during tuning.
 *
 * IPC: sends { type: "ready", port } once listening; answers { type: "metrics" } with the
 * process metric snapshot and { type: "reset-metrics" } by clearing it.
 */
const databaseUrl = process.env.LOAD_API_DATABASE_URL;
if (databaseUrl === undefined || process.send === undefined) {
  throw new Error("load-api-server runs only as a child of the load suite (LOAD_API_DATABASE_URL and IPC required)");
}

const config = validateEnvironment({
  APP_ENV: "test",
  // The validated profile must say "test"; the parent still runs this process with
  // NODE_ENV=production so Express and Node use their production code paths.
  NODE_ENV: "test",
  DATABASE_URL: databaseUrl,
  LOG_LEVEL: "info",
  OTP_CAPABILITY_STATE: "SANDBOX",
  ALLOW_LOCAL_OTP_CODES: "true",
});

// One redacted log line per request, as in production; written to a discarded stdout.
const sink: LogSink = (line) => {
  process.stdout.write(`${line}\n`);
};
const telemetry = createTelemetry({ service: "api", logLevel: "info", sink });
const poolMax = process.env.LOAD_API_POOL_MAX;

const app = await NestFactory.create(AppModule.register({
  config,
  secrets: loadRuntimeSecrets(process.env),
  telemetry,
  ...(poolMax === undefined ? {} : { sqlPool: new PgPoolAdapter(new Pool({ connectionString: databaseUrl, max: Number(poolMax) })) }),
}), { logger: ["error", "warn"] });
installApiTelemetry(app, telemetry);
await app.listen(0, "127.0.0.1");

process.on("message", (message: { type?: string }) => {
  if (message?.type === "metrics") process.send!({ type: "metrics", snapshot: telemetry.metrics.snapshot() });
  if (message?.type === "reset-metrics") {
    telemetry.metrics.reset();
    process.send!({ type: "metrics-reset" });
  }
});
process.on("disconnect", () => {
  void app.close().finally(() => process.exit(0));
});
process.send({ type: "ready", port: (app.getHttpServer().address() as AddressInfo).port });
