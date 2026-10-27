import { describe, expect, it, vi } from "vitest";

import type { AuthPrincipal, UserRole } from "@kisantractor/domain";
import { InMemoryMetrics, OperationalIndicators } from "@kisantractor/observability";
import { CapabilityRegistry, CapabilityUnavailableError, LocalDevelopmentOtpAdapter } from "@kisantractor/providers";

import type {
  IdentityRuntimeConfig,
  IdentityStore,
  NewOtpChallenge,
  RefreshInput,
  RefreshResult,
  RequestContext,
  VerifyAndIssueInput,
  VerifyAndIssueResult,
} from "./identity.contracts.js";
import {
  AuthenticationRejectedError,
  IdentityService,
} from "./identity.service.js";

const context: RequestContext = {
  correlationId: "request-1",
  requesterFingerprint: "hashed-at-boundary-client-1",
  actorChannel: "WEB",
};

const makeConfig = (
  environment: IdentityRuntimeConfig["environment"] = "test",
): IdentityRuntimeConfig => ({
  environment,
  policy: {
    otpLength: 6,
    otpTtlMs: 5 * 60_000,
    maxOtpAttempts: 3,
    phoneRequestWindowMs: 60_000,
    maxPhoneRequests: 2,
    requesterWindowMs: 60_000,
    maxRequesterRequests: 5,
    accessTtlMs: 15 * 60_000,
    refreshTtlMs: 30 * 24 * 60 * 60_000,
  },
  secrets: {
    otpHashKey: Buffer.alloc(32, 1),
    lookupHashKey: Buffer.alloc(32, 2),
    sessionHashKey: Buffer.alloc(32, 3),
    phoneEncryptionKey: Buffer.alloc(32, 4),
  },
});

interface MemoryUser {
  readonly id: string;
  readonly roles: Set<UserRole>;
  active: boolean;
}

interface MemorySession {
  readonly id: string;
  readonly userId: string;
  readonly accessHash: string;
  readonly refreshHash: string;
  readonly accessExpiresAt: Date;
  readonly refreshExpiresAt: Date;
  revoked: boolean;
}

class MemoryIdentityStore implements IdentityStore {
  readonly challenges: NewOtpChallenge[] = [];
  readonly users = new Map<string, MemoryUser>();
  readonly sessions: MemorySession[] = [];
  readonly audits: Array<{ action: string; reason: string; resourceId: string }> = [];
  invalidated = new Set<string>();
  consumed = new Set<string>();
  attempts = new Map<string, number>();

  async auditAuthenticationEvent(
    action: "otp.request" | "otp.verify" | "session.refresh" | "session.revoke",
    reason: string,
    resourceId: string,
  ): Promise<void> {
    this.audits.push({ action, reason, resourceId });
  }

  async createOtpChallenge(challenge: NewOtpChallenge): Promise<boolean> {
    const byPhone = this.challenges.filter(
      ({ phoneLookupHash }) => phoneLookupHash === challenge.phoneLookupHash,
    ).length;
    const byRequester = this.challenges.filter(
      ({ requesterHash }) => requesterHash === challenge.requesterHash,
    ).length;
    if (
      byPhone >= challenge.maxPhoneRequests ||
      byRequester >= challenge.maxRequesterRequests
    ) {
      this.audits.push({
        action: "otp.request",
        reason: "RATE_LIMITED",
        resourceId: challenge.id,
      });
      return false;
    }
    this.challenges.push(challenge);
    this.audits.push({ action: "otp.request", reason: "SUCCESS", resourceId: challenge.id });
    return true;
  }

  async invalidateOtpChallenge(
    challengeId: string,
    reason: string,
  ): Promise<void> {
    this.invalidated.add(challengeId);
    this.audits.push({ action: "otp.request", reason, resourceId: challengeId });
  }

