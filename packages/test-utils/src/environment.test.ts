import { describe, expect, it } from "vitest";

import { createTestEnvironment } from "./environment.js";

describe("createTestEnvironment", () => {
  it("returns isolated repeatable test configuration", () => {
    const first = createTestEnvironment({ API_PORT: "4999" });
    const second = createTestEnvironment();

    expect(first.API_PORT).toBe("4999");
    expect(second.API_PORT).toBe("4100");
    expect(second.APP_ENV).toBe("test");
  });
});
