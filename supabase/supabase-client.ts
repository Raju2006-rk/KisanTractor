import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Builds a Supabase client from environment variables. The anon (public) key is
 * safe to use in a browser; it is NOT a secret. Never put the service_role key
 * in client-side code.
 *
 *   SUPABASE_URL       e.g. https://oysdbkbmalbuqlrjneug.supabase.co
 *   SUPABASE_ANON_KEY  the anon public key from Project Settings -> API
 */
export function createSupabaseClient(
  env: Readonly<Record<string, string | undefined>> = process.env,
): SupabaseClient {
  const url = env.SUPABASE_URL?.trim();
  const anonKey = env.SUPABASE_ANON_KEY?.trim();
  if (!url) throw new Error("SUPABASE_URL is required");
  if (!anonKey) throw new Error("SUPABASE_ANON_KEY is required");
  return createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