  async verifyAndIssueSession(
    input: VerifyAndIssueInput,
  ): Promise<VerifyAndIssueResult> {
    const challenge = this.challenges.find(({ id }) => id === input.challengeId);
    if (challenge === undefined) return { status: "REJECTED", reason: "NOT_FOUND" };
    if (this.invalidated.has(input.challengeId) || this.consumed.has(input.challengeId)) {
      return { status: "REJECTED", reason: "CONSUMED" };
    }
    if (challenge.expiresAt.getTime() <= input.now.getTime()) {
      this.invalidated.add(input.challengeId);
      return { status: "REJECTED", reason: "EXPIRED" };
    }
    const attemptCount = this.attempts.get(input.challengeId) ?? 0;
    if (attemptCount >= challenge.maxAttempts) {
      return { status: "REJECTED", reason: "ATTEMPTS_EXHAUSTED" };
    }
    if (
      challenge.phoneLookupHash !== input.phoneLookupHash ||
      challenge.purpose !== input.purpose
    ) {
      this.attempts.set(input.challengeId, attemptCount + 1);
      return { status: "REJECTED", reason: "BINDING_MISMATCH" };
    }
    if (challenge.codeHash !== input.submittedCodeHash) {
      this.attempts.set(input.challengeId, attemptCount + 1);
      return { status: "REJECTED", reason: "INVALID_CODE" };
    }

    let user = this.users.get(input.phoneLookupHash);
    if (user === undefined && input.roleToGrant === undefined) {
      this.consumed.add(input.challengeId);
      return { status: "REJECTED", reason: "ACCOUNT_NOT_FOUND" };
    }
    if (user === undefined) {
      user = { id: `user-${this.users.size + 1}`, roles: new Set(), active: true };
      this.users.set(input.phoneLookupHash, user);
    }
    if (!user.active) return { status: "REJECTED", reason: "ACCOUNT_INACTIVE" };
    if (input.roleToGrant !== undefined) user.roles.add(input.roleToGrant);

    this.sessions.push({
      id: input.session.id,
      userId: user.id,
      accessHash: input.session.accessTokenHash,
      refreshHash: input.session.refreshTokenHash,
      accessExpiresAt: input.session.accessExpiresAt,
      refreshExpiresAt: input.session.refreshExpiresAt,
      revoked: false,
    });
    this.consumed.add(input.challengeId);
    return {
      status: "ISSUED",
      principal: {
        userId: user.id,
        sessionId: input.session.id,
        roles: [...user.roles],
      },
    };
  }

  async refreshSession(input: RefreshInput): Promise<RefreshResult> {
    const current = this.sessions.find(
      ({ refreshHash }) => refreshHash === input.refreshTokenHash,
    );
    if (
      current === undefined ||
      current.revoked ||
      current.refreshExpiresAt.getTime() <= input.now.getTime()
    ) {
      return { status: "REJECTED" };
    }
    current.revoked = true;
    const user = [...this.users.values()].find(({ id }) => id === current.userId);
    if (user === undefined || !user.active) return { status: "REJECTED" };
    this.sessions.push({
      id: input.replacement.id,
      userId: user.id,
      accessHash: input.replacement.accessTokenHash,
      refreshHash: input.replacement.refreshTokenHash,
      accessExpiresAt: input.replacement.accessExpiresAt,
      refreshExpiresAt: input.replacement.refreshExpiresAt,
      revoked: false,
    });
    return {
      status: "ROTATED",
      principal: {
        userId: user.id,
        sessionId: input.replacement.id,
        roles: [...user.roles],
      },
    };
  }

  async revokeSession(
    sessionId: string,
    userId: string,
  ): Promise<boolean> {
    const session = this.sessions.find(
      (candidate) => candidate.id === sessionId && candidate.userId === userId,
    );
    if (session === undefined || session.revoked) return false;
    session.revoked = true;
    return true;
  }

  async authenticateAccessToken(
    accessTokenHash: string,
    now: Date,
  ): Promise<AuthPrincipal | undefined> {
    const session = this.sessions.find(
      ({ accessHash }) => accessHash === accessTokenHash,
    );
    if (
      session === undefined ||
      session.revoked ||
      session.accessExpiresAt.getTime() <= now.getTime()
    ) {
      return undefined;
    }
    const user = [...this.users.values()].find(({ id }) => id === session.userId);
    if (user === undefined || !user.active) return undefined;
    return {
      userId: user.id,
      sessionId: session.id,
      roles: [...user.roles],
    };
  }
}

const localService = (
  store: MemoryIdentityStore,
  now: () => Date,
): IdentityService => {
  const adapter = new LocalDevelopmentOtpAdapter({ environment: "test", enabled: true });
  return new IdentityService(
    store,
    new CapabilityRegistry({ OTP: { state: "SANDBOX", provider: adapter } }),
    makeConfig(),
    now,
  );
};

