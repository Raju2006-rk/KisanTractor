import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

import type { SqlPool } from "@kisantractor/database";
import { SHAREABLE_PHONE_PATTERN } from "@kisantractor/domain";
import type { PushDeviceDirectory, PushDeviceToken, SmsRecipientDirectory } from "@kisantractor/providers";

/** Keys for contact resolution; the same runtime secrets the identity and catalog stores use. */
export interface MessagingDirectorySecrets {
  /** Decrypts `users.normalized_phone_ciphertext` (written by identity). */
  readonly phoneEncryptionKey: Uint8Array;
  /** Encrypts push registration tokens at rest. */
  readonly fieldEncryptionKey: Uint8Array;
  /** Keyed hash for push-token lookups. */
  readonly lookupHashKey: Uint8Array;
}

/** Resolves the Owner's shareable phone; the caller has already applied the sharing policy. */
export interface OwnerContactDirectory {
  ownerPhone(ownerId: string): Promise<string | undefined>;
}

export const pushDevicePlatforms = ["WEB", "ANDROID", "IOS"] as const;
export type PushDevicePlatform = (typeof pushDevicePlatforms)[number];

export interface PushDeviceRegistry {
  registerPushDevice(userId: string, token: string, platform: PushDevicePlatform, at: Date): Promise<void>;
  /** Removes the token only when it belongs to `userId`; returns whether a row was removed. */
  unregisterPushDevice(userId: string, token: string): Promise<boolean>;
}

const key = (value: Uint8Array, name: string): Buffer => {
  const buffer = Buffer.from(value);
  if (buffer.length !== 32) throw new TypeError(`${name} must be exactly 32 bytes`);
  return buffer;
};

const PUSH_TOKEN_AAD = Buffer.from("push-device-token-v1", "utf8");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** AES-256-GCM envelope `[1][nonce:12][tag:16][ciphertext]`, the format identity writes. */
const open = (envelope: Buffer, encryptionKey: Buffer, aad?: Buffer): string | undefined => {
  if (envelope.length < 30 || envelope[0] !== 1) return undefined;
  try {
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey, envelope.subarray(1, 13));
    if (aad !== undefined) decipher.setAAD(aad);
    decipher.setAuthTag(envelope.subarray(13, 29));
    return Buffer.concat([decipher.update(envelope.subarray(29)), decipher.final()]).toString("utf8");
  } catch {
    return undefined;
  }
};

interface PhoneRow extends Record<string, unknown> {
  readonly normalized_phone_ciphertext: Buffer | Uint8Array;
}

interface TokenRow extends Record<string, unknown> {
  readonly id: string;
  readonly token_ciphertext: Buffer | Uint8Array;
}

/**
 * Contact resolution for messaging and consent-aware contact sharing. It decrypts a number or a
 * push token only at the moment a provider needs it; nothing it returns is stored, logged, or
 * put in the outbox. Deleted and suspended accounts resolve to nothing.
 */
export class PostgresMessagingDirectory
implements SmsRecipientDirectory, PushDeviceDirectory, OwnerContactDirectory, PushDeviceRegistry {
  readonly #phoneKey: Buffer;
  readonly #fieldKey: Buffer;
  readonly #lookupKey: Buffer;

  constructor(private readonly pool: SqlPool, secrets: MessagingDirectorySecrets) {
    this.#phoneKey = key(secrets.phoneEncryptionKey, "phoneEncryptionKey");
    this.#fieldKey = key(secrets.fieldEncryptionKey, "fieldEncryptionKey");
    this.#lookupKey = Buffer.from(secrets.lookupHashKey);
    if (this.#lookupKey.length < 32) throw new TypeError("lookupHashKey must contain at least 32 bytes");
  }

  async smsNumber(userId: string): Promise<string | undefined> {
    if (!UUID.test(userId)) return undefined;
    const row = (await this.pool.query<PhoneRow>(
      `SELECT normalized_phone_ciphertext FROM public.users
       WHERE id = $1 AND status = 'ACTIVE' AND deleted_at IS NULL`, [userId])).rows[0];
    if (row === undefined) return undefined;
    const phone = open(Buffer.from(row.normalized_phone_ciphertext), this.#phoneKey);
    return phone !== undefined && SHAREABLE_PHONE_PATTERN.test(phone) ? phone : undefined;
  }

  ownerPhone(ownerId: string): Promise<string | undefined> {
    return this.smsNumber(ownerId);
  }

  async pushTokens(userId: string, limit: number): Promise<readonly PushDeviceToken[]> {
    if (!UUID.test(userId)) return [];
    const rows = (await this.pool.query<TokenRow>(
      `SELECT d.id, d.token_ciphertext FROM public.push_device_registrations d
       JOIN public.users u ON u.id = d.user_id AND u.status = 'ACTIVE' AND u.deleted_at IS NULL
       WHERE d.user_id = $1 ORDER BY d.last_registered_at DESC, d.id LIMIT $2`,
      [userId, Math.max(1, Math.min(limit, 20))])).rows;
    return Object.freeze(rows.flatMap((row) => {
      const token = open(Buffer.from(row.token_ciphertext), this.#fieldKey, PUSH_TOKEN_AAD);
      return token === undefined ? [] : [Object.freeze({ registrationId: row.id, token })];
    }));
  }

  async revokePushToken(registrationId: string): Promise<void> {
    if (!UUID.test(registrationId)) return;
    await this.pool.query("DELETE FROM public.push_device_registrations WHERE id = $1", [registrationId]);
  }

  async registerPushDevice(userId: string, token: string, platform: PushDevicePlatform, at: Date): Promise<void> {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#fieldKey, nonce);
    cipher.setAAD(PUSH_TOKEN_AAD);
    const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
    const envelope = Buffer.concat([Buffer.from([1]), nonce, cipher.getAuthTag(), ciphertext]);
    // A token names one device; registering it again (even from another account) moves it.
    await this.pool.query(
      `INSERT INTO public.push_device_registrations
         (user_id, platform, token_ciphertext, token_lookup_hash, created_at, last_registered_at)
       VALUES ($1, $2, $3, $4, $5, $5)
       ON CONFLICT (token_lookup_hash) DO UPDATE
         SET user_id = EXCLUDED.user_id, platform = EXCLUDED.platform,
             token_ciphertext = EXCLUDED.token_ciphertext, last_registered_at = EXCLUDED.last_registered_at,
             version = public.push_device_registrations.version + 1`,
      [userId, platform, envelope, this.#tokenHash(token), at.toISOString()],
    );
  }

  async unregisterPushDevice(userId: string, token: string): Promise<boolean> {
    const result = await this.pool.query(
      "DELETE FROM public.push_device_registrations WHERE token_lookup_hash = $1 AND user_id = $2",
      [this.#tokenHash(token), userId],
    );
    return result.rowCount > 0;
  }

  #tokenHash(token: string): string {
    return createHmac("sha256", this.#lookupKey).update("push-device-token-v1").update("\0").update(token).digest("hex");
  }
}
