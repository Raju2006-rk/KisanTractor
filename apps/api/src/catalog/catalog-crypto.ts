import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

import type { CatalogSecrets } from "./catalog.contracts.js";

const requireKey = (key: Uint8Array, name: string, exactLength?: number): Buffer => {
  const value = Buffer.from(key);
  if (exactLength !== undefined && value.length !== exactLength) {
    throw new TypeError(`${name} must be exactly ${exactLength} bytes`);
  }
  if (value.length < 32) throw new TypeError(`${name} must contain at least 32 bytes`);
  return value;
};

export class CatalogCrypto {
  readonly #fieldEncryptionKey: Buffer;
  readonly #lookupHashKey: Buffer;

  constructor(secrets: CatalogSecrets) {
    this.#fieldEncryptionKey = requireKey(secrets.fieldEncryptionKey, "fieldEncryptionKey", 32);
    this.#lookupHashKey = requireKey(secrets.lookupHashKey, "lookupHashKey");
  }

  encrypt(value: string, purpose: "registration" | "photo-object-key" | "document-object-key"): Uint8Array {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#fieldEncryptionKey, nonce);
    cipher.setAAD(Buffer.from(`catalog-${purpose}-v1`, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return Buffer.concat([Buffer.from([1]), nonce, cipher.getAuthTag(), ciphertext]);
  }

  decrypt(value: Uint8Array, purpose: "registration" | "photo-object-key" | "document-object-key"): string {
    const envelope = Buffer.from(value);
    if (envelope.length < 30 || envelope[0] !== 1) throw new Error("Unsupported encrypted catalog value");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.#fieldEncryptionKey,
      envelope.subarray(1, 13),
    );
    decipher.setAAD(Buffer.from(`catalog-${purpose}-v1`, "utf8"));
    decipher.setAuthTag(envelope.subarray(13, 29));
    return Buffer.concat([
      decipher.update(envelope.subarray(29)),
      decipher.final(),
    ]).toString("utf8");
  }

  registrationLookupHash(registrationNumber: string): string {
    return createHmac("sha256", this.#lookupHashKey)
      .update("tractor-registration-v1")
      .update("\0")
      .update(registrationNumber)
      .digest("hex");
  }
}
