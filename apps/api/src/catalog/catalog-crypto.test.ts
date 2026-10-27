import { describe, expect, it } from "vitest";

import { CatalogCrypto } from "./catalog-crypto.js";

const secrets = {
  fieldEncryptionKey: new Uint8Array(32).fill(11),
  lookupHashKey: new Uint8Array(32).fill(17),
};

describe("CatalogCrypto", () => {
  it("round-trips registration values with randomized authenticated ciphertext", () => {
    const crypto = new CatalogCrypto(secrets);
    const first = crypto.encrypt("TS08AB1234", "registration");
    const second = crypto.encrypt("TS08AB1234", "registration");

    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(false);
    expect(crypto.decrypt(first, "registration")).toBe("TS08AB1234");
    expect(Buffer.from(first).includes(Buffer.from("TS08AB1234"))).toBe(false);
  });

  it("uses a deterministic blind index without exposing plaintext", () => {
    const crypto = new CatalogCrypto(secrets);
    const hash = crypto.registrationLookupHash("TS08AB1234");
    expect(hash).toBe(crypto.registrationLookupHash("TS08AB1234"));
    expect(hash).not.toContain("TS08AB1234");
  });

  it("rejects ciphertext under the wrong field purpose", () => {
    const crypto = new CatalogCrypto(secrets);
    const encrypted = crypto.encrypt("private/photo.webp", "photo-object-key");
    expect(() => crypto.decrypt(encrypted, "registration")).toThrow();
  });
});