describe("IdentityService OTP flow", () => {
  it("binds a hashed, expiring challenge to phone and purpose and grants an explicit role", async () => {
    const clock = new Date("2026-01-01T00:00:00.000Z");
    const store = new MemoryIdentityStore();
    const service = localService(store, () => new Date(clock));
    const challenge = await service.requestOtp(
      "+91 98765-43210",
      "REGISTER_FARMER",
      context,
    );

    expect(challenge).toMatchObject({ accepted: true, testOnly: true });
    expect(challenge.developmentCode).toMatch(/^\d{6}$/u);
    expect(store.challenges[0]).toMatchObject({ purpose: "REGISTER_FARMER" });
    expect(store.challenges[0]?.codeHash).toMatch(/^[a-f\d]{64}$/u);
    expect(JSON.stringify(store.challenges[0])).not.toContain(challenge.developmentCode);
    expect(JSON.stringify(store.challenges[0])).not.toContain("9876543210");

    await expect(
      service.verifyOtp({
        challengeId: challenge.challengeId,
        phone: "+919876543210",
        purpose: "REGISTER_OWNER",
        code: challenge.developmentCode ?? "",
        context,
      }),
    ).rejects.toBeInstanceOf(AuthenticationRejectedError);

    const session = await service.verifyOtp({
      challengeId: challenge.challengeId,
      phone: "9876543210",
      purpose: "REGISTER_FARMER",
      code: challenge.developmentCode ?? "",
      context,
    });
    expect(session.principal.roles).toEqual(["FARMER"]);
    expect(session.accessCredential).not.toBe(session.refreshCredential);
    await expect(service.authenticateAccessCredential(session.accessCredential)).resolves.toEqual(
      session.principal,
    );
    await expect(
      service.verifyOtp({
        challengeId: challenge.challengeId,
        phone: "9876543210",
        purpose: "REGISTER_FARMER",
        code: challenge.developmentCode ?? "",
        context,
      }),
    ).rejects.toBeInstanceOf(AuthenticationRejectedError);
  });

  it("expires challenges and limits code attempts", async () => {
    let clock = new Date("2026-01-01T00:00:00.000Z");
    const store = new MemoryIdentityStore();
    const service = localService(store, () => new Date(clock));
    const challenge = await service.requestOtp("9876543210", "REGISTER_OWNER", context);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(
        service.verifyOtp({
          challengeId: challenge.challengeId,
          phone: "9876543210",
          purpose: "REGISTER_OWNER",
          code: "000000",
          context,
        }),
      ).rejects.toThrow("invalid or expired");
    }
    await expect(
      service.verifyOtp({
        challengeId: challenge.challengeId,
        phone: "9876543210",
        purpose: "REGISTER_OWNER",
        code: challenge.developmentCode ?? "",
        context,
      }),
    ).rejects.toThrow("invalid or expired");

    const expiring = await service.requestOtp("9123456789", "REGISTER_OWNER", {
      ...context,
      requesterFingerprint: "client-2",
    });
    clock = new Date(expiring.expiresAt.getTime());
    await expect(
      service.verifyOtp({
        challengeId: expiring.challengeId,
        phone: "9123456789",
        purpose: "REGISTER_OWNER",
        code: expiring.developmentCode ?? "",
        context,
      }),
    ).rejects.toThrow("invalid or expired");
  });

  it("throttles phone requests without sending another code", async () => {
    const store = new MemoryIdentityStore();
    const deliveries = vi.fn();
    const adapter = new LocalDevelopmentOtpAdapter({
      environment: "test",
      enabled: true,
      onDelivery: deliveries,
    });
    const service = new IdentityService(
      store,
      new CapabilityRegistry({ OTP: { state: "SANDBOX", provider: adapter } }),
      makeConfig(),
    );

    await service.requestOtp("9876543210", "SIGN_IN", context);
    await service.requestOtp("9876543210", "SIGN_IN", context);
    const throttled = await service.requestOtp("9876543210", "SIGN_IN", context);

    expect(throttled).toMatchObject({ accepted: true });
    expect(deliveries).toHaveBeenCalledTimes(2);
    expect(store.audits).toContainEqual(
      expect.objectContaining({ action: "otp.request", reason: "RATE_LIMITED" }),
    );
  });
});

