/// <reference types="vite/client" />

/**
 * Browser-visible configuration.
 *
 * Only VITE_-prefixed variables belong here — anything listed is inlined into
 * the client bundle by Vite. Service-role keys and provider secrets must never
 * appear in this interface. In particular the following are server-side only
 * and must never gain a VITE_ alias:
 *
 *   SUPABASE_SECRET_KEY, SUPABASE_SECRET_KEYS, SUPABASE_ACCESS_TOKEN,
 *   SUPABASE_DB_PASSWORD, ONESIGNAL_REST_API_KEY, OPENIWATCH_INGEST_SECRET,
 *   NETLIFY_AUTH_TOKEN, RESEND_API_KEY
 *
 * VITE_SUPABASE_ANON_KEY is deliberately absent: the legacy browser variable is
 * no longer read as configuration. A deployment that still sets it is told to
 * rename it rather than being silently accepted.
 */
interface ImportMetaEnv {
  /** Supabase project URL. Required in staging and production. */
  readonly VITE_SUPABASE_URL?: string
  /**
   * Supabase **publishable** key (`sb_publishable_...`). Required in staging
   * and production.
   *
   * Not the legacy `anon` JWT, and never a secret key: `src/lib/env.ts`
   * refuses a value shaped like `sb_secret_...` or like a JWT.
   */
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string
  readonly VITE_DEFAULT_ORG_NAME?: string
  /** "true" enables the signal simulator. Never honoured in production. */
  readonly VITE_ENABLE_SIMULATOR?: string
  /**
   * "true" permits browser-local demo data. Honoured only when the environment
   * label is absent or unrecognised — never in staging or production.
   */
  readonly VITE_ENABLE_LOCAL_DEMO?: string
  readonly VITE_SPYGLASS_BASE_URL?: string
  readonly VITE_ONESIGNAL_APP_ID?: string
  readonly VITE_ENABLE_SMS?: string
  /** "Staging" or "Production" switch on fail-closed configuration handling. */
  readonly VITE_ENVIRONMENT_LABEL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
