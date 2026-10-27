export const userRoles = ["FARMER", "OWNER", "FUTURE_OPERATOR"] as const;
export type UserRole = (typeof userRoles)[number];

export const otpPurposes = [
  "SIGN_IN",
  "REGISTER_FARMER",
  "REGISTER_OWNER",
] as const;
export type OtpPurpose = (typeof otpPurposes)[number];

export interface AuthPrincipal {
  readonly userId: string;
  readonly sessionId: string;
  readonly roles: readonly UserRole[];
}

export interface AuthSession {
  readonly principal: AuthPrincipal;
  readonly accessCredential: string;
  readonly accessExpiresAt: Date;
  readonly refreshCredential: string;
  readonly refreshExpiresAt: Date;
}

export class InvalidIndianPhoneError extends Error {
  readonly code = "INVALID_INDIAN_PHONE";

  constructor() {
    super("Enter a valid 10-digit Indian mobile number");
    this.name = "InvalidIndianPhoneError";
  }
}

/** Normalizes supported Indian mobile formats to E.164 (+91XXXXXXXXXX). */
export function normalizeIndianPhone(input: string): string {
  const compact = input.trim().replace(/[\s()-]/gu, "");
  let nationalNumber = compact;

  if (nationalNumber.startsWith("+91")) {
    nationalNumber = nationalNumber.slice(3);
  } else if (nationalNumber.startsWith("0091")) {
    nationalNumber = nationalNumber.slice(4);
  } else if (nationalNumber.startsWith("91") && nationalNumber.length === 12) {
    nationalNumber = nationalNumber.slice(2);
  } else if (nationalNumber.startsWith("0") && nationalNumber.length === 11) {
    nationalNumber = nationalNumber.slice(1);
  }

  if (!/^[6-9]\d{9}$/u.test(nationalNumber)) {
    throw new InvalidIndianPhoneError();
  }

  return `+91${nationalNumber}`;
}

export function roleForOtpPurpose(purpose: OtpPurpose): UserRole | undefined {
  if (purpose === "REGISTER_FARMER") return "FARMER";
  if (purpose === "REGISTER_OWNER") return "OWNER";
  return undefined;
}
