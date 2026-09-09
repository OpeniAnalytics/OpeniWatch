import { dataMode } from '@/lib/env'
import type { DataProvider } from './provider'
import { LocalDataProvider } from './local/provider'
import { SupabaseDataProvider } from './supabase/provider'

/**
 * Provider selection.
 *
 * Supabase when the browser is configured to reach it, the browser-local demo
 * provider only when demo mode has been explicitly enabled in development.
 *
 * When configuration is blocked there is no provider. This throws rather than
 * substituting the demo provider, and the application renders the configuration
 * screen before it ever reaches this call — a deployed OpeniWatch must never
 * serve browser-local data in place of a backend it cannot reach.
 */

let instance: DataProvider | null = null

export function getDataProvider(): DataProvider {
  if (instance) return instance
  if (dataMode === null) {
    throw new Error(
      'OpeniWatch is not configured. No data provider may be created in this state.',
    )
  }
  instance = dataMode === 'supabase' ? new SupabaseDataProvider() : new LocalDataProvider()
  return instance
}

/** Test hook: drops the memoized provider. */
export function resetDataProvider(): void {
  instance = null
}

export { dataMode }
export type { DataProvider }
