import { describe, expect, it } from "vitest";

import {
  InvalidIndianPhoneError,
  normalizeIndianPhone,
  roleForOtpPurpose,
} from "./identity.js";

describe("Indian phone normalization", () => {
  it.each([
    ["9876543210", "+919876543210"],
    ["09876543210", "+919876543210"],
    ["91 98765-43210", "+919876543210"],
    ["+91 (98765) 43210", "+919876543210"],
    ["0091 9876543210", "+919876543210"],
  ])("normalizes %s to E.164", (input, expected) => {
    expect(normalizeIndianPhone(input)).toBe(expected);
  });

  it.each(["", "123", "+911234567890", "98765432101", "abcdefghij"])(
    "rejects invalid mobile number %s",
    (input) => {
      expect(() => normalizeIndianPhone(input)).toThrow(InvalidIndianPhoneError);
    },
  );
});

describe("OTP purpose roles", () => {
  it("grants only the role explicitly bound to a registration purpose", () => {
    expect(roleForOtpPurpose("REGISTER_FARMER")).toBe("FARMER");
    expect(roleForOtpPurpose("REGISTER_OWNER")).toBe("OWNER");
    expect(roleForOtpPurpose("SIGN_IN")).toBeUndefined();
  });
});