describe("IdentityService sessions", () => {
  it("rotates refresh credentials and revokes sessions immediately", async () => {
    const clock = new Date("2026-01-01T00:00:00.000Z");
    const store = new MemoryIdentityStore();
    const service = localService(store, () => new Date(clock));
    const challenge = await service.requestOtp("9876543210", "REGISTER_OWNER", context);
    const first = await service.verifyOtp({
      challengeId: challenge.challengeId,
      phone: "9876543210",
      purpose: "REGISTER_OWNER",
      code: challenge.developmentCode ?? "",
      context,
    });

    const rotated = await service.refreshSession(first.refreshCredential, context);
    expect(rotated.principal.roles).toEqual(["OWNER"]);
    expect(rotated.principal.sessionId).not.toBe(first.principal.sessionId);
    await expect(service.authenticateAccessCredential(first.accessCredential)).rejects.toThrow(
      "invalid or expired",
    );
    await expect(service.refreshSession(first.refreshCredential, context)).rejects.toThrow(
      "invalid or expired",
    );

    await service.revokeSession(rotated.principal, "USER_LOGOUT", context);
    await expect(service.authenticateAccessCredential(rotated.accessCredential)).rejects.toThrow(
      "invalid or expired",
    );
  });
});

describe("production identity safety", () => {
  it("returns the same generic request shape for invalid, accepted, and throttled requests", async () => {
    const store = new MemoryIdentityStore();
    const externalAdapter = {
      kind: "EXTERNAL" as const,
      send: vi.fn(async () => ({ adapter: "provider", testOnly: false })),
    };
    const config = makeConfig("production");
    const service = new IdentityService(
      store,
      new CapabilityRegistry({ OTP: { state: "LIVE", provider: externalAdapter } }),
      { ...config, policy: { ...config.policy, maxPhoneRequests: 1 } },
      () => new Date("2026-01-01T00:00:00.000Z"),
    );

    const accepted = await service.requestOtp("9876543210", "SIGN_IN", context);
    const throttled = await service.requestOtp("9876543210", "SIGN_IN", context);
    const invalid = await service.requestOtp("123", "SIGN_IN", context);
    for (const response of [accepted, throttled, invalid]) {
      expect(Object.keys(response).sort()).toEqual([
        "accepted",
        "challengeId",
        "expiresAt",
        "message",
      ]);
      expect(response.accepted).toBe(true);
      expect(response.message).toBe(accepted.message);
      expect(response).not.toHaveProperty("developmentCode");
    }
    expect(externalAdapter.send).toHaveBeenCalledTimes(1);
  });

  it("rejects an unconfigured capability and any local adapter outside local/test", async () => {
    const store = new MemoryIdentityStore();
    const unconfigured = new IdentityService(
      store,
      new CapabilityRegistry(),
      makeConfig("production"),
    );
    await expect(unconfigured.requestOtp("9876543210", "SIGN_IN", context)).rejects.toThrow(
      /not configured/,
    );

    const forgedLocal = {
      kind: "LOCAL_DEVELOPMENT" as const,
      send: vi.fn(),
    };
    const unsafe = new IdentityService(
      store,
      new CapabilityRegistry({ OTP: { state: "LIVE", provider: forgedLocal } }),
      makeConfig("production"),
    );
    await expect(unsafe.requestOtp("9876543210", "SIGN_IN", context)).rejects.toThrow(
      /forbidden outside local\/test/,
    );
    expect(forgedLocal.send).not.toHaveBeenCalled();
  });
});

