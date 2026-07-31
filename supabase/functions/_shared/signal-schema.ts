/**
 * Inbound signal validation for Edge Functions (Deno).
 *
 * This is a deliberate, dependency-free mirror of
 * `src/services/ingestion/schema.ts`. Edge Functions cannot resolve the browser
 * `@/` alias, and pulling zod over the network on every cold start is a
 * needless dependency on a security boundary — so the rules are re-expressed
 * here in plain TypeScript.
 *
 * The two files must stay in step. `src/services/ingestion/schemaParity.test.ts`
 * asserts the field lists match, so a field added on one side and forgotten on
 * the other fails the test suite.
 */

export const COLLECTION_METHODS = [
  'manual_submission',
  'webhook',
  'connector_pull',
  'simulator',
] as const

export const MEDIA_TYPES = ['image', 'video', 'document', 'audio'] as const

/** Field names accepted on a signal. Checked against the browser schema. */
export const SIGNAL_INPUT_FIELDS = [
  'author',
  'collectionMethod',
  'hasPublicGeotag',
  'language',
  'latitude',
  'longitude',
  'media',
  'originalText',
  'provenance',
  'publishedAt',
  'rawPayload',
  'sourcePlatform',
  'sourceRecordId',
  'sourceUrl',
  'suggestedLocationId',
] as const

export interface ValidationIssue {
  path: string
  message: string
}

export interface ValidatedSignal {
  sourcePlatform: string
  sourceRecordId: string
  sourceUrl: string | null
  originalText: string
  publishedAt: string
  collectionMethod: (typeof COLLECTION_METHODS)[number]
  provenance: string
  author: {
    handle: string
    displayName: string | null
    profileLocationText: string | null
    profileUrl: string | null
    profileDescription: string | null
    sourceProfileMetadata: Record<string, unknown>
  } | null
  media: Array<{
    mediaType: (typeof MEDIA_TYPES)[number]
    url: string
    thumbnailUrl: string | null
    caption: string | null
    capturedAt: string | null
  }>
  latitude: number | null
  longitude: number | null
  hasPublicGeotag: boolean
  language: string | null
  rawPayload: Record<string, unknown>
  suggestedLocationId: string | null
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Only http(s). Blocks javascript:, data: and other schemes at the boundary. */
function externalUrl(value: unknown, path: string, issues: ValidationIssue[]): string | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string') {
    issues.push({ path, message: 'must be a string' })
    return null
  }
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      issues.push({ path, message: 'must be an http(s) URL' })
      return null
    }
    return value
  } catch {
    issues.push({ path, message: 'must be a valid URL' })
    return null
  }
}

function boundedString(
  value: unknown,
  path: string,
  max: number,
  issues: ValidationIssue[],
  { required = false }: { required?: boolean } = {},
): string | null {
  if (value === null || value === undefined || value === '') {
    if (required) issues.push({ path, message: 'is required' })
    return null
  }
  if (typeof value !== 'string') {
    issues.push({ path, message: 'must be a string' })
    return null
  }
  if (value.length > max) {
    issues.push({ path, message: `must be at most ${max} characters` })
    return null
  }
  return value
}

function boundedNumber(
  value: unknown,
  path: string,
  min: number,
  max: number,
  issues: ValidationIssue[],
): number | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    issues.push({ path, message: 'must be a number' })
    return null
  }
  if (value < min || value > max) {
    issues.push({ path, message: `must be between ${min} and ${max}` })
    return null
  }
  return value
}

function isoTimestamp(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  { required = false }: { required?: boolean } = {},
): string | null {
  if (value === null || value === undefined || value === '') {
    if (required) issues.push({ path, message: 'is required' })
    return null
  }
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    issues.push({ path, message: 'must be an ISO-8601 timestamp' })
    return null
  }
  return new Date(value).toISOString()
}

