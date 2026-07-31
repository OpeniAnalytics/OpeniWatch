import { dataMode } from '@/lib/env'
import type { DataProvider } from './provider'
import { LocalDataProvider } from './local/provider'
import { SupabaseDataProvider } from './supabase/provider'

/**
 * Provider selection.
 *
 * Supabase when credentials are configured, otherwise the browser-local demo
 * provider. The interface displays the active mode so nobody mistakes demo
 * data for live collection.
 */

let instance: DataProvider | null = null

export function getDataProvider(): DataProvider {
  if (instance) return instance
  instance = dataMode === 'supabase' ? new SupabaseDataProvider() : new LocalDataProvider()
  return instance
}

/** Test hook: drops the memoized provider. */
export function resetDataProvider(): void {
  instance = null
}

export { dataMode }
export type { DataProvider }
