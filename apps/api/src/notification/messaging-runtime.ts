import type { EnvironmentConfig } from "@kisantractor/config";
import type { SqlPool } from "@kisantractor/database";
import type { NotificationChannel } from "@kisantractor/domain";
import type { CapabilityRegistry, ModalNotificationChannelAdapter } from "@kisantractor/providers";

import {
  buildMessagingAdapter,
  type MessagingAdapterOptions,
  type MessagingProviderSecrets,
  type RuntimeSecrets,
} from "../runtime-config.js";
import { PostgresMessagingDirectory } from "./messaging-directory.js";

type DirectorySecrets = Pick<RuntimeSecrets, "PHONE_ENCRYPTION_KEY" | "FIELD_ENCRYPTION_KEY" | "LOOKUP_HASH_KEY">;

export const createMessagingDirectory = (pool: SqlPool, secrets: DirectorySecrets): PostgresMessagingDirectory =>
  new PostgresMessagingDirectory(pool, {
    phoneEncryptionKey: secrets.PHONE_ENCRYPTION_KEY,
    fieldEncryptionKey: secrets.FIELD_ENCRYPTION_KEY,
    lookupHashKey: secrets.LOOKUP_HASH_KEY,
  });

/**
 * Channels generated for each notification. IN_APP always (the stored record is the in-app
 * delivery, so it continues whatever MESSAGING's state); SMS always, so an unconfigured or rolled
 * back SMS channel is recorded honestly as NOT_SENT; PUSH only when a push provider is configured.
 */
export const notificationChannelsFor = (config: Readonly<EnvironmentConfig>): readonly NotificationChannel[] =>
  Object.freeze(["IN_APP", "SMS", ...(config.PUSH_PROVIDER === "fcm" ? ["PUSH" as const] : [])]);

/** Device tokens are collected only while push can actually be sent (data minimization). */
export const pushRegistrationAvailable = (config: Readonly<EnvironmentConfig>, registry: CapabilityRegistry): boolean => {
  const state = registry.getState("MESSAGING");
  return config.PUSH_PROVIDER === "fcm" && (state === "SANDBOX" || state === "LIVE");
};

/** True when contact sharing is launched by configuration (ENABLE_OWNER_CONTACT_SHARING). */
export const ownerContactSharingEnabled = (config: Readonly<EnvironmentConfig>): boolean =>
  config.ENABLE_OWNER_CONTACT_SHARING === true;

/**
 * Builds the configured MSG91/FCM provider handle with a directory that is created only when a
 * provider needs it, so processes without messaging never load contact-decryption keys for it.
 */
export function buildConfiguredMessaging(
  config: Readonly<EnvironmentConfig>,
  secrets: MessagingProviderSecrets | undefined,
  directory: () => PostgresMessagingDirectory,
  options: MessagingAdapterOptions = {},
): ModalNotificationChannelAdapter | undefined {
  return buildMessagingAdapter(config, secrets, () => {
    const resolved = directory();
    return { sms: resolved, push: resolved };
  }, options);
}
