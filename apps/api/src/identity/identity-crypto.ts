import {
  createCipheriv,
  createHmac,
  randomBytes,
  randomInt,
} from "node:crypto";

import type { OtpPurpose } from "@kisantractor/domain";

import type { IdentitySecrets } from "./identity.contracts.js";

const requireKey = (key: Uint8Array, name: string, exactLength?: number): Buffer => {
  const value = Buffer.from(key);
  if (exactLength !== undefined && value.length !== exactLength) {
    throw new TypeError(`${name} must be exactly ${exactLength} bytes`);
  }
  if (value.length < 32) {
    throw new TypeError(`${name} must contain at least 32 bytes`);
  }
  return value;
};

const hmac = (key: Uint8Array, domain: string, value: string): string =>
  createHmac("sha256", requireKey(key, `${domain} key`))
    .update(domain)
    .update("\0")
    .update(value)
    .digest("hex");

export class IdentityCrypto {
  readonly #otpHashKey: Buffer;
  readonly #lookupHashKey: Buffer;
  readonly #sessionHashKey: Buffer;
  readonly #phoneEncryptionKey: Buffer;

  constructor(secrets: IdentitySecrets) {
    this.#otpHashKey = requireKey(secrets.otpHashKey, "otpHashKey");
    this.#lookupHashKey = requireKey(secrets.lookupHashKey, "lookupHashKey");
    this.#sessionHashKey = requireKey(secrets.sessionHashKey, "sessionHashKey");
    this.#phoneEncryptionKey = requireKey(
      secrets.phoneEncryptionKey,
      "phoneEncryptionKey",
      32,
    );
  }

  phoneLookupHash(normalizedPhone: string): string {
    return hmac(this.#lookupHashKey, "phone-lookup-v1", normalizedPhone);
  }

  requesterHash(fingerprint: string): string {
    const normalized = fingerprint.trim();
    if (normalized.length === 0) {
      throw new TypeError("requesterFingerprint must not be empty");
    }
    return hmac(this.#lookupHashKey, "otp-requester-v1", normalized);
  }

  otpCodeHash(
    challengeId: string,
    normalizedPhone: string,
    purpose: OtpPurpose,
    code: string,
  ): string {
    return hmac(
      this.#otpHashKey,
      "otp-code-v1",
      `${challengeId}\0${normalizedPhone}\0${purpose}\0${code}`,
    );
  }

  sessionTokenHash(token: string): string {
    return hmac(this.#sessionHashKey, "session-token-v1", token);
  }

  encryptPhone(normalizedPhone: string): Uint8Array {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#phoneEncryptionKey, nonce);
    const ciphertext = Buffer.concat([
      cipher.update(normalizedPhone, "utf8"),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([Buffer.from([1]), nonce, tag, ciphertext]);
  }

  generateOtp(length: number): string {
    if (!Number.isInteger(length) || length < 4 || length > 8) {
      throw new RangeError("otpLength must be an integer from 4 to 8");
    }
    return randomInt(0, 10 ** length).toString().padStart(length, "0");
  }

  generateCredential(): string {
    return randomBytes(32).toString("base64url");
  }
}
