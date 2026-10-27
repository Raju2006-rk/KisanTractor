import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { createTestEnvironment } from "@kisantractor/test-utils";

import {
  getPublicRuntimeConfig,
  validateEnvironment,
} from "./environment.js";

describe("environment validation properties", () => {
  it("preserves every valid TCP port", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 65_535 }), (port) => {
        const config = validateEnvironment(
          createTestEnvironment({ API_PORT: String(port) }),
        );

        expect(config.API_PORT).toBe(port);
      }),
    );
  });

  it("never projects database credentials to public runtime config", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Za-z0-9]{1,24}$/),
        fc.stringMatching(/^[A-Za-z0-9]{1,24}$/),
        (username, password) => {
          const databaseUrl = `postgresql://${username}:${password}@localhost:5432/kisantractor_test`;
          const config = validateEnvironment(
            createTestEnvironment({ DATABASE_URL: databaseUrl }),
          );
          const serialized = JSON.stringify(getPublicRuntimeConfig(config));

          expect(serialized).not.toContain(databaseUrl);
          expect(serialized).not.toContain("DATABASE_URL");
        },
      ),
    );
  });
});