export function validateSignal(
  input: unknown,
  index: number,
): { signal: ValidatedSignal | null; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = []
  const at = (field: string) => `signals[${index}].${field}`

  if (!isRecord(input)) {
    return { signal: null, issues: [{ path: `signals[${index}]`, message: 'must be an object' }] }
  }

  const sourcePlatform = boundedString(input.sourcePlatform, at('sourcePlatform'), 120, issues, {
    required: true,
  })
  const sourceRecordId = boundedString(input.sourceRecordId, at('sourceRecordId'), 300, issues, {
    required: true,
  })
  const originalText = boundedString(input.originalText, at('originalText'), 20_000, issues, {
    required: true,
  })
  const publishedAt = isoTimestamp(input.publishedAt, at('publishedAt'), issues, { required: true })
  const provenance = boundedString(input.provenance, at('provenance'), 1000, issues, {
    required: true,
  })

  const collectionMethod = input.collectionMethod
  if (
    typeof collectionMethod !== 'string' ||
    !COLLECTION_METHODS.includes(collectionMethod as (typeof COLLECTION_METHODS)[number])
  ) {
    issues.push({
      path: at('collectionMethod'),
      message: `must be one of: ${COLLECTION_METHODS.join(', ')}`,
    })
  }

  const sourceUrl = externalUrl(input.sourceUrl, at('sourceUrl'), issues)
  const latitude = boundedNumber(input.latitude, at('latitude'), -90, 90, issues)
  const longitude = boundedNumber(input.longitude, at('longitude'), -180, 180, issues)

  let author: ValidatedSignal['author'] = null
  if (isRecord(input.author)) {
    const handle = boundedString(input.author.handle, at('author.handle'), 200, issues, {
      required: true,
    })
    author = handle
      ? {
          handle,
          displayName: boundedString(input.author.displayName, at('author.displayName'), 200, issues),
          // Self-declared profile location. Never treated as current location.
          profileLocationText: boundedString(
            input.author.profileLocationText,
            at('author.profileLocationText'),
            300,
            issues,
          ),
          profileUrl: externalUrl(input.author.profileUrl, at('author.profileUrl'), issues),
          profileDescription: boundedString(
            input.author.profileDescription,
            at('author.profileDescription'),
            2000,
            issues,
          ),
          sourceProfileMetadata: isRecord(input.author.sourceProfileMetadata)
            ? input.author.sourceProfileMetadata
            : {},
        }
      : null
  } else if (input.author !== null && input.author !== undefined) {
    issues.push({ path: at('author'), message: 'must be an object or null' })
  }

  const media: ValidatedSignal['media'] = []
  if (Array.isArray(input.media)) {
    if (input.media.length > 20) {
      issues.push({ path: at('media'), message: 'must contain at most 20 items' })
    }
    input.media.slice(0, 20).forEach((item, mediaIndex) => {
      if (!isRecord(item)) {
        issues.push({ path: at(`media[${mediaIndex}]`), message: 'must be an object' })
        return
      }
      const mediaType = item.mediaType
      if (
        typeof mediaType !== 'string' ||
        !MEDIA_TYPES.includes(mediaType as (typeof MEDIA_TYPES)[number])
      ) {
        issues.push({
          path: at(`media[${mediaIndex}].mediaType`),
          message: `must be one of: ${MEDIA_TYPES.join(', ')}`,
        })
        return
      }
      const url = externalUrl(item.url, at(`media[${mediaIndex}].url`), issues)
      if (!url) return
      media.push({
        mediaType: mediaType as (typeof MEDIA_TYPES)[number],
        url,
        thumbnailUrl: externalUrl(
          item.thumbnailUrl,
          at(`media[${mediaIndex}].thumbnailUrl`),
          issues,
        ),
        caption: boundedString(item.caption, at(`media[${mediaIndex}].caption`), 1000, issues),
        capturedAt: isoTimestamp(item.capturedAt, at(`media[${mediaIndex}].capturedAt`), issues),
      })
    })
  } else if (input.media !== undefined && input.media !== null) {
    issues.push({ path: at('media'), message: 'must be an array' })
  }

  if (issues.length > 0) return { signal: null, issues }

  return {
    signal: {
      sourcePlatform: sourcePlatform!,
      sourceRecordId: sourceRecordId!,
      sourceUrl,
      originalText: originalText!,
      publishedAt: publishedAt!,
      collectionMethod: collectionMethod as (typeof COLLECTION_METHODS)[number],
      provenance: provenance!,
      author,
      media,
      latitude,
      longitude,
      // A geotag claim requires coordinates to support it.
      hasPublicGeotag: input.hasPublicGeotag === true && latitude !== null && longitude !== null,
      language: boundedString(input.language, at('language'), 20, issues),
      rawPayload: isRecord(input.rawPayload) ? input.rawPayload : {},
      suggestedLocationId: boundedString(
        input.suggestedLocationId,
        at('suggestedLocationId'),
        64,
        issues,
      ),
    },
    issues: [],
  }
}

export function validateBatch(payload: unknown): {
  signals: ValidatedSignal[]
  issues: ValidationIssue[]
  batchId: string | null
} {
  if (!isRecord(payload)) {
    return { signals: [], issues: [{ path: '', message: 'body must be a JSON object' }], batchId: null }
  }
  if (!Array.isArray(payload.signals)) {
    return {
      signals: [],
      issues: [{ path: 'signals', message: 'must be an array' }],
      batchId: null,
    }
  }
  if (payload.signals.length === 0) {
    return {
      signals: [],
      issues: [{ path: 'signals', message: 'must contain at least one signal' }],
      batchId: null,
    }
  }
  // A batch cap keeps one request from monopolising the function.
  if (payload.signals.length > 50) {
    return {
      signals: [],
      issues: [{ path: 'signals', message: 'must contain at most 50 signals' }],
      batchId: null,
    }
  }

  const signals: ValidatedSignal[] = []
  const issues: ValidationIssue[] = []

  payload.signals.forEach((item, index) => {
    const result = validateSignal(item, index)
    if (result.signal) signals.push(result.signal)
    issues.push(...result.issues)
  })

  return {
    signals,
    issues,
    batchId: typeof payload.batchId === 'string' ? payload.batchId.slice(0, 200) : null,
  }
}
