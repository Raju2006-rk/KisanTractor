import type { Session, SupabaseClient, User } from "@supabase/supabase-js";

import { createSupabaseClient } from "./supabase-client.js";

/** E.164: a plus sign, a nonzero country-code digit, then 8 to 15 digits total. */
const E164 = /^\+[1-9]\d{7,14}$/u;

function requireE164(phone: string): string {
  const normalized = phone.replace(/[\s()-]/gu, "");
  if (!E164.test(normalized)) {
    throw new Error("Phone must be E.164, e.g. +919876543210 (country code, digits only)");
  }
  return normalized;
}

/** 4-8 digit OTP, matching Supabase's default code length. */
function requireCode(code: string): string {
  const normalized = code.trim();
  if (!/^\d{4,8}$/u.test(normalized)) throw new Error("OTP code must be 4 to 8 digits");
  return normalized;
}

export interface PhoneAuth {
  /**
   * Asks Supabase to send an OTP SMS to the phone. Supabase delivers it through
   * the SMS provider configured in the dashboard; without a configured (paid,
   * India: DLT-registered) provider, no message is sent.
   *
   * @param createUser when false, only an existing user receives a code.
   */
  sendOtp(phone: string, options?: { createUser?: boolean }): Promise<void>;
  /** Exchanges a phone + received code for a Supabase session (access + refresh token). */
  verifyOtp(phone: string, code: string): Promise<{ session: Session; user: User }>;
}

export function createPhoneAuth(client: SupabaseClient = createSupabaseClient()): PhoneAuth {
  return {
    async sendOtp(phone, options = {}) {
      const { error } = await client.auth.signInWithOtp({
        phone: requireE164(phone),
        options: { channel: "sms", shouldCreateUser: options.createUser ?? true },
      });
      if (error) throw new Error(`Failed to send OTP: ${error.message}`);
    },

    async verifyOtp(phone, code) {
      const { data, error } = await client.auth.verifyOtp({
        phone: requireE164(phone),
        token: requireCode(code),
        type: "sms",
      });
      if (error) throw new Error(`Failed to verify OTP: ${error.message}`);
      if (!data.session || !data.user) throw new Error("Verification did not return a session");
      return { session: data.session, user: data.user };
    },
  };
}
