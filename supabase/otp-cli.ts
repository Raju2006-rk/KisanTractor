/**
 * Minimal CLI to exercise Supabase phone OTP end to end.
 *
 *   send:    tsx supabase/otp-cli.ts send +919876543210
 *   verify:  tsx supabase/otp-cli.ts verify +919876543210 123456
 *
 * Reads SUPABASE_URL and SUPABASE_ANON_KEY from the environment.
 */
import { createPhoneAuth } from "./phone-auth.js";

async function main(): Promise<void> {
  const [command, phone, code] = process.argv.slice(2);
  const auth = createPhoneAuth();

  if (command === "send" && phone) {
    await auth.sendOtp(phone);
    console.log(`OTP requested for ${phone}. Check the phone for the SMS code.`);
    return;
  }

  if (command === "verify" && phone && code) {
    const { session, user } = await auth.verifyOtp(phone, code);
    console.log("Verified. Supabase session issued.");
    console.log(JSON.stringify({
      userId: user.id,
      phone: user.phone,
      expiresAt: session.expires_at,
      accessTokenPreview: `${session.access_token.slice(0, 12)}...`,
    }, null, 2));
    return;
  }

  console.error("Usage:\n  tsx supabase/otp-cli.ts send <+E164>\n  tsx supabase/otp-cli.ts verify <+E164> <code>");
  process.exit(1);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
