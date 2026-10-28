# Supabase phone-OTP auth (standalone)

This folder is a self-contained Supabase Auth integration. It is **separate** from
the KisanTractor app's own OTP/identity system: a Supabase login here does **not**
authenticate a user in the booking app, whose sessions, roles, and bookings key off
the app's own `DATABASE_URL` records, not Supabase Auth tokens.

## Files

- `migrations/0001_profiles_phone_auth.sql` — a `profiles` table tied to Supabase
  `auth.users`, Row Level Security (each user sees only their own row), and a
  trigger that creates a profile on signup.
- `supabase-client.ts` — builds a Supabase client from `SUPABASE_URL` and
  `SUPABASE_ANON_KEY`.
- `phone-auth.ts` — `sendOtp(phone)` and `verifyOtp(phone, code)`.
- `otp-cli.ts` — a runnable demo.

## One-time setup

1. **Install the SDK** (from the repo root):
   ```
   corepack pnpm add @supabase/supabase-js -w
   ```
2. **Apply the schema**: paste `migrations/0001_profiles_phone_auth.sql` into the
   Supabase dashboard SQL editor and run it (or `supabase db push` with the CLI).
3. **Enable phone auth**: Supabase dashboard -> Authentication -> Providers -> Phone.
   - Connect a paid SMS provider (Twilio, MessageBird, Vonage, Textlocal).
   - For Indian numbers you must complete DLT registration; Supabase does not
     send any SMS without a configured provider.
   - Set the SMS message template, keeping the `{{ .Code }}` placeholder:
     ```
     Your KisanTractor verification code is {{ .Code }}. It expires in 5 minutes.
     ```
4. **Environment**: add to your shell (the anon key is public/safe; it is not a secret):
   ```
   SUPABASE_URL=https://oysdbkbmalbuqlrjneug.supabase.co
   SUPABASE_ANON_KEY=<anon public key from Project Settings -> API>
   ```

## Try it

```
tsx supabase/otp-cli.ts send +919876543210
tsx supabase/otp-cli.ts verify +919876543210 123456
```

## Use in code

```ts
import { createPhoneAuth } from "./supabase/phone-auth.js";

const auth = createPhoneAuth();
await auth.sendOtp("+919876543210");
const { session, user } = await auth.verifyOtp("+919876543210", "123456");
```

Never put the Supabase `service_role` key in client-side code; only the anon key.
