import type { SignalInput } from '@/services/ingestion/schema'
import { signalInputSchema } from '@/services/ingestion/schema'
import type {
  ConnectionTestResult,
  Connector,
  ConnectorContext,
  CursorStore,
  HealthCheckResult,
  PullResult,
} from './types'
import { createMemoryCursorStore } from './types'

/**
 * Phase 1 connectors.
 *
 * Two are real (manual submission, generic webhook). Three are deliberate
 * stubs that describe precisely what they need rather than pretending to work.
 * Nothing here fabricates a vendor endpoint or performs unsupported scraping.
 */

const sharedCursors: CursorStore = createMemoryCursorStore()

function cursorKey(context: ConnectorContext, connectorId: string): string {
  return `${context.organizationId}:${context.programId}:${connectorId}`
}

/** Base implementation of the cursor and no-op halves of the interface. */
function baseConnector(
  id: string,
  cursors: CursorStore = sharedCursors,
): Pick<Connector, 'getCursor' | 'saveCursor'> {
  return {
    async getCursor(context) {
      return cursors.read(cursorKey(context, id))
    },
    async saveCursor(context, cursor) {
      await cursors.write(cursorKey(context, id), cursor)
    },
  }
}

// ---------------------------------------------------------------------------
// Manual analyst submission — implemented
// ---------------------------------------------------------------------------

export const manualConnector: Connector = {
  kind: 'manual',
  id: 'manual',
  displayName: 'Manual analyst submission',
  status: 'implemented',
  description:
    'An analyst enters a public source or operational report directly. The submission runs through the same validation, normalization, matching and scoring path as every other signal.',
  ...baseConnector('manual'),

  async testConnection(): Promise<ConnectionTestResult> {
    return {
      ok: true,
      message: 'Manual submission requires no external connection.',
      missingRequirements: [],
    }
  },

  async pullSignals(): Promise<PullResult> {
    // Manual submission is push-only by definition.
    return { signals: [], nextCursor: null, note: 'Manual submission has nothing to pull.' }
  },

  normalizeSignal(raw): SignalInput | null {
    const parsed = signalInputSchema.safeParse(raw)
    return parsed.success ? parsed.data : null
  },

  async handleWebhook(): Promise<SignalInput[]> {
    return []
  },

  async healthCheck(): Promise<HealthCheckResult> {
    return {
      ok: true,
      message: 'Available.',
      checkedAt: new Date().toISOString(),
    }
  },
}

// ---------------------------------------------------------------------------
// Generic webhook — implemented
// ---------------------------------------------------------------------------

export const genericWebhookConnector: Connector = {
  kind: 'generic_webhook',
  id: 'generic-webhook',
  displayName: 'Secure ingest webhook',
  status: 'implemented',
  description:
    'Accepts normalized signal records at the ingest Edge Function. Requires a shared secret header, validates every payload against the shared schema, and deduplicates on (platform, source record id) and content hash.',
  ...baseConnector('generic-webhook'),

  async testConnection(context): Promise<ConnectionTestResult> {
    const endpoint = typeof context.config.endpoint === 'string' ? context.config.endpoint : null
    return {
      ok: Boolean(endpoint),
      message: endpoint
        ? `Endpoint configured at ${endpoint}. The shared secret is held server-side and is not readable from the browser.`
        : 'No endpoint recorded on the integration.',
      missingRequirements: endpoint ? [] : ['integrations.config.endpoint'],
    }
  },

  async pullSignals(): Promise<PullResult> {
    return { signals: [], nextCursor: null, note: 'The webhook connector is push-only.' }
  },

  normalizeSignal(raw): SignalInput | null {
    const parsed = signalInputSchema.safeParse(raw)
    return parsed.success ? parsed.data : null
  },

  async handleWebhook(payload): Promise<SignalInput[]> {
    // Accepts either a bare signal or { signals: [...] }.
    const items = Array.isArray((payload as { signals?: unknown[] })?.signals)
      ? (payload as { signals: unknown[] }).signals
      : [payload]

    const accepted: SignalInput[] = []
    for (const item of items) {
      const parsed = signalInputSchema.safeParse(item)
      if (parsed.success) accepted.push(parsed.data)
    }
    return accepted
  },

  async healthCheck(context): Promise<HealthCheckResult> {
    const endpoint = typeof context.config.endpoint === 'string' ? context.config.endpoint : null
    return {
      ok: Boolean(endpoint),
      message: endpoint ? 'Endpoint configured.' : 'No endpoint recorded.',
      checkedAt: new Date().toISOString(),
    }
  },
}

