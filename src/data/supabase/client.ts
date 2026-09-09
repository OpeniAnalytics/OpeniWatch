import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { env, isSupabaseConfigured } from '@/lib/env'

/**
 * Supabase browser client.
 *
 * Created with the anon key only. The service-role key is never imported into
 * `src/` — it exists solely in the Edge Function environment, where it is used
 * by the ingest endpoint.
 *
 * Two auth options below are load-bearing and easy to get wrong:
 *
 * **flowType: 'pkce'.** auth-js defaults to `implicit`, which returns tokens in
 * the URL fragment. PKCE returns a single-use `code` instead, which is bound to
 * a verifier held in this browser and exchanged over a POST. That keeps the
 * access token out of the address bar, out of browser history, out of the
 * Referer header and out of any screenshot an operator pastes into a ticket.
 *
 * **detectSessionInUrl: false.** With it on, the client silently consumes an
 * auth code the moment any page loads. OpeniWatch exchanges the code itself, in
 * the /auth/callback and /auth/confirm routes, so that it happens exactly once
 * and in a place that can report a real error to the operator. Leaving both on
 * would mean two consumers racing for a single-use credential, and the loser
 * reports a failure for a sign-in that actually succeeded.
 */

let client: SupabaseClient | null = null

export function getSupabaseClient(): SupabaseClient {
  if (!isSupabaseConfigured) {
    throw new Error(
      'Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY, or set VITE_ENABLE_LOCAL_DEMO=true for local demo mode.',
    )
  }
  if (!client) {
    client = createClient(env.supabaseUrl, env.supabaseAnonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
        flowType: 'pkce',
      },
      realtime: { params: { eventsPerSecond: 5 } },
    })
  }
  return client
}

/** snake_case row -> camelCase object, applied to every table read. */
export function toCamel<T>(row: Record<string, unknown>): T {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(row)) {
    out[key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase())] = value
  }
  return out as T
}

/** camelCase object -> snake_case row, applied to every write. */
export function toSnake(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    out[key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)] = item
  }
  return out
}
