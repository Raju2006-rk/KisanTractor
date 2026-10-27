import { describe, expect, it } from "vitest";

import { isSerializationFailure, retrySerializationFailures } from "./serialization-retry.js";

const failure = (code: string) => Object.assign(new Error(`database error ${code}`), { code });
const noPause = async () => undefined;

describe("retrySerializationFailures", () => {
  it("re-runs the whole transaction after a serialization failure or deadlock until it commits", async () => {
    const outcomes = [failure("40001"), failure("40P01"), "committed"];
    let attempts = 0;
    const result = await retrySerializationFailures(async () => {
      const next = outcomes[attempts++]!;
      if (next instanceof Error) throw next;
      return next;
    }, { pause: noPause });
    expect(result).toBe("committed");
    expect(attempts).toBe(3);
  });

  it("rethrows the last database error unchanged once attempts are exhausted", async () => {
    let attempts = 0;
    const error = failure("40001");
    await expect(retrySerializationFailures(async () => {
      attempts += 1;
      throw error;
    }, { attempts: 3, pause: noPause })).rejects.toBe(error);
    expect(attempts).toBe(3);
  });

  it("never retries domain errors or other database errors unless asked to", async () => {
    let attempts = 0;
    await expect(retrySerializationFailures(async () => {
      attempts += 1;
      throw failure("23P01");
    }, { pause: noPause })).rejects.toMatchObject({ code: "23P01" });
    expect(attempts).toBe(1);

    attempts = 0;
    await expect(retrySerializationFailures(async () => {
      attempts += 1;
      throw failure("23P01");
    }, { pause: noPause, attempts: 2, alsoRetry: new Set(["23P01"]) })).rejects.toMatchObject({ code: "23P01" });
    expect(attempts).toBe(2);

    attempts = 0;
    await expect(retrySerializationFailures(async () => {
      attempts += 1;
      throw new Error("The selected interval is no longer available");
    }, { pause: noPause })).rejects.toThrow("no longer available");
    expect(attempts).toBe(1);
    expect(isSerializationFailure(new Error("plain"))).toBe(false);
  });
});
