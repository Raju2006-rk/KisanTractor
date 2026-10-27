import {
  deploymentEnvironments,
  getPublicRuntimeConfig,
  validateEnvironment,
} from "./index.js";

const requestedEnvironment = process.argv[2];

if (
  requestedEnvironment !== undefined &&
  !deploymentEnvironments.some((environment) => environment === requestedEnvironment)
) {
  console.error(
    `Unknown environment profile. Expected one of: ${deploymentEnvironments.join(", ")}.`,
  );
  process.exitCode = 1;
} else {
  try {
    const config = validateEnvironment({
      ...process.env,
      ...(requestedEnvironment === undefined
        ? {}
        : { APP_ENV: requestedEnvironment }),
    });
    console.log(JSON.stringify(getPublicRuntimeConfig(config)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Configuration failed.");
    process.exitCode = 1;
  }
}
