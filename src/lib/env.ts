/**
 * Browser-visible configuration.
 *
 * Only VITE_-prefixed variables may be read here. Service-role keys, provider
 * secrets and connector API keys are read exclusively by Supabase Edge
 * Functions from the server-side environment — importing them into `src/`
 * would inline them into the browser bundle.
 */

interface BrowserEnv {
  supabaseUrl: string
  supabaseAnonKey: string
  defaultOrgName: string
  enableSimulator: boolean
  spyglassBaseUrl: string
  oneSignalAppId: string
  /**
   * Mirrors the server-side OPENIWATCH_ENABLE_SMS flag so the interface can say
   * why SMS is off. It does NOT enable sending — only the Edge Function can do
   * that, and it requires its own server-side flag.
   */
  enableSms: boolean
  /** Label shown in the environment banner, e.g. "Staging". Empty hides it. */
  environmentLabel: string
}

function readString(key: string, fallback = ''): string {
  const value = import.meta.env[key as keyof ImportMetaEnv]
  return typeof value === 'string' && value.length > 0 ? value : fallback
}

export const env: BrowserEnv = {
  supabaseUrl: readString('VITE_SUPABASE_URL'),
  supabaseAnonKey: readString('VITE_SUPABASE_ANON_KEY'),
  defaultOrgName: readString('VITE_DEFAULT_ORG_NAME', 'Openi Security Services'),
  // Defaults on so a fresh clone can demonstrate the workflow immediately.
  enableSimulator: readString('VITE_ENABLE_SIMULATOR', 'true') !== 'false',
  spyglassBaseUrl: readString('VITE_SPYGLASS_BASE_URL'),
  oneSignalAppId: readString('VITE_ONESIGNAL_APP_ID'),
  enableSms: readString('VITE_ENABLE_SMS', 'false') === 'true',
  environmentLabel: readString('VITE_ENVIRONMENT_LABEL'),
}

/**
 * True when Supabase credentials are present.
 *
 * When false the application runs in local demo mode against a browser-local
 * data provider seeded with the pilot data. Demo mode is labelled in the UI —
 * it is never presented as a live backend.
 */
export const isSupabaseConfigured = Boolean(env.supabaseUrl && env.supabaseAnonKey)

export type DataMode = 'supabase' | 'local-demo'

export const dataMode: DataMode = isSupabaseConfigured ? 'supabase' : 'local-demo'