// ---------------------------------------------------------------------------
// Zignal / Spyglass — requires vendor documentation
// ---------------------------------------------------------------------------

/**
 * Zignal connector stub.
 *
 * No endpoint path, authentication scheme or payload shape is invented here.
 * `normalizeSignal` is written against a *hypothetical* record shape and is
 * clearly marked as such — it exists to show where vendor field names slot in
 * once documentation is available. See docs/INTEGRATIONS.md for the exact list
 * of information required to complete this connector.
 */
export const zignalConnector: Connector = {
  kind: 'zignal',
  id: 'zignal',
  displayName: 'Zignal / Spyglass',
  status: 'requires_vendor_documentation',
  description:
    'Strategic monitoring feed. Not operational in Phase 1: the endpoint paths, authentication scheme, pagination model and payload shape must come from Zignal vendor documentation. No endpoints are fabricated in this codebase.',
  ...baseConnector('zignal'),

  async testConnection(): Promise<ConnectionTestResult> {
    return {
      ok: false,
      message:
        'Zignal integration is not implemented. It cannot be tested until vendor API documentation is supplied.',
      missingRequirements: [
        'Zignal API base URL (ZIGNAL_API_BASE_URL)',
        'Zignal API credentials (ZIGNAL_API_KEY) and the authentication scheme they use',
        'Documented endpoint paths for listing and retrieving matched content',
        'Documented pagination or cursor model for incremental collection',
        'Documented payload field names for text, author, timestamps, media and source URL',
        'Rate limits and terms of use for programmatic collection',
      ],
    }
  },

  async pullSignals(): Promise<PullResult> {
    return {
      signals: [],
      nextCursor: null,
      note: 'Zignal pull is not implemented. Awaiting vendor API documentation.',
    }
  },

  /**
   * Maps a hypothetical Zignal-shaped record onto the shared schema.
   *
   * The field names below are PLACEHOLDERS chosen to show the mapping shape.
   * They must be replaced with the real names from vendor documentation before
   * this connector is enabled.
   */
  normalizeSignal(raw, context): SignalInput | null {
    if (!raw || typeof raw !== 'object') return null
    const record = raw as Record<string, unknown>

    const text = typeof record.content === 'string' ? record.content : null
    const id = typeof record.id === 'string' ? record.id : null
    const published = typeof record.publishedAt === 'string' ? record.publishedAt : null
    if (!text || !id || !published) return null

    const candidate = {
      sourcePlatform: typeof record.platform === 'string' ? record.platform : 'Public web source',
      sourceRecordId: id,
      sourceUrl: typeof record.url === 'string' ? record.url : null,
      originalText: text,
      publishedAt: published,
      collectionMethod: 'connector_pull' as const,
      provenance: `Collected by the Zignal connector for organization ${context.organizationId}.`,
      rawPayload: record,
    }

    const parsed = signalInputSchema.safeParse(candidate)
    return parsed.success ? parsed.data : null
  },

  async handleWebhook(): Promise<SignalInput[]> {
    // Zignal push delivery, if it exists, is undocumented here.
    return []
  },

  async healthCheck(): Promise<HealthCheckResult> {
    return {
      ok: false,
      message: 'Not implemented. Requires Zignal vendor API documentation.',
      checkedAt: new Date().toISOString(),
    }
  },
}

// ---------------------------------------------------------------------------
// RSS / news — requires credentials (feed URLs)
// ---------------------------------------------------------------------------

