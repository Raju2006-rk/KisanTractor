import { describe, expect, it, vi } from "vitest";

import { LocalDevelopmentOtpAdapter } from "./otp.js";

const request = {
  challengeId: "10000000-0000-4000-8000-000000000001",
  normalizedPhone: "+919876543210",
  purpose: "SIGN_IN" as const,
  code: "042381",
  expiresAt: new Date("2026-01-01T00:05:00.000Z"),
};

describe("LocalDevelopmentOtpAdapter", () => {
  it("clearly labels a local code and performs no hidden external action", async () => {
    const onDelivery = vi.fn();
    const adapter = new LocalDevelopmentOtpAdapter({
      environment: "test",
      enabled: true,
      onDelivery,
    });

    await expect(adapter.send(request)).resolves.toEqual({
      adapter: "local-development",
      testOnly: true,
      userMessage: "Development OTP only — no live message was sent.",
      developmentCode: "042381",
    });
    expect(onDelivery).toHaveBeenCalledWith(request);
  });

  it("requires opt-in and refuses staging or production construction", () => {
    expect(
      () =>
        new LocalDevelopmentOtpAdapter({ environment: "local", enabled: false }),
    ).toThrow(/explicit opt-in/);
    expect(
      () =>
        new LocalDevelopmentOtpAdapter({
          environment: "production",
          enabled: true,
        }),
    ).toThrow(/only in local or test/);
    expect(
      () =>
        new LocalDevelopmentOtpAdapter({ environment: "staging", enabled: true }),
    ).toThrow(/only in local or test/);
  });
});
