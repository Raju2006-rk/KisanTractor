import { randomUUID } from "node:crypto";

import {
  InvalidIndianPhoneError,
  normalizeIndianPhone,
  roleForOtpPurpose,
  type AuthPrincipal,
  type AuthSession,
  type OtpPurpose,
} from "@kisantractor/domain";
import {
  CapabilityRegistry,
  type OtpAdapter,
  type OtpDispatchReceipt,
} from "@kisantractor/providers";
import { noopIndicators, type OperationalIndicators } from "@kisantractor/observability";

import type {
  IdentityRuntimeConfig,
  IdentityStore,
  RequestContext,
  SessionMaterial,
} from "./identity.contracts.js";
import { IdentityCrypto } from "./identity-crypto.js";

const GENERIC_REQUEST_MESSAGE =
  "If this phone can receive a code, verification instructions are available.";
const GENERIC_AUTH_MESSAGE = "The verification credentials are invalid or expired.";
/** Challenge identifiers are server-generated UUIDs. */
const CHALLENGE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export interface OtpChallengeResponse {
  readonly accepted: true;
  readonly challengeId: string;
  readonly expiresAt: Date;
  readonly message: string;
  readonly testOnly?: true;
  readonly developmentCode?: string;
}

export interface VerifyOtpCommand {
  readonly challengeId: string;
  readonly phone: string;
  readonly purpose: OtpPurpose;
  readonly code: string;
  readonly context: RequestContext;
}

export class AuthenticationRejectedError extends Error {
  readonly code = "AUTHENTICATION_REJECTED";

  constructor() {
    super(GENERIC_AUTH_MESSAGE);
    this.name = "AuthenticationRejectedError";
  }
}

const requirePositiveDuration = (value: number, name: string): void => {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
};

interface GeneratedSession {
  readonly accessCredential: string;
  readonly refreshCredential: string;
  readonly material: SessionMaterial;
}

export class IdentityService {
  readonly #crypto: IdentityCrypto;

  constructor(
    private readonly store: IdentityStore,
    private readonly capabilities: CapabilityRegistry,
    private readonly config: IdentityRuntimeConfig,
    private readonly now: () => Date = () => new Date(),
    private readonly indicators: OperationalIndicators = noopIndicators,
  ) {
    this.#crypto = new IdentityCrypto(config.secrets);
    for (const [name, value] of Object.entries(config.policy)) {
      requirePositiveDuration(value, name);
    }
    if (config.policy.refreshTtlMs <= config.policy.accessTtlMs) {
      throw new TypeError("refreshTtlMs must exceed accessTtlMs");
    }
  }

  async requestOtp(
    phone: string,
    purpose: OtpPurpose,
    context: RequestContext,
  ): Promise<OtpChallengeResponse> {
    const adapter = this.capabilities.requireConfigured<OtpAdapter>("OTP");
    this.#assertAdapterAllowed(adapter);

    const challengeId = randomUUID();
    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + this.config.policy.otpTtlMs);
    let normalizedPhone: string;

    try {
      normalizedPhone = normalizeIndianPhone(phone);
    } catch (error) {
      if (!(error instanceof InvalidIndianPhoneError)) throw error;
      await this.store.auditAuthenticationEvent(
        "otp.request",
        "INVALID_PHONE",
        challengeId,
        context,
      );
      this.indicators.otpRequested("INVALID_PHONE");
      return this.#requestResponse(challengeId, expiresAt);
    }

