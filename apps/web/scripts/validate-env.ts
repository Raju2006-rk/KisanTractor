import {
  getPublicRuntimeConfig,
  validateEnvironment,
} from "@kisantractor/config";

try {
  const config = validateEnvironment(process.env);
  console.log(
    JSON.stringify({
      event: "environment.validated",
      service: "web",
      config: getPublicRuntimeConfig(config),
    }),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : "Configuration failed.");
  process.exitCode = 1;
}
