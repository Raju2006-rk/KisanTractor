import type {
  AuthPrincipal,
  OtpPurpose,
  UserRole,
} from "@kisantractor/domain";
import type { AuditActorChannel } from "@kisantractor/database";

export interface IdentityPolicy {
  readonly otpLength: number;
  readonly otpTtlMs: number;
  readonly maxOtpAttempts: number;
  readonly phoneRequestWindowMs: number;
  readonly maxPhoneRequests: number;
  readonly requesterWindowMs: number;
  readonly maxRequesterRequests: number;
  readonly accessTtlMs: number;
  readonly refreshTtlMs: number;
}

export interface IdentitySecrets {
  readonly otpHashKey: Uint8Array;
  readonly lookupHashKey: Uint8Array;
  readonly sessionHashKey: Uint8Array;
  readonly phoneEncryptionKey: Uint8Array;
}

export interface IdentityRuntimeConfig {
  readonly environment: "local" | "test" | "staging" | "production";
  readonly policy: IdentityPolicy;
  readonly secrets: IdentitySecrets;
}

export interface RequestContext {
  readonly correlationId: string;
  readonly requesterFingerprint: string;
  readonly actorChannel: AuditActorChannel;
}

export interface NewOtpChallenge {
  readonly id: string;
  readonly phoneLookupHash: string;
  readonly purpose: OtpPurpose;
  readonly codeHash: string;
  readonly requesterHash: string;
  readonly expiresAt: Date;
  readonly maxAttempts: number;
  readonly phoneWindowStartsAt: Date;
  readonly maxPhoneRequests: number;
  readonly requesterWindowStartsAt: Date;
  readonly maxRequesterRequests: number;
  readonly context: RequestContext;
}

export interface SessionMaterial {
  readonly id: string;
  readonly accessTokenHash: string;
  readonly refreshTokenHash: string;
  readonly accessExpiresAt: Date;
  readonly refreshExpiresAt: Date;
}

export interface VerifyAndIssueInput {
  readonly challengeId: string;
  readonly phoneLookupHash: string;
  readonly phoneCiphertext: Uint8Array;
  readonly purpose: OtpPurpose;
  readonly submittedCodeHash: string;
  readonly roleToGrant?: UserRole;
  readonly session: SessionMaterial;
  readonly now: Date;
  readonly context: RequestContext;
}

export type VerifyAndIssueResult =
  | {
      readonly status: "ISSUED";
      readonly principal: AuthPrincipal;
    }
  | {
      readonly status: "REJECTED";
      readonly reason:
        | "NOT_FOUND"
        | "BINDING_MISMATCH"
        | "EXPIRED"
        | "CONSUMED"
        | "ATTEMPTS_EXHAUSTED"
        | "INVALID_CODE"
        | "ACCOUNT_NOT_FOUND"
        | "ACCOUNT_INACTIVE";
    };

export interface RefreshInput {
  readonly refreshTokenHash: string;
  readonly replacement: SessionMaterial;
  readonly now: Date;
  readonly context: RequestContext;
}

export type RefreshResult =
  | { readonly status: "ROTATED"; readonly principal: AuthPrincipal }
  | { readonly status: "REJECTED" };

export interface IdentityStore {
  auditAuthenticationEvent(
    action: "otp.request" | "otp.verify" | "session.refresh" | "session.revoke",
    reason: string,
    /** Omitted when the request named no well-formed resource. */
    resourceId: string | undefined,
    context: RequestContext,
  ): Promise<void>;
  createOtpChallenge(challenge: NewOtpChallenge): Promise<boolean>;
  invalidateOtpChallenge(
    challengeId: string,
    reason: string,
    context: RequestContext,
  ): Promise<void>;
  verifyAndIssueSession(input: VerifyAndIssueInput): Promise<VerifyAndIssueResult>;
  refreshSession(input: RefreshInput): Promise<RefreshResult>;
  revokeSession(
    sessionId: string,
    userId: string,
    reason: string,
    now: Date,
    context: RequestContext,
  ): Promise<boolean>;
  authenticateAccessToken(
    accessTokenHash: string,
    now: Date,
  ): Promise<AuthPrincipal | undefined>;
}
