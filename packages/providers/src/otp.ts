import type { OtpPurpose } from "@kisantractor/domain";

import { assertProviderRuntimeSafety } from "./capability-registry.js";

export interface OtpDeliveryRequest {
  readonly challengeId: string;
  readonly normalizedPhone: string;
  readonly purpose: OtpPurpose;
  readonly code: string;
  readonly expiresAt: Date;
}

export interface OtpDispatchReceipt {
  readonly adapter: string;
  readonly testOnly: boolean;
  readonly userMessage?: string;
  readonly developmentCode?: string;
}

export interface OtpAdapter {
  readonly kind: "LOCAL_DEVELOPMENT" | "EXTERNAL";
  send(request: OtpDeliveryRequest): Promise<OtpDispatchReceipt>;
}

export interface LocalDevelopmentOtpAdapterOptions {
  readonly environment: "local" | "test" | "staging" | "production";
  readonly enabled: boolean;
  readonly onDelivery?: (request: OtpDeliveryRequest) => void | Promise<void>;
}

/**
 * Explicit, opt-in adapter for local/test use. It never contacts a provider and
 * cannot be constructed for staging or production.
 */
export class LocalDevelopmentOtpAdapter implements OtpAdapter {
  readonly kind = "LOCAL_DEVELOPMENT" as const;

  constructor(private readonly options: LocalDevelopmentOtpAdapterOptions) {
    if (!options.enabled) {
      throw new Error("Local OTP adapter requires explicit opt-in");
    }
    if (options.environment !== "local" && options.environment !== "test") {
      throw new Error("Local OTP adapter is allowed only in local or test environments");
    }
    assertProviderRuntimeSafety({
      environment: options.environment,
      enabledDevelopmentFeatures: ["LOCAL_OTP_CODES"],
    });
  }

  async send(request: OtpDeliveryRequest): Promise<OtpDispatchReceipt> {
    await this.options.onDelivery?.(request);
    return Object.freeze({
      adapter: "local-development",
      testOnly: true,
      userMessage: "Development OTP only — no live message was sent.",
      developmentCode: request.code,
    });
  }
}