export const rssConnector: Connector = {
  kind: 'rss',
  id: 'rss',
  displayName: 'RSS / news feeds',
  status: 'requires_credentials',
  description:
    'Polls configured RSS or Atom feeds for local news items. Requires RSS_FEED_URLS. Only feeds the operator explicitly configures are read; no site is crawled or scraped.',
  ...baseConnector('rss'),

  async testConnection(context): Promise<ConnectionTestResult> {
    const feeds = Array.isArray(context.config.feedUrls) ? context.config.feedUrls : []
    return {
      ok: feeds.length > 0,
      message:
        feeds.length > 0
          ? `${feeds.length} feed(s) configured.`
          : 'No feeds configured. Set RSS_FEED_URLS and record the feed list on the integration.',
      missingRequirements: feeds.length > 0 ? [] : ['RSS_FEED_URLS'],
    }
  },

  async pullSignals(context): Promise<PullResult> {
    const feeds = Array.isArray(context.config.feedUrls) ? context.config.feedUrls : []
    return {
      signals: [],
      nextCursor: context.cursor,
      note:
        feeds.length === 0
          ? 'No feeds configured; nothing pulled.'
          : 'RSS pulling runs server-side and is not enabled in Phase 1.',
    }
  },

  normalizeSignal(raw, context): SignalInput | null {
    if (!raw || typeof raw !== 'object') return null
    const item = raw as Record<string, unknown>
    const title = typeof item.title === 'string' ? item.title : ''
    const description = typeof item.description === 'string' ? item.description : ''
    const link = typeof item.link === 'string' ? item.link : null
    const pubDate = typeof item.pubDate === 'string' ? item.pubDate : null
    if (!title && !description) return null
    if (!pubDate || !link) return null

    const parsed = signalInputSchema.safeParse({
      sourcePlatform: 'News / RSS',
      sourceRecordId: link,
      sourceUrl: link,
      originalText: [title, description].filter(Boolean).join('\n\n'),
      publishedAt: pubDate,
      collectionMethod: 'connector_pull' as const,
      provenance: `Collected from a configured RSS feed for organization ${context.organizationId}.`,
      rawPayload: item,
    })
    return parsed.success ? parsed.data : null
  },

  async handleWebhook(): Promise<SignalInput[]> {
    return []
  },

  async healthCheck(context): Promise<HealthCheckResult> {
    const feeds = Array.isArray(context.config.feedUrls) ? context.config.feedUrls : []
    return {
      ok: feeds.length > 0,
      message: feeds.length > 0 ? `${feeds.length} feed(s) configured.` : 'No feeds configured.',
      checkedAt: new Date().toISOString(),
    }
  },
}

// ---------------------------------------------------------------------------
// Public safety feed — requires credentials
// ---------------------------------------------------------------------------

export const publicSafetyConnector: Connector = {
  kind: 'public_safety',
  id: 'public-safety',
  displayName: 'Public safety feed',
  status: 'requires_credentials',
  description:
    'Ingests incident notices from an agency-provided public safety feed. Requires an agency endpoint and key, and agency permission for programmatic access.',
  ...baseConnector('public-safety'),

  async testConnection(): Promise<ConnectionTestResult> {
    return {
      ok: false,
      message: 'No public safety feed is configured.',
      missingRequirements: [
        'PUBLIC_SAFETY_FEED_URL',
        'PUBLIC_SAFETY_FEED_KEY',
        'Written agency permission for programmatic access',
        'Documented payload field names',
      ],
    }
  },

  async pullSignals(context): Promise<PullResult> {
    return {
      signals: [],
      nextCursor: context.cursor,
      note: 'Public safety feed is not configured.',
    }
  },

  normalizeSignal(raw, context): SignalInput | null {
    if (!raw || typeof raw !== 'object') return null
    const item = raw as Record<string, unknown>
    const description = typeof item.description === 'string' ? item.description : null
    const id = typeof item.incidentId === 'string' ? item.incidentId : null
    const reportedAt = typeof item.reportedAt === 'string' ? item.reportedAt : null
    if (!description || !id || !reportedAt) return null

    const parsed = signalInputSchema.safeParse({
      sourcePlatform: 'Public safety feed',
      sourceRecordId: id,
      originalText: description,
      publishedAt: reportedAt,
      collectionMethod: 'connector_pull' as const,
      provenance: `Collected from a configured public safety feed for organization ${context.organizationId}.`,
      latitude: typeof item.latitude === 'number' ? item.latitude : null,
      longitude: typeof item.longitude === 'number' ? item.longitude : null,
      rawPayload: item,
    })
    return parsed.success ? parsed.data : null
  },

  async handleWebhook(): Promise<SignalInput[]> {
    return []
  },

  async healthCheck(): Promise<HealthCheckResult> {
    return {
      ok: false,
      message: 'Not configured.',
      checkedAt: new Date().toISOString(),
    }
  },
}

export const ALL_CONNECTORS: readonly Connector[] = [
  manualConnector,
  genericWebhookConnector,
  zignalConnector,
  rssConnector,
  publicSafetyConnector,
]

export function getConnector(id: string): Connector | undefined {
  return ALL_CONNECTORS.find((c) => c.id === id)
}
