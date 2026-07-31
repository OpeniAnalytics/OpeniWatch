/// <reference types="vite/client" />

/**
 * Browser-visible configuration.
 *
 * Only VITE_-prefixed variables belong here — anything listed is inlined into
 * the client bundle by Vite. Service-role keys and provider secrets must never
 * appear in this interface.
 */
interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string
  readonly VITE_SUPABASE_ANON_KEY?: string
  readonly VITE_DEFAULT_ORG_NAME?: string
  readonly VITE_ENABLE_SIMULATOR?: string
  readonly VITE_SPYGLASS_BASE_URL?: string
  readonly VITE_ONESIGNAL_APP_ID?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
