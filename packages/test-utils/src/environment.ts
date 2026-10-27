const baseTestEnvironment = {
  CONFIG_VERSION: "1",
  APP_ENV: "test",
  NODE_ENV: "test",
  API_HOST: "127.0.0.1",
  API_PORT: "4100",
  PUBLIC_WEB_ORIGIN: "http://localhost:3100",
  PUBLIC_API_ORIGIN: "http://localhost:4100",
  DATABASE_URL:
    "postgresql://test-user:test-password@localhost:5432/kisantractor_test",
  LOG_LEVEL: "warn",
  ENABLE_PWA: "false",
} as const;

export function createTestEnvironment(
  overrides: Readonly<Record<string, string | undefined>> = {},
): NodeJS.ProcessEnv {
  return { ...baseTestEnvironment, ...overrides };
}
