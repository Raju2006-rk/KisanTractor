import "reflect-metadata";
import {
  getPublicRuntimeConfig,
  validateEnvironment,
} from "@kisantractor/config";
import { CORRELATION_ID_HEADER } from "@kisantractor/observability";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";
import { createProcessTelemetry, installApiTelemetry } from "./telemetry.js";
async function bootstrap(): Promise<void> {
  const config = validateEnvironment(process.env);
  const telemetry = createProcessTelemetry(config, "api");
  telemetry.logger.info("environment.validated", { config: getPublicRuntimeConfig(config) });
  // rawBody keeps the exact request bytes so provider webhook signatures are verified over what
  // the provider signed; the webhook route refuses to verify without them.
  const app = await NestFactory.create(AppModule.register({ config, telemetry }), { rawBody: true });
  // Before routing: every request gets a validated correlation ID, span, metrics, and log line.
  const removeTelemetry = installApiTelemetry(app, telemetry);
  app.enableCors({
    origin: config.PUBLIC_WEB_ORIGIN,
    credentials: true,
    exposedHeaders: [CORRELATION_ID_HEADER],
  });
  app.enableShutdownHooks();
  process.once("beforeExit", () => {
    removeTelemetry();
    telemetry.shutdown();
  });
  await app.listen(config.API_PORT, config.API_HOST);
}
void bootstrap();