    const code = this.#crypto.generateOtp(this.config.policy.otpLength);
    const accepted = await this.store.createOtpChallenge({
      id: challengeId,
      phoneLookupHash: this.#crypto.phoneLookupHash(normalizedPhone),
      purpose,
      codeHash: this.#crypto.otpCodeHash(
        challengeId,
        normalizedPhone,
        purpose,
        code,
      ),
      requesterHash: this.#crypto.requesterHash(context.requesterFingerprint),
      expiresAt,
      maxAttempts: this.config.policy.maxOtpAttempts,
      phoneWindowStartsAt: new Date(
        createdAt.getTime() - this.config.policy.phoneRequestWindowMs,
      ),
      maxPhoneRequests: this.config.policy.maxPhoneRequests,
      requesterWindowStartsAt: new Date(
        createdAt.getTime() - this.config.policy.requesterWindowMs,
      ),
      maxRequesterRequests: this.config.policy.maxRequesterRequests,
      context,
    });

    if (!accepted) {
      // The store refuses only when a phone or requester throttle is exceeded.
      this.indicators.otpRequested("THROTTLED");
      return this.#requestResponse(challengeId, expiresAt);
    }

    let receipt: OtpDispatchReceipt;
    try {
      receipt = await adapter.send({
        challengeId,
        normalizedPhone,
        purpose,
        code,
        expiresAt,
      });
    } catch (error) {
      await this.store.invalidateOtpChallenge(
        challengeId,
        "DELIVERY_FAILED",
        context,
      );
      this.indicators.otpRequested("DELIVERY_FAILED");
      throw error;
    }

    this.indicators.otpRequested("ISSUED");
    return this.#requestResponse(challengeId, expiresAt, receipt);
  }

  async verifyOtp(command: VerifyOtpCommand): Promise<AuthSession> {
    const now = this.now();
    if (!CHALLENGE_ID_PATTERN.test(command.challengeId)) {
      // A malformed challenge is audited and answered exactly like a wrong code; it never reaches SQL.
      await this.store.auditAuthenticationEvent("otp.verify", "MALFORMED_CHALLENGE", undefined, command.context);
      this.indicators.otpVerificationRejected("NOT_FOUND");
      throw new AuthenticationRejectedError();
    }
    let normalizedPhone: string;
    try {
      normalizedPhone = normalizeIndianPhone(command.phone);
    } catch (error) {
      if (!(error instanceof InvalidIndianPhoneError)) throw error;
      await this.store.auditAuthenticationEvent(
        "otp.verify",
        "INVALID_CREDENTIALS",
        command.challengeId,
        command.context,
      );
      this.indicators.otpVerificationRejected("INVALID_PHONE");
      throw new AuthenticationRejectedError();
    }

    const credentials = this.#newSessionMaterial(now);
    const roleToGrant = roleForOtpPurpose(command.purpose);
    const result = await this.store.verifyAndIssueSession({
      challengeId: command.challengeId,
      phoneLookupHash: this.#crypto.phoneLookupHash(normalizedPhone),
      phoneCiphertext: this.#crypto.encryptPhone(normalizedPhone),
      purpose: command.purpose,
      submittedCodeHash: this.#crypto.otpCodeHash(
        command.challengeId,
        normalizedPhone,
        command.purpose,
        command.code,
      ),
      ...(roleToGrant === undefined ? {} : { roleToGrant }),
      session: credentials.material,
      now,
      context: command.context,
    });

    if (result.status !== "ISSUED") {
      this.indicators.otpVerificationRejected(result.reason);
      throw new AuthenticationRejectedError();
    }

    this.indicators.otpVerified();
    return this.#authSession(result.principal, credentials);
  }

  async refreshSession(
    refreshCredential: string,
    context: RequestContext,
  ): Promise<AuthSession> {
    const now = this.now();
    const credentials = this.#newSessionMaterial(now);
    const result = await this.store.refreshSession({
      refreshTokenHash: this.#crypto.sessionTokenHash(refreshCredential),
      replacement: credentials.material,
      now,
      context,
    });
    if (result.status !== "ROTATED") {
      throw new AuthenticationRejectedError();
    }
    return this.#authSession(result.principal, credentials);
  }

  async revokeSession(
    principal: AuthPrincipal,
    reason: string,
    context: RequestContext,
  ): Promise<void> {
    const revoked = await this.store.revokeSession(
      principal.sessionId,
      principal.userId,
      reason.trim() || "USER_REQUESTED",
      this.now(),
      context,
    );
    if (!revoked) throw new AuthenticationRejectedError();
  }

  async authenticateAccessCredential(
    accessCredential: string,
  ): Promise<AuthPrincipal> {
    const principal = await this.store.authenticateAccessToken(
      this.#crypto.sessionTokenHash(accessCredential),
      this.now(),
    );
    if (principal === undefined) throw new AuthenticationRejectedError();
    return principal;
  }

  #newSessionMaterial(now: Date): GeneratedSession {
    const accessCredential = this.#crypto.generateCredential();
    const refreshCredential = this.#crypto.generateCredential();
    return {
      accessCredential,
      refreshCredential,
      material: {
        id: randomUUID(),
        accessTokenHash: this.#crypto.sessionTokenHash(accessCredential),
        refreshTokenHash: this.#crypto.sessionTokenHash(refreshCredential),
        accessExpiresAt: new Date(now.getTime() + this.config.policy.accessTtlMs),
        refreshExpiresAt: new Date(now.getTime() + this.config.policy.refreshTtlMs),
      },
    };
  }

  #authSession(
    principal: AuthPrincipal,
    credentials: GeneratedSession,
  ): AuthSession {
    return Object.freeze({
      principal: Object.freeze({
        ...principal,
        roles: Object.freeze([...principal.roles]),
      }),
      accessCredential: credentials.accessCredential,
      accessExpiresAt: credentials.material.accessExpiresAt,
      refreshCredential: credentials.refreshCredential,
      refreshExpiresAt: credentials.material.refreshExpiresAt,
    });
  }

  #requestResponse(
    challengeId: string,
    expiresAt: Date,
    receipt?: OtpDispatchReceipt,
  ): OtpChallengeResponse {
    const base = {
      accepted: true as const,
      challengeId,
      expiresAt,
      message: GENERIC_REQUEST_MESSAGE,
    };
    if (
      this.config.environment !== "production" &&
      receipt?.testOnly === true &&
      receipt.developmentCode !== undefined
    ) {
      return Object.freeze({
        ...base,
        message: receipt.userMessage ?? GENERIC_REQUEST_MESSAGE,
        testOnly: true as const,
        developmentCode: receipt.developmentCode,
      });
    }
    return Object.freeze(base);
  }

  #assertAdapterAllowed(adapter: OtpAdapter): void {
    if (
      adapter.kind === "LOCAL_DEVELOPMENT" &&
      this.config.environment !== "local" &&
      this.config.environment !== "test"
    ) {
      throw new Error("Development OTP adapter is forbidden outside local/test");
    }
  }
}
