import { createCipheriv, createHmac, randomBytes } from "node:crypto";

import type { BookingSecrets } from "./booking.contracts.js";

const key = (value: Uint8Array, name: string, exact = false): Buffer => {
  const result = Buffer.from(value);
  if ((exact && result.length !== 32) || (!exact && result.length < 32)) {
    throw new TypeError(`${name} must ${exact ? "be exactly" : "contain at least"} 32 bytes`);
  }
  return result;
};

export class BookingCrypto {
  readonly #encryptionKey: Buffer;
  readonly #lookupKey: Buffer;

  constructor(secrets: BookingSecrets) {
    this.#encryptionKey = key(secrets.fieldEncryptionKey, "fieldEncryptionKey", true);
    this.#lookupKey = key(secrets.lookupHashKey, "lookupHashKey");
  }

  encryptCoordinationPhone(phone: string): Uint8Array {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#encryptionKey, nonce);
    cipher.setAAD(Buffer.from("booking-recipient-phone-v1", "utf8"));
    const encrypted = Buffer.concat([cipher.update(phone, "utf8"), cipher.final()]);
    return Buffer.concat([
      Buffer.from([1]), nonce, cipher.getAuthTag(), encrypted,
    ]);
  }

  coordinationPhoneLookupHash(phone: string): string {
    return createHmac("sha256", this.#lookupKey)
      .update("booking-recipient-phone-v1\0")
      .update(phone)
      .digest("hex");
  }
}
