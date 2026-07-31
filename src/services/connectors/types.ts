import type { ConnectorKind, IntegrationStatus } from '@/domain/enums'
import type { SignalInput } from '@/services/ingestion/schema'

/**
 * Collection connector interface.
 *
 * Every source of signals — Zignal/Spyglass, RSS, a public safety feed, manual
 * submission, a generic webhook — implements this. New sources plug in without
 * the ingestion pipeline, scoring or interface changing, which is what lets
 * live Zignal ingestion be added later without restructuring the application.
 *
 * Each connector reports its own `status` honestly. A connector that cannot run
 * says so, and the administration screen shows that state rather than implying
 * the integration works.
 */

export interface ConnectorContext {
  organizationId: string
  programId: string
  /**
   * Non-secret configuration from `integrations.config`.
   * Credentials are never passed through here — server-side connectors read
   * them from the environment at the point of use.
   */
  config: Record<string, unknown>
  /** Opaque cursor from the previous pull, or null on first run. */
  cursor: string | null
}

export interface PullResult {
  signals: SignalInput[]
  /** Cursor to persist for the next pull. Null leaves the cursor unchanged. */
  nextCursor: string | null
  /** Operator-facing note about what the pull did. */
  note: string
}

export interface HealthCheckResult {
  ok: boolean
  /** Plain-language status. Never contains credentials. */
  message: string
  checkedAt: string
}

export interface ConnectionTestResult {
  ok: boolean
  message: string
  /** What an operator must supply to make this connector work. */
  missingRequirements: string[]
}

export interface Connector {
  readonly kind: ConnectorKind
  readonly id: string
  readonly displayName: string
  readonly status: IntegrationStatus
  /** What this connector does and what it still needs, shown in administration. */
  readonly description: string

  /** Verifies configuration and reachability without ingesting anything. */
  testConnection(context: ConnectorContext): Promise<ConnectionTestResult>

  /** Fetches new signals since the stored cursor. */
  pullSignals(context: ConnectorContext): Promise<PullResult>

  /**
   * Maps one source-shaped record onto the shared signal schema.
   * Exposed separately so a payload can be normalized in isolation — this is
   * the function a live Zignal integration mainly needs to fill in.
   */
  normalizeSignal(raw: unknown, context: ConnectorContext): SignalInput | null

  /** Reads the persisted incremental cursor. */
  getCursor(context: ConnectorContext): Promise<string | null>

  /** Persists the incremental cursor. */
  saveCursor(context: ConnectorContext, cursor: string | null): Promise<void>

  /** Handles an inbound push from the source, returning signals to ingest. */
  handleWebhook(payload: unknown, context: ConnectorContext): Promise<SignalInput[]>

  /** Lightweight liveness probe for the administration screen. */
  healthCheck(context: ConnectorContext): Promise<HealthCheckResult>
}

/**
 * Cursor persistence is injected so connectors stay free of storage concerns:
 * the Supabase provider writes `collection_sources.cursor`, the local demo
 * provider keeps it in browser storage.
 */
export interface CursorStore {
  read(sourceKey: string): Promise<string | null>
  write(sourceKey: string, cursor: string | null): Promise<void>
}

/** In-memory cursor store used by the demo provider and tests. */
export function createMemoryCursorStore(initial: Record<string, string | null> = {}): CursorStore {
  const store = new Map<string, string | null>(Object.entries(initial))
  return {
    async read(sourceKey) {
      return store.get(sourceKey) ?? null
    },
    async write(sourceKey, cursor) {
      store.set(sourceKey, cursor)
    },
  }
}