/** Validates: Requirements 18.2 */
describe("IdentityService OTP indicators", () => {
  it("counts issued, throttled, and invalid-phone requests and verification outcomes by reason", async () => {
    const metrics = new InMemoryMetrics();
    const store = new MemoryIdentityStore();
    const adapter = new LocalDevelopmentOtpAdapter({ environment: "test", enabled: true });
    const clock = new Date("2026-01-01T00:00:00.000Z");
    const service = new IdentityService(
      store,
      new CapabilityRegistry({ OTP: { state: "SANDBOX", provider: adapter } }),
      makeConfig(),
      () => new Date(clock),
      new OperationalIndicators(metrics),
    );

    const first = await service.requestOtp("9876543210", "SIGN_IN", context);
    await service.requestOtp("9876543210", "SIGN_IN", context);
    await service.requestOtp("9876543210", "SIGN_IN", context);
    await service.requestOtp("123", "SIGN_IN", context);

    expect(metrics.value("kt_otp_requests_total", { outcome: "ISSUED" })).toBe(2);
    expect(metrics.value("kt_otp_requests_total", { outcome: "THROTTLED" })).toBe(1);
    expect(metrics.value("kt_otp_requests_total", { outcome: "INVALID_PHONE" })).toBe(1);

    const wrongCode = first.developmentCode === "000000" ? "111111" : "000000";
    await expect(service.verifyOtp({
      challengeId: first.challengeId, phone: "9876543210", purpose: "SIGN_IN", code: wrongCode, context,
    })).rejects.toBeInstanceOf(AuthenticationRejectedError);
    await expect(service.verifyOtp({
      challengeId: first.challengeId, phone: "12", purpose: "SIGN_IN", code: "000000", context,
    })).rejects.toBeInstanceOf(AuthenticationRejectedError);

    const rejected = metrics.snapshot()
      .filter((sample) => sample.name === "kt_otp_verifications_total" && sample.kind === "counter");
    expect(rejected.map((sample) => sample.labels.reason).sort()).toContain("INVALID_PHONE");
    expect(metrics.total("kt_otp_verifications_total")).toBe(2);
    expect(metrics.value("kt_otp_verifications_total", { outcome: "SUCCEEDED", reason: "NONE" })).toBe(0);
    // Labels never carry the phone, challenge ID, or code.
    expect(JSON.stringify(metrics.snapshot())).not.toMatch(/9876543210/u);
    expect(JSON.stringify(metrics.snapshot())).not.toContain(first.challengeId);
  });
});

/** Validates: Requirements 14.2, 14.4, 18.7 */
describe("OTP capability rollback", () => {
  for (const rolledBackTo of ["DEGRADED", "UNCONFIGURED"] as const) {
    it(`refuses new codes after a rollback to ${rolledBackTo} without touching state, and keeps existing sign-ins`, async () => {
      const clock = new Date("2026-01-01T00:00:00.000Z");
      const store = new MemoryIdentityStore();
      const deliveries = vi.fn();
      const adapter = new LocalDevelopmentOtpAdapter({ environment: "test", enabled: true, onDelivery: deliveries });
      const before = new IdentityService(store, new CapabilityRegistry({ OTP: { state: "SANDBOX", provider: adapter } }), makeConfig(), () => new Date(clock));
      const signedIn = await before.verifyOtp({
        ...(await before.requestOtp("9876543210", "REGISTER_FARMER", context).then(({ challengeId, developmentCode }) =>
          ({ challengeId, code: developmentCode ?? "" }))),
        phone: "9876543210", purpose: "REGISTER_FARMER", context,
      });
      const outstanding = await before.requestOtp("9123456789", "REGISTER_OWNER", { ...context, requesterFingerprint: "client-2" });

      // The rollback is a configuration change and a restart: a new registry, the same database.
      const after = new IdentityService(store, new CapabilityRegistry(rolledBackTo === "DEGRADED"
        ? { OTP: { state: "DEGRADED", manualAlternativeAvailable: false } }
        : {}), makeConfig(), () => new Date(clock));
      const challenges = store.challenges.length;
      const audits = store.audits.length;
      const error = await after.requestOtp("9000000001", "SIGN_IN", context).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(CapabilityUnavailableError);
      expect(error).toMatchObject({ capability: "OTP", state: rolledBackTo, retryable: rolledBackTo === "DEGRADED" });
      expect(store.challenges).toHaveLength(challenges);
      expect(store.audits).toHaveLength(audits);
      expect(deliveries).toHaveBeenCalledTimes(2);

      // Sessions and codes already delivered need no provider, so nobody is signed out.
      await expect(after.authenticateAccessCredential(signedIn.accessCredential)).resolves.toEqual(signedIn.principal);
      await expect(after.refreshSession(signedIn.refreshCredential, context)).resolves.toMatchObject({
        principal: { userId: signedIn.principal.userId },
      });
      await expect(after.verifyOtp({
        challengeId: outstanding.challengeId, phone: "9123456789", purpose: "REGISTER_OWNER",
        code: outstanding.developmentCode ?? "", context,
      })).resolves.toMatchObject({ principal: { roles: ["OWNER"] } });
    });
  }
});
