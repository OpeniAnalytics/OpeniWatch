import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { env, isSupabaseConfigured } from '@/lib/env'

/**
 * Supabase browser client.
 *
 * Created with the anon key only. The service-role key is never imported into
 * `src/` — it exists solely in the Edge Function environment, where it is used
 * by the ingest endpoint.
 */

let client: SupabaseClient | null = null

export function getSupabaseClient(): SupabaseClient {
  if (!isSupabaseConfigured) {
    throw new Error(
      'Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY, or run without them to use local demo mode.',
    )
  }
  if (!client) {
    client = createClient(env.supabaseUrl, env.supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
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
