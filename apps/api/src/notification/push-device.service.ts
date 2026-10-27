import type { AuthPrincipal } from "@kisantractor/domain";

import { pushDevicePlatforms, type PushDevicePlatform, type PushDeviceRegistry } from "./messaging-directory.js";

/** FCM registration tokens: URL-safe characters, well under this length. */
const PUSH_TOKEN = /^[A-Za-z0-9_:.-]{20,4096}$/u;

export class PushDeviceValidationError extends Error {
  readonly code = "PUSH_DEVICE_INVALID";

  constructor(readonly field: "token" | "platform", message: string) {
    super(message);
    this.name = "PushDeviceValidationError";
  }
}

/** Push is not configured, so the platform does not collect device tokens (data minimization). */
export class PushUnavailableError extends Error {
  readonly code = "CAPABILITY_UNAVAILABLE";

  constructor() {
    super("Push notifications are not available");
    this.name = "PushUnavailableError";
  }
}

const requireToken = (value: unknown): string => {
  if (typeof value !== "string" || !PUSH_TOKEN.test(value.trim())) {
    throw new PushDeviceValidationError("token", "token must be a push registration token");
  }
  return value.trim();
};

/**
 * Registers a signed-in user's device for push notifications. Push is a progressive
 * enhancement (Requirement 17.5): nothing else depends on a registration, and a user can always
 * remove one. Tokens are accepted only while a push channel is configured.
 */
export class PushDeviceService {
  constructor(
    private readonly registry: PushDeviceRegistry,
    private readonly pushAvailable: () => boolean,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async register(principal: AuthPrincipal, input: Readonly<{ token?: unknown; platform?: unknown }>): Promise<void> {
    const token = requireToken(input.token);
    const platform = input.platform;
    if (typeof platform !== "string" || !pushDevicePlatforms.includes(platform as PushDevicePlatform)) {
      throw new PushDeviceValidationError("platform", `platform must be one of ${pushDevicePlatforms.join(", ")}`);
    }
    if (!this.pushAvailable()) throw new PushUnavailableError();
    await this.registry.registerPushDevice(principal.userId, token, platform as PushDevicePlatform, this.now());
  }

  /** Always permitted, so a user can withdraw a device even after push is switched off. */
  async unregister(principal: AuthPrincipal, input: Readonly<{ token?: unknown }>): Promise<void> {
    await this.registry.unregisterPushDevice(principal.userId, requireToken(input.token));
  }
}
